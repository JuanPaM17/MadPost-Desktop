import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { tenantRepository } from "../../infrastructure/sqlite/repositories";
import { supabaseConnection } from "../../infrastructure/supabase/SupabaseClient";
import { runtimeLogger } from "../runtime/RuntimeLogger";

const BATCH_SIZE = 500;

type ColumnSpec = { name: string; boolean?: true };
const columns = (specification: string[]) => specification.map((entry) => entry.endsWith("::bool") ? { name: entry.slice(0, -6), boolean: true as const } : { name: entry });

// This is intentionally explicit: it is the shared SQLite/Supabase contract and prevents accidental fields from being uploaded.
export const FULL_SYNC_TABLES = [
  ["tenants", columns(["id", "name", "logo_path", "address", "phone", "tax_id", "invoice_footer", "created_at", "updated_at", "max_sauces"])],
  ["users", columns(["id", "tenant_id", "username", "password_hash", "display_name", "role", "active::bool", "created_at", "updated_at"])],
  ["categories", columns(["id", "tenant_id", "name", "sort_order", "show_additions::bool", "show_sauces::bool", "hidden::bool", "created_at", "updated_at"])],
  ["products", columns(["id", "tenant_id", "category_id", "name", "price", "image_path", "active::bool", "created_at", "updated_at", "stock", "description"])],
  ["product_options", columns(["id", "product_id", "name", "active::bool", "sort_order"])],
  ["discounts", columns(["id", "tenant_id", "product_id", "discount_type", "discount_value", "active::bool", "start_date", "end_date", "created_at", "updated_at"])],
  ["additions", columns(["id", "tenant_id", "name", "price", "active::bool", "created_at", "updated_at", "stock", "quantity_per_sale"])],
  ["sauces", columns(["id", "tenant_id", "name", "active::bool", "created_at", "updated_at"])],
  ["supplies", columns(["id", "tenant_id", "name", "unit", "stock", "low_stock_threshold", "active::bool", "created_at", "updated_at"])],
  ["product_supplies", columns(["product_id", "supply_id", "quantity_per_sale"])],
  ["addition_supplies", columns(["addition_id", "supply_id", "quantity_per_sale"])],
  ["combos", columns(["id", "tenant_id", "name", "price", "image_path", "active::bool", "created_at", "updated_at"])],
  ["combo_items", columns(["id", "combo_id", "product_id", "quantity"])],
  ["cash_sessions", columns(["id", "tenant_id", "user_id", "session_number", "opening_amount", "closing_amount", "expected_amount", "status", "opened_at", "closed_at"])],
  ["restaurant_tables", columns(["id", "tenant_id", "name", "shape", "width", "height", "pos_x", "pos_y", "type", "floor", "active::bool", "created_at", "updated_at"])],
  ["delivery_types", columns(["id", "tenant_id", "name", "price", "sort_order", "created_at", "updated_at"])],
  ["sales", columns(["id", "tenant_id", "user_id", "cash_session_id", "total", "payment_method", "cash_given", "change_given", "invoice_number", "notes", "created_at", "is_delivery", "table_order_id", "cash_amount", "card_amount", "discount_type", "discount_value", "subtotal", "delivery_price", "client_name", "collected_by_user_id", "collected_by_display_name", "delivery_type_id", "delivery_type_name"])],
  ["sale_items", columns(["id", "sale_id", "product_id", "product_name", "quantity", "unit_price", "subtotal", "notes", "selected_option", "combo_id", "combo_sale_item_id", "original_unit_price", "category_name"])],
  ["sale_item_additions", columns(["id", "sale_item_id", "addition_id", "addition_name", "price", "quantity"])],
  ["sale_item_sauces", columns(["id", "sale_item_id", "sauce_id", "sauce_name"])],
  ["table_orders", columns(["id", "tenant_id", "table_id", "user_id", "cash_session_id", "client_name", "status", "opened_at", "closed_at", "notes", "customer_notes"])],
  ["table_order_clients", columns(["id", "table_order_id", "client_name", "client_number", "status", "created_at", "delivery_type_id"])],
  ["table_order_items", columns(["id", "table_order_id", "product_id", "product_name", "quantity", "unit_price", "subtotal", "added_at", "notes", "selected_option", "table_order_client_id", "combo_id", "combo_table_order_item_id", "original_unit_price", "category_name"])],
  ["table_order_item_additions", columns(["id", "table_order_item_id", "addition_id", "addition_name", "price", "quantity"])],
  ["table_order_item_sauces", columns(["id", "table_order_item_id", "sauce_id", "sauce_name"])],
  ["stock_logs", columns(["id", "tenant_id", "user_id", "user_name", "item_type", "item_id", "item_name", "delta", "stock_before", "stock_after", "created_at"])],
] as const satisfies readonly (readonly [string, readonly ColumnSpec[]])[];

export type TableSyncProgress = { tableName: string; totalRecords: number; status: "SYNCING" | "DONE" | "ERROR" | "CANCELLED"; error: string | null; logLines: string[] };
export type FullSyncResult = { ok: boolean; completedTables: number; progress: TableSyncProgress[] };

class FullSyncService {
  private cancelled = false;

  get tables() { return FULL_SYNC_TABLES.map(([table]) => table); }
  cancel() { this.cancelled = true; }
  reset() { this.cancelled = false; }

  async resetAndSync(tenantId: string, onProgress: (progress: TableSyncProgress) => void = () => {}): Promise<FullSyncResult> {
    this.reset();
    const progress: TableSyncProgress[] = [];
    const report = (entry: TableSyncProgress) => { progress.push(entry); onProgress(entry); };
    const resetLog = [logLine("Eliminando datos del tenant en la nube...")];
    report({ tableName: "__reset_nube__", totalRecords: 0, status: "SYNCING", error: null, logLines: resetLog });
    const client = supabaseConnection.getClient();
    const { error: resetError } = await client.rpc("delete_tenant_data", { p_tenant_id: tenantId });
    if (resetError) {
      const error = shortError(resetError.message);
      report({ tableName: "__reset_nube__", totalRecords: 0, status: "ERROR", error, logLines: [...resetLog, logLine(`ERROR al eliminar: ${error}`)] });
      return { ok: false, completedTables: 0, progress };
    }
    report({ tableName: "__reset_nube__", totalRecords: 0, status: "DONE", error: null, logLines: [...resetLog, logLine("Datos eliminados correctamente.")] });
    if (this.cancelled) return { ok: false, completedTables: 0, progress };

    const result = await this.syncAll(onProgress, progress);
    if (result.ok) {
      const database = await databaseManager.database();
      await database.execute("DELETE FROM sync_queue");
      await database.execute("DELETE FROM pending_deletes");
      const syncedAt = new Date().toISOString();
      await tenantRepository.updateLastSyncedAt(tenantId, syncedAt);
      const { error } = await client.from("tenants").update({ last_synced_at: syncedAt }).eq("id", tenantId);
      if (error) runtimeLogger.error("FullSyncService", "No se pudo actualizar last_synced_at remoto.", error);
    }
    return result;
  }

  private async syncAll(onProgress: (progress: TableSyncProgress) => void, progress: TableSyncProgress[]): Promise<FullSyncResult> {
    let errors = 0;
    let completedTables = 0;
    for (const [tableName, tableColumns] of FULL_SYNC_TABLES) {
      if (this.cancelled) {
        const entry = { tableName, totalRecords: 0, status: "CANCELLED" as const, error: null, logLines: [logLine("Cancelado antes de iniciar.")] };
        progress.push(entry); onProgress(entry);
        continue;
      }
      const database = await databaseManager.database();
      const selected = tableColumns.map((column) => column.name).join(", ");
      const rows = await database.select<Record<string, unknown>[]>(`SELECT ${selected} FROM ${tableName}`);
      const lines = [logLine(`Iniciando sincronizacion de ${rows.length} registro(s).`)];
      const notify = (entry: TableSyncProgress) => { progress.push(entry); onProgress(entry); };
      notify({ tableName, totalRecords: rows.length, status: "SYNCING", error: null, logLines: [...lines] });
      if (!rows.length) {
        completedTables++;
        notify({ tableName, totalRecords: 0, status: "DONE", error: null, logLines: [...lines, logLine("Tabla vacia, nada que sincronizar.")] });
        continue;
      }
      try {
        const client = supabaseConnection.getClient();
        let processed = 0;
        for (let index = 0; index < rows.length; index += BATCH_SIZE) {
          if (this.cancelled) throw new Error("SYNC_CANCELLED");
          const batch = rows.slice(index, index + BATCH_SIZE).map((row) => toRemoteRow(row, tableColumns));
          const { error } = await client.from(tableName).upsert(batch);
          if (error) throw new Error(error.message);
          processed += batch.length;
          lines.push(logLine(`Lote ${index / BATCH_SIZE + 1} enviado (${processed}/${rows.length} registros).`));
          notify({ tableName, totalRecords: rows.length, status: "SYNCING", error: null, logLines: [...lines] });
        }
        completedTables++;
        notify({ tableName, totalRecords: rows.length, status: "DONE", error: null, logLines: [...lines, logLine(`Sincronizacion completada. ${rows.length} registro(s) subidos.`)] });
      } catch (reason) {
        const cancelled = reason instanceof Error && reason.message === "SYNC_CANCELLED";
        const error = cancelled ? null : shortError(errorMessage(reason));
        if (!cancelled) errors++;
        notify({ tableName, totalRecords: rows.length, status: cancelled ? "CANCELLED" : "ERROR", error, logLines: [...lines, logLine(cancelled ? "Cancelado por el usuario." : `ERROR: ${error}`)] });
      }
    }
    return { ok: errors === 0 && !this.cancelled, completedTables, progress };
  }
}

function toRemoteRow(row: Record<string, unknown>, specifications: readonly ColumnSpec[]) {
  return Object.fromEntries(specifications.map(({ name, boolean }) => [name, boolean && row[name] !== null && row[name] !== undefined ? Number(row[name]) !== 0 : row[name] ?? null]));
}
function logLine(message: string) { return `${new Date().toISOString()} - ${message}`; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function shortError(error: string) { return error.length > 200 ? `${error.slice(0, 200)}...` : error; }

export const fullSyncService = new FullSyncService();
