import { syncQueueRepository, tenantRepository, type SyncQueueEntry } from "../../infrastructure/sqlite/repositories";
import { supabaseConnection } from "../../infrastructure/supabase/SupabaseClient";
import { runtimeLogger } from "../runtime/RuntimeLogger";
import { connectivityMonitor } from "./ConnectivityMonitor";

export type SyncRuntimeContext = { tenantId: string; syncEnabled: boolean };

class SyncService {
  private timerId: number | null = null;
  private started = false;
  private running = false;

  async start(context: SyncRuntimeContext) {
    if (!context.syncEnabled) {
      runtimeLogger.info("SyncService", "No iniciado: sync deshabilitado por licencia.");
      return;
    }
    if (this.started) return;
    this.started = true;
    connectivityMonitor.start();
    runtimeLogger.info("SyncService", "Iniciado.", { tenantId: context.tenantId, initialDelaySeconds: 5, intervalSeconds: 60 });
    this.schedule(context, 5_000);
  }

  async stop() {
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.timerId = null;
    this.started = false;
    this.running = false;
    connectivityMonitor.stop();
    runtimeLogger.info("SyncService", "Detenido.");
  }

  private schedule(context: SyncRuntimeContext, delayMs: number) {
    this.timerId = window.setTimeout(async () => {
      await this.syncIfOnline(context);
      if (this.started) this.schedule(context, 60_000);
    }, delayMs);
  }

  private async syncIfOnline(context: SyncRuntimeContext) {
    if (!connectivityMonitor.isOnline()) return;
    if (this.running) return;
    this.running = true;
    try { await this.processSyncQueue(context.tenantId); }
    catch (error) { runtimeLogger.error("SyncService", "Fallo el ciclo de sincronizacion.", error); }
    finally { this.running = false; }
  }

  private async processSyncQueue(tenantId: string) {
    const entries = await syncQueueRepository.loadPending(50);
    if (!entries.length) return;
    let synced = 0;
    runtimeLogger.info("SyncService", "Procesando cola.", { entries: entries.length });
    for (const entry of entries) {
      try {
        await this.pushEntry(entry);
        await syncQueueRepository.markSynced(entry.id, new Date().toISOString());
        synced += 1;
      } catch (error) {
        await syncQueueRepository.incrementRetry(entry.id);
        runtimeLogger.error("SyncService", `Fallo la entrada id=${entry.id} tabla=${entry.table_name} accion=${entry.action}.`, error);
      }
    }
    if (synced > 0) await this.updateLastSyncedAt(tenantId);
  }

  private async pushEntry(entry: SyncQueueEntry) {
    if (entry.action === "DELETE") {
      // Entity deletes with cascades stay in DeleteSyncService. Combo items are replaced independently on combo edits.
      if (entry.table_name !== "combo_items") return;
      const { error } = await supabaseConnection.getClient().from("combo_items").delete().eq("id", entry.record_id);
      if (error) throw new Error(error.message);
      return;
    }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(entry.payload_json) as Record<string, unknown>; }
    catch { throw new Error("payload_json invalido"); }
    if (!payload || Array.isArray(payload)) throw new Error("payload_json debe ser un objeto JSON");
    const client = supabaseConnection.getClient();
    const { error } = entry.action === "INSERT"
      ? await client.from(entry.table_name).upsert(payload)
      : await client.from(entry.table_name).update(payload).eq("id", entry.record_id);
    if (error) throw new Error(error.message);
  }

  private async updateLastSyncedAt(tenantId: string) {
    const syncedAt = new Date().toISOString();
    try {
      await tenantRepository.updateLastSyncedAt(tenantId, syncedAt);
      const { error } = await supabaseConnection.getClient().from("tenants").update({ last_synced_at: syncedAt }).eq("id", tenantId);
      if (error) throw new Error(error.message);
      runtimeLogger.info("SyncService", "last_synced_at actualizado.", { tenantId, syncedAt });
    } catch (error) {
      runtimeLogger.error("SyncService", "No fue posible actualizar last_synced_at.", error);
    }
  }
}

export const syncService = new SyncService();
