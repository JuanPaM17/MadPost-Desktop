import Database from "@tauri-apps/plugin-sql";

type SqliteDatabase = Awaited<ReturnType<typeof Database.load>>;

const migrations = [
  `CREATE TABLE IF NOT EXISTS licenses_cache (
    key TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    tenant_name TEXT,
    expires_at TEXT NOT NULL,
    validated_at TEXT NOT NULL,
    sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0, 1)),
    device_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    slug TEXT,
    address TEXT,
    phone TEXT,
    tax_id TEXT,
    logo_path TEXT,
    invoice_footer TEXT,
    max_sauces INTEGER,
    last_synced_at TEXT,
    react_migrated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'SELLER', 'SUPERADMIN')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, username)
  )`,
  `CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    synced_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS pending_deletes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER,
    show_additions INTEGER, show_sauces INTEGER, hidden INTEGER, created_at TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, category_id TEXT, name TEXT NOT NULL, price REAL,
    image_path TEXT, active INTEGER, created_at TEXT, updated_at TEXT, stock REAL, description TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS product_options (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, name TEXT NOT NULL, active INTEGER, sort_order INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS discounts (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, product_id TEXT, discount_type TEXT, discount_value REAL,
    active INTEGER, start_date TEXT, end_date TEXT, created_at TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS additions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, price REAL, active INTEGER,
    created_at TEXT, updated_at TEXT, stock REAL, quantity_per_sale REAL
  )`,
  `CREATE TABLE IF NOT EXISTS sauces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, active INTEGER, created_at TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS supplies (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, unit TEXT, stock REAL,
    low_stock_threshold REAL, active INTEGER, created_at TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS product_supplies (
    product_id TEXT NOT NULL, supply_id TEXT NOT NULL, quantity_per_sale REAL, PRIMARY KEY(product_id, supply_id)
  )`,
  `CREATE TABLE IF NOT EXISTS combos (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, price REAL, image_path TEXT,
    active INTEGER, created_at TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS combo_items (
    id TEXT PRIMARY KEY, combo_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity REAL
  )`,
  `CREATE TABLE IF NOT EXISTS cash_sessions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, session_number INTEGER, opening_amount REAL,
    closing_amount REAL, expected_amount REAL, status TEXT, opened_at TEXT, closed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS restaurant_tables (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, shape TEXT, width REAL, height REAL,
    pos_x REAL, pos_y REAL, type TEXT, floor TEXT, active INTEGER, created_at TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_types (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, price REAL, sort_order INTEGER, created_at TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, cash_session_id TEXT, total REAL, payment_method TEXT,
    cash_given REAL, change_given REAL, invoice_number TEXT, notes TEXT, created_at TEXT, is_delivery INTEGER,
    table_order_id TEXT, cash_amount REAL, card_amount REAL, discount_type TEXT, discount_value REAL, subtotal REAL,
    delivery_price REAL, client_name TEXT, collected_by_user_id TEXT, collected_by_display_name TEXT,
    delivery_type_id TEXT, delivery_type_name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, product_id TEXT, product_name TEXT, quantity REAL, unit_price REAL,
    subtotal REAL, notes TEXT, selected_option TEXT, combo_id TEXT, combo_sale_item_id TEXT, original_unit_price REAL, category_name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sale_item_additions (
    id TEXT PRIMARY KEY, sale_item_id TEXT NOT NULL, addition_id TEXT, addition_name TEXT, price REAL, quantity REAL
  )`,
  `CREATE TABLE IF NOT EXISTS sale_item_sauces (
    id TEXT PRIMARY KEY, sale_item_id TEXT NOT NULL, sauce_id TEXT, sauce_name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS table_orders (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, table_id TEXT, user_id TEXT, cash_session_id TEXT, client_name TEXT,
    status TEXT, opened_at TEXT, closed_at TEXT, notes TEXT, customer_notes TEXT, comanda_sent INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS table_order_clients (
    id TEXT PRIMARY KEY, table_order_id TEXT NOT NULL, client_name TEXT, client_number INTEGER, status TEXT, created_at TEXT, delivery_type_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS table_order_items (
    id TEXT PRIMARY KEY, table_order_id TEXT NOT NULL, product_id TEXT, product_name TEXT, quantity REAL, unit_price REAL,
    subtotal REAL, added_at TEXT, notes TEXT, selected_option TEXT, table_order_client_id TEXT, combo_id TEXT,
    combo_table_order_item_id TEXT, original_unit_price REAL, category_name TEXT, updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS comandas (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, table_order_id TEXT NOT NULL,
    table_name TEXT, comanda_number INTEGER, created_at TEXT,
    client_id TEXT, client_name TEXT, customer_notes TEXT, is_delivery INTEGER, delivery_price REAL
  )`,
  `CREATE TABLE IF NOT EXISTS comanda_items (
    id TEXT PRIMARY KEY, comanda_id TEXT NOT NULL, product_name TEXT, quantity REAL,
    additions_text TEXT, sauces_text TEXT, notes TEXT, selected_option TEXT,
    category_name TEXT, subtotal REAL, combo_parent_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS table_order_item_additions (
    id TEXT PRIMARY KEY, table_order_item_id TEXT NOT NULL, addition_id TEXT, addition_name TEXT, price REAL, quantity REAL
  )`,
  `CREATE TABLE IF NOT EXISTS table_order_item_sauces (
    id TEXT PRIMARY KEY, table_order_item_id TEXT NOT NULL, sauce_id TEXT, sauce_name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS stock_logs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, user_name TEXT, item_type TEXT, item_id TEXT,
    item_name TEXT, delta REAL, stock_before REAL, stock_after REAL, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT,
    user_name TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mobile_device_aliases (
    tenant_id TEXT NOT NULL,
    ip TEXT NOT NULL,
    alias TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, ip)
  )`,
  `CREATE TABLE IF NOT EXISTS user_quick_links (
    user_id TEXT NOT NULL,
    view_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, view_id)
  )`,
  `CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_code TEXT NOT NULL,
    PRIMARY KEY (role_id, permission_code)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_users_tenant_role ON users(tenant_id, role, active)",
  "CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue(synced_at, retry_count, id)",
  "CREATE INDEX IF NOT EXISTS idx_pending_deletes_status ON pending_deletes(status, id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_date ON audit_log(tenant_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS audit_log_items (
    id          TEXT PRIMARY KEY,
    audit_id    TEXT NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    label       TEXT,
    quantity    REAL,
    unit_price  REAL,
    subtotal    REAL,
    note        TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_audit_log_items_audit ON audit_log_items(audit_id)",
];

class DatabaseManager {
  private databasePromise: Promise<SqliteDatabase> | null = null;
  private secondaryPromise: Promise<SqliteDatabase> | null = null;
  private _dualWriteEnabled = false;

  enableDualWrite() { this._dualWriteEnabled = true; }
  disableDualWrite() { this._dualWriteEnabled = false; this.secondaryPromise = null; }

  /** Cierra y resetea la conexion principal (usar tras reemplazar el archivo de DB). */
  async resetPrimary() {
    if (this.databasePromise) {
      const db = await this.databasePromise.catch(() => null);
      if (db) await db.close().catch(() => {});
      this.databasePromise = null;
    }
  }

  async database(): Promise<SqliteDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = this.openAndMigrate("sqlite:madpost.db");
    }
    const primary = await this.databasePromise;
    if (!this._dualWriteEnabled) return primary;

    const secondary = await this.secondaryDatabase();
    return new Proxy(primary, {
      get(target, prop) {
        if (prop === "execute") {
          return async (sql: string, values?: unknown[]) => {
            const result = await (target.execute as (sql: string, values?: unknown[]) => Promise<unknown>)(sql, values);
            (secondary.execute as (sql: string, values?: unknown[]) => Promise<unknown>)(sql, values).catch(() => {});
            return result;
          };
        }
        return (target as unknown as Record<string | symbol, unknown>)[prop];
      },
    }) as SqliteDatabase;
  }

  async secondaryDatabase(): Promise<SqliteDatabase> {
    if (!this.secondaryPromise) {
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      const base = await appDataDir();
      const javaDbPath = await join(base, "..", "MadPost", "madpost.db");
      this.secondaryPromise = Database.load(`sqlite:${javaDbPath}`);
    }
    return this.secondaryPromise;
  }

  private async openAndMigrate(path: string): Promise<SqliteDatabase> {
    const database = await Database.load(path);
    await this.migrateLegacySyncQueue(database);
    for (const statement of migrations) {
      await database.execute(statement);
    }
    await this.ensureColumn(database, "tenants", "last_synced_at", "TEXT");
    await this.ensureColumn(database, "tenants", "invoice_footer", "TEXT");
    await this.ensureColumn(database, "tenants", "max_sauces", "INTEGER");
    await this.ensureColumn(database, "tenants", "stock_alert_threshold", "REAL");
    await this.ensureColumn(database, "tenants", "printer_receipt", "TEXT");
    await this.ensureColumn(database, "tenants", "printer_kitchen", "TEXT");
    await this.ensureColumn(database, "tenants", "comanda_copies", "INTEGER");
    await this.ensureColumn(database, "tenants", "delivery_whatsapp", "TEXT");
    await this.ensureColumn(database, "tenants", "mobile_server_enabled", "INTEGER NOT NULL DEFAULT 0");
    await this.ensureColumn(database, "table_order_clients", "notes", "TEXT");
    await this.ensureColumn(database, "table_order_clients", "is_card", "INTEGER");
    await this.ensureColumn(database, "table_orders", "comanda_sent", "INTEGER");
    await this.ensureColumn(database, "table_order_items", "updated_at", "TEXT");
    await this.ensureColumn(database, "tenants", "react_migrated", "INTEGER NOT NULL DEFAULT 0");
    await database.execute("DROP TABLE IF EXISTS addition_supplies");
    await this.dropRoleCheckConstraint(database);
    return database;
  }

  private async migrateLegacySyncQueue(database: SqliteDatabase) {
    const columns = await database.select<{ name: string }[]>("PRAGMA table_info(sync_queue)");
    if (!columns.length || columns.some((column) => column.name === "table_name")) return;
    const hasLegacyShape = columns.some((column) => column.name === "entity_type") && columns.some((column) => column.name === "entity_id");
    if (!hasLegacyShape) return;
    await database.execute("ALTER TABLE sync_queue RENAME TO sync_queue_legacy");
    await database.execute(`CREATE TABLE sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      synced_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    )`);
    await database.execute(`INSERT INTO sync_queue(table_name, record_id, action, payload_json, created_at, synced_at, retry_count)
      SELECT CASE entity_type WHEN 'USER' THEN 'users' ELSE lower(entity_type) END,
        entity_id, action, payload, created_at,
        CASE WHEN status = 'SYNCED' THEN synced_at ELSE NULL END, 0
      FROM sync_queue_legacy`);
    await database.execute("DROP TABLE sync_queue_legacy");
  }

  /** Elimina el CHECK constraint de role en users si todavia existe (migracion unica). */
  private async dropRoleCheckConstraint(database: SqliteDatabase) {
    const rows = await database.select<{ sql: string }[]>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
    );
    const tableSql = rows[0]?.sql ?? "";
    // Si el CHECK ya fue eliminado, no hacer nada
    if (!tableSql.includes("CHECK (role IN")) return;

    await database.execute("ALTER TABLE users RENAME TO users_old");
    await database.execute(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, username)
    )`);
    await database.execute("INSERT INTO users SELECT * FROM users_old");
    await database.execute("DROP TABLE users_old");
  }

  private async ensureColumn(database: SqliteDatabase, table: string, column: string, definition: string) {
    const columns = await database.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
    if (!columns.some((entry) => entry.name === column)) {
      await database.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export const databaseManager = new DatabaseManager();
