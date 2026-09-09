import { invoke } from "@tauri-apps/api/core";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { sessionContext } from "../../core/session/SessionContext";
import type { TableOrderItem } from "./TableOrderService";

export type ComandaItem = {
  id: string;
  comanda_id: string;
  product_name: string;
  quantity: number;
  additions_text: string | null;
  sauces_text: string | null;
  notes: string | null;
  selected_option: string | null;
  category_name: string | null;
  subtotal: number;
  combo_parent_id: string | null;
};

export type Comanda = {
  id: string;
  table_order_id: string;
  table_name: string;
  comanda_number: number;
  created_at: string;
  client_id: string | null;
  client_name: string | null;
  customer_notes: string | null;
  is_delivery: number;
  delivery_price: number | null;
  items: ComandaItem[];
};

const uuid = () => crypto.randomUUID();
const instantNow = () => new Date().toISOString();

function buildAdditionsText(additions: { name: string; quantity: number }[]): string | null {
  if (!additions.length) return null;
  return additions.map((a) => (a.quantity > 1 ? `x${a.quantity} ${a.name}` : a.name)).join(", ");
}

function buildSaucesText(sauces: { name: string }[]): string | null {
  if (!sauces.length) return null;
  return sauces.map((s) => s.name).join(", ");
}

export const comandaService = {
  async getLastComandaTime(tableOrderId: string): Promise<string | null> {
    const db = await databaseManager.database();
    const rows = await db.select<{ t: string | null }[]>(
      "SELECT MAX(created_at) AS t FROM comandas WHERE table_order_id = $1",
      [tableOrderId],
    );
    return rows[0]?.t ?? null;
  },

  async hasComanda(tableOrderId: string): Promise<boolean> {
    const db = await databaseManager.database();
    const rows = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM comandas WHERE table_order_id = $1",
      [tableOrderId],
    );
    return (rows[0]?.n ?? 0) > 0;
  },

  async getAllComandas(tableOrderId: string): Promise<Comanda[]> {
    const db = await databaseManager.database();
    const rows = await db.select<Omit<Comanda, "items">[]>(
      "SELECT id, table_order_id, table_name, comanda_number, created_at, client_id, client_name, customer_notes, is_delivery, delivery_price FROM comandas WHERE table_order_id = $1 ORDER BY comanda_number ASC",
      [tableOrderId],
    );
    const result: Comanda[] = [];
    for (const row of rows) {
      const items = await db.select<ComandaItem[]>(
        "SELECT id, comanda_id, product_name, quantity, additions_text, sauces_text, notes, selected_option, category_name, subtotal, combo_parent_id FROM comanda_items WHERE comanda_id = $1 ORDER BY rowid ASC",
        [row.id],
      );
      result.push({ ...row, items });
    }
    return result;
  },

  async getItemsForComanda(
    tableOrderId: string,
    since: string | null,
    clientId: string | null,
  ): Promise<TableOrderItem[]> {
    const db = await databaseManager.database();
    let query: string;
    const params: unknown[] = [tableOrderId];

    if (since) {
      query = `SELECT i.id, i.table_order_id, i.product_id, i.product_name, i.quantity, i.unit_price, i.subtotal,
               i.selected_option, i.combo_id, i.combo_table_order_item_id, i.table_order_client_id,
               i.notes, i.original_unit_price, i.added_at, i.updated_at
               FROM table_order_items i
               WHERE i.table_order_id = $1
                 AND (i.table_order_client_id IS NULL OR i.table_order_client_id NOT IN (
                   SELECT id FROM table_order_clients WHERE table_order_id = $1 AND status = 'CANCELLED'
                 ))
                 AND COALESCE(i.updated_at, i.added_at) > $2
               ORDER BY COALESCE(i.updated_at, i.added_at) ASC`;
      params.push(since);
    } else {
      query = `SELECT i.id, i.table_order_id, i.product_id, i.product_name, i.quantity, i.unit_price, i.subtotal,
               i.selected_option, i.combo_id, i.combo_table_order_item_id, i.table_order_client_id,
               i.notes, i.original_unit_price, i.added_at, i.updated_at
               FROM table_order_items i
               WHERE i.table_order_id = $1
                 AND (i.table_order_client_id IS NULL OR i.table_order_client_id NOT IN (
                   SELECT id FROM table_order_clients WHERE table_order_id = $1 AND status = 'CANCELLED'
                 ))
               ORDER BY i.rowid ASC`;
    }

    const rows = await db.select<(Omit<TableOrderItem, "additions" | "sauces"> & { added_at: string; updated_at: string | null })[]>(query, params);

    // Si hay clientId, filtrar solo items de ese cliente (incluyendo hijos de combo que le pertenezcan transitivamente)
    const filtered = clientId ? rows.filter((r) => r.table_order_client_id === clientId || r.combo_table_order_item_id !== null) : rows;

    const items: TableOrderItem[] = [];
    for (const row of filtered) {
      const [additions, sauces] = await Promise.all([
        db.select<{ name: string; quantity: number; price: number }[]>(
          "SELECT addition_name AS name, quantity, price FROM table_order_item_additions WHERE table_order_item_id = $1",
          [row.id],
        ),
        db.select<{ name: string }[]>(
          "SELECT sauce_name AS name FROM table_order_item_sauces WHERE table_order_item_id = $1",
          [row.id],
        ),
      ]);
      items.push({ ...row, additions, sauces });
    }
    return items;
  },

  async generateComanda(params: {
    tableOrderId: string;
    tableName: string;
    clientId: string | null;
    clientName: string | null;
    customerNotes: string | null;
    isDelivery: boolean;
    deliveryPrice: number | null;
  }): Promise<Comanda | null> {
    const db = await databaseManager.database();
    const tenantId = sessionContext.current()?.tenantId ?? "";

    const lastTime = await this.getLastComandaTime(params.tableOrderId);
    const allItems = await this.getItemsForComanda(params.tableOrderId, lastTime, params.clientId);

    // Solo items raiz para determinar si hay algo nuevo
    const rootItems = allItems.filter((i) => !i.combo_table_order_item_id);
    if (!rootItems.length) return null;

    const comandaId = uuid();
    const now = instantNow();

    const countRows = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM comandas WHERE table_order_id = $1",
      [params.tableOrderId],
    );
    const comandaNumber = (countRows[0]?.n ?? 0) + 1;

    await db.execute(
      `INSERT INTO comandas(id, tenant_id, table_order_id, table_name, comanda_number, created_at,
        client_id, client_name, customer_notes, is_delivery, delivery_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [comandaId, tenantId, params.tableOrderId, params.tableName, comandaNumber, now,
        params.clientId, params.clientName, params.customerNotes,
        params.isDelivery ? 1 : 0, params.deliveryPrice],
    );

    // Marcar comanda_sent en la orden
    await db.execute("UPDATE table_orders SET comanda_sent=1 WHERE id=$1", [params.tableOrderId]);

    const savedItems = await this.saveComandaItems(db, comandaId, allItems);

    return {
      id: comandaId,
      table_order_id: params.tableOrderId,
      table_name: params.tableName,
      comanda_number: comandaNumber,
      created_at: now,
      client_id: params.clientId,
      client_name: params.clientName,
      customer_notes: params.customerNotes,
      is_delivery: params.isDelivery ? 1 : 0,
      delivery_price: params.deliveryPrice,
      items: savedItems,
    };
  },

  async buildFullOrderComanda(params: {
    tableOrderId: string;
    tableName: string;
    clientId: string | null;
    clientName: string | null;
    customerNotes: string | null;
    isDelivery: boolean;
    deliveryPrice: number | null;
  }): Promise<Comanda | null> {
    const db = await databaseManager.database();
    const allItems = await this.getItemsForComanda(params.tableOrderId, null, params.clientId);
    const rootItems = allItems.filter((i) => !i.combo_table_order_item_id);
    if (!rootItems.length) return null;

    const tmpId = uuid();
    const items = await this.saveComandaItems(db, tmpId, allItems);
    // Borrar inmediatamente — comanda transitoria, no queda en BD
    await db.execute("DELETE FROM comanda_items WHERE comanda_id=$1", [tmpId]);

    return {
      id: tmpId,
      table_order_id: params.tableOrderId,
      table_name: params.tableName,
      comanda_number: 0,
      created_at: instantNow(),
      client_id: params.clientId,
      client_name: params.clientName,
      customer_notes: params.customerNotes,
      is_delivery: params.isDelivery ? 1 : 0,
      delivery_price: params.deliveryPrice,
      items,
    };
  },

  async saveComandaItems(
    db: Awaited<ReturnType<typeof databaseManager.database>>,
    comandaId: string,
    items: TableOrderItem[],
  ): Promise<ComandaItem[]> {
    const result: ComandaItem[] = [];
    // Mapear id de item de mesa → id de comanda_item (para combos)
    const idMap = new Map<string, string>();

    const roots = items.filter((i) => !i.combo_table_order_item_id);
    const children = items.filter((i) => !!i.combo_table_order_item_id);

    for (const item of roots) {
      const cid = uuid();
      idMap.set(item.id, cid);
      const addText = buildAdditionsText(item.additions);
      const sacText = buildSaucesText(item.sauces);
      await db.execute(
        `INSERT INTO comanda_items(id, comanda_id, product_name, quantity, additions_text, sauces_text,
          notes, selected_option, category_name, subtotal, combo_parent_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)`,
        [cid, comandaId, item.product_name, item.quantity, addText, sacText,
          item.notes, item.selected_option, null, item.subtotal],
      );
      result.push({ id: cid, comanda_id: comandaId, product_name: item.product_name, quantity: item.quantity,
        additions_text: addText, sauces_text: sacText, notes: item.notes, selected_option: item.selected_option,
        category_name: null, subtotal: item.subtotal, combo_parent_id: null });
    }

    for (const child of children) {
      const cid = uuid();
      const parentCid = child.combo_table_order_item_id ? (idMap.get(child.combo_table_order_item_id) ?? null) : null;
      const addText = buildAdditionsText(child.additions);
      const sacText = buildSaucesText(child.sauces);
      await db.execute(
        `INSERT INTO comanda_items(id, comanda_id, product_name, quantity, additions_text, sauces_text,
          notes, selected_option, category_name, subtotal, combo_parent_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [cid, comandaId, child.product_name, child.quantity, addText, sacText,
          child.notes, child.selected_option, null, child.subtotal, parentCid],
      );
      result.push({ id: cid, comanda_id: comandaId, product_name: child.product_name, quantity: child.quantity,
        additions_text: addText, sauces_text: sacText, notes: child.notes, selected_option: child.selected_option,
        category_name: null, subtotal: child.subtotal, combo_parent_id: parentCid });
    }

    return result;
  },

  async printComanda(
    comanda: Comanda,
    printerName: string,
    copies: number,
    allClients: { id: string; client_name: string | null; client_number: number }[],
  ): Promise<void> {
    const lines = buildComandaLines(comanda, allClients);
    if (import.meta.env.DEV) {
      devComandaPreviewCallback?.(lines);
      return;
    }
    for (let i = 0; i < Math.max(1, copies); i++) {
      await invoke("print_comanda", { printerName, lines });
    }
  },

  async hasChangedItemsSince(tableOrderId: string): Promise<boolean> {
    const lastTime = await this.getLastComandaTime(tableOrderId);
    if (!lastTime) return false;
    const db = await databaseManager.database();
    const rows = await db.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM table_order_items i
       WHERE i.table_order_id = $1
         AND (i.table_order_client_id IS NULL OR i.table_order_client_id NOT IN (
           SELECT id FROM table_order_clients WHERE table_order_id = $1 AND status = 'CANCELLED'
         ))
         AND COALESCE(i.updated_at, i.added_at) > $2`,
      [tableOrderId, lastTime],
    );
    return (rows[0]?.n ?? 0) > 0;
  },

  async buildChangedItemsComanda(params: {
    tableOrderId: string;
    tableName: string;
    clientId: string | null;
    clientName: string | null;
    customerNotes: string | null;
    isDelivery: boolean;
    deliveryPrice: number | null;
  }): Promise<Comanda | null> {
    const lastTime = await this.getLastComandaTime(params.tableOrderId);
    if (!lastTime) return null;
    const db = await databaseManager.database();
    const allItems = await this.getItemsForComanda(params.tableOrderId, lastTime, params.clientId);
    const rootItems = allItems.filter((i) => !i.combo_table_order_item_id);
    if (!rootItems.length) return null;

    const tmpId = uuid();
    const items = await this.saveComandaItems(db, tmpId, allItems);
    await db.execute("DELETE FROM comanda_items WHERE comanda_id=$1", [tmpId]);

    return {
      id: tmpId,
      table_order_id: params.tableOrderId,
      table_name: params.tableName,
      comanda_number: 0,
      created_at: instantNow(),
      client_id: params.clientId,
      client_name: params.clientName,
      customer_notes: params.customerNotes,
      is_delivery: params.isDelivery ? 1 : 0,
      delivery_price: params.deliveryPrice,
      items,
    };
  },
};

let devComandaPreviewCallback: ((lines: string[]) => void) | undefined;
export function setDevComandaPreviewCallback(cb: (lines: string[]) => void) {
  devComandaPreviewCallback = cb;
}

function buildComandaLines(
  comanda: Comanda,
  allClients: { id: string; client_name: string | null; client_number: number }[],
): string[] {
  const lines: string[] = [];

  // Header
  lines.push(`COMANDA #${comanda.comanda_number > 0 ? comanda.comanda_number : "COMPLETA"}`);
  lines.push(comanda.table_name);
  const ts = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date(comanda.created_at));
  lines.push(ts);
  lines.push("--------------------------------");

  if (comanda.client_name) {
    lines.push(`Cliente: ${comanda.client_name}`);
  }
  if (comanda.is_delivery) {
    lines.push(`** DOMICILIO **`);
    if (comanda.delivery_price) lines.push(`  Costo: $${comanda.delivery_price.toLocaleString("es-CO")}`);
  }
  if (comanda.customer_notes) {
    lines.push(`Nota: ${comanda.customer_notes}`);
  }
  lines.push("--------------------------------");

  // Agrupar items raiz y sus hijos
  const roots = comanda.items.filter((i) => !i.combo_parent_id);
  const childrenMap = new Map<string, ComandaItem[]>();
  for (const child of comanda.items.filter((i) => !!i.combo_parent_id)) {
    const list = childrenMap.get(child.combo_parent_id!) ?? [];
    list.push(child);
    childrenMap.set(child.combo_parent_id!, list);
  }

  for (const item of roots) {
    const qty = item.quantity !== 1 ? `${item.quantity}x ` : "";
    lines.push(`${qty}${item.product_name}`);
    if (item.selected_option) lines.push(`   >> ${item.selected_option}`);
    if (item.additions_text) lines.push(`   + ${item.additions_text}`);
    if (item.sauces_text) lines.push(`   Salsas: ${item.sauces_text}`);
    if (item.notes) lines.push(`   * ${item.notes}`);

    const children = childrenMap.get(item.id) ?? [];
    for (const child of children) {
      const cqty = child.quantity !== 1 ? `${child.quantity}x ` : "";
      lines.push(`   - ${cqty}${child.product_name}`);
      if (child.selected_option) lines.push(`      >> ${child.selected_option}`);
      if (child.additions_text) lines.push(`      + ${child.additions_text}`);
      if (child.sauces_text) lines.push(`      Salsas: ${child.sauces_text}`);
    }
  }

  lines.push("--------------------------------");
  return lines;
}
