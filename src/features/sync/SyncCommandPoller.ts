import { backupService } from "../backup/BackupService";
import type { RuntimeContext } from "../runtime/PostLoginCoordinator";
import { runtimeLogger } from "../runtime/RuntimeLogger";
import { supabaseConnection } from "../../infrastructure/supabase/SupabaseClient";
import { connectivityMonitor } from "./ConnectivityMonitor";
import { fullSyncService, type TableSyncProgress } from "./FullSyncService";

type SyncCommand = { id: string; expires_at: string | null };

class SyncCommandPoller {
  private started = false;
  private running = false;
  private timerId: number | null = null;
  private context: RuntimeContext | null = null;

  async start(context: RuntimeContext) {
    if (!context.syncEnabled) return runtimeLogger.info("SyncCommandPoller", "No iniciado: sync deshabilitado por licencia.");
    if (this.started) return;
    this.started = true;
    this.context = context;
    connectivityMonitor.start();
    this.timerId = window.setTimeout(() => void this.runAndSchedule(), 60_000);
    runtimeLogger.info("SyncCommandPoller", "Iniciado.", { tenantId: context.tenantId, initialDelaySeconds: 60, intervalMinutes: 5 });
  }

  async stop() {
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.timerId = null;
    this.started = false;
    this.context = null;
    fullSyncService.cancel();
    runtimeLogger.info("SyncCommandPoller", "Detenido.");
  }

  private async runAndSchedule() {
    await this.pollOnce();
    if (this.started) this.timerId = window.setTimeout(() => void this.runAndSchedule(), 5 * 60_000);
  }

  private async pollOnce() {
    const context = this.context;
    if (!context || !connectivityMonitor.isOnline()) return;
    try {
      const client = supabaseConnection.getClient();
      const { data, error } = await client.from("sync_commands").select("id, expires_at").eq("tenant_id", context.tenantId).eq("status", "pending").order("requested_at", { ascending: true }).limit(1);
      if (error) throw error;
      const command = data?.[0] as SyncCommand | undefined;
      if (!command) return;
      if (command.expires_at && Date.parse(command.expires_at) < Date.now()) {
        await this.patchCommand(command.id, { status: "expired" });
        runtimeLogger.info("SyncCommandPoller", "Comando expirado marcado.", { commandId: command.id });
        return;
      }
      if (this.running) { runtimeLogger.info("SyncCommandPoller", "Sync ya en ejecucion; comando omitido.", { commandId: command.id }); return; }
      this.running = true;
      await this.executeCommand(command.id, context);
    } catch (error) {
      runtimeLogger.error("SyncCommandPoller", "Error consultando sync_commands.", error);
    }
  }

  private async executeCommand(commandId: string, context: RuntimeContext) {
    try {
      await this.patchCommand(commandId, { status: "running", started_at: new Date().toISOString() });
      const startedAt = Date.now();
      const progress: TableSyncProgress[] = [];
      const result = await fullSyncService.resetAndSync(context.tenantId, (entry) => progress.push(entry));
      const durationSecs = Math.floor((Date.now() - startedAt) / 1000);
      const elapsed = `${String(Math.floor(durationSecs / 60)).padStart(2, "0")}:${String(durationSecs % 60).padStart(2, "0")}`;
      const resultSummary = result.ok ? `${result.completedTables}/${fullSyncService.tables.length} tablas OK - ${elapsed}` : `Error en sync - ${result.completedTables}/${fullSyncService.tables.length} tablas OK`;
      const backup = await backupService.createBackup(context.tenantId);
      // Deduplicar: quedarse con la ultima entrada por tabla (estado final)
      const finalByTable = new Map<string, TableSyncProgress>();
      for (const entry of progress) finalByTable.set(entry.tableName, entry);
      const syncLog = Array.from(finalByTable.values()).map((entry) => ({
        table: entry.tableName,
        status: entry.status.toLowerCase(),
        records: entry.totalRecords,
        ...(entry.error ? { error: entry.error } : {}),
        log: entry.logLines.map((line) => {
          const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(line);
          if (!match) return line;
          const d = new Date(match[1]);
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          const ss = String(d.getSeconds()).padStart(2, "0");
          return `${hh}:${mm}:${ss} \u2014 ${line.replace(/^\S+ - /, "")}`;
        }),
      }));
      await this.patchCommand(commandId, {
        status: result.ok ? "done" : "error", finished_at: new Date().toISOString(), duration_secs: durationSecs,
        result_summary: resultSummary, sync_log_json: JSON.stringify(syncLog), backup_ok: backup.uploadedToR2,
        backup_error: backup.error,
      });
      runtimeLogger.info("SyncCommandPoller", "Comando finalizado.", { commandId, resultSummary, backupOk: backup.uploadedToR2 });
    } catch (error) {
      runtimeLogger.error("SyncCommandPoller", "Fallo ejecutando comando remoto.", error);
      try { await this.patchCommand(commandId, { status: "error", finished_at: new Date().toISOString(), backup_ok: false, backup_error: errorMessage(error) }); }
      catch (patchError) { runtimeLogger.error("SyncCommandPoller", "No se pudo reportar el fallo del comando.", patchError); }
    } finally { this.running = false; }
  }

  private async patchCommand(commandId: string, fields: Record<string, unknown>) {
    const { error } = await supabaseConnection.getClient().from("sync_commands").update(fields).eq("id", commandId);
    if (error) throw new Error(error.message);
  }
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
export const syncCommandPoller = new SyncCommandPoller();
