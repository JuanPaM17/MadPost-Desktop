import { runtimeLogger } from "../runtime/RuntimeLogger";
import { connectivityMonitor } from "../sync/ConnectivityMonitor";
import type { RuntimeContext } from "../runtime/PostLoginCoordinator";
import { backupService } from "./BackupService";

class BackupScheduler {
  private timerId: number | null = null;
  private unsubscribeConnectivity: (() => void) | null = null;
  private started = false;

  async start(context: RuntimeContext) {
    if (this.started) return;
    this.started = true;
    connectivityMonitor.start();
    this.unsubscribeConnectivity = connectivityMonitor.subscribe((online, previousOnline) => {
      if (online && !previousOnline) void this.uploadPending(context);
    });
    void this.runStartup(context);
    const delay = millisecondsToNextSlot();
    this.timerId = window.setTimeout(() => void this.runScheduled(context), delay);
    runtimeLogger.info("BackupScheduler", "Iniciado.", { nextBackupMinutes: Math.floor(delay / 60_000) });
  }

  async stop() {
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.timerId = null;
    this.unsubscribeConnectivity?.(); this.unsubscribeConnectivity = null;
    this.started = false;
    runtimeLogger.info("BackupScheduler", "Detenido.");
  }

  private async runStartup(context: RuntimeContext) {
    try {
      await this.checkMissedBackup(context);
      await this.uploadPending(context);
      await backupService.purgeOldBackups(context.tenantId);
    } catch (error) { runtimeLogger.error("BackupScheduler", "Fallo la preparacion inicial de backups.", error); }
  }

  private async runScheduled(context: RuntimeContext) {
    try {
      runtimeLogger.info("BackupScheduler", "Ejecutando backup programado.");
      const result = await backupService.createBackup(context.tenantId);
      if (result.error) runtimeLogger.info("BackupScheduler", "Backup programado con aviso.", { error: result.error });
      await this.uploadPending(context);
      await backupService.purgeOldBackups(context.tenantId);
    } catch (error) { runtimeLogger.error("BackupScheduler", "Fallo el backup programado.", error); }
    if (this.started) this.timerId = window.setTimeout(() => void this.runScheduled(context), 12 * 60 * 60 * 1000);
  }

  private async checkMissedBackup(context: RuntimeContext) {
    const last = await backupService.latestBackupTime();
    if (!last) { runtimeLogger.info("BackupScheduler", "No hay backups previos; creando el inicial."); await backupService.createBackup(context.tenantId); return; }
    const now = new Date();
    const candidates = [slot(daysAgo(1), 23), slot(now, 14), slot(now, 23)];
    if (candidates.some((candidate) => candidate > last && candidate < now)) { runtimeLogger.info("BackupScheduler", "Slot de backup perdido; creando copia de compensacion."); await backupService.createBackup(context.tenantId); }
  }

  private async uploadPending(context: RuntimeContext) { await backupService.uploadPendingBackups(context.tenantId); await backupService.uploadPendingLogs(context.tenantId); }
}

function slot(date: Date, hour: number) { const target = new Date(date); target.setHours(hour, 0, 0, 0); return target; }
function daysAgo(days: number) { const date = new Date(); date.setDate(date.getDate() - days); return date; }
function millisecondsToNextSlot() { const now = new Date(); const target = now < slot(now, 14) ? slot(now, 14) : now < slot(now, 23) ? slot(now, 23) : slot(daysAgo(-1), 14); return target.getTime() - now.getTime(); }

export const backupScheduler = new BackupScheduler();
