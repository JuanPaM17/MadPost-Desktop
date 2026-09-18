import { licenseService } from "../features/license/LicenseService";
import { migrationService } from "../features/migration/MigrationService";
import { databaseManager } from "../infrastructure/sqlite/DatabaseManager";

export type StartupResult = { screen: "license"; online: boolean } | { screen: "auth"; tenantId: string; tenantName: string };

export async function startApplication(onInvalidLicense: () => void): Promise<StartupResult> {
  // Si existe la DB de Java, habilitar dual-write silenciosamente.
  if (await migrationService.javaDbExists()) {
    databaseManager.enableDualWrite();
  }

  const cached = await licenseService.hasValidCachedLicense();
  if (!cached) return { screen: "license", online: await licenseService.isReachable() };
  void licenseService.revalidateInBackground(cached).then((result) => { if (result === "invalid") onInvalidLicense(); });
  return { screen: "auth", tenantId: cached.tenant_id, tenantName: cached.tenant_name ?? "Mi negocio" };
}
