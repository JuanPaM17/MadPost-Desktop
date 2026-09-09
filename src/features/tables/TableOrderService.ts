import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";

export type TableOrderItem = {
  id: string;
  table_order_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  selected_option: string | null;
  combo_id: string | null;
  combo_table_order_item_id: string | null;
  table_order_client_id: string | null;
  notes: string | null;
  original_unit_price: number | null;
  additions: { name: string; quantity: number; price: number }[];
  sauces: { name: string }[];
};

export type TableOrder = {
  id: string;
  tenant_id: string;
  table_id: string;
  user_id: string;
  cash_session_id: string;
  client_name: string | null;
  status: "OPEN" | "CLOSED";
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
  comanda_sent: number | null; // 1 = comanda sent to kitchen
};

const instantNow = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export const tableOrderService = {
  async getOpenOrderByTable(tableId: string): Promise<TableOrder | null> {
    const db = await databaseManager.database();
    const rows = await db.select<TableOrder[]>(
      "SELECT id, tenant_id, table_id, user_id, cash_session_id, client_name, status, opened_at, closed_at, notes FROM table_orders WHERE table_id = $1 AND status = 'OPEN' LIMIT 1",
      [tableId],
    );
    return rows[0] ?? null;
  },

  async openOrder(tenantId: string, tableId: string, cashSessionId: string, userId: string, clientName: string | null): Promise<TableOrder> {
    const db = await databaseManager.database();
    const now = instantNow();
    const orderId = uuid();
    const clientId = uuid();
    const name = clientName?.trim() || null;

    await db.execute(
      "INSERT INTO table_orders(id, tenant_id, table_id, user_id, cash_session_id, client_name, status, opened_at) VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7)",
      [orderId, tenantId, tableId, userId, cashSessionId, name, now],
    );

    await db.execute(
      "INSERT INTO table_order_clients(id, table_order_id, client_name, client_number, status, created_at) VALUES ($1,$2,$3,1,'ACTIVE',$4)",
      [clientId, orderId, name, now],
    );

    return { id: orderId, tenant_id: tenantId, table_id: tableId, user_id: userId, cash_session_id: cashSessionId, client_name: name, status: "OPEN", opened_at: now, closed_at: null, notes: null };
  },

  async getOpenOrdersByTableIds(tableIds: string[]): Promise<TableOrder[]> {
    if (!tableIds.length) return [];
    const db = await databaseManager.database();
    const placeholders = tableIds.map((_, i) => `$${i + 1}`).join(",");
    return db.select<TableOrder[]>(
      `SELECT id, tenant_id, table_id, user_id, cash_session_id, client_name, status, opened_at, closed_at, notes FROM table_orders WHERE table_id IN (${placeholders}) AND status = 'OPEN'`,
      tableIds,
    );
  },

  async getItemsForOrder(orderId: string, excludeCancelled = true): Promise<TableOrderItem[]> {
    const db = await databaseManager.database();
    const cancelFilter = excludeCancelled
      ? `AND (i.table_order_client_id IS NULL OR i.table_order_client_id NOT IN (
           SELECT id FROM table_order_clients WHERE table_order_id = $1 AND status = 'CANCELLED'
         ))`
      : "";
    const rows = await db.select<Omit<TableOrderItem, "additions" | "sauces">[]>(
      `SELECT i.id, i.table_order_id, i.product_id, i.product_name, i.quantity, i.unit_price, i.subtotal, i.selected_option, i.combo_id, i.combo_table_order_item_id, i.table_order_client_id, i.notes, i.original_unit_price
       FROM table_order_items i
       WHERE i.table_order_id = $1 ${cancelFilter}
       ORDER BY i.rowid ASC`,
      [orderId],
    );
    const items: TableOrderItem[] = [];
    for (const row of rows) {
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

  async getSalesByTableOrderId(orderId: string): Promise<{ total: number; delivery_price: number | null; invoice_number: string }[]> {
    const db = await databaseManager.database();
    return db.select<{ total: number; delivery_price: number | null; invoice_number: string }[]>(
      "SELECT total, delivery_price, invoice_number FROM sales WHERE table_order_id = $1",
      [orderId],
    );
  },

  async getOrdersByTableAndSession(tableId: string, cashSessionId: string): Promise<TableOrder[]> {
    const db = await databaseManager.database();
    return db.select<TableOrder[]>(
      "SELECT o.id, o.tenant_id, o.table_id, o.user_id, o.cash_session_id, o.client_name, o.status, o.opened_at, o.closed_at, o.notes, o.comanda_sent FROM table_orders o WHERE o.table_id = $1 AND o.cash_session_id = $2 ORDER BY o.opened_at DESC",
      [tableId, cashSessionId],
    );
  },

  async setNotes(orderId: string, notes: string | null): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_orders SET notes = $1 WHERE id = $2", [notes, orderId]);
  },

  async getClients(orderId: string): Promise<TableOrderClient[]> {
    const db = await databaseManager.database();
    return db.select(
      "SELECT id, client_name, client_number, status, notes, delivery_type_id, is_card FROM table_order_clients WHERE table_order_id = $1 AND status != 'CANCELLED' ORDER BY client_number ASC",
      [orderId],
    );
  },

  async addClient(orderId: string, clientName: string | null): Promise<TableOrderClient> {
    const db = await databaseManager.database();
    const rows = await db.select<{ max_n: number }[]>(
      "SELECT COALESCE(MAX(client_number), 0) AS max_n FROM table_order_clients WHERE table_order_id = $1",
      [orderId],
    );
    const nextNumber = (rows[0]?.max_n ?? 0) + 1;
    const id = uuid();
    const now = instantNow();
    await db.execute(
      "INSERT INTO table_order_clients(id, table_order_id, client_name, client_number, status, created_at) VALUES ($1,$2,$3,$4,'ACTIVE',$5)",
      [id, orderId, clientName?.trim() || null, nextNumber, now],
    );
    return { id, client_name: clientName?.trim() || null, client_number: nextNumber, status: "ACTIVE", notes: null, delivery_type_id: null, is_card: 0 };
  },

  async updateClientName(clientId: string, name: string | null): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_order_clients SET client_name=$1 WHERE id=$2", [name?.trim() || null, clientId]);
  },

  async updateClientNotes(clientId: string, notes: string | null): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_order_clients SET notes=$1 WHERE id=$2", [notes?.trim() || null, clientId]);
  },

  async updateClientDeliveryType(clientId: string, deliveryTypeId: string | null): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_order_clients SET delivery_type_id=$1 WHERE id=$2", [deliveryTypeId, clientId]);
  },

  async updateClientCard(clientId: string, isCard: boolean): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_order_clients SET is_card=$1 WHERE id=$2", [isCard ? 1 : 0, clientId]);
  },

  async cancelClient(clientId: string): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_order_clients SET status='CANCELLED' WHERE id=$1", [clientId]);
  },

  async decrementItem(itemId: string): Promise<"removed" | "decremented"> {
    const db = await databaseManager.database();
    const rows = await db.select<{ quantity: number; subtotal: number; unit_price: number }[]>(
      "SELECT quantity, subtotal, unit_price FROM table_order_items WHERE id=$1", [itemId],
    );
    if (!rows.length) return "removed";
    const { quantity, unit_price } = rows[0];
    if (quantity <= 1) {
      await db.execute("DELETE FROM table_order_item_additions WHERE table_order_item_id=$1", [itemId]);
      await db.execute("DELETE FROM table_order_item_sauces WHERE table_order_item_id=$1", [itemId]);
      // If it's a combo parent, delete children too
      const children = await db.select<{ id: string }[]>("SELECT id FROM table_order_items WHERE combo_table_order_item_id=$1", [itemId]);
      for (const child of children) {
        await db.execute("DELETE FROM table_order_item_additions WHERE table_order_item_id=$1", [child.id]);
        await db.execute("DELETE FROM table_order_item_sauces WHERE table_order_item_id=$1", [child.id]);
        await db.execute("DELETE FROM table_order_items WHERE id=$1", [child.id]);
      }
      await db.execute("DELETE FROM table_order_items WHERE id=$1", [itemId]);
      return "removed";
    }
    const addRows = await db.select<{ price: number; quantity: number }[]>(
      "SELECT price, quantity FROM table_order_item_additions WHERE table_order_item_id=$1", [itemId],
    );
    const additionsTotal = addRows.reduce((s, a) => s + a.price * a.quantity, 0);
    const newQty = quantity - 1;
    const newSubtotal = (unit_price + additionsTotal) * newQty;
    await db.execute("UPDATE table_order_items SET quantity=$1, subtotal=$2 WHERE id=$3", [newQty, newSubtotal, itemId]);
    return "decremented";
  },

  async updateItemNotes(itemId: string, notes: string | null): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_order_items SET notes=$1, updated_at=$2 WHERE id=$3", [notes?.trim() || null, instantNow(), itemId]);
  },

  async getItemsByClient(orderId: string): Promise<Map<string, TableOrderItem[]>> {
    const items = await this.getItemsForOrder(orderId);
    const map = new Map<string, TableOrderItem[]>();
    for (const item of items) {
      const key = item.table_order_client_id ?? "__none__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  },

  async updateItemOption(itemId: string, selectedOption: string | null): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE table_order_items SET selected_option=$1, updated_at=$2 WHERE id=$3", [selectedOption, instantNow(), itemId]);
  },

  async replaceItemAdditions(itemId: string, additions: { id: string; name: string; price: number; quantity: number }[]): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("DELETE FROM table_order_item_additions WHERE table_order_item_id=$1", [itemId]);
    for (const a of additions) {
      if (a.quantity <= 0) continue;
      await db.execute(
        "INSERT INTO table_order_item_additions(id, table_order_item_id, addition_id, addition_name, price, quantity) VALUES ($1,$2,$3,$4,$5,$6)",
        [uuid(), itemId, a.id, a.name, a.price, a.quantity],
      );
    }
    const rows = await db.select<{ quantity: number; unit_price: number }[]>(
      "SELECT quantity, unit_price FROM table_order_items WHERE id=$1", [itemId],
    );
    if (rows.length) {
      const additionsTotal = additions.reduce((s, a) => s + a.price * a.quantity, 0);
      const newSubtotal = (rows[0].unit_price + additionsTotal) * rows[0].quantity;
      await db.execute("UPDATE table_order_items SET subtotal=$1, updated_at=$2 WHERE id=$3", [newSubtotal, instantNow(), itemId]);
    }
  },

  async replaceItemSauces(itemId: string, sauces: { id: string; name: string }[]): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("DELETE FROM table_order_item_sauces WHERE table_order_item_id=$1", [itemId]);
    for (const s of sauces) {
      await db.execute(
        "INSERT INTO table_order_item_sauces(id, table_order_item_id, sauce_id, sauce_name) VALUES ($1,$2,$3,$4)",
        [uuid(), itemId, s.id, s.name],
      );
    }
    await db.execute("UPDATE table_order_items SET updated_at=$1 WHERE id=$2", [instantNow(), itemId]);
  },

  async addItem(params: {
    orderId: string;
    clientId: string | null;
    productId: string | null;
    productName: string;
    quantity: number;
    unitPrice: number;
    selectedOption: string | null;
    comboId: string | null;
    comboParentItemId: string | null;
    additions: { id: string; name: string; price: number; quantity: number }[];
    sauces: { id: string; name: string }[];
  }): Promise<string> {
    const db = await databaseManager.database();
    const itemId = uuid();
    const now = instantNow();
    const additionsTotal = params.additions.reduce((s, a) => s + a.price * a.quantity, 0);
    const subtotal = (params.unitPrice + additionsTotal) * params.quantity;
    await db.execute(
      "INSERT INTO table_order_items(id, table_order_id, product_id, product_name, quantity, unit_price, subtotal, added_at, selected_option, table_order_client_id, combo_id, combo_table_order_item_id, original_unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [itemId, params.orderId, params.productId, params.productName, params.quantity, params.unitPrice, subtotal, now, params.selectedOption, params.clientId, params.comboId, params.comboParentItemId, params.unitPrice],
    );
    for (const addition of params.additions) {
      if (addition.quantity <= 0) continue;
      await db.execute(
        "INSERT INTO table_order_item_additions(id, table_order_item_id, addition_id, addition_name, price, quantity) VALUES ($1,$2,$3,$4,$5,$6)",
        [uuid(), itemId, addition.id, addition.name, addition.price, addition.quantity],
      );
    }
    for (const sauce of params.sauces) {
      await db.execute(
        "INSERT INTO table_order_item_sauces(id, table_order_item_id, sauce_id, sauce_name) VALUES ($1,$2,$3,$4)",
        [uuid(), itemId, sauce.id, sauce.name],
      );
    }
    return itemId;
  },

  async closeOrder(orderId: string): Promise<void> {
    const db = await databaseManager.database();
    await db.execute(
      "UPDATE table_orders SET status='CLOSED', closed_at=$1 WHERE id=$2",
      [instantNow(), orderId],
    );
  },

  async deleteOrder(orderId: string): Promise<void> {
    const db = await databaseManager.database();
    const items = await db.select<{ id: string }[]>("SELECT id FROM table_order_items WHERE table_order_id=$1", [orderId]);
    for (const item of items) {
      await db.execute("DELETE FROM table_order_item_additions WHERE table_order_item_id=$1", [item.id]);
      await db.execute("DELETE FROM table_order_item_sauces WHERE table_order_item_id=$1", [item.id]);
    }
    await db.execute("DELETE FROM table_order_items WHERE table_order_id=$1", [orderId]);
    await db.execute("DELETE FROM table_order_clients WHERE table_order_id=$1", [orderId]);
    await db.execute("DELETE FROM table_orders WHERE id=$1", [orderId]);
  },
};

export type TableOrderClient = {
  id: string;
  client_name: string | null;
  client_number: number;
  status: string;
  notes: string | null;
  delivery_type_id: string | null;
  is_card: number;
};
