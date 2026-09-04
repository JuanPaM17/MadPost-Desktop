import { sessionContext } from "../../core/session/SessionContext";
import { auditService } from "../audit/AuditService";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { pendingDeletesRepository, syncQueueRepository } from "../../infrastructure/sqlite/repositories";

export type Category = { id: string; tenantId: string; name: string; sortOrder: number; showAdditions: number; showSauces: number; hidden: number; createdAt: string; updatedAt: string; productCount: number };

class CategoryService {
  private tenantId() { const tenantId = sessionContext.current()?.tenantId; if (!tenantId) throw new Error("No hay una sesion activa."); return tenantId; }
  async list() {
    const database = await databaseManager.database(); const tenantId = this.tenantId();
    const rows = await database.select<{ id: string; tenant_id: string; name: string; sort_order: number; show_additions: number; show_sauces: number; hidden: number; created_at: string; updated_at: string; product_count: number }[]>(`SELECT c.id, c.tenant_id, c.name, c.sort_order, c.show_additions, c.show_sauces, c.hidden, c.created_at, c.updated_at, COUNT(p.id) AS product_count
      FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.tenant_id = c.tenant_id WHERE c.tenant_id = $1
      GROUP BY c.id ORDER BY c.hidden, c.sort_order, c.name COLLATE NOCASE`, [tenantId]);
    return rows.map(mapCategory);
  }
  async save(existing: Category | null, values: { name: string; showAdditions: boolean; showSauces: boolean }, logChange = true) {
    const name = values.name.trim(); if (!name) throw new Error("El nombre de la categoria es obligatorio.");
    const database = await databaseManager.database(); const tenantId = this.tenantId(); const timestamp = new Date().toISOString();
    let sortOrder = existing?.sortOrder;
    if (sortOrder === undefined) { const rows = await database.select<{ next_order: number }[]>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM categories WHERE tenant_id = $1", [tenantId]); sortOrder = rows[0]?.next_order ?? 0; }
    const category: Category = existing ? { ...existing, name, showAdditions: values.showAdditions ? 1 : 0, showSauces: values.showSauces ? 1 : 0, updatedAt: timestamp } : { id: crypto.randomUUID(), tenantId, name, sortOrder, showAdditions: values.showAdditions ? 1 : 0, showSauces: values.showSauces ? 1 : 0, hidden: 0, createdAt: timestamp, updatedAt: timestamp, productCount: 0 };
    await database.execute(`INSERT INTO categories(id, tenant_id, name, sort_order, show_additions, show_sauces, hidden, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, show_additions=excluded.show_additions, show_sauces=excluded.show_sauces, hidden=excluded.hidden, updated_at=excluded.updated_at`, [category.id, category.tenantId, category.name, category.sortOrder, category.showAdditions, category.showSauces, category.hidden, category.createdAt, category.updatedAt]);
    await syncQueueRepository.enqueue("categories", category.id, "INSERT", payload(category));
    if (logChange) await auditService.log(existing ? "EDITAR_CATEGORIA" : "CREAR_CATEGORIA", "CATALOGO", `Categoria: ${category.name}`, category.id);
    return category;
  }
  async setHidden(category: Category, hidden: boolean) { const updated = await this.save({ ...category, hidden: hidden ? 1 : 0 }, { name: category.name, showAdditions: category.showAdditions === 1, showSauces: category.showSauces === 1 }, false); await auditService.log(hidden ? "DESACTIVAR_CATEGORIA" : "ACTIVAR_CATEGORIA", "CATALOGO", `Categoria: ${category.name}`, category.id); return updated; }
  async deletionCheck(categoryId: string) { const database = await databaseManager.database(); const rows = await database.select<{ total: number }[]>("SELECT COUNT(*) AS total FROM products WHERE category_id = $1 AND tenant_id = $2", [categoryId, this.tenantId()]); const productCount = rows[0]?.total ?? 0; return { canDelete: productCount === 0, productCount }; }
  async remove(category: Category) {
    const database = await databaseManager.database(); const tenantId = this.tenantId();
    await database.execute("UPDATE products SET category_id = NULL WHERE category_id = $1 AND tenant_id = $2", [category.id, tenantId]);
    await database.execute("DELETE FROM categories WHERE id = $1 AND tenant_id = $2", [category.id, tenantId]);
    await syncQueueRepository.clearForRecord("categories", category.id);
    await pendingDeletesRepository.enqueue("categories", category.id);
    await auditService.log("ELIMINAR_CATEGORIA", "CATALOGO", `Categoria: ${category.name}`, category.id);
  }
}
function mapCategory(row: { id: string; tenant_id: string; name: string; sort_order: number; show_additions: number; show_sauces: number; hidden: number; created_at: string; updated_at: string; product_count: number }): Category { return { id: row.id, tenantId: row.tenant_id, name: row.name, sortOrder: row.sort_order, showAdditions: row.show_additions, showSauces: row.show_sauces, hidden: row.hidden, createdAt: row.created_at, updatedAt: row.updated_at, productCount: row.product_count }; }
function payload(category: Category) { return { id: category.id, tenant_id: category.tenantId, name: category.name, sort_order: category.sortOrder, show_additions: category.showAdditions === 1, show_sauces: category.showSauces === 1, hidden: category.hidden === 1, created_at: category.createdAt, updated_at: category.updatedAt }; }
export const categoryService = new CategoryService();
