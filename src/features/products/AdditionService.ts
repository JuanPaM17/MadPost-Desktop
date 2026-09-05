import { sessionContext } from "../../core/session/SessionContext";
import { auditService } from "../audit/AuditService";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { pendingDeletesRepository, syncQueueRepository } from "../../infrastructure/sqlite/repositories";

export type Addition = { id: string; tenantId: string; name: string; price: number; active: number; stock: number | null; quantityPerSale: number; createdAt: string; updatedAt: string };

class AdditionService {
  private tenantId() { const tenantId = sessionContext.current()?.tenantId; if (!tenantId) throw new Error("No hay una sesion activa."); return tenantId; }
  async list() { const database = await databaseManager.database(); const rows = await database.select<{ id: string; tenant_id: string; name: string; price: number; active: number; stock: number | null; quantity_per_sale: number; created_at: string; updated_at: string }[]>("SELECT id, tenant_id, name, price, active, stock, quantity_per_sale, created_at, updated_at FROM additions WHERE tenant_id = $1 ORDER BY active DESC, name COLLATE NOCASE", [this.tenantId()]); return rows.map(mapAddition); }
  async save(existing: Addition | null, values: { name: string; price: number; stock: number | null; quantityPerSale: number }) {
    const name = values.name.trim(); if (!name) throw new Error("El nombre de la adicion es obligatorio."); if (!Number.isFinite(values.price) || values.price < 0) throw new Error("El precio debe ser un numero valido."); if (values.stock !== null && (!Number.isFinite(values.stock) || values.stock < 0)) throw new Error("El stock debe ser un numero positivo."); if (!Number.isFinite(values.quantityPerSale) || values.quantityPerSale <= 0) throw new Error("La cantidad por venta debe ser mayor que cero.");
    const now = new Date().toISOString(); const tenantId = this.tenantId();
    const addition: Addition = existing ? { ...existing, name, price: values.price, stock: values.stock, quantityPerSale: values.quantityPerSale, updatedAt: now } : { id: crypto.randomUUID(), tenantId, name, price: values.price, active: 1, stock: values.stock, quantityPerSale: values.quantityPerSale, createdAt: now, updatedAt: now };
    const database = await databaseManager.database();
    await database.execute(`INSERT INTO additions(id, tenant_id, name, price, active, stock, quantity_per_sale, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, stock=excluded.stock, quantity_per_sale=excluded.quantity_per_sale, updated_at=excluded.updated_at`, [addition.id, addition.tenantId, addition.name, addition.price, addition.active, addition.stock, addition.quantityPerSale, addition.createdAt, addition.updatedAt]);
    await syncQueueRepository.enqueue("additions", addition.id, "INSERT", payload(addition)); await auditService.log(existing ? "EDITAR_ADICION" : "CREAR_ADICION", "CATALOGO", `Adicion: ${addition.name} | Precio: $${addition.price}`, addition.id); return addition;
  }
  async setActive(addition: Addition, active: boolean) { const database = await databaseManager.database(); const updatedAt = new Date().toISOString(); await database.execute("UPDATE additions SET active = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4", [active ? 1 : 0, updatedAt, addition.id, this.tenantId()]); await syncQueueRepository.enqueue("additions", addition.id, "UPDATE", { id: addition.id, active }); await auditService.log(active ? "ACTIVAR_ADICION" : "DESACTIVAR_ADICION", "CATALOGO", `Adicion: ${addition.name}`, addition.id); }
  async remove(addition: Addition) { const database = await databaseManager.database(); await syncQueueRepository.clearForRecord("additions", addition.id); await database.execute("DELETE FROM additions WHERE id = $1 AND tenant_id = $2", [addition.id, this.tenantId()]); await pendingDeletesRepository.enqueue("additions", addition.id); await auditService.log("ELIMINAR_ADICION", "CATALOGO", `Adicion: ${addition.name} | Precio: $${addition.price}`, addition.id); }
}
function mapAddition(row: { id: string; tenant_id: string; name: string; price: number; active: number; stock: number | null; quantity_per_sale: number; created_at: string; updated_at: string }): Addition { return { id: row.id, tenantId: row.tenant_id, name: row.name, price: row.price, active: row.active, stock: row.stock, quantityPerSale: row.quantity_per_sale, createdAt: row.created_at, updatedAt: row.updated_at }; }
function payload(addition: Addition) { return { id: addition.id, tenant_id: addition.tenantId, name: addition.name, price: addition.price, active: addition.active === 1, stock: addition.stock, quantity_per_sale: addition.quantityPerSale, created_at: addition.createdAt, updated_at: addition.updatedAt }; }
export const additionService = new AdditionService();
