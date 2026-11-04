import type { CachedLicense, Tenant } from "../../core/types";
import { deviceService } from "../../infrastructure/device/DeviceService";
import { licenseRepository, tenantRepository } from "../../infrastructure/sqlite/repositories";
import { supabaseConnection } from "../../infrastructure/supabase/SupabaseClient";
import { ensureSuperAdmin } from "../auth/AuthService";

type RemoteTenant = { name?: string; slug?: string; address?: string | null; phone?: string | null; tax_id?: string | null } | Array<{ name?: string; slug?: string; address?: string | null; phone?: string | null; tax_id?: string | null }> | null;
type RemoteLicense = {
  key: string;
  tenant_id: string;
  expires_at: string;
  sync_enabled: boolean | null;
  max_devices: number | null;
  tenants: RemoteTenant;
};
type RemoteDevice = { id: string; device_id: string; hostname: string; active: boolean };

export type LicenseActivation = { tenantId: string; tenantName: string; address: string | null; phone: string | null; taxId: string | null };
export type Revalidation = "valid" | "offline" | "invalid" | "device_blocked";

class LicenseService {
  async hasValidCachedLicense() {
    return licenseRepository.getValid();
  }

  async fetchRemoteTenantData(tenantId: string): Promise<{ address: string | null; phone: string | null; taxId: string | null }> {
    try {
      const { data } = await supabaseConnection.getClient().from("tenants").select("address, phone, tax_id").eq("id", tenantId).maybeSingle<{ address: string | null; phone: string | null; tax_id: string | null }>();
      return { address: data?.address ?? null, phone: data?.phone ?? null, taxId: data?.tax_id ?? null };
    } catch {
      return { address: null, phone: null, taxId: null };
    }
  }

  /** Consulta Supabase por device_id para saber si este equipo esta bloqueado, sin necesitar cache local. */
  async checkDeviceBlocked(): Promise<boolean> {
    try {
      const deviceId = await deviceService.getDeviceId();
      const { data } = await supabaseConnection.getClient()
        .from("license_devices")
        .select("active")
        .eq("device_id", deviceId)
        .limit(1)
        .maybeSingle<{ active: boolean }>();
      if (!data) return false; // nunca registrado
      return !data.active;
    } catch {
      return false;
    }
  }

  async isReachable() {
    try {
      const client = supabaseConnection.getClient();
      const { error } = await client.from("licenses").select("key", { head: true, count: "exact" }).limit(1);
      return !error;
    } catch {
      return false;
    }
  }

  async activate(rawKey: string): Promise<LicenseActivation> {
    const key = rawKey.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
      throw new Error("La clave de licencia debe tener formato UUID.");
    }
    const remote = await this.fetchLicense(key);
    const deviceId = await this.registerDevice(remote);
    const tenant = this.toTenant(remote);
    await this.cache(remote, tenant, deviceId);
    await ensureSuperAdmin(remote.tenant_id);
    return { tenantId: remote.tenant_id, tenantName: tenant.name, address: tenant.address, phone: tenant.phone, taxId: tenant.tax_id };
  }

  async revalidateInBackground(cached: CachedLicense): Promise<Revalidation> {
    try {
      const remote = await this.fetchLicense(cached.key);
      const deviceId = await this.registerDevice(remote, cached.device_id ?? undefined);
      const tenant = this.toTenant(remote);
      await this.cache(remote, tenant, deviceId);
      // Si antes estaba marcado como bloqueado y ahora es valido, limpiar el flag.
      await licenseRepository.setDeviceBlocked(cached.key, false);
      await ensureSuperAdmin(remote.tenant_id);
      return "valid";
    } catch (error) {
      if (error instanceof InvalidLicenseError) {
        if (error.isDeviceBlocked) {
          await licenseRepository.setDeviceBlocked(cached.key, true);
          return "device_blocked";
        }
        return "invalid";
      }
      return "offline";
    }
  }

  private async fetchLicense(key: string): Promise<RemoteLicense> {
    const { data, error } = await supabaseConnection
      .getClient()
      .from("licenses")
      .select("key, tenant_id, expires_at, sync_enabled, max_devices, tenants(name, slug, address, phone, tax_id)")
      .eq("key", key)
      .eq("active", true)
      .maybeSingle<RemoteLicense>();
    if (error) throw new Error("No fue posible conectar con el servidor de licencias.");
    if (!data || new Date(data.expires_at).getTime() <= Date.now()) throw new InvalidLicenseError();
    return data;
  }

  private async registerDevice(license: RemoteLicense, cachedDeviceId?: string) {
    const deviceId = cachedDeviceId ?? (await deviceService.getDeviceId());
    const hostname = await deviceService.getHostname();
    const client = supabaseConnection.getClient();
    const { data, error } = await client
      .from("license_devices")
      .select("id, device_id, hostname, active")
      .eq("license_key", license.key)
      .returns<RemoteDevice[]>();
    if (error) throw new Error("No fue posible verificar el dispositivo.");

    const current = data.find((device) => device.device_id === deviceId);
    if (current) {
      if (!current.active) throw new InvalidLicenseError("Este dispositivo fue desactivado.", true);
      await this.touchDevice(current.id);
      return deviceId;
    }

    const sameHostname = data.find((device) => device.hostname === hostname);
    if (sameHostname) {
      if (!sameHostname.active) throw new InvalidLicenseError("Este dispositivo fue desactivado.", true);
      const { error: updateError } = await client
        .from("license_devices")
        .update({ device_id: deviceId, last_seen: new Date().toISOString() })
        .eq("id", sameHostname.id);
      if (updateError) throw new Error("No fue posible actualizar el dispositivo.");
      return deviceId;
    }

    const activeDevices = data.filter((device) => device.active).length;
    if (activeDevices >= (license.max_devices ?? 1)) throw new InvalidLicenseError("La licencia ya alcanzo el limite de dispositivos.");
    const timestamp = new Date().toISOString();
    const { error: insertError } = await client.from("license_devices").insert({
      license_key: license.key,
      device_id: deviceId,
      hostname,
      registered_at: timestamp,
      last_seen: timestamp,
      active: true,
    });
    if (insertError) throw new Error("No fue posible registrar este dispositivo.");
    return deviceId;
  }

  private async touchDevice(id: string) {
    const { error } = await supabaseConnection
      .getClient()
      .from("license_devices")
      .update({ last_seen: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error("No fue posible actualizar la ultima conexion del dispositivo.");
  }

  private toTenant(license: RemoteLicense): Tenant {
    const remoteTenant = Array.isArray(license.tenants) ? license.tenants[0] : license.tenants;
    return { id: license.tenant_id, name: remoteTenant?.name ?? "Mi negocio", slug: remoteTenant?.slug ?? null, address: remoteTenant?.address ?? null, phone: remoteTenant?.phone ?? null, tax_id: remoteTenant?.tax_id ?? null };
  }

  private async cache(license: RemoteLicense, tenant: Tenant, deviceId: string) {
    const timestamp = new Date().toISOString();
    await licenseRepository.save({
      key: license.key,
      tenant_id: license.tenant_id,
      tenant_name: tenant.name,
      expires_at: license.expires_at,
      validated_at: timestamp,
      sync_enabled: license.sync_enabled ? 1 : 0,
      device_id: deviceId,
    });
    await tenantRepository.upsert(tenant);
  }
}

class InvalidLicenseError extends Error {
  readonly isDeviceBlocked: boolean;
  constructor(message = "La licencia no es valida, esta vencida o el dispositivo fue bloqueado.", isDeviceBlocked = false) {
    super(message);
    this.isDeviceBlocked = isDeviceBlocked;
  }
}

export const licenseService = new LicenseService();
