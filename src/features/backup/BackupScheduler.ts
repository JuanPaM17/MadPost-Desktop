import { runtimeLogger } from "../runtime/RuntimeLogger";
import { connectivityMonitor } from "../sync/ConnectivityMonitor";
import type { RuntimeContext } from "../runtime/PostLoginCoordinator";
import { backupService } from "./BackupService";
import { backupScheduleRepository } from "../../infrastructure/sqlite/repositories";

const HOURLY = 60 * 60 * 1000;

class BackupScheduler {
  private hourlyTimerId: number | null = null;
  private fixedTimerId: number | null = null;
  private nextHourlyAt: Date | null = null;
  private nextFixedAt: Date | null = null;
  private unsubscribeConnectivity: (() => void) | null = null;
  private started = false;
  private context: RuntimeContext | null = null;

  async start(context: RuntimeContext) {
    if (this.started) return;
    this.started = true;
    this.context = context;
    connectivityMonitor.start();
    this.unsubscribeConnectivity = connectivityMonitor.subscribe((online, previousOnline) => {
      if (online && !previousOnline) void this.uploadPending(context);
    });
    // Slots fijos: 5:30 PM y 11:00 PM — siempre activos independiente de la caja
    this.scheduleNextFixed(context);
    // Al iniciar subir pendientes y purgar
    void this.uploadPending(context);
    void backupService.purgeOldBackups(context.tenantId).catch(() => {});
    // Retomar timer horario si habia caja abierta al cerrar sesion
    await this.resumeHourlyIfNeeded(context);
    runtimeLogger.info("BackupScheduler", "Iniciado.");
  }

  async stop() {
    this.clearHourlyTimer();
    this.clearFixedTimer();
    this.unsubscribeConnectivity?.();
    this.unsubscribeConnectivity = null;
    this.context = null;
    this.started = false;
    runtimeLogger.info("BackupScheduler", "Detenido.");
  }

  getNextScheduledTime(): Date | null {
    const candidates = [this.nextHourlyAt, this.nextFixedAt].filter((d): d is Date => d !== null);
    if (!candidates.length) return null;
    return candidates.reduce((a, b) => a < b ? a : b);
  }

  /** Llamar al abrir caja real (no demo). */
  async onCashSessionOpened(tenantId: string) {
    if (!this.started || !this.context) return;
    const now = new Date().toISOString();
    await backupScheduleRepository.setCashOpened(now);
    await this.runHourlyBackup(this.context);
  }

  /** Llamar al cerrar caja real (no demo). */
  async onCashSessionClosed(tenantId: string) {
    if (!this.started || !this.context) return;
    const now = new Date().toISOString();
    await backupScheduleRepository.setCashClosed(now);
    this.clearHourlyTimer();
    // Backup final al cerrar caja
    try {
      runtimeLogger.info("BackupScheduler", "Backup al cerrar caja.");
      const result = await backupService.createBackup(this.context.tenantId);
      if (result.error) runtimeLogger.info("BackupScheduler", "Backup cierre con aviso.", { error: result.error });
      await backupScheduleRepository.setLastBackup(new Date().toISOString());
      await this.uploadPending(this.context);
    } catch (error) { runtimeLogger.error("BackupScheduler", "Fallo el backup al cerrar caja.", error); }
  }

  // ── Privados ──────────────────────────────────────────────────────────────

  private async resumeHourlyIfNeeded(context: RuntimeContext) {
    try {
      const row = await backupScheduleRepository.load();
      const cashOpen = row.cash_opened_at ? new Date(row.cash_opened_at) : null;
      const cashClose = row.cash_closed_at ? new Date(row.cash_closed_at) : null;
      const cajaAbierta = cashOpen && (!cashClose || cashOpen > cashClose);
      if (!cajaAbierta) return;
      const lastBackup = row.last_backup_at ? new Date(row.last_backup_at) : null;
      if (!lastBackup) { await this.runHourlyBackup(context); return; }
      const elapsed = Date.now() - lastBackup.getTime();
      if (elapsed >= HOURLY) {
        runtimeLogger.info("BackupScheduler", "Backup pendiente por caja abierta al retomar sesion.");
        await this.runHourlyBackup(context);
      } else {
        const remaining = HOURLY - elapsed;
        this.nextHourlyAt = new Date(Date.now() + remaining);
        this.hourlyTimerId = window.setTimeout(() => void this.runHourlyBackup(context), remaining);
        runtimeLogger.info("BackupScheduler", "Timer horario retomado.", { remainingMinutes: Math.floor(remaining / 60_000) });
      }
    } catch (error) { runtimeLogger.error("BackupScheduler", "No se pudo retomar el timer horario.", error); }
  }

  private async runHourlyBackup(context: RuntimeContext) {
    this.clearHourlyTimer();
    try {
      runtimeLogger.info("BackupScheduler", "Ejecutando backup horario.");
      // Verificar que la caja sigue abierta antes de ejecutar
      const row = await backupScheduleRepository.load();
      const cashOpen = row.cash_opened_at ? new Date(row.cash_opened_at) : null;
      const cashClose = row.cash_closed_at ? new Date(row.cash_closed_at) : null;
      const cajaAbierta = cashOpen && (!cashClose || cashOpen > cashClose);
      if (!cajaAbierta) { runtimeLogger.info("BackupScheduler", "Caja cerrada, cancelando timer horario."); return; }
      const result = await backupService.createBackup(context.tenantId);
      if (result.error) runtimeLogger.info("BackupScheduler", "Backup horario con aviso.", { error: result.error });
      await backupScheduleRepository.setLastBackup(new Date().toISOString());
      await this.uploadPending(context);
    } catch (error) { runtimeLogger.error("BackupScheduler", "Fallo el backup horario.", error); }
    if (this.started) {
      this.nextHourlyAt = new Date(Date.now() + HOURLY);
      this.hourlyTimerId = window.setTimeout(() => void this.runHourlyBackup(context), HOURLY);
    }
  }

  private scheduleNextFixed(context: RuntimeContext) {
    const delay = msToNextFixedSlot();
    this.nextFixedAt = new Date(Date.now() + delay);
    this.fixedTimerId = window.setTimeout(() => void this.runFixedBackup(context), delay);
    runtimeLogger.info("BackupScheduler", "Proximo backup fijo.", { minutesAway: Math.floor(delay / 60_000) });
  }

  private async runFixedBackup(context: RuntimeContext) {
    try {
      runtimeLogger.info("BackupScheduler", "Ejecutando backup fijo programado.");
      const result = await backupService.createBackup(context.tenantId);
      if (result.error) runtimeLogger.info("BackupScheduler", "Backup fijo con aviso.", { error: result.error });
      await backupScheduleRepository.setLastBackup(new Date().toISOString());
      await this.uploadPending(context);
      await backupService.purgeOldBackups(context.tenantId);
    } catch (error) { runtimeLogger.error("BackupScheduler", "Fallo el backup fijo.", error); }
    if (this.started) this.scheduleNextFixed(context);
  }

  private clearHourlyTimer() {
    if (this.hourlyTimerId !== null) window.clearTimeout(this.hourlyTimerId);
    this.hourlyTimerId = null;
    this.nextHourlyAt = null;
  }

  private clearFixedTimer() {
    if (this.fixedTimerId !== null) window.clearTimeout(this.fixedTimerId);
    this.fixedTimerId = null;
    this.nextFixedAt = null;
  }

  private async uploadPending(context: RuntimeContext) {
    await backupService.uploadPendingBackups(context.tenantId);
    await backupService.uploadPendingLogs(context.tenantId);
  }
}

function slot(date: Date, hour: number, minute = 0) { const d = new Date(date); d.setHours(hour, minute, 0, 0); return d; }
function daysAhead(days: number) { const d = new Date(); d.setDate(d.getDate() + days); return d; }
function msToNextFixedSlot() {
  const now = new Date();
  const s1730 = slot(now, 17, 30);
  const s2300 = slot(now, 23, 0);
  if (now < s1730) return s1730.getTime() - now.getTime();
  if (now < s2300) return s2300.getTime() - now.getTime();
  return slot(daysAhead(1), 17, 30).getTime() - now.getTime();
}

export const backupScheduler = new BackupScheduler();
