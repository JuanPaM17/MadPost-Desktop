import { copyFile, exists, stat } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { metaRepository } from "../../infrastructure/sqlite/repositories";

const META_KEY_MIGRATED = "java_db_migrated";
const META_KEY_LAST_MTIME = "java_db_last_mtime";

async function getJavaDbPath(): Promise<string> {
  // appDataDir() retorna %APPDATA%\com.madpost.desktop\ -- subimos un nivel para llegar a %APPDATA%
  const base = await appDataDir();
  return join(base, "..", "MadPost", "madpost.db");
}

async function getReactDbPath(): Promise<string> {
  return join(await appDataDir(), "madpost.db");
}

export type MigrationProgress =
  | { phase: "checking" }
  | { phase: "copying"; percent: number }
  | { phase: "done" }
  | { phase: "error"; message: string }
  | { phase: "no_source" };

class MigrationService {
  /** Retorna true si existe la DB de Java en la ruta esperada. */
  async javaDbExists(): Promise<boolean> {
    try {
      return await exists(await getJavaDbPath());
    } catch {
      return false;
    }
  }

  /** Retorna true si ya se realizo la migracion inicial. */
  async isMigrated(): Promise<boolean> {
    try {
      const val = await metaRepository.get(META_KEY_MIGRATED);
      return val === "1";
    } catch {
      return false;
    }
  }


  /**
   * Copia la DB de Java al AppData de React, marca react_migrated=1 en la copia,
   * guarda el tamaño actual y habilita la escritura dual en DatabaseManager.
   * Llama onProgress con el estado actual.
   */
  async migrate(onProgress: (p: MigrationProgress) => void): Promise<boolean> {
    onProgress({ phase: "checking" });

    const javaDbPath = await getJavaDbPath();
    const sourceExists = await this.javaDbExists();
    if (!sourceExists) {
      onProgress({ phase: "no_source" });
      return false;
    }

    try {
      onProgress({ phase: "copying", percent: 10 });

      // Cerrar la DB de React antes de reemplazar el archivo.
      await databaseManager.resetPrimary();

      onProgress({ phase: "copying", percent: 30 });

      // Copiar los tres archivos de SQLite (db + wal + shm) para incluir
      // todos los datos no comprometidos en el WAL de Java.
      const reactDbPath = await getReactDbPath();
      await copyFile(javaDbPath, reactDbPath);
      // Copiar WAL y SHM si existen (datos recientes de Java aun no en el archivo principal)
      try { await copyFile(javaDbPath + "-wal", reactDbPath + "-wal"); } catch { /* no existe, ok */ }
      try { await copyFile(javaDbPath + "-shm", reactDbPath + "-shm"); } catch { /* no existe, ok */ }

      onProgress({ phase: "copying", percent: 80 });

      // Reabrir la DB de React y aplicar migraciones para que quede al dia.
      const db = await databaseManager.database();

      // Marcar react_migrated=1 para que Java sepa que fue importada.
      try {
        await db.execute("ALTER TABLE tenants ADD COLUMN react_migrated INTEGER NOT NULL DEFAULT 0");
      } catch { /* columna ya existe */ }
      await db.execute("UPDATE tenants SET react_migrated = 1");

      // Limpiar sync_queue de entradas con IDs no-UUID que vinieron de Java (MD5 sin guiones).
      await db.execute(`DELETE FROM sync_queue WHERE synced_at IS NULL AND payload_json LIKE '%"id":"%' AND NOT (
        SUBSTR(json_extract(payload_json, '$.id'), 9, 1) = '-' AND
        SUBSTR(json_extract(payload_json, '$.id'), 14, 1) = '-' AND
        SUBSTR(json_extract(payload_json, '$.id'), 19, 1) = '-' AND
        SUBSTR(json_extract(payload_json, '$.id'), 24, 1) = '-' AND
        LENGTH(json_extract(payload_json, '$.id')) = 36
      )`);

      onProgress({ phase: "copying", percent: 90 });

      await metaRepository.set(META_KEY_MIGRATED, "1");

      // Forzar checkpoint para fusionar el WAL al archivo principal.
      // Esto limpia el WAL y estabiliza el mtime para la proxima comparacion.
      await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");

      // Guardar mtime DESPUES del checkpoint, cuando el WAL ya esta limpio.
      const dbInfo = await stat(javaDbPath);
      let latestMtime = dbInfo.mtime ?? 0;
      try {
        const walInfo = await stat(javaDbPath + "-wal");
        if ((walInfo.mtime ?? 0) > latestMtime) latestMtime = walInfo.mtime!;
      } catch { /* wal no existe */ }
      await metaRepository.set(META_KEY_LAST_MTIME, String(latestMtime));

      // Habilitar escritura dual hacia la DB de Java.
      databaseManager.enableDualWrite();

      onProgress({ phase: "done" });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress({ phase: "error", message });
      return false;
    }
  }

  async hasChanges(): Promise<boolean> {
    try {
      const javaDbPath = await getJavaDbPath();
      // Revisar mtime del .db y del .wal (cambios recientes van al WAL)
      const dbInfo = await stat(javaDbPath);
      let latestMtime = dbInfo.mtime ?? 0;
      try {
        const walInfo = await stat(javaDbPath + "-wal");
        if ((walInfo.mtime ?? 0) > latestMtime) latestMtime = walInfo.mtime!;
      } catch { /* wal no existe */ }
      const lastMtime = await metaRepository.get(META_KEY_LAST_MTIME);
      return lastMtime === null || String(latestMtime) !== lastMtime;
    } catch {
      return false;
    }
  }

  async bootCheck(onProgress?: (p: MigrationProgress) => void): Promise<void> {
    const migrated = await this.isMigrated();
    if (!migrated) return;
    if (!(await this.javaDbExists())) return;
    if (await this.hasChanges()) {
      await this.migrate(onProgress ?? (() => {}));
    } else {
      databaseManager.enableDualWrite();
    }
  }
}

export const migrationService = new MigrationService();
