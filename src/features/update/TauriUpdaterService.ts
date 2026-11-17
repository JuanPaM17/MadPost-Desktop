import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  private checkedChannel: InstallChannel | null = null;

  async checkV2(channel: InstallChannel): Promise<UpdateV2Info> {
    this.checkedChannel = null;
    const result = await invoke<UpdateV2Info>("check_for_update_v2", { channel });
    if (result.available) {
      this.checkedChannel = channel;
    }
    return result;
  }

  async download(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    if (!this.checkedChannel) {
      throw new Error("No hay una actualizacion pendiente. Verifica de nuevo antes de descargar.");
    }

    const unlisten = await listen<{ event: string; totalBytes?: number; downloadedBytes?: number }>(
      "update-progress",
      ({ payload }) => {
        if (payload.event === "started") {
          onProgress({ event: "started", totalBytes: payload.totalBytes ?? null });
        } else if (payload.event === "progress") {
          onProgress({ event: "progress", downloadedBytes: payload.downloadedBytes ?? 0, totalBytes: null });
        } else if (payload.event === "finished") {
          onProgress({ event: "finished" });
        }
      }
    );

    try {
      await invoke("download_update", { channel: this.checkedChannel });
    } finally {
      unlisten();
    }
  }

  async install(): Promise<void> {
    if (!this.checkedChannel) {
      throw new Error("No hay una actualizacion pendiente.");
    }
    await invoke("install_update_v2", { channel: this.checkedChannel });
  }

  async relaunch(): Promise<void> {
    await relaunch();
  }

  clearPending(): void {
    this.checkedChannel = null;
  }
}

export const tauriUpdaterService = new TauriUpdaterService();
