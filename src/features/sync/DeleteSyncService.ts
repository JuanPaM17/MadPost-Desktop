import { pendingDeletesRepository, type PendingDeleteEntry } from "../../infrastructure/sqlite/repositories";
import { supabaseConnection } from "../../infrastructure/supabase/SupabaseClient";
import { runtimeLogger } from "../runtime/RuntimeLogger";
import { connectivityMonitor } from "./ConnectivityMonitor";
import type { SyncRuntimeContext } from "./SyncService";

const rpcByTable: Record<string, { name: string; parameter: string }> = {
  sales: { name: "delete_sale", parameter: "p_sale_id" },
  cash_sessions: { name: "delete_cash_session", parameter: "p_session_id" },
  users: { name: "delete_user", parameter: "p_user_id" },
  categories: { name: "delete_category", parameter: "p_category_id" },
  additions: { name: "delete_addition", parameter: "p_addition_id" },
  products: { name: "delete_product", parameter: "p_product_id" },
  combos: { name: "delete_combo", parameter: "p_combo_id" },
  sauces: { name: "delete_sauce", parameter: "p_sauce_id" },
  discounts: { name: "delete_discount", parameter: "p_discount_id" },
  delivery_types: { name: "delete_delivery_type", parameter: "p_delivery_type_id" },
  product_supplies: { name: "delete_product_supplies", parameter: "p_product_id" },
  supplies: { name: "delete_supply", parameter: "p_supply_id" },
};

class DeleteSyncService {
  private timerId: number | null = null;
  private started = false;
  private running = false;

  async start(context: SyncRuntimeContext) {
    if (!context.syncEnabled) {
      runtimeLogger.info("DeleteSyncService", "No iniciado: sync deshabilitado por licencia.");
      return;
    }
    if (this.started) return;
    this.started = true;
    runtimeLogger.info("DeleteSyncService", "Iniciado.", { tenantId: context.tenantId, initialDelaySeconds: 2, intervalSeconds: 60 });
    this.schedule();
  }

  async stop() {
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.timerId = null;
    this.started = false;
    this.running = false;
    runtimeLogger.info("DeleteSyncService", "Detenido.");
  }

  private schedule() {
    this.timerId = window.setTimeout(async () => {
      await this.runIfOnline();
      if (this.started) this.scheduleNext();
    }, 2_000);
  }

  private scheduleNext() {
    this.timerId = window.setTimeout(async () => {
      await this.runIfOnline();
      if (this.started) this.scheduleNext();
    }, 60_000);
  }

  private async runIfOnline() {
    if (!connectivityMonitor.isOnline() || this.running) return;
    this.running = true;
    try { await this.processPendingDeletes(); }
    catch (error) { runtimeLogger.error("DeleteSyncService", "Fallo el ciclo de eliminaciones.", error); }
    finally { this.running = false; }
  }

  private async processPendingDeletes() {
    const pending = await pendingDeletesRepository.loadPending();
    if (!pending.length) return;
    runtimeLogger.info("DeleteSyncService", "Procesando eliminaciones pendientes.", { entries: pending.length });
    for (const entry of pending) {
      try {
        await this.callRpc(entry);
        await pendingDeletesRepository.markDone(entry.id);
        runtimeLogger.info("DeleteSyncService", "Eliminacion aplicada.", { table: entry.table_name, recordId: entry.record_id });
      } catch (error) {
        await pendingDeletesRepository.incrementAttempts(entry.id);
        runtimeLogger.error("DeleteSyncService", `Fallo eliminacion id=${entry.id} tabla=${entry.table_name} intento=${entry.attempts + 1}.`, error);
      }
    }
  }

  private async callRpc(entry: PendingDeleteEntry) {
    const rpc = rpcByTable[entry.table_name];
    if (!rpc) throw new Error(`No existe RPC configurado para la tabla ${entry.table_name}.`);
    const { error } = await supabaseConnection.getClient().rpc(rpc.name, { [rpc.parameter]: entry.record_id });
    if (error) throw new Error(error.message);
  }
}

export const deleteSyncService = new DeleteSyncService();
