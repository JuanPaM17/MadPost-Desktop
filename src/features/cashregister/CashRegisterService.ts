import { sessionContext } from "../../core/session/SessionContext";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import {
  pendingDeletesRepository,
  syncQueueRepository,
} from "../../infrastructure/sqlite/repositories";
import { auditService } from "../audit/AuditService";

function expensePayload(expense: CashExpense) {
  return {
    id: expense.id,
    tenant_id: expense.tenantId,
    cash_session_id: expense.cashSessionId,
    description: expense.description,
    amount: expense.amount,
    created_at: expense.createdAt,
    ...(expense.createdBy !== null ? { created_by: expense.createdBy } : {}),
  };
}

export type CashSession = {
  id: string;
  tenantId: string;
  userId: string | null;
  sessionNumber: number;
  openingAmount: number;
  closingAmount: number | null;
  expectedAmount: number | null;
  baseAmount: number | null;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  userName: string | null;
};
export type CashSummary = {
  saleCount: number;
  total: number;
  cash: number;
  cashCount: number;
  card: number;
  cardCount: number;
  delivery: number;
  deliveryCount: number;
  deliveryCash: number;
  deliveryCashCount: number;
  deliveryCard: number;
  deliveryCardCount: number;
  deliveryCollection: number;
};
export type CashTopProduct = { name: string; quantity: number };
export type CashExpense = {
  id: string;
  tenantId: string;
  cashSessionId: string;
  description: string;
  amount: number;
  createdAt: string;
  createdBy: string | null;
};

class CashRegisterService {
  private session() {
    const session = sessionContext.current();
    if (!session) throw new Error("No hay una sesion activa.");
    return session;
  }
  private map(row: SessionRow): CashSession {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      sessionNumber: Number(row.session_number ?? 0),
      openingAmount: Number(row.opening_amount ?? 0),
      closingAmount:
        row.closing_amount === null ? null : Number(row.closing_amount),
      expectedAmount:
        row.expected_amount === null ? null : Number(row.expected_amount),
      baseAmount:
        row.base_amount === null || row.base_amount === undefined ? null : Number(row.base_amount),
      status: row.status === "CLOSED" ? "CLOSED" : "OPEN",
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      userName: row.user_name,
    };
  }
  async getOpenSession() {
    const session = this.session();
    const database = await databaseManager.database();
    const rows = await database.select<SessionRow[]>(
      `${sessionQuery} WHERE cs.tenant_id=$1 AND cs.status='OPEN' ORDER BY cs.opened_at DESC LIMIT 1`,
      [session.tenantId],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }
  async listSessions() {
    const session = this.session();
    const database = await databaseManager.database();
    const where = "cs.tenant_id=$1";
    const params = [session.tenantId];
    const rows = await database.select<SessionRow[]>(
      `${sessionQuery} WHERE ${where} ORDER BY cs.opened_at DESC`,
      params,
    );
    return rows.map((row) => this.map(row));
  }
  async summary(sessionId: string): Promise<CashSummary> {
    const database = await databaseManager.database();
    const rows = await database.select<SummaryRow[]>(
      `SELECT COUNT(*) AS sale_count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(COALESCE(cash_amount, CASE WHEN payment_method='CASH' THEN total ELSE 0 END)),0) AS cash, COALESCE(SUM(CASE WHEN COALESCE(cash_amount, CASE WHEN payment_method='CASH' THEN total ELSE 0 END)>0 THEN 1 ELSE 0 END),0) AS cash_count, COALESCE(SUM(COALESCE(card_amount, CASE WHEN payment_method='CARD' THEN total ELSE 0 END)),0) AS card, COALESCE(SUM(CASE WHEN COALESCE(card_amount, CASE WHEN payment_method='CARD' THEN total ELSE 0 END)>0 THEN 1 ELSE 0 END),0) AS card_count, COALESCE(SUM(CASE WHEN is_delivery=1 THEN total ELSE 0 END),0) AS delivery, COALESCE(SUM(CASE WHEN is_delivery=1 THEN 1 ELSE 0 END),0) AS delivery_count, COALESCE(SUM(CASE WHEN is_delivery=1 THEN COALESCE(cash_amount, CASE WHEN payment_method='CASH' THEN total ELSE 0 END) ELSE 0 END),0) AS delivery_cash, COALESCE(SUM(CASE WHEN is_delivery=1 AND COALESCE(cash_amount, CASE WHEN payment_method='CASH' THEN total ELSE 0 END)>0 THEN 1 ELSE 0 END),0) AS delivery_cash_count, COALESCE(SUM(CASE WHEN is_delivery=1 THEN COALESCE(card_amount, CASE WHEN payment_method='CARD' THEN total ELSE 0 END) ELSE 0 END),0) AS delivery_card, COALESCE(SUM(CASE WHEN is_delivery=1 AND COALESCE(card_amount, CASE WHEN payment_method='CARD' THEN total ELSE 0 END)>0 THEN 1 ELSE 0 END),0) AS delivery_card_count, COALESCE(SUM(CASE WHEN is_delivery=1 THEN COALESCE(delivery_price,0) ELSE 0 END),0) AS delivery_collection FROM sales WHERE cash_session_id=$1`,
      [sessionId],
    );
    const row = rows[0] ?? ({} as SummaryRow);
    return {
      saleCount: Number(row.sale_count ?? 0),
      total: Number(row.total ?? 0),
      cash: Number(row.cash ?? 0),
      cashCount: Number(row.cash_count ?? 0),
      card: Number(row.card ?? 0),
      cardCount: Number(row.card_count ?? 0),
      delivery: Number(row.delivery ?? 0),
      deliveryCount: Number(row.delivery_count ?? 0),
      deliveryCash: Number(row.delivery_cash ?? 0),
      deliveryCashCount: Number(row.delivery_cash_count ?? 0),
      deliveryCard: Number(row.delivery_card ?? 0),
      deliveryCardCount: Number(row.delivery_card_count ?? 0),
      deliveryCollection: Number(row.delivery_collection ?? 0),
    };
  }
  async topProducts(sessionId: string): Promise<CashTopProduct[]> {
    const database = await databaseManager.database();
    const rows = await database.select<
      { name: string | null; quantity: number }[]
    >(
      "SELECT COALESCE(si.product_name, 'Producto') AS name, SUM(si.quantity) AS quantity FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.cash_session_id=$1 GROUP BY si.product_name ORDER BY quantity DESC, name COLLATE NOCASE LIMIT 5",
      [sessionId],
    );
    return rows.map((row) => ({
      name: row.name ?? "Producto",
      quantity: Number(row.quantity),
    }));
  }
  async openSession(openingAmount: number) {
    if (!Number.isFinite(openingAmount) || openingAmount < 0)
      throw new Error("Ingresa un monto de apertura valido.");
    const session = this.session();
    if (await this.getOpenSession())
      throw new Error("Ya hay una caja abierta.");
    const database = await databaseManager.database();
    const now = new Date().toISOString();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const rows = await database.select<{ next: number }[]>(
      "SELECT COALESCE(MAX(session_number),0)+1 AS next FROM cash_sessions WHERE tenant_id=$1 AND opened_at >= $2 AND opened_at < $3",
      [session.tenantId, today.toISOString(), tomorrow.toISOString()],
    );
    const cash: CashSession = {
      id: crypto.randomUUID(),
      tenantId: session.tenantId,
      userId: session.user.id,
      sessionNumber: Number(rows[0]?.next ?? 1),
      openingAmount,
      closingAmount: null,
      expectedAmount: null,
      status: "OPEN",
      openedAt: now,
      closedAt: null,
      userName: session.user.display_name || session.user.username,
    };
    await database.execute(
      "INSERT INTO cash_sessions(id,tenant_id,user_id,session_number,opening_amount,status,opened_at) VALUES($1,$2,$3,$4,$5,'OPEN',$6)",
      [
        cash.id,
        cash.tenantId,
        cash.userId,
        cash.sessionNumber,
        cash.openingAmount,
        cash.openedAt,
      ],
    );
    await this.enqueueSync("INSERT", cash);
    await auditService.log(
      "ABRIR_CAJA",
      "CAJA",
      `Caja #${cash.sessionNumber} | Apertura: ${cash.openingAmount}`,
      cash.id,
    );
    return cash;
  }
  async closeSession(cash: CashSession, closingAmount: number, baseAmount?: number) {
    if (!Number.isFinite(closingAmount) || closingAmount < 0)
      throw new Error("Ingresa un monto de cierre valido.");
    if (baseAmount !== undefined && (!Number.isFinite(baseAmount) || baseAmount < 0))
      throw new Error("Ingresa un monto de base valido.");
    const session = this.session();
    const database = await databaseManager.database();
    const openTables = await database.select<{ total: number }[]>(
      "SELECT COUNT(*) AS total FROM table_orders WHERE tenant_id=$1 AND status='OPEN'",
      [session.tenantId],
    );
    if ((openTables[0]?.total ?? 0) > 0)
      throw new Error(
        `Hay ${openTables[0].total} mesa(s) con cuenta abierta. Cobralas antes de cerrar la caja.`,
      );
    const summary = await this.summary(cash.id);
    const expenses = await this.listExpenses(cash.id);
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
    const expected = cash.openingAmount + summary.cash - totalExpenses;
    const closedAt = new Date().toISOString();
    const base = baseAmount ?? null;
    await database.execute(
      "UPDATE cash_sessions SET closing_amount=$1, expected_amount=$2, status='CLOSED', closed_at=$3, base_amount=$4 WHERE id=$5 AND tenant_id=$6 AND status='OPEN'",
      [closingAmount, expected, closedAt, base, cash.id, session.tenantId],
    );
    const closed: CashSession = {
      ...cash,
      closingAmount,
      expectedAmount: expected,
      baseAmount: base,
      status: "CLOSED" as const,
      closedAt,
    };
    await syncQueueRepository.clearForRecord("cash_sessions", cash.id);
    await this.enqueueSync("INSERT", closed);
    await auditService.log(
      "CERRAR_CAJA",
      "CAJA",
      `Caja #${cash.sessionNumber} | Esperado: ${expected} | Real: ${closingAmount} | Gastos: ${totalExpenses} | Diferencia: ${closingAmount - expected}`,
      cash.id,
    );
    return { cash: closed, summary };
  }
  async listExpenses(sessionId: string): Promise<CashExpense[]> {
    const database = await databaseManager.database();
    const rows = await database.select<ExpenseRow[]>(
      "SELECT * FROM cash_expenses WHERE cash_session_id=$1 ORDER BY created_at ASC",
      [sessionId],
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      cashSessionId: row.cash_session_id,
      description: row.description,
      amount: Number(row.amount),
      createdAt: row.created_at,
      createdBy: row.created_by,
    }));
  }
  async addExpense(sessionId: string, description: string, amount: number): Promise<CashExpense> {
    if (!description.trim()) throw new Error("Ingresa una descripcion.");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresa un monto valido.");
    const session = this.session();
    const database = await databaseManager.database();
    const expense: CashExpense = {
      id: crypto.randomUUID(),
      tenantId: session.tenantId,
      cashSessionId: sessionId,
      description: description.trim(),
      amount,
      createdAt: new Date().toISOString(),
      createdBy: session.user.id,
    };
    await database.execute(
      "INSERT INTO cash_expenses(id,tenant_id,cash_session_id,description,amount,created_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [expense.id, expense.tenantId, expense.cashSessionId, expense.description, expense.amount, expense.createdAt, expense.createdBy],
    );
    await syncQueueRepository.enqueue("cash_expenses", expense.id, "INSERT", expensePayload(expense));
    return expense;
  }
  async updateExpense(expenseId: string, description: string, amount: number): Promise<void> {
    if (!description.trim()) throw new Error("Ingresa una descripcion.");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresa un monto valido.");
    const database = await databaseManager.database();
    await database.execute(
      "UPDATE cash_expenses SET description=$1, amount=$2 WHERE id=$3",
      [description.trim(), amount, expenseId],
    );
    const rows = await database.select<{ id: string; tenant_id: string; cash_session_id: string; description: string; amount: number; created_at: string; created_by: string | null }[]>(
      "SELECT * FROM cash_expenses WHERE id=$1",
      [expenseId],
    );
    if (rows[0]) {
      const updated: CashExpense = {
        id: rows[0].id,
        tenantId: rows[0].tenant_id,
        cashSessionId: rows[0].cash_session_id,
        description: rows[0].description,
        amount: Number(rows[0].amount),
        createdAt: rows[0].created_at,
        createdBy: rows[0].created_by,
      };
      await syncQueueRepository.clearForRecord("cash_expenses", expenseId);
      await syncQueueRepository.enqueue("cash_expenses", expenseId, "UPDATE", expensePayload(updated));
    }
  }
  async deleteExpense(expenseId: string): Promise<void> {
    const database = await databaseManager.database();
    await syncQueueRepository.clearForRecord("cash_expenses", expenseId);
    await database.execute("DELETE FROM cash_expenses WHERE id=$1", [expenseId]);
    await pendingDeletesRepository.enqueue("cash_expenses", expenseId);
  }
  private async enqueueSync(action: "INSERT" | "UPDATE", cash: CashSession) {
    await syncQueueRepository.enqueue("cash_sessions", cash.id, action, cashPayload(cash));
  }
  async deleteClosedSession(cash: CashSession, skipRoleCheck = false) {
    const session = this.session();
    if (!skipRoleCheck && session.user.role !== "SUPERADMIN")
      throw new Error("Solo un superadministrador puede eliminar una caja.");
    if (cash.status !== "CLOSED")
      throw new Error("Solo se pueden eliminar cajas cerradas.");
    const database = await databaseManager.database();
    const sales = await database.select<{ id: string }[]>(
      "SELECT id FROM sales WHERE cash_session_id=$1",
      [cash.id],
    );
    const orders = await database.select<{ id: string }[]>(
      "SELECT id FROM table_orders WHERE cash_session_id=$1",
      [cash.id],
    );
    for (const sale of sales) {
      await syncQueueRepository.clearForRecord("sales", sale.id);
      await database.execute("DELETE FROM sale_items WHERE sale_id=$1", [
        sale.id,
      ]);
      await database.execute("DELETE FROM sales WHERE id=$1", [sale.id]);
      await pendingDeletesRepository.enqueue("sales", sale.id);
    }
    for (const order of orders) {
      await database.execute(
        "DELETE FROM table_order_items WHERE table_order_id=$1",
        [order.id],
      );
      await database.execute(
        "DELETE FROM table_order_clients WHERE table_order_id=$1",
        [order.id],
      );
      await database.execute("DELETE FROM table_orders WHERE id=$1", [
        order.id,
      ]);
    }
    await syncQueueRepository.clearForRecord("cash_sessions", cash.id);
    await database.execute(
      "DELETE FROM cash_sessions WHERE id=$1 AND status='CLOSED'",
      [cash.id],
    );
    await pendingDeletesRepository.enqueue("cash_sessions", cash.id);
    await auditService.log(
      "ELIMINAR_CAJA",
      "CAJA",
      `Caja #${cash.sessionNumber} eliminada`,
      cash.id,
    );
  }
}

type SessionRow = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  session_number: number;
  opening_amount: number;
  closing_amount: number | null;
  expected_amount: number | null;
  base_amount: number | null | undefined;
  status: string;
  opened_at: string;
  closed_at: string | null;
  user_name: string | null;
};
type ExpenseRow = {
  id: string;
  tenant_id: string;
  cash_session_id: string;
  description: string;
  amount: number;
  created_at: string;
  created_by: string | null;
};
type SummaryRow = {
  sale_count?: number;
  total?: number;
  cash?: number;
  cash_count?: number;
  card?: number;
  card_count?: number;
  delivery?: number;
  delivery_count?: number;
  delivery_cash?: number;
  delivery_cash_count?: number;
  delivery_card?: number;
  delivery_card_count?: number;
  delivery_collection?: number;
};
const sessionQuery =
  "SELECT cs.*, COALESCE(u.display_name,u.username) AS user_name FROM cash_sessions cs LEFT JOIN users u ON u.id=cs.user_id";
function cashPayload(cash: CashSession) {
  return {
    id: cash.id,
    tenant_id: cash.tenantId,
    user_id: cash.userId,
    session_number: cash.sessionNumber,
    opening_amount: cash.openingAmount,
    status: cash.status,
    opened_at: cash.openedAt,
    ...(cash.closingAmount !== null ? { closing_amount: cash.closingAmount } : {}),
    ...(cash.expectedAmount !== null ? { expected_amount: cash.expectedAmount } : {}),
    ...(cash.baseAmount !== null ? { base_amount: cash.baseAmount } : {}),
    ...(cash.closedAt ? { closed_at: cash.closedAt } : {}),
  };
}
export const cashRegisterService = new CashRegisterService();
