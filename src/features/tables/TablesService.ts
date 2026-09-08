import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { sessionContext } from "../../core/session/SessionContext";

export type RestaurantTable = {
  id: string;
  tenant_id: string;
  name: string;
  shape: "SQUARE" | "ROUND" | "RECTANGLE";
  width: number;
  height: number;
  pos_x: number;
  pos_y: number;
  type: "TABLE" | "WALL";
  floor: number;
  active: number;
  created_at: string;
  updated_at: string;
};

const instantNow = () => new Date().toISOString();
function uuid() { return crypto.randomUUID(); }

export const tablesService = {
  async listByFloor(tenantId: string, floor: number): Promise<RestaurantTable[]> {
    const db = await databaseManager.database();
    return db.select<RestaurantTable[]>(
      "SELECT id, tenant_id, name, shape, width, height, pos_x, pos_y, type, floor, active, created_at, updated_at FROM restaurant_tables WHERE tenant_id = $1 AND floor = $2 AND active = 1",
      [tenantId, floor],
    );
  },

  async listFloors(tenantId: string): Promise<number[]> {
    const db = await databaseManager.database();
    const rows = await db.select<{ floor: number }[]>(
      "SELECT DISTINCT CAST(floor AS INTEGER) AS floor FROM restaurant_tables WHERE tenant_id = $1 AND active = 1 ORDER BY floor ASC",
      [tenantId],
    );
    return rows.map((r) => r.floor);
  },

  async create(tenantId: string, data: Omit<RestaurantTable, "id" | "tenant_id" | "created_at" | "updated_at" | "active">): Promise<RestaurantTable> {
    const db = await databaseManager.database();
    const now = instantNow();
    const id = uuid();
    await db.execute(
      "INSERT INTO restaurant_tables(id, tenant_id, name, shape, width, height, pos_x, pos_y, type, floor, active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11)",
      [id, tenantId, data.name, data.shape, data.width, data.height, data.pos_x, data.pos_y, data.type, data.floor, now],
    );
    return { id, tenant_id: tenantId, active: 1, created_at: now, updated_at: now, ...data };
  },

  async update(table: RestaurantTable): Promise<void> {
    const db = await databaseManager.database();
    const now = instantNow();
    await db.execute(
      "UPDATE restaurant_tables SET name=$1, shape=$2, width=$3, height=$4, pos_x=$5, pos_y=$6, type=$7, floor=$8, updated_at=$9 WHERE id=$10",
      [table.name, table.shape, table.width, table.height, table.pos_x, table.pos_y, table.type, table.floor, now, table.id],
    );
  },

  async updatePosition(id: string, pos_x: number, pos_y: number): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE restaurant_tables SET pos_x=$1, pos_y=$2, updated_at=$3 WHERE id=$4", [pos_x, pos_y, instantNow(), id]);
  },

  async updateSize(id: string, width: number, height: number): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE restaurant_tables SET width=$1, height=$2, updated_at=$3 WHERE id=$4", [width, height, instantNow(), id]);
  },

  async delete(id: string): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("UPDATE restaurant_tables SET active=0, updated_at=$1 WHERE id=$2", [instantNow(), id]);
  },

  async clone(source: RestaurantTable, overrides: Partial<RestaurantTable> = {}): Promise<RestaurantTable> {
    const merged = { ...source, ...overrides };
    return this.create(source.tenant_id, {
      name: merged.name,
      shape: merged.shape,
      width: merged.width,
      height: merged.height,
      pos_x: merged.pos_x,
      pos_y: merged.pos_y,
      type: merged.type,
      floor: merged.floor,
    });
  },

  async cloneFloor(tenantId: string, fromFloor: number, toFloor: number): Promise<void> {
    const db = await databaseManager.database();
    const now = instantNow();
    const rows = await db.select<RestaurantTable[]>(
      "SELECT * FROM restaurant_tables WHERE tenant_id=$1 AND floor=$2 AND active=1",
      [tenantId, fromFloor],
    );
    for (const row of rows) {
      const newId = uuid();
      await db.execute(
        "INSERT INTO restaurant_tables(id, tenant_id, name, shape, width, height, pos_x, pos_y, type, floor, active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11)",
        [newId, tenantId, row.name, row.shape, row.width, row.height, row.pos_x, row.pos_y, row.type, toFloor, now],
      );
    }
  },

  async deleteFloor(tenantId: string, floor: number): Promise<void> {
    const db = await databaseManager.database();
    const now = instantNow();
    // Soft-delete the floor
    await db.execute("UPDATE restaurant_tables SET active=0, updated_at=$1 WHERE tenant_id=$2 AND floor=$3", [now, tenantId, floor]);
    // Shift all higher floors down by 1
    const higher = await db.select<{ floor: number }[]>(
      "SELECT DISTINCT CAST(floor AS INTEGER) AS floor FROM restaurant_tables WHERE tenant_id=$1 AND floor>$2 AND active=1 ORDER BY floor ASC",
      [tenantId, floor],
    );
    for (const row of higher) {
      await db.execute("UPDATE restaurant_tables SET floor=$1, updated_at=$2 WHERE tenant_id=$3 AND floor=$4 AND active=1", [row.floor - 1, now, tenantId, row.floor]);
    }
  },

  tenantId(): string {
    return sessionContext.current()?.tenantId ?? "";
  },
};
