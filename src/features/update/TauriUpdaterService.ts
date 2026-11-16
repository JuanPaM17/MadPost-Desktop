import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateV2Info = {
  available: boolean;
  version: string | null;
  currentVersion: string;
  releaseNotes: string | null;
  pubDate: string | null;
};

export type DownloadProgress =
  | { event: "started"; totalBytes: number | null }
  | { event: "progress"; downloadedBytes: number; totalBytes: number | null }
  | { event: "finished" };

export type InstallChannel = "stable" | "beta";

class TauriUpdaterService {
  // Referencia al objeto Update para reusar entre check -> download -> install
  // sin necesidad de repetir el check.
  private pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;

  async checkV2(channel: InstallChannel): Promise<UpdateV2Info> {
    this.pendingUpdate = null;

    // check_for_update_v2 construye el updater con el endpoint correcto en Rust,
    // inyecta el token de GitHub y retorna solo los metadatos.
    const result = await invoke<UpdateV2Info>("check_for_update_v2", { channel });

    if (result.available) {
      // Tambien ejecutamos check() desde JS para obtener el objeto Update
      // que necesitaremos para download(). El endpoint se configura en Rust;
      // aqui usamos el plugin con el endpoint por defecto (stable) ya que el
      // objeto Update que nos importa es el que el Rust construyo.
      // Guardamos la referencia para reutilizarla en downloadAndInstall.
      try {
        this.pendingUpdate = await check();
      } catch {
        // Si falla el check JS (por ejemplo repo privado sin token en el plugin JS),
        // descargamos via el mecanismo alternativo documentado.
        this.pendingUpdate = null;
      }
    }

    return result;
  }

  async downloadAndInstall(
    onProgress: (progress: DownloadProgress) => void
  ): Promise<void> {
    if (!this.pendingUpdate) {
      throw new Error(
        "No hay una actualizacion pendiente. Ejecuta checkV2() primero."
      );
    }

    const update = this.pendingUpdate;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          onProgress({
            event: "started",
            totalBytes: event.data.contentLength ?? null,
          });
          break;
        case "Progress":
          onProgress({
            event: "progress",
            downloadedBytes: event.data.chunkLength,
            totalBytes: null,
          });
          break;
        case "Finished":
          onProgress({ event: "finished" });
          break;
      }
    });

    // downloadAndInstall lanza el instalador NSIS en modo passive y espera.
    // Tras instalacion exitosa, relanzamos la app con el mecanismo oficial del plugin.
    await relaunch();
  }

  clearPending(): void {
    this.pendingUpdate = null;
  }
}

export const tauriUpdaterService = new TauriUpdaterService();
