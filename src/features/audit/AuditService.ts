import { sessionContext } from "../../core/session/SessionContext";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import type { AuditEntry, AuditItem } from "./AuditEntry";

type AuditFilters = { action?: string; entityType?: string; userName?: string; dateFrom?: string; dateTo?: string };
export type AuditItemInput = { label?: string | null; quantity?: number | null; unitPrice?: number | null; subtotal?: number | null; note?: string | null };

class AuditService {
  async log(action: string, entityType: string, details: string, entityId: string | null = null, items?: AuditItemInput[]) {
    const session = sessionContext.current();
    if (!session) return null;
    const entryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const database = await databaseManager.database();
    await database.execute(
      `INSERT INTO audit_log(id, tenant_id, user_id, user_name, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entryId, session.tenantId, session.user.id, session.user.display_name || session.user.username, action, entityType, entityId, details, now],
    );
    if (items?.length) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await database.execute(
          `INSERT INTO audit_log_items(id, audit_id, sort_order, label, quantity, unit_price, subtotal, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [crypto.randomUUID(), entryId, i, item.label ?? null, item.quantity ?? null, item.unitPrice ?? null, item.subtotal ?? null, item.note ?? null],
        );
      }
    }
    return entryId;
  }

  async list(filters: AuditFilters = {}): Promise<AuditEntry[]> {
    const session = sessionContext.current();
    if (!session) return [];
    const database = await databaseManager.database();
    const parameters: (string | number)[] = [session.tenantId];
    const clauses = ["tenant_id = $1"];
    if (filters.dateFrom) { parameters.push(bogotaStart(filters.dateFrom)); clauses.push(`created_at >= $${parameters.length}`); }
    if (filters.dateTo) { parameters.push(bogotaStart(nextDate(filters.dateTo))); clauses.push(`created_at < $${parameters.length}`); }
    if (!filters.dateFrom && !filters.dateTo) { parameters.push(new Date(Date.now() - 30 * 86_400_000).toISOString()); clauses.push(`created_at >= $${parameters.length}`); }
    if (filters.action) { parameters.push(filters.action); clauses.push(`action = $${parameters.length}`); }
    if (filters.entityType) { parameters.push(filters.entityType); clauses.push(`entity_type = $${parameters.length}`); }
    if (filters.userName) { parameters.push(filters.userName); clauses.push(`user_name = $${parameters.length}`); }
    const rows = await database.select<{ id: string; user_name: string | null; action: string; entity_type: string; entity_id: string | null; details: string | null; created_at: string }[]>(
      `SELECT id, user_name, action, entity_type, entity_id, details, created_at FROM audit_log WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 1000`, parameters,
    );
    const entries: AuditEntry[] = rows.map((row) => ({ id: row.id, userName: row.user_name, action: row.action, entityType: row.entity_type, entityId: row.entity_id, details: row.details, createdAt: row.created_at }));
    if (entries.length > 0) {
      const ids = entries.map((e) => `'${e.id}'`).join(",");
      const itemRows = await database.select<{ id: string; audit_id: string; sort_order: number; label: string | null; quantity: number | null; unit_price: number | null; subtotal: number | null; note: string | null }[]>(
        `SELECT id, audit_id, sort_order, label, quantity, unit_price, subtotal, note FROM audit_log_items WHERE audit_id IN (${ids}) ORDER BY audit_id, sort_order`,
      );
      const itemsByAudit = new Map<string, AuditItem[]>();
      for (const r of itemRows) {
        const list = itemsByAudit.get(r.audit_id) ?? [];
        list.push({ id: r.id, sortOrder: r.sort_order, label: r.label, quantity: r.quantity, unitPrice: r.unit_price, subtotal: r.subtotal, note: r.note });
        itemsByAudit.set(r.audit_id, list);
      }
      for (const entry of entries) {
        const its = itemsByAudit.get(entry.id);
        if (its?.length) entry.items = its;
      }
    }
    return entries;
  }

  async distinctActions() {
    const session = sessionContext.current();
    if (!session) return [];
    const database = await databaseManager.database();
    const rows = await database.select<{ action: string }[]>("SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1 ORDER BY action", [session.tenantId]);
    return rows.map((row) => row.action);
  }

  async distinctEntityTypes() {
    const session = sessionContext.current();
    if (!session) return [];
    const database = await databaseManager.database();
    const rows = await database.select<{ entity_type: string }[]>("SELECT DISTINCT entity_type FROM audit_log WHERE tenant_id = $1 ORDER BY entity_type", [session.tenantId]);
    return rows.map((row) => row.entity_type);
  }

  async distinctUserNames() {
    const session = sessionContext.current();
    if (!session) return [];
    const database = await databaseManager.database();
    const rows = await database.select<{ user_name: string }[]>("SELECT DISTINCT user_name FROM audit_log WHERE tenant_id = $1 AND user_name IS NOT NULL ORDER BY user_name", [session.tenantId]);
    return rows.map((row) => row.user_name);
  }
}

function bogotaStart(date: string) { const [year, month, day] = date.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day, 5)).toISOString(); }
function nextDate(date: string) { const [year, month, day] = date.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day + 1, 5)).toISOString(); }

export const auditService = new AuditService();
