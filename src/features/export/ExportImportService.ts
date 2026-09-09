import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { hash as bcryptHash } from "bcryptjs";
import * as XLSX from "xlsx-js-style";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { sessionContext } from "../../core/session/SessionContext";
import { syncQueueRepository } from "../../infrastructure/sqlite/repositories";
import { excelService } from "./ExcelService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" }).replace(/-/g, "");
}

function tenantId(): string {
  const id = sessionContext.current()?.tenantId;
  if (!id) throw new Error("Sin sesion activa");
  return id;
}

// ---------------------------------------------------------------------------
// Export: Productos y Adiciones
// ---------------------------------------------------------------------------
export async function exportProductos(): Promise<boolean> {
  const db = await databaseManager.database();
  const tid = tenantId();

  const [categorias, productos, adiciones, insumos, insumosProd, combos, comboItems, opciones, salsas] = await Promise.all([
    db.select<Record<string, unknown>[]>("SELECT name AS Nombre, sort_order AS Orden FROM categories WHERE tenant_id=$1 ORDER BY sort_order, name COLLATE NOCASE", [tid]),
    db.select<Record<string, unknown>[]>(
      `SELECT p.name AS Nombre, COALESCE(c.name,'') AS Categoria, p.price AS Precio,
              p.stock AS "Stock Directo", CASE WHEN p.active=1 THEN 'Si' ELSE 'No' END AS Activo, COALESCE(p.description,'') AS Descripcion
       FROM products p LEFT JOIN categories c ON c.id=p.category_id
       WHERE p.tenant_id=$1 ORDER BY p.name COLLATE NOCASE`, [tid]),
    db.select<Record<string, unknown>[]>("SELECT name AS Nombre, price AS Precio, stock AS \"Stock Directo\", CASE WHEN active=1 THEN 'Si' ELSE 'No' END AS Activo FROM additions WHERE tenant_id=$1 ORDER BY name COLLATE NOCASE", [tid]),
    db.select<Record<string, unknown>[]>("SELECT name AS Nombre, unit AS Unidad, stock AS Stock_Actual, low_stock_threshold AS Umbral_Alerta FROM supplies WHERE tenant_id=$1 ORDER BY name COLLATE NOCASE", [tid]),
    db.select<Record<string, unknown>[]>(
      `SELECT p.name AS Producto, s.name AS Insumo, ps.quantity_per_sale AS Cantidad_Por_Venta
       FROM product_supplies ps JOIN products p ON p.id=ps.product_id JOIN supplies s ON s.id=ps.supply_id
       WHERE p.tenant_id=$1 ORDER BY p.name COLLATE NOCASE`, [tid]),
    db.select<Record<string, unknown>[]>("SELECT name AS Nombre, price AS Precio, CASE WHEN active=1 THEN 'Si' ELSE 'No' END AS Activo FROM combos WHERE tenant_id=$1 ORDER BY name COLLATE NOCASE", [tid]),
    db.select<Record<string, unknown>[]>(
      `SELECT c.name AS Combo, p.name AS Producto, ci.quantity AS Cantidad
       FROM combo_items ci JOIN combos c ON c.id=ci.combo_id JOIN products p ON p.id=ci.product_id
       WHERE c.tenant_id=$1 ORDER BY c.name COLLATE NOCASE`, [tid]),
    db.select<Record<string, unknown>[]>(
      `SELECT p.name AS Producto, po.name AS Opcion, po.sort_order AS Orden
       FROM product_options po JOIN products p ON p.id=po.product_id
       WHERE p.tenant_id=$1 AND po.active=1 ORDER BY p.name COLLATE NOCASE, po.sort_order`, [tid]),
    db.select<Record<string, unknown>[]>("SELECT name AS Nombre, CASE WHEN active=1 THEN 'Si' ELSE 'No' END AS Activo FROM sauces WHERE tenant_id=$1 ORDER BY name COLLATE NOCASE", [tid]),
  ]);

  return excelService.exportWorkbook(`productos_adiciones_${todayStr()}`, [
    { name: "Categorias", rows: categorias },
    { name: "Productos", rows: productos },
    { name: "Adiciones", rows: adiciones },
    { name: "Insumos", rows: insumos },
    { name: "Insumos_Productos", rows: insumosProd },
    { name: "Combos", rows: combos },
    { name: "Combos_Items", rows: comboItems },
    { name: "Opciones_Productos", rows: opciones },
    { name: "Salsas", rows: salsas },
  ]);
}

// ---------------------------------------------------------------------------
// Export: Historial de Pedidos
// ---------------------------------------------------------------------------
export async function exportHistorial(): Promise<boolean> {
  const db = await databaseManager.database();
  const tid = tenantId();

  const pedidos = await db.select<Record<string, unknown>[]>(
    `SELECT s.invoice_number AS Factura,
            strftime('%d/%m/%Y %H:%M', s.created_at, 'localtime') AS Fecha,
            COALESCE(u.display_name, u.username, 'Desconocido') AS Vendedor,
            cs.session_number AS "Caja #",
            s.payment_method AS "Metodo Pago",
            COALESCE(s.subtotal, '') AS Subtotal,
            COALESCE(s.discount_type, '') AS "Descuento Tipo",
            COALESCE(s.discount_value, '') AS "Descuento Valor",
            s.total AS Total,
            COALESCE(s.cash_given, '') AS "Efectivo Recibido",
            COALESCE(s.change_given, '') AS Cambio,
            COALESCE(s.cash_amount, '') AS "Monto Efectivo",
            COALESCE(s.card_amount, '') AS "Monto Tarjeta",
            CASE WHEN s.is_delivery=1 THEN 'Si' ELSE 'No' END AS Domicilio,
            COALESCE(s.delivery_price, '') AS "Precio Domicilio",
            COALESCE(s.client_name, '') AS Cliente,
            COALESCE(s.notes, '') AS Notas
     FROM sales s
     LEFT JOIN users u ON s.user_id = u.id
     LEFT JOIN cash_sessions cs ON s.cash_session_id = cs.id
     WHERE s.tenant_id=$1
     ORDER BY s.created_at DESC`, [tid]);

  const detalle = await db.select<Record<string, unknown>[]>(
    `SELECT s.invoice_number AS Factura,
            si.product_name AS Producto,
            COALESCE(si.selected_option, '') AS Opcion,
            si.quantity AS Cantidad,
            si.unit_price AS Precio_Unitario,
            COALESCE(GROUP_CONCAT(sia.addition_name || CASE WHEN sia.quantity > 1 THEN ' x' || sia.quantity ELSE '' END, ', '), '') AS Adiciones,
            COALESCE(si.notes, '') AS Notas,
            si.subtotal AS Subtotal
     FROM sale_items si
     JOIN sales s ON si.sale_id = s.id
     LEFT JOIN sale_item_additions sia ON sia.sale_item_id = si.id
     WHERE s.tenant_id=$1 AND si.combo_sale_item_id IS NULL
     GROUP BY si.id
     ORDER BY s.created_at DESC, si.id`, [tid]);

  return excelService.exportWorkbook(`historial_pedidos_${todayStr()}`, [
    { name: "Pedidos", rows: pedidos },
    { name: "Detalle_Pedidos", rows: detalle },
  ]);
}

// ---------------------------------------------------------------------------
// Export: Cajas Registradoras
// ---------------------------------------------------------------------------
export async function exportCajas(): Promise<boolean> {
  const db = await databaseManager.database();
  const tid = tenantId();

  const cajas = await db.select<Record<string, unknown>[]>(
    `SELECT cs.session_number AS Caja,
            CASE WHEN cs.status='OPEN' THEN 'Abierta' ELSE 'Cerrada' END AS Estado,
            strftime('%d/%m/%Y %H:%M', cs.opened_at, 'localtime') AS Fecha_Apertura,
            COALESCE(strftime('%d/%m/%Y %H:%M', cs.closed_at, 'localtime'), '') AS Fecha_Cierre,
            COALESCE(u.display_name, u.username, 'Desconocido') AS Vendedor,
            COALESCE(cs.opening_amount, 0) AS Monto_Inicial,
            COALESCE(cs.expected_amount, 0) AS Monto_Esperado,
            COALESCE(cs.actual_amount, 0) AS Monto_Real,
            COALESCE(cs.actual_amount, 0) - COALESCE(cs.expected_amount, 0) AS Diferencia,
            COALESCE(SUM(s.total), 0) AS Total_Ventas,
            COUNT(s.id) AS Num_Pedidos
     FROM cash_sessions cs
     LEFT JOIN users u ON cs.user_id = u.id
     LEFT JOIN sales s ON s.cash_session_id = cs.id
     WHERE cs.tenant_id=$1
     GROUP BY cs.id
     ORDER BY cs.session_number DESC`, [tid]);

  return excelService.exportWorkbook(`cajas_${todayStr()}`, [
    { name: "Cajas", rows: cajas },
  ]);
}

// ---------------------------------------------------------------------------
// Export: Usuarios (solo admin)
// ---------------------------------------------------------------------------
export async function exportUsuarios(): Promise<boolean> {
  const db = await databaseManager.database();
  const tid = tenantId();

  const usuarios = await db.select<Record<string, unknown>[]>(
    `SELECT id AS ID, username AS Usuario,
            COALESCE(display_name, '') AS Nombre_Display,
            CASE WHEN role='ADMIN' THEN 'Administrador' WHEN role='SUPERADMIN' THEN 'Superadministrador' ELSE 'Vendedor' END AS Rol,
            CASE WHEN active=1 THEN 'Si' ELSE 'No' END AS Activo
     FROM users WHERE tenant_id=$1 ORDER BY username COLLATE NOCASE`, [tid]);

  return excelService.exportWorkbook(`usuarios_${todayStr()}`, [
    { name: "Usuarios", rows: usuarios },
  ]);
}

// ---------------------------------------------------------------------------
// Import: Productos y Adiciones
// ---------------------------------------------------------------------------
export type ImportResult = { created: number; updated: number; errors: string[] };

export async function importProductos(): Promise<ImportResult | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Archivo de Excel", extensions: ["xlsx", "xls"] }],
  });
  if (!selected || Array.isArray(selected)) return null;

  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(selected);
  const workbook = XLSX.read(bytes, { type: "array" });

  const db = await databaseManager.database();
  const tid = tenantId();
  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  function sheetRows<T = Record<string, unknown>>(name: string): T[] {
    const ws = workbook.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json<T>(ws, { defval: null });
  }

  // 1. Categorias
  const catRows = sheetRows<{ Nombre?: string; Orden?: number }>("Categorias");
  const catIdByName = new Map<string, string>();
  for (const row of catRows) {
    const name = row.Nombre?.toString().trim();
    if (!name) continue;
    try {
      const existing = await db.select<{ id: string }[]>("SELECT id FROM categories WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [tid, name]);
      if (existing[0]) {
        await db.execute("UPDATE categories SET sort_order=$1, updated_at=$2 WHERE id=$3", [row.Orden ?? 0, now, existing[0].id]);
        catIdByName.set(name.toLowerCase(), existing[0].id);
        updated++;
      } else {
        const id = crypto.randomUUID();
        await db.execute("INSERT INTO categories(id,tenant_id,name,sort_order,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)", [id, tid, name, row.Orden ?? 0, now]);
        catIdByName.set(name.toLowerCase(), id);
        created++;
      }
    } catch (e) { errors.push(`Categoria '${name}': ${String(e)}`); }
  }

  // 2. Productos
  const prodRows = sheetRows<{ Nombre?: string; Categoria?: string; Precio?: number; "Stock Directo"?: number; Activo?: string; Descripcion?: string }>("Productos");
  const prodIdByName = new Map<string, string>();
  for (const row of prodRows) {
    const name = row.Nombre?.toString().trim();
    if (!name) continue;
    try {
      const catId = row.Categoria ? (catIdByName.get(row.Categoria.toString().toLowerCase()) ?? null) : null;
      const active = row.Activo?.toString().toLowerCase() !== "no" ? 1 : 0;
      const stock = row["Stock Directo"] ?? null;
      const existing = await db.select<{ id: string }[]>("SELECT id FROM products WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [tid, name]);
      if (existing[0]) {
        await db.execute("UPDATE products SET category_id=$1,price=$2,stock=$3,active=$4,description=$5,updated_at=$6 WHERE id=$7",
          [catId, Number(row.Precio ?? 0), stock, active, row.Descripcion || null, now, existing[0].id]);
        prodIdByName.set(name.toLowerCase(), existing[0].id);
        updated++;
      } else {
        const id = crypto.randomUUID();
        await db.execute("INSERT INTO products(id,tenant_id,name,category_id,price,stock,active,description,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)",
          [id, tid, name, catId, Number(row.Precio ?? 0), stock, active, row.Descripcion || null, now]);
        prodIdByName.set(name.toLowerCase(), id);
        created++;
      }
    } catch (e) { errors.push(`Producto '${name}': ${String(e)}`); }
  }

  // 3. Adiciones
  const addRows = sheetRows<{ Nombre?: string; Precio?: number; "Stock Directo"?: number; Activo?: string }>("Adiciones");
  for (const row of addRows) {
    const name = row.Nombre?.toString().trim();
    if (!name) continue;
    try {
      const active = row.Activo?.toString().toLowerCase() !== "no" ? 1 : 0;
      const stock = row["Stock Directo"] ?? null;
      const existing = await db.select<{ id: string }[]>("SELECT id FROM additions WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [tid, name]);
      if (existing[0]) {
        await db.execute("UPDATE additions SET price=$1,stock=$2,active=$3,updated_at=$4 WHERE id=$5", [Number(row.Precio ?? 0), stock, active, now, existing[0].id]);
        updated++;
      } else {
        await db.execute("INSERT INTO additions(id,tenant_id,name,price,stock,active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)", [crypto.randomUUID(), tid, name, Number(row.Precio ?? 0), stock, active, now]);
        created++;
      }
    } catch (e) { errors.push(`Adicion '${name}': ${String(e)}`); }
  }

  // 4. Insumos
  const insRows = sheetRows<{ Nombre?: string; Unidad?: string; Stock_Actual?: number; Umbral_Alerta?: number }>("Insumos");
  const insIdByName = new Map<string, string>();
  for (const row of insRows) {
    const name = row.Nombre?.toString().trim();
    if (!name) continue;
    try {
      const existing = await db.select<{ id: string }[]>("SELECT id FROM supplies WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [tid, name]);
      if (existing[0]) {
        await db.execute("UPDATE supplies SET unit=$1,stock=$2,low_stock_threshold=$3,updated_at=$4 WHERE id=$5", [row.Unidad || null, row.Stock_Actual ?? null, row.Umbral_Alerta ?? null, now, existing[0].id]);
        insIdByName.set(name.toLowerCase(), existing[0].id);
        updated++;
      } else {
        const id = crypto.randomUUID();
        await db.execute("INSERT INTO supplies(id,tenant_id,name,unit,stock,low_stock_threshold,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)", [id, tid, name, row.Unidad || null, row.Stock_Actual ?? null, row.Umbral_Alerta ?? null, now]);
        insIdByName.set(name.toLowerCase(), id);
        created++;
      }
    } catch (e) { errors.push(`Insumo '${name}': ${String(e)}`); }
  }

  // 5. Insumos_Productos
  const insProdRows = sheetRows<{ Producto?: string; Insumo?: string; Cantidad_Por_Venta?: number }>("Insumos_Productos");
  for (const row of insProdRows) {
    const prodName = row.Producto?.toString().trim();
    const insName = row.Insumo?.toString().trim();
    if (!prodName || !insName) continue;
    try {
      const prodId = prodIdByName.get(prodName.toLowerCase());
      const insId = insIdByName.get(insName.toLowerCase());
      if (!prodId || !insId) { errors.push(`Insumo_Producto '${prodName}/${insName}': producto o insumo no encontrado`); continue; }
      const existing = await db.select<{ id: string }[]>("SELECT id FROM product_supplies WHERE product_id=$1 AND supply_id=$2", [prodId, insId]);
      if (existing[0]) {
        await db.execute("UPDATE product_supplies SET quantity_per_sale=$1 WHERE id=$2", [Number(row.Cantidad_Por_Venta ?? 1), existing[0].id]);
        updated++;
      } else {
        await db.execute("INSERT INTO product_supplies(id,product_id,supply_id,quantity_per_sale) VALUES($1,$2,$3,$4)", [crypto.randomUUID(), prodId, insId, Number(row.Cantidad_Por_Venta ?? 1)]);
        created++;
      }
    } catch (e) { errors.push(`Insumo_Producto '${prodName}/${insName}': ${String(e)}`); }
  }

  // 6. Salsas
  const salsaRows = sheetRows<{ Nombre?: string; Activo?: string }>("Salsas");
  for (const row of salsaRows) {
    const name = row.Nombre?.toString().trim();
    if (!name) continue;
    try {
      const active = row.Activo?.toString().toLowerCase() !== "no" ? 1 : 0;
      const existing = await db.select<{ id: string }[]>("SELECT id FROM sauces WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [tid, name]);
      if (existing[0]) {
        await db.execute("UPDATE sauces SET active=$1,updated_at=$2 WHERE id=$3", [active, now, existing[0].id]);
        updated++;
      } else {
        await db.execute("INSERT INTO sauces(id,tenant_id,name,active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)", [crypto.randomUUID(), tid, name, active, now]);
        created++;
      }
    } catch (e) { errors.push(`Salsa '${name}': ${String(e)}`); }
  }

  // 7. Opciones_Productos
  const opRows = sheetRows<{ Producto?: string; Opcion?: string; Orden?: number }>("Opciones_Productos");
  for (const row of opRows) {
    const prodName = row.Producto?.toString().trim();
    const opName = row.Opcion?.toString().trim();
    if (!prodName || !opName) continue;
    try {
      const prodId = prodIdByName.get(prodName.toLowerCase());
      if (!prodId) { errors.push(`Opcion '${prodName}/${opName}': producto no encontrado`); continue; }
      const existing = await db.select<{ id: string }[]>("SELECT id FROM product_options WHERE product_id=$1 AND LOWER(name)=LOWER($2)", [prodId, opName]);
      if (existing[0]) {
        await db.execute("UPDATE product_options SET sort_order=$1 WHERE id=$2", [row.Orden ?? 0, existing[0].id]);
        updated++;
      } else {
        await db.execute("INSERT INTO product_options(id,product_id,name,sort_order,active,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5,$5)", [crypto.randomUUID(), prodId, opName, row.Orden ?? 0, now]);
        created++;
      }
    } catch (e) { errors.push(`Opcion '${prodName}/${opName}': ${String(e)}`); }
  }

  // 8. Combos
  const comboRows = sheetRows<{ Nombre?: string; Precio?: number; Activo?: string }>("Combos");
  const comboItemRows = sheetRows<{ Combo?: string; Producto?: string; Cantidad?: number }>("Combos_Items");
  for (const row of comboRows) {
    const name = row.Nombre?.toString().trim();
    if (!name) continue;
    try {
      const active = row.Activo?.toString().toLowerCase() !== "no" ? 1 : 0;
      const existing = await db.select<{ id: string }[]>("SELECT id FROM combos WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [tid, name]);
      const comboId = existing[0]?.id ?? crypto.randomUUID();
      if (existing[0]) {
        await db.execute("UPDATE combos SET price=$1,active=$2,updated_at=$3 WHERE id=$4", [Number(row.Precio ?? 0), active, now, comboId]);
        updated++;
      } else {
        await db.execute("INSERT INTO combos(id,tenant_id,name,price,active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)", [comboId, tid, name, Number(row.Precio ?? 0), active, now]);
        created++;
      }
      // Items del combo
      const items = comboItemRows.filter((r) => r.Combo?.toString().trim().toLowerCase() === name.toLowerCase());
      await db.execute("DELETE FROM combo_items WHERE combo_id=$1", [comboId]);
      for (const item of items) {
        const pName = item.Producto?.toString().trim();
        if (!pName) continue;
        const prodId = prodIdByName.get(pName.toLowerCase());
        if (!prodId) { errors.push(`Combo item '${name}/${pName}': producto no encontrado`); continue; }
        await db.execute("INSERT INTO combo_items(id,combo_id,product_id,quantity) VALUES($1,$2,$3,$4)", [crypto.randomUUID(), comboId, prodId, Number(item.Cantidad ?? 1)]);
      }
    } catch (e) { errors.push(`Combo '${name}': ${String(e)}`); }
  }

  return { created, updated, errors };
}

// ---------------------------------------------------------------------------
// Import: Usuarios (solo admin)
// ---------------------------------------------------------------------------
export async function importUsuarios(): Promise<ImportResult | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Archivo de Excel", extensions: ["xlsx", "xls"] }],
  });
  if (!selected || Array.isArray(selected)) return null;

  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(selected);
  const workbook = XLSX.read(bytes, { type: "array" });
  const ws = workbook.Sheets["Usuarios"];
  if (!ws) return { created: 0, updated: 0, errors: ["La hoja 'Usuarios' no fue encontrada en el archivo."] };

  const rows = XLSX.utils.sheet_to_json<{ Usuario?: string; Nombre_Display?: string; Rol?: string; Activo?: string; ID?: string }>(ws, { defval: null });
  const db = await databaseManager.database();
  const tid = tenantId();
  const now = new Date().toISOString();
  let created = 0;
  const errors: string[] = [];

  const defaultHash = await bcryptHash("madpost123", 12);

  for (const row of rows) {
    const username = row.Usuario?.toString().trim().toLowerCase();
    if (!username) continue;
    try {
      const rolRaw = row.Rol?.toString().toLowerCase() ?? "";
      const role = rolRaw.includes("admin") ? "ADMIN" : "SELLER";
      const active = row.Activo?.toString().toLowerCase() === "no" ? 0 : 1;
      const displayName = row.Nombre_Display?.toString().trim() || null;
      const existing = await db.select<{ id: string }[]>("SELECT id FROM users WHERE tenant_id=$1 AND LOWER(username)=LOWER($2)", [tid, username]);
      if (existing[0]) continue; // ya existe, no se actualiza
      const userId = crypto.randomUUID();
      const user = { id: userId, tenant_id: tid, username, password_hash: defaultHash, display_name: displayName, role, active };
      await db.execute("INSERT INTO users(id,tenant_id,username,password_hash,display_name,role,active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)",
        [userId, tid, username, defaultHash, displayName, role, active, now]);
      await syncQueueRepository.ensureUserInsert(userId, user);
      created++;
    } catch (e) { errors.push(`Usuario '${username}': ${String(e)}`); }
  }

  return { created, updated: 0, errors };
}

// ---------------------------------------------------------------------------
// Backup local (.db)
// ---------------------------------------------------------------------------
export async function exportBackupDb(): Promise<boolean> {
  const destination = await save({
    defaultPath: `madpost_backup_${todayStr()}.db`,
    filters: [{ name: "Base de datos SQLite", extensions: ["db"] }],
  });
  if (!destination) return false;
  await invoke("export_db_backup", { destPath: destination });
  return true;
}

export async function importBackupDb(): Promise<boolean> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Base de datos SQLite", extensions: ["db"] }],
  });
  if (!selected || Array.isArray(selected)) return false;
  await invoke("restore_db_backup", { srcPath: selected });
  return true;
}
