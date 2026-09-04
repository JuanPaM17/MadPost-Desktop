import { tenantRepository } from "../../infrastructure/sqlite/repositories";

export type BusinessConfig = { tenantId: string; name: string; address: string; phone: string; taxId: string };

class ConfigService {
  async save(config: BusinessConfig) {
    const existing = await tenantRepository.get(config.tenantId);
    await tenantRepository.upsert({
      id: config.tenantId, name: config.name.trim(), slug: existing?.slug ?? null,
      address: config.address.trim() || null, phone: config.phone.trim() || null, tax_id: config.taxId.trim() || null,
    });
  }
}

export const configService = new ConfigService();
