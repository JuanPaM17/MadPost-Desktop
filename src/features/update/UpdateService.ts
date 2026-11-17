import { invoke } from "@tauri-apps/api/core";
import { licenseService } from "../license/LicenseService";

export const APP_VERSION = __MADPOST_VERSION__;
export type ReleaseEntry = { version: string; date: string; notes: string };

declare const __MADPOST_VERSION__: string;

class UpdateService {
  async listReleases(): Promise<ReleaseEntry[]> {
    try {
      const prereleaseAccess = await licenseService.hasPrereleaseAccess();
      return await invoke<ReleaseEntry[]>("list_releases", { prereleaseAccess });
    } catch { return []; }
  }
}

export const updateService = new UpdateService();
