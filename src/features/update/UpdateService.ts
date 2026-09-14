import { invoke } from "@tauri-apps/api/core";
import { runtimeLogger } from "../runtime/RuntimeLogger";

export const APP_VERSION = __MADPOST_VERSION__;
export type UpdateInfo = { version: string; releaseUrl: string; downloadUrl: string | null; releaseNotes: string; forced: boolean };
export type ReleaseEntry = { version: string; date: string; notes: string };
export type UpdateCheckResult = { state: "upToDate" | "available" | "unavailable"; message: string; update: UpdateInfo | null };

class UpdateService {
  async checkForUpdate(): Promise<UpdateInfo | null> { return (await this.check()).update; }

  async check(): Promise<UpdateCheckResult> {
    try {
      return await invoke<UpdateCheckResult>("check_for_update");
    } catch (error) {
      runtimeLogger.info("UpdateService", "check_for_update invoke failed", { reason: error instanceof Error ? error.message : String(error) });
      return { state: "unavailable", message: "No pudimos conectarnos para buscar actualizaciones. Puedes intentarlo de nuevo mas tarde.", update: null };
    }
  }

  async listReleases(): Promise<ReleaseEntry[]> {
    try {
      return await invoke<ReleaseEntry[]>("list_releases");
    } catch { return []; }
  }

  async install(update: UpdateInfo) {
    if (!update.downloadUrl) throw new Error("Esta actualizacion aun no tiene un instalador disponible.");
    const result = await invoke<{ started: boolean; message: string }>("install_update", { downloadUrl: update.downloadUrl });
    if (!result.started) throw new Error(result.message);
    runtimeLogger.info("UpdateService", result.message, { version: update.version });
  }
}

export const updateService = new UpdateService();
