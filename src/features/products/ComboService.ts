import { sessionContext } from "../../core/session/SessionContext";
import { auditService } from "../audit/AuditService";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { pendingDeletesRepository, syncQueueRepository } from "../../infrastructure/sqlite/repositories";

export type ComboItem = { id: string; productId: string; productName: string | null; productPrice: number | null; quantity: number };
export type Combo = { id: string; tenantId: string; name: string; price: number; active: number; createdAt: string; updatedAt: string; items: ComboItem[]; deletionReason: string | null };
export type ComboProductOption = { id: string; name: string; price: number };

class ComboService {
  private tenantId() { const tenantId = sessionContext.current()?.tenantId; if (!tenantId) throw new Error("No hay una sesion activa."); return tenantId; }
  async list() {
    const database = await databaseManager.database(); const tenantId = this.tenantId();
    const combos = await database.select<{ id: string; tenant_id: string; name: string; price: number; active: number; created_at: string; updated_at: string; open_order_count: number }[]>(`SELECT c.id, c.tenant_id, c.name, c.price, c.active, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM table_order_items toi JOIN table_orders t ON t.id=toi.table_order_id WHERE toi.combo_id=c.id AND t.status='OPEN' AND t.tenant_id=c.tenant_id) AS open_order_count
      FROM combos c WHERE c.tenant_id=$1 ORDER BY c.active DESC, c.name COLLATE NOCASE`, [tenantId]);
    const items = await database.select<{ id: string; combo_id: string; product_id: string; product_name: string | null; product_price: number | null; quantity: number }[]>(`SELECT ci.id, ci.combo_id, ci.product_id, p.name AS product_name, p.price AS product_price, ci.quantity
      FROM combo_items ci LEFT JOIN products p ON p.id=ci.product_id JOIN combos c ON c.id=ci.combo_id WHERE c.tenant_id=$1 ORDER BY ci.id`, [tenantId]);
    const itemsByCombo = new Map<string, ComboItem[]>();
    for (const item of items) itemsByCombo.set(item.combo_id, [...(itemsByCombo.get(item.combo_id) ?? []), { id: item.id, productId: item.product_id, productName: item.product_name, productPrice: item.product_price, quantity: item.quantity }]);
    return combos.map((combo) => ({ id: combo.id, tenantId: combo.tenant_id, name: combo.name, price: combo.price, active: combo.active, createdAt: combo.created_at, updatedAt: combo.updated_at, items: itemsByCombo.get(combo.id) ?? [], deletionReason: combo.open_order_count > 0 ? "Tiene mesa abierta" : null }));
  }
  async activeProducts() { const database = await databaseManager.database(); return database.select<ComboProductOption[]>("SELECT id, name, price FROM products WHERE tenant_id=$1 AND active=1 ORDER BY name COLLATE NOCASE", [this.tenantId()]); }
  async save(existing: Combo | null, values: { name: string; price: number }, items: ComboItem[]) {
    const name = values.name.trim(); if (!name) throw new Error("El nombre del combo es obligatorio."); if (!Number.isFinite(values.price) || values.price < 0) throw new Error("El precio debe ser un numero valido."); if (!items.length) throw new Error("Agrega al menos un producto al combo."); if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) throw new Error("La cantidad de cada producto debe estar entre 1 y 99.");
    const now = new Date().toISOString(); const tenantId = this.tenantId(); const combo: Combo = existing ? { ...existing, name, price: values.price, updatedAt: now } : { id: crypto.randomUUID(), tenantId, name, price: values.price, active: 1, createdAt: now, updatedAt: now, items: [], deletionReason: null };
    const database = await databaseManager.database();
    await database.execute(`INSERT INTO combos(id, tenant_id, name, price, active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, active=excluded.active, updated_at=excluded.updated_at`, [combo.id, combo.tenantId, combo.name, combo.price, combo.active, combo.createdAt, combo.updatedAt]);
    await syncQueueRepository.enqueue("combos", combo.id, "INSERT", comboPayload(combo));
    const previousItems = await database.select<{ id: string }[]>("SELECT id FROM combo_items WHERE combo_id=$1", [combo.id]);
    for (const item of previousItems) await syncQueueRepository.enqueue("combo_items", item.id, "DELETE", {});
    await database.execute("DELETE FROM combo_items WHERE combo_id=$1", [combo.id]);
    const savedItems: ComboItem[] = [];
    for (const item of items) { const saved = { ...item, id: item.id || crypto.randomUUID() }; await database.execute("INSERT INTO combo_items(id, combo_id, product_id, quantity) VALUES ($1,$2,$3,$4)", [saved.id, combo.id, saved.productId, saved.quantity]); await syncQueueRepository.enqueue("combo_items", saved.id, "INSERT", { id: saved.id, combo_id: combo.id, product_id: saved.productId, quantity: saved.quantity }); savedItems.push(saved); }
    const result = { ...combo, items: savedItems };
    await auditService.log(existing ? "EDITAR_COMBO" : "CREAR_COMBO", "CATALOGO", `Combo: ${result.name} | Precio: $${result.price}`, result.id);
    return result;
  }
  async setActive(combo: Combo, active: boolean) { const database = await databaseManager.database(); await database.execute("UPDATE combos SET active=$1, updated_at=$2 WHERE id=$3 AND tenant_id=$4", [active ? 1 : 0, new Date().toISOString(), combo.id, this.tenantId()]); await syncQueueRepository.enqueue("combos", combo.id, "UPDATE", { id: combo.id, active }); await auditService.log(active ? "ACTIVAR_COMBO" : "DESACTIVAR_COMBO", "CATALOGO", `Combo: ${combo.name} | Precio: $${combo.price}`, combo.id); }
  async remove(combo: Combo) { const database = await databaseManager.database(); await database.execute("DELETE FROM sync_queue WHERE table_name='combo_items' AND record_id IN (SELECT id FROM combo_items WHERE combo_id=$1) AND synced_at IS NULL", [combo.id]); await syncQueueRepository.clearForRecord("combos", combo.id); await database.execute("DELETE FROM combo_items WHERE combo_id=$1", [combo.id]); await database.execute("DELETE FROM combos WHERE id=$1 AND tenant_id=$2", [combo.id, this.tenantId()]); await pendingDeletesRepository.enqueue("combos", combo.id); await auditService.log("ELIMINAR_COMBO", "CATALOGO", `Combo: ${combo.name} | Precio: $${combo.price}`, combo.id); }
}
function comboPayload(combo: Combo) { return { id: combo.id, tenant_id: combo.tenantId, name: combo.name, price: combo.price, active: combo.active === 1, created_at: combo.createdAt, updated_at: combo.updatedAt }; }
export const comboService = new ComboService();
