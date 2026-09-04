import { sessionContext } from "../../core/session/SessionContext";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import type { AuditEntry } from "./AuditEntry";

type AuditFilters = { action: string | null; days: number };

class AuditService {
  async log(action: string, entityType: string, details: string, entityId: string | null = null) {
    const session = sessionContext.current();
    if (!session) return null;
    const entry = {
      id: crypto.randomUUID(), tenantId: session.tenantId, userId: session.user.id, userName: session.user.display_name || session.user.username,
      action, entityType, entityId, details, createdAt: new Date().toISOString(),
    };
    const database = await databaseManager.database();
    await database.execute(
      `INSERT INTO audit_log(id, tenant_id, user_id, user_name, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.id, entry.tenantId, entry.userId, entry.userName, entry.action, entry.entityType, entry.entityId, entry.details, entry.createdAt],
    );
    return entry;
  }

  async list(filters: AuditFilters): Promise<AuditEntry[]> {
    const session = sessionContext.current();
    if (!session) return [];
    const database = await databaseManager.database();
    const since = new Date(Date.now() - filters.days * 86_400_000).toISOString();
    const actionClause = filters.action ? " AND action = $3" : "";
    const parameters = filters.action ? [session.tenantId, since, filters.action] : [session.tenantId, since];
    const rows = await database.select<{ id: string; user_name: string | null; action: string; entity_type: string; entity_id: string | null; details: string | null; created_at: string }[]>(
      `SELECT id, user_name, action, entity_type, entity_id, details, created_at FROM audit_log
       WHERE tenant_id = $1 AND created_at >= $2${actionClause} ORDER BY created_at DESC LIMIT 500`, parameters,
    );
    return rows.map((row) => ({ id: row.id, userName: row.user_name, action: row.action, entityType: row.entity_type, entityId: row.entity_id, details: row.details, createdAt: row.created_at }));
  }

  async distinctActions() {
    const session = sessionContext.current();
    if (!session) return [];
    const database = await databaseManager.database();
    const rows = await database.select<{ action: string }[]>("SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1 ORDER BY action", [session.tenantId]);
    return rows.map((row) => row.action);
  }
}

export const auditService = new AuditService();
