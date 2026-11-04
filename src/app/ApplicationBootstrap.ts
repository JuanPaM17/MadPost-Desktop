import { licenseService } from "../features/license/LicenseService";
import { migrationService } from "../features/migration/MigrationService";
import { databaseManager } from "../infrastructure/sqlite/DatabaseManager";
import { licenseRepository, tenantRepository } from "../infrastructure/sqlite/repositories";

export type StartupResult =
  | { screen: "license"; online: boolean }
  | { screen: "blocked" }
  | { screen: "auth"; tenantId: string; tenantName: string; address: string | null; phone: string | null; taxId: string | null };

export async function startApplication(onSessionInvalidated: (reason: "blocked" | "invalid") => void): Promise<StartupResult> {
  // Si existe la DB de Java, habilitar dual-write silenciosamente.
  // if (await migrationService.javaDbExists()) {
  //   databaseManager.enableDualWrite();
  // }

  const anyCached = await licenseRepository.getAnyCached();

  // Sin cache: verificar online si este dispositivo ya fue bloqueado antes de pedir la licencia.
  if (!anyCached) {
    const online = await licenseService.isReachable();
    if (online && await licenseService.checkDeviceBlocked()) return { screen: "blocked" };
    return { screen: "license", online };
  }

  // Si ya estaba marcado como bloqueado localmente y no hay internet, mantener el bloqueo.
  // Si hay internet, revalidar para confirmar (por si el admin lo reactivo).
  if (anyCached.device_blocked) {
    const online = await licenseService.isReachable();
    if (!online) return { screen: "blocked" };
    const cached = await licenseService.hasValidCachedLicense();
    const revalidation = await licenseService.revalidateInBackground(cached ?? anyCached);
    if (revalidation === "device_blocked") return { screen: "blocked" };
    if (revalidation === "invalid") return { screen: "license", online: true };
    // Fue reactivado: continuar al auth.
    const tenant = await tenantRepository.get(anyCached.tenant_id);
    return { screen: "auth", tenantId: anyCached.tenant_id, tenantName: anyCached.tenant_name ?? "Mi negocio", address: tenant?.address ?? null, phone: tenant?.phone ?? null, taxId: tenant?.tax_id ?? null };
  }

  // Cache valida normal.
  const cached = await licenseService.hasValidCachedLicense();
  if (!cached) return { screen: "license", online: await licenseService.isReachable() };

  // Revalidar en background -- si detecta bloqueo o invalidez notifica para cerrar la sesion activa.
  void licenseService.revalidateInBackground(cached).then((result) => {
    if (result === "device_blocked") onSessionInvalidated("blocked");
    else if (result === "invalid") onSessionInvalidated("invalid");
  });

  const tenant = await tenantRepository.get(cached.tenant_id);
  return { screen: "auth", tenantId: cached.tenant_id, tenantName: cached.tenant_name ?? "Mi negocio", address: tenant?.address ?? null, phone: tenant?.phone ?? null, taxId: tenant?.tax_id ?? null };
}
