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
  async loadAutoStart(): Promise<boolean> { const database = await databaseManager.database(); const rows = await database.select<{ mobile_server_enabled: number }[]>("SELECT mobile_server_enabled FROM tenants WHERE id=$1", [this.tenantId()]); return (rows[0]?.mobile_server_enabled ?? 0) === 1; }
  async saveAutoStart(enabled: boolean): Promise<void> { const database = await databaseManager.database(); await database.execute("UPDATE tenants SET mobile_server_enabled=$1 WHERE id=$2", [enabled ? 1 : 0, this.tenantId()]); }
  async startServer(): Promise<void> { const ctx = sessionContext.current(); if (!ctx) throw new Error("Sin sesion activa."); await invoke("start_mobile_api", { tenantId: ctx.tenantId, tenantName: ctx.tenantName }); await invoke("publish_mdns", { tenantId: ctx.tenantId, tenantName: ctx.tenantName }); }
  async stopServer(): Promise<void> { await invoke("stop_mobile_api"); await invoke("unpublish_mdns"); }
  private tenantId() { const tenantId = sessionContext.current()?.tenantId; if (!tenantId) throw new Error("No hay una sesion activa."); return tenantId; }
}

export const mobileDevicesService = new MobileDevicesService();
