import { sessionContext } from "../../core/session/SessionContext";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";

export type PosCategory = { id: string; name: string };
export type PosProduct = { id: string; name: string; description: string | null; price: number; originalPrice: number; categoryId: string | null; showAdditions: boolean; showSauces: boolean; stock: number | null; options: string[] };
export type PosAddition = { id: string; name: string; price: number; stock: number | null };
export type PosSauce = { id: string; name: string };
export type PosComboItem = { productId: string; name: string; quantity: number; showAdditions: boolean; showSauces: boolean; options: string[] };
export type PosCombo = { id: string; name: string; price: number; items: PosComboItem[] };

class PosService {
  private tenantId() {
    const tenantId = sessionContext.current()?.tenantId;
    if (!tenantId) throw new Error("No hay una sesion activa.");
    return tenantId;
  }

  async categories(): Promise<PosCategory[]> {
    const database = await databaseManager.database();
    return database.select<PosCategory[]>(
      "SELECT id, name FROM categories WHERE tenant_id=$1 AND COALESCE(hidden,0)=0 ORDER BY sort_order, name COLLATE NOCASE",
      [this.tenantId()],
    );
  }

  async products(categoryId: string | null): Promise<PosProduct[]> {
    const database = await databaseManager.database();
    const rows = await database.select<{ id: string; name: string; description: string | null; price: number; category_id: string | null; show_additions: number | null; show_sauces: number | null; stock: number | null; discount_type: "PERCENT" | "FIXED_PRICE" | null; discount_value: number | null }[]>(
      `SELECT p.id, p.name, p.description, p.price, p.category_id, c.show_additions, c.show_sauces, p.stock, d.discount_type, d.discount_value FROM products p
       LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN discounts d ON d.product_id=p.id AND d.tenant_id=p.tenant_id AND d.active=1 AND (d.start_date IS NULL OR d.start_date <= $3) AND (d.end_date IS NULL OR d.end_date >= $3)
       WHERE p.tenant_id=$1 AND p.active=1 AND ($2 IS NULL OR p.category_id=$2)
       ORDER BY p.name COLLATE NOCASE`,
      [this.tenantId(), categoryId, new Date().toISOString()],
    );
    const optionRows = await database.select<{ product_id: string; name: string }[]>("SELECT po.product_id, po.name FROM product_options po JOIN products p ON p.id=po.product_id WHERE p.tenant_id=$1 AND po.active=1 ORDER BY po.sort_order", [this.tenantId()]);
    const options = new Map<string, string[]>();
    for (const row of optionRows) options.set(row.product_id, [...(options.get(row.product_id) ?? []), row.name]);
    return rows.map((row) => { const originalPrice = Number(row.price ?? 0); const price = row.discount_type === "FIXED_PRICE" ? Number(row.discount_value) : row.discount_type === "PERCENT" ? originalPrice * (1 - Number(row.discount_value ?? 0) / 100) : originalPrice; return { id: row.id, name: row.name, description: row.description, price, originalPrice, categoryId: row.category_id, showAdditions: row.show_additions === 1, showSauces: row.show_sauces === 1, stock: row.stock === null ? null : Number(row.stock), options: options.get(row.id) ?? [] }; });
  }

  async additions(): Promise<PosAddition[]> {
    const database = await databaseManager.database();
    const rows = await database.select<{ id: string; name: string; price: number; stock: number | null }[]>("SELECT id, name, price, stock FROM additions WHERE tenant_id=$1 AND active=1 ORDER BY name COLLATE NOCASE", [this.tenantId()]);
    return rows.map((row) => ({ id: row.id, name: row.name, price: Number(row.price ?? 0), stock: row.stock === null ? null : Number(row.stock) }));
  }

  async sauces(): Promise<{ items: PosSauce[]; max: number }> { const database = await databaseManager.database(); const [items, config] = await Promise.all([database.select<PosSauce[]>("SELECT id, name FROM sauces WHERE tenant_id=$1 AND active=1 ORDER BY name COLLATE NOCASE", [this.tenantId()]), database.select<{ max_sauces: number | null }[]>("SELECT max_sauces FROM tenants WHERE id=$1", [this.tenantId()])]); return { items, max: Math.max(1, Number(config[0]?.max_sauces ?? 3)) }; }

  async combos(): Promise<PosCombo[]> {
    const database = await databaseManager.database();
    const rows = await database.select<{ id: string; name: string; price: number }[]>(
      "SELECT id, name, price FROM combos WHERE tenant_id=$1 AND active=1 ORDER BY name COLLATE NOCASE",
      [this.tenantId()],
    );
    const itemRows = await database.select<{ combo_id: string; product_id: string; name: string; quantity: number; show_additions: number | null; show_sauces: number | null }[]>("SELECT ci.combo_id, ci.product_id, p.name, ci.quantity, c2.show_additions, c2.show_sauces FROM combo_items ci JOIN products p ON p.id=ci.product_id JOIN combos c ON c.id=ci.combo_id LEFT JOIN categories c2 ON c2.id=p.category_id WHERE c.tenant_id=$1", [this.tenantId()]);
    const optionsRows = await database.select<{ product_id: string; name: string }[]>("SELECT po.product_id, po.name FROM product_options po JOIN products p ON p.id=po.product_id WHERE p.tenant_id=$1 AND po.active=1", [this.tenantId()]);
    const options = new Map<string, string[]>(); for (const row of optionsRows) options.set(row.product_id, [...(options.get(row.product_id) ?? []), row.name]);
    return rows.map((row) => ({ ...row, price: Number(row.price ?? 0), items: itemRows.filter((item) => item.combo_id === row.id).map((item) => ({ productId: item.product_id, name: item.name, quantity: Number(item.quantity), showAdditions: item.show_additions === 1, showSauces: item.show_sauces === 1, options: options.get(item.product_id) ?? [] })) }));
  }
}

export const posService = new PosService();
