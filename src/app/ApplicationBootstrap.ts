import { licenseService } from "../features/license/LicenseService";
import { migrationService } from "../features/migration/MigrationService";
import { databaseManager } from "../infrastructure/sqlite/DatabaseManager";
import { tenantRepository } from "../infrastructure/sqlite/repositories";

export type StartupResult = { screen: "license"; online: boolean } | { screen: "auth"; tenantId: string; tenantName: string; address: string | null; phone: string | null; taxId: string | null };

export async function startApplication(onInvalidLicense: () => void): Promise<StartupResult> {
  // Si existe la DB de Java, habilitar dual-write silenciosamente.
  if (await migrationService.javaDbExists()) {
    databaseManager.enableDualWrite();
  }

  const cached = await licenseService.hasValidCachedLicense();
  if (!cached) return { screen: "license", online: await licenseService.isReachable() };
  void licenseService.revalidateInBackground(cached).then((result) => { if (result === "invalid") onInvalidLicense(); });
  const tenant = await tenantRepository.get(cached.tenant_id);
  return { screen: "auth", tenantId: cached.tenant_id, tenantName: cached.tenant_name ?? "Mi negocio", address: tenant?.address ?? null, phone: tenant?.phone ?? null, taxId: tenant?.tax_id ?? null };
}
