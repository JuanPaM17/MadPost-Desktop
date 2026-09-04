import { sessionContext } from "../../core/session/SessionContext";
import { auditService } from "../audit/AuditService";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { pendingDeletesRepository, syncQueueRepository } from "../../infrastructure/sqlite/repositories";

export type Sauce = { id: string; tenantId: string; name: string; active: number; createdAt: string; updatedAt: string };

class SauceService {
  private tenantId() { const tenantId = sessionContext.current()?.tenantId; if (!tenantId) throw new Error("No hay una sesion activa."); return tenantId; }

  async list() {
    const database = await databaseManager.database();
    const rows = await database.select<{ id: string; tenant_id: string; name: string; active: number; created_at: string; updated_at: string }[]>("SELECT id, tenant_id, name, active, created_at, updated_at FROM sauces WHERE tenant_id = $1 ORDER BY active DESC, name COLLATE NOCASE", [this.tenantId()]);
    return rows.map((row) => ({ id: row.id, tenantId: row.tenant_id, name: row.name, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async save(existing: Sauce | null, name: string) {
    const normalizedName = name.trim(); if (!normalizedName) throw new Error("El nombre de la salsa es obligatorio.");
    const timestamp = new Date().toISOString(); const tenantId = this.tenantId();
    const sauce: Sauce = existing ? { ...existing, name: normalizedName, updatedAt: timestamp } : { id: crypto.randomUUID(), tenantId, name: normalizedName, active: 1, createdAt: timestamp, updatedAt: timestamp };
    const database = await databaseManager.database();
    await database.execute(`INSERT INTO sauces(id, tenant_id, name, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`, [sauce.id, sauce.tenantId, sauce.name, sauce.active, sauce.createdAt, sauce.updatedAt]);
    await syncQueueRepository.enqueue("sauces", sauce.id, "INSERT", toPayload(sauce));
    await auditService.log(existing ? "EDITAR_SALSA" : "CREAR_SALSA", "CATALOGO", `Salsa: ${sauce.name}`, sauce.id);
    return sauce;
  }

  async setActive(sauce: Sauce, active: boolean) {
    const database = await databaseManager.database(); const updatedAt = new Date().toISOString();
    await database.execute("UPDATE sauces SET active = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4", [active ? 1 : 0, updatedAt, sauce.id, this.tenantId()]);
    await syncQueueRepository.enqueue("sauces", sauce.id, "UPDATE", { id: sauce.id, active });
    await auditService.log(active ? "ACTIVAR_SALSA" : "DESACTIVAR_SALSA", "CATALOGO", `Salsa: ${sauce.name}`, sauce.id);
  }

  async remove(sauce: Sauce) {
    const database = await databaseManager.database();
    await syncQueueRepository.clearForRecord("sauces", sauce.id);
    await database.execute("DELETE FROM sauces WHERE id = $1 AND tenant_id = $2", [sauce.id, this.tenantId()]);
    await pendingDeletesRepository.enqueue("sauces", sauce.id);
    await auditService.log("ELIMINAR_SALSA", "CATALOGO", `Salsa: ${sauce.name}`, sauce.id);
  }

  async maxSauces() {
    const database = await databaseManager.database();
    const rows = await database.select<{ max_sauces: number | null }[]>("SELECT max_sauces FROM tenants WHERE id = $1", [this.tenantId()]);
    return rows[0]?.max_sauces ?? 3;
  }

  async setMaxSauces(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error("El maximo debe estar entre 1 y 20.");
    const tenantId = this.tenantId(); const database = await databaseManager.database(); const updatedAt = new Date().toISOString();
    await database.execute("UPDATE tenants SET max_sauces = $1, updated_at = $2 WHERE id = $3", [value, updatedAt, tenantId]);
    await syncQueueRepository.enqueue("tenants", tenantId, "UPDATE", { id: tenantId, max_sauces: value });
  }
}

function toPayload(sauce: Sauce) { return { id: sauce.id, tenant_id: sauce.tenantId, name: sauce.name, active: sauce.active === 1, created_at: sauce.createdAt, updated_at: sauce.updatedAt }; }
export const sauceService = new SauceService();
