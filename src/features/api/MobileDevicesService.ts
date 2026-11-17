import { invoke } from "@tauri-apps/api/core";
import { sessionContext } from "../../core/session/SessionContext";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";

export type MobileClient = { ip: string; connected_at: string };
export type MobileApiStatus = { active: boolean; port: number; local_ip: string | null; clients: MobileClient[] };
export type DeviceAlias = { ip: string; alias: string };
export type MobileDevice = { id: string; alias: string; status: "pending" | "approved" | "revoked"; last_ip: string | null; last_seen_at: string | null; registered_at: string };

class MobileDevicesService {
  async status() { return invoke<MobileApiStatus>("mobile_api_status"); }
  async aliases(): Promise<DeviceAlias[]> { const database = await databaseManager.database(); const rows = await database.select<DeviceAlias[]>("SELECT ip,alias FROM mobile_device_aliases WHERE tenant_id=$1 ORDER BY updated_at DESC", [this.tenantId()]); return rows; }
  async setAlias(ip: string, alias: string) { const database = await databaseManager.database(); await database.execute("INSERT INTO mobile_device_aliases(tenant_id,ip,alias,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,ip) DO UPDATE SET alias=excluded.alias,updated_at=excluded.updated_at", [this.tenantId(), ip, alias.trim(), new Date().toISOString()]); }
  async loadAutoStart(): Promise<boolean> { const database = await databaseManager.database(); const rows = await database.select<{ mobile_server_enabled: number }[]>("SELECT mobile_server_enabled FROM tenants WHERE id=$1", [this.tenantId()]); return (rows[0]?.mobile_server_enabled ?? 0) === 1; }
  async saveAutoStart(enabled: boolean): Promise<void> { const database = await databaseManager.database(); await database.execute("UPDATE tenants SET mobile_server_enabled=$1 WHERE id=$2", [enabled ? 1 : 0, this.tenantId()]); }
  async listDevices(): Promise<MobileDevice[]> {
    const database = await databaseManager.database();
    const tenantId = this.tenantId();
    return database.select<MobileDevice[]>(
      "SELECT id, alias, status, last_ip, last_seen_at, registered_at FROM mobile_devices WHERE tenant_id=$1 ORDER BY registered_at DESC",
      [tenantId],
    );
  }

  async patchDevice(id: string, patch: { alias?: string; status?: "approved" | "revoked" | "pending" }): Promise<void> {
    const database = await databaseManager.database();
    const tenantId = this.tenantId();
    if (patch.alias !== undefined) {
      await database.execute("UPDATE mobile_devices SET alias=$1 WHERE id=$2 AND tenant_id=$3", [patch.alias.trim(), id, tenantId]);
    }
    if (patch.status !== undefined) {
      await database.execute("UPDATE mobile_devices SET status=$1 WHERE id=$2 AND tenant_id=$3", [patch.status, id, tenantId]);
    }
  }

  async deleteDevice(id: string): Promise<void> {
    const database = await databaseManager.database();
    await database.execute("DELETE FROM mobile_devices WHERE id=$1 AND tenant_id=$2", [id, this.tenantId()]);
  }

  async startServer(): Promise<{ ok: boolean; message: string }> {
    const ctx = sessionContext.current();
    if (!ctx) throw new Error("Sin sesion activa.");
    const database = await databaseManager.database();
    const rows = await database.select<{ address: string | null }[]>("SELECT address FROM tenants WHERE id=$1", [ctx.tenantId]);
    const tenantAddress = rows[0]?.address ?? "";
    const result = await invoke<{ active: boolean; message: string }>("start_mobile_api", { tenantId: ctx.tenantId, tenantName: ctx.tenantName, tenantAddress });
    if (result.active) {
      await invoke("publish_mdns", { tenantId: ctx.tenantId, tenantName: ctx.tenantName, tenantAddress }).catch(() => {});
    }
    return { ok: result.active, message: result.message };
  }
  async stopServer(): Promise<void> { await invoke("stop_mobile_api"); await invoke("unpublish_mdns"); }
  private tenantId() { const tenantId = sessionContext.current()?.tenantId; if (!tenantId) throw new Error("No hay una sesion activa."); return tenantId; }
}

export const mobileDevicesService = new MobileDevicesService();
