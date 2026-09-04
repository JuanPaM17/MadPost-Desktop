import { BaseDirectory, copyFile, exists, mkdir, readDir, readFile, remove } from "@tauri-apps/plugin-fs";
import { tenantRepository } from "../../infrastructure/sqlite/repositories";
import { runtimeLogger } from "../runtime/RuntimeLogger";
import { connectivityMonitor } from "../sync/ConnectivityMonitor";
import { r2Client } from "./R2Client";

const BACKUP_DIRECTORY = "backups";
const LOG_DIRECTORY = "logs";
const BACKUP_PATTERN = /^madpost_backup_(\d{8}_\d{6})\.db$/;

export type BackupResult = { fileName: string | null; uploadedToR2: boolean; error: string | null };

class BackupService {
  async createBackup(tenantId: string): Promise<BackupResult> {
    let fileName: string;
    try { fileName = await this.createLocalBackup(); }
    catch (error) { return { fileName: null, uploadedToR2: false, error: `Error creando copia local: ${message(error)}` }; }
    if (!r2Client.isConfigured() || !connectivityMonitor.isOnline()) return { fileName, uploadedToR2: false, error: null };
    try { await this.uploadBackup(tenantId, fileName); return { fileName, uploadedToR2: true, error: null }; }
    catch (error) { return { fileName, uploadedToR2: false, error: `Copia guardada localmente: ${message(error)}` }; }
  }

  async createLocalBackup() {
    await mkdir(BACKUP_DIRECTORY, { baseDir: BaseDirectory.AppData, recursive: true });
    const fileName = `madpost_backup_${localTimestamp(new Date())}.db`;
    await copyFile("madpost.db", `${BACKUP_DIRECTORY}/${fileName}`, { fromPathBaseDir: BaseDirectory.AppData, toPathBaseDir: BaseDirectory.AppData });
    runtimeLogger.info("BackupService", "Backup local creado.", { fileName });
    return fileName;
  }

  async uploadPendingBackups(tenantId: string) {
    if (!r2Client.isConfigured() || !connectivityMonitor.isOnline()) return;
    const prefix = await this.backupPrefix(tenantId); if (!prefix) return;
    const remoteNames = new Set((await r2Client.listObjects(prefix)).map((item) => item.key.split("/").pop()));
    for (const fileName of await this.listBackupNames()) if (!remoteNames.has(fileName)) await this.uploadBackup(tenantId, fileName);
  }

  async uploadPendingLogs(tenantId: string) {
    if (import.meta.env.DEV || !r2Client.isConfigured() || !connectivityMonitor.isOnline()) return;
    const slug = await this.getTenantSlug(tenantId); if (!slug) return;
    const prefix = `${slug}/prd/logs/`;
    const remote = new Map((await r2Client.listObjects(prefix)).map((item) => [item.key.split("/").pop(), item.size]));
    await mkdir(LOG_DIRECTORY, { baseDir: BaseDirectory.AppData, recursive: true });
    const logs = await readDir(LOG_DIRECTORY, { baseDir: BaseDirectory.AppData });
    for (const entry of logs) {
      const name = entry.name;
      if (!name.startsWith("madpost-") || !name.endsWith(".log")) continue;
      const data = await readFile(`${LOG_DIRECTORY}/${name}`, { baseDir: BaseDirectory.AppData });
      if (data.length && remote.get(name) !== data.length) { await r2Client.putObject(`${prefix}${name}`, data); runtimeLogger.info("BackupService", "Log subido a R2.", { fileName: name }); }
    }
  }

  async purgeOldBackups(tenantId: string) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const fileName of await this.listBackupNames()) {
      const timestamp = backupTimestamp(fileName);
      if (timestamp && timestamp.getTime() < cutoff) { await remove(`${BACKUP_DIRECTORY}/${fileName}`, { baseDir: BaseDirectory.AppData }); runtimeLogger.info("BackupService", "Backup local eliminado por antiguedad.", { fileName }); }
    }
    if (!r2Client.isConfigured() || !connectivityMonitor.isOnline()) return;
    const slug = await this.getTenantSlug(tenantId); if (!slug) return;
    for (const prefix of [`${slug}/${environmentName()}/backups/`, `${slug}/${environmentName()}/logs/`]) for (const object of await r2Client.listObjects(prefix)) if (object.lastModified.getTime() < cutoff) await r2Client.deleteObject(object.key);
  }

  async hasBackups() { return (await this.listBackupNames()).length > 0; }
  async latestBackupTime() { const dates = (await this.listBackupNames()).map(backupTimestamp).filter((value): value is Date => Boolean(value)); return dates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null; }

  private async uploadBackup(tenantId: string, fileName: string) {
    const prefix = await this.backupPrefix(tenantId); if (!prefix) throw new Error("Tenant slug no disponible.");
    await r2Client.putObject(`${prefix}${fileName}`, await readFile(`${BACKUP_DIRECTORY}/${fileName}`, { baseDir: BaseDirectory.AppData }));
    runtimeLogger.info("BackupService", "Backup subido a R2.", { fileName });
  }
  private async backupPrefix(tenantId: string) { const slug = await this.getTenantSlug(tenantId); return slug ? `${slug}/${environmentName()}/backups/` : null; }
  private async getTenantSlug(tenantId: string) { return (await tenantRepository.get(tenantId))?.slug ?? null; }
  private async listBackupNames() {
    await mkdir(BACKUP_DIRECTORY, { baseDir: BaseDirectory.AppData, recursive: true });
    return (await readDir(BACKUP_DIRECTORY, { baseDir: BaseDirectory.AppData })).map((entry) => entry.name).filter((name) => BACKUP_PATTERN.test(name)).sort();
  }
}

function localTimestamp(date: Date) { const pad = (value: number) => value.toString().padStart(2, "0"); return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`; }
function backupTimestamp(fileName: string) { const match = BACKUP_PATTERN.exec(fileName); if (!match) return null; const [date, time] = match[1].split("_"); return new Date(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6))); }
function environmentName() { return import.meta.env.DEV ? "dev" : "prd"; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

export const backupService = new BackupService();
