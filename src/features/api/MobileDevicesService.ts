import { invoke } from "@tauri-apps/api/core";
import { sessionContext } from "../../core/session/SessionContext";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";

export type MobileClient = { ip: string; connected_at: string };
export type MobileApiStatus = { active: boolean; port: number; local_ip: string | null; clients: MobileClient[] };
export type DeviceAlias = { ip: string; alias: string };

class MobileDevicesService {
  async status() { return invoke<MobileApiStatus>("mobile_api_status"); }
  async aliases(): Promise<DeviceAlias[]> { const database = await databaseManager.database(); const rows = await database.select<DeviceAlias[]>("SELECT ip,alias FROM mobile_device_aliases WHERE tenant_id=$1 ORDER BY updated_at DESC", [this.tenantId()]); return rows; }
  async setAlias(ip: string, alias: string) { const database = await databaseManager.database(); await database.execute("INSERT INTO mobile_device_aliases(tenant_id,ip,alias,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,ip) DO UPDATE SET alias=excluded.alias,updated_at=excluded.updated_at", [this.tenantId(), ip, alias.trim(), new Date().toISOString()]); }
  private tenantId() { const tenantId = sessionContext.current()?.tenantId; if (!tenantId) throw new Error("No hay una sesion activa."); return tenantId; }
}

export const mobileDevicesService = new MobileDevicesService();
