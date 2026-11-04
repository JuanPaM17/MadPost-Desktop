import type { CachedLicense, LocalUser, Tenant, UserRole } from "../../core/types";
import { databaseManager } from "./DatabaseManager";

// SQLite persists instants as ISO-8601 UTC TEXT, equivalent to Java Instant.toString().
const instantNow = () => new Date().toISOString();

export const metaRepository = {
  async get(key: string) {
    const database = await databaseManager.database();
    const rows = await database.select<{ value: string }[]>("SELECT value FROM app_meta WHERE key = $1", [key]);
    return rows[0]?.value ?? null;
  },
  async set(key: string, value: string) {
    const database = await databaseManager.database();
    await database.execute(
      "INSERT OR REPLACE INTO app_meta(key, value, updated_at) VALUES ($1, $2, $3)",
      [key, value, instantNow()],
    );
  },
};

export const licenseRepository = {
  async getValid(): Promise<CachedLicense | null> {
    const database = await databaseManager.database();
    const rows = await database.select<CachedLicense[]>(
      "SELECT key, tenant_id, tenant_name, expires_at, validated_at, sync_enabled, device_id FROM licenses_cache ORDER BY validated_at DESC LIMIT 1",
    );
    const license = rows[0];
    return license && new Date(license.expires_at).getTime() > Date.now() ? license : null;
  },
  async getAnyCached(): Promise<(CachedLicense & { device_blocked: number }) | null> {
    const database = await databaseManager.database();
    const rows = await database.select<(CachedLicense & { device_blocked: number })[]>(
      "SELECT key, tenant_id, tenant_name, expires_at, validated_at, sync_enabled, device_id, device_blocked FROM licenses_cache ORDER BY validated_at DESC LIMIT 1",
    );
    return rows[0] ?? null;
  },
  async setDeviceBlocked(key: string, blocked: boolean) {
    const database = await databaseManager.database();
    await database.execute("UPDATE licenses_cache SET device_blocked = $1 WHERE key = $2", [blocked ? 1 : 0, key]);
  },
  async save(license: CachedLicense) {
    const database = await databaseManager.database();
    await database.execute(
      `INSERT OR REPLACE INTO licenses_cache
       (key, tenant_id, tenant_name, expires_at, validated_at, sync_enabled, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [license.key, license.tenant_id, license.tenant_name, license.expires_at, license.validated_at, license.sync_enabled, license.device_id],
    );
  },
  async clear(key?: string) {
    const database = await databaseManager.database();
    await database.execute(key ? "DELETE FROM licenses_cache WHERE key = $1" : "DELETE FROM licenses_cache", key ? [key] : []);
  },
};

export const tenantRepository = {
  async upsert(tenant: Tenant) {
    const database = await databaseManager.database();
    const timestamp = instantNow();
    await database.execute(
      `INSERT INTO tenants(id, name, slug, address, phone, tax_id, invoice_footer, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT(id) DO UPDATE SET
       name = CASE WHEN tenants.name IS NULL OR tenants.name = '' THEN excluded.name ELSE tenants.name END,
       slug = excluded.slug,
       address = COALESCE(excluded.address, tenants.address),
       phone = COALESCE(excluded.phone, tenants.phone),
       tax_id = COALESCE(excluded.tax_id, tenants.tax_id),
       invoice_footer = COALESCE(excluded.invoice_footer, tenants.invoice_footer),
       updated_at = excluded.updated_at`,
      [tenant.id, tenant.name, tenant.slug, tenant.address, tenant.phone, tenant.tax_id, null, timestamp],
    );
  },
  async get(id: string): Promise<Tenant | null> {
    const database = await databaseManager.database();
    const rows = await database.select<Tenant[]>("SELECT id, name, slug, address, phone, tax_id FROM tenants WHERE id = $1", [id]);
    return rows[0] ?? null;
  },
  async updateLastSyncedAt(tenantId: string, syncedAt: string) {
    const database = await databaseManager.database();
    await database.execute("UPDATE tenants SET last_synced_at = $1, updated_at = $2 WHERE id = $3", [syncedAt, syncedAt, tenantId]);
  },
};

export const userRepository = {
  async hasAdmin(tenantId: string) {
    const database = await databaseManager.database();
    const rows = await database.select<{ total: number }[]>(
      "SELECT COUNT(*) AS total FROM users WHERE tenant_id = $1 AND role = 'ADMIN' AND active = 1",
      [tenantId],
    );
    return rows[0]?.total > 0;
  },
  async findByUsername(tenantId: string, username: string): Promise<LocalUser | null> {
    const database = await databaseManager.database();
    const rows = await database.select<LocalUser[]>(
      "SELECT id, tenant_id, username, password_hash, display_name, role, active FROM users WHERE tenant_id = $1 AND username = $2 LIMIT 1",
      [tenantId, username.toLowerCase()],
    );
    return rows[0] ?? null;
  },
  async insert(user: Omit<LocalUser, "active"> & { active?: number }) {
    const database = await databaseManager.database();
    const timestamp = instantNow();
    await database.execute(
      `INSERT INTO users(id, tenant_id, username, password_hash, display_name, role, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [user.id, user.tenant_id, user.username.toLowerCase(), user.password_hash, user.display_name, user.role, user.active ?? 1, timestamp],
    );
  },
  async updatePassword(userId: string, passwordHash: string) {
    const database = await databaseManager.database();
    await database.execute(
      "UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3",
      [passwordHash, instantNow(), userId],
    );
  },
  async updateProfile(userId: string, username: string, displayName: string, passwordHash?: string) {
    const database = await databaseManager.database();
    const timestamp = instantNow();
    if (passwordHash) {
      await database.execute(
        "UPDATE users SET username = $1, display_name = $2, password_hash = $3, updated_at = $4 WHERE id = $5",
        [username, displayName, passwordHash, timestamp, userId],
      );
      return;
    }
    await database.execute("UPDATE users SET username = $1, display_name = $2, updated_at = $3 WHERE id = $4", [username, displayName, timestamp, userId]);
  },
};

export const recoveryRepository = {
  async save(userId: string, codeHash: string) {
    const database = await databaseManager.database();
    await database.execute(
      "INSERT OR REPLACE INTO recovery_codes(user_id, code_hash) VALUES ($1, $2)",
      [userId, codeHash],
    );
  },
  async findForUser(tenantId: string, username: string) {
    const database = await databaseManager.database();
    const rows = await database.select<{ id: string; code_hash: string; role: UserRole }[]>(
      `SELECT u.id, rc.code_hash, u.role
       FROM users u JOIN recovery_codes rc ON u.id = rc.user_id
       WHERE u.tenant_id = $1 AND u.username = $2 AND u.active = 1 LIMIT 1`,
      [tenantId, username.toLowerCase()],
    );
    return rows[0] ?? null;
  },
  async remove(userId: string) {
    const database = await databaseManager.database();
    await database.execute("DELETE FROM recovery_codes WHERE user_id = $1", [userId]);
  },
};

export const syncQueueRepository = {
  async enqueue(tableName: string, recordId: string, action: "INSERT" | "UPDATE" | "DELETE", payload: unknown) {
    const { sessionContext } = await import("../../core/session/SessionContext");
    if (sessionContext.isDemo()) return false;
    const license = await licenseRepository.getValid();
    if (!license?.sync_enabled) return false;
    const database = await databaseManager.database();
    await database.execute(
      `INSERT INTO sync_queue(table_name, record_id, action, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tableName, recordId, action, JSON.stringify(payload), instantNow()],
    );
    return true;
  },
  async ensureUserInsert(entityId: string, payload: unknown) {
    const license = await licenseRepository.getValid();
    if (!license?.sync_enabled) return false;
    const database = await databaseManager.database();
    const entries = await database.select<{ id: number; synced_at: string | null }[]>(
      "SELECT id, synced_at FROM sync_queue WHERE table_name = 'users' AND record_id = $1 AND action = 'INSERT' ORDER BY id DESC LIMIT 1",
      [entityId],
    );
    if (entries[0]?.synced_at) return true;
    if (entries[0]) {
      await database.execute("UPDATE sync_queue SET payload_json=$1, retry_count=0 WHERE id=$2", [JSON.stringify(payload), entries[0].id]);
      return true;
    }
    return this.enqueue("users", entityId, "INSERT", payload);
  },
  async replacePendingPayload(id: number, payload: unknown, resetRetries = false) {
    const database = await databaseManager.database();
    await database.execute(`UPDATE sync_queue SET payload_json=$1${resetRetries ? ", retry_count=0" : ""} WHERE id=$2 AND synced_at IS NULL`, [JSON.stringify(payload), id]);
  },
  async loadPending(limit = 50) {
    const database = await databaseManager.database();
    return database.select<SyncQueueEntry[]>(
      "SELECT id, table_name, record_id, action, payload_json FROM sync_queue WHERE synced_at IS NULL AND retry_count < 5 ORDER BY id LIMIT $1",
      [limit],
    );
  },
  async markSynced(id: number, syncedAt: string) {
    const database = await databaseManager.database();
    await database.execute("UPDATE sync_queue SET synced_at = $1 WHERE id = $2", [syncedAt, id]);
  },
  async incrementRetry(id: number) {
    const database = await databaseManager.database();
    await database.execute("UPDATE sync_queue SET retry_count = retry_count + 1 WHERE id = $1", [id]);
  },
  async clearForRecord(tableName: string, recordId: string) {
    const database = await databaseManager.database();
    await database.execute("DELETE FROM sync_queue WHERE table_name = $1 AND record_id = $2 AND synced_at IS NULL", [tableName, recordId]);
  },
};

export type SyncQueueEntry = {
  id: number;
  table_name: string;
  record_id: string;
  action: "INSERT" | "UPDATE" | "DELETE";
  payload_json: string;
};

export const pendingDeletesRepository = {
  async enqueue(tableName: string, recordId: string) {
    const { sessionContext } = await import("../../core/session/SessionContext");
    if (sessionContext.isDemo()) return false;
    const license = await licenseRepository.getValid();
    if (!license?.sync_enabled) return false;
    const database = await databaseManager.database();
    await database.execute(
      "INSERT INTO pending_deletes(table_name, record_id, created_at) VALUES ($1, $2, $3)",
      [tableName, recordId, instantNow()],
    );
    return true;
  },
  async loadPending() {
    const database = await databaseManager.database();
    return database.select<PendingDeleteEntry[]>(
      "SELECT id, table_name, record_id, attempts FROM pending_deletes WHERE status = 'PENDING' ORDER BY id",
    );
  },
  async markDone(id: number) {
    const database = await databaseManager.database();
    await database.execute("UPDATE pending_deletes SET status = 'DONE' WHERE id = $1", [id]);
  },
  async incrementAttempts(id: number) {
    const database = await databaseManager.database();
    await database.execute("UPDATE pending_deletes SET attempts = attempts + 1 WHERE id = $1", [id]);
  },
};

export type PendingDeleteEntry = { id: number; table_name: string; record_id: string; attempts: number };

export type NewUser = Omit<LocalUser, "active" | "password_hash"> & { password_hash: string; role: UserRole };

export const quickLinksRepository = {
  async load(userId: string): Promise<string[]> {
    const database = await databaseManager.database();
    const rows = await database.select<{ view_id: string }[]>(
      "SELECT view_id FROM user_quick_links WHERE user_id=$1 ORDER BY sort_order",
      [userId],
    );
    return rows.map((r) => r.view_id);
  },
  async save(userId: string, viewIds: string[]): Promise<void> {
    const database = await databaseManager.database();
    await database.execute("DELETE FROM user_quick_links WHERE user_id=$1", [userId]);
    for (let i = 0; i < viewIds.length; i++) {
      await database.execute(
        "INSERT INTO user_quick_links(user_id, view_id, sort_order) VALUES($1,$2,$3)",
        [userId, viewIds[i], i],
      );
    }
  },
};
