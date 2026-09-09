import { invoke } from "@tauri-apps/api/core";
import { appConfig } from "../../config/AppConfig";
import { runtimeLogger } from "../runtime/RuntimeLogger";

export const APP_VERSION = __MADPOST_VERSION__;
export type UpdateInfo = { version: string; releaseUrl: string; downloadUrl: string | null; releaseNotes: string; forced: boolean };
export type ReleaseEntry = { version: string; date: string; notes: string };
export type UpdateCheckResult = { state: "upToDate" | "available" | "unavailable"; message: string; update: UpdateInfo | null };
type GithubRelease = { tag_name?: string; html_url?: string; body?: string | null; published_at?: string | null; assets?: { id?: number; name?: string }[] };
type UpdateConfig = { latestVersion: string; minimumVersion: string };

class UpdateService {
  async checkForUpdate(): Promise<UpdateInfo | null> { return (await this.check()).update; }

  async check(): Promise<UpdateCheckResult> {
    if (import.meta.env.DEV) return { state: "upToDate", message: "Estas usando una version de desarrollo.", update: null };
    if (!appConfig.githubRepo()) return { state: "unavailable", message: "Las actualizaciones no estan disponibles en este momento.", update: null };
    try {
      // 1. Leer update-config.json para determinar forced y si hay update
      const configResponse = await fetch(
        `https://raw.githubusercontent.com/${appConfig.githubRepo()}/main/update-config.json`,
        { signal: AbortSignal.timeout(6_000) },
      );
      if (!configResponse.ok) {
        runtimeLogger.info("UpdateService", "No se pudo leer update-config.json; se continua normalmente.", { status: configResponse.status });
        return { state: "unavailable", message: "No pudimos consultar actualizaciones ahora. Puedes seguir trabajando con normalidad.", update: null };
      }
      const config = await configResponse.json() as UpdateConfig;
      const forced = isNewer(config.minimumVersion, APP_VERSION);
      const updateAvailable = isNewer(config.latestVersion, APP_VERSION);
      if (!forced && !updateAvailable) return { state: "upToDate", message: "Tienes la version mas reciente instalada.", update: null };

      // 2. Obtener release de GitHub para notas y downloadUrl
      const releaseResponse = await fetch(`${releasesApi()}/latest`, { headers: githubHeaders(), signal: AbortSignal.timeout(8_000) });
      let releaseNotes = "";
      let releaseUrl = "";
      let downloadUrl: string | null = null;
      if (releaseResponse.ok) {
        const release = await releaseResponse.json() as GithubRelease;
        releaseNotes = release.body ?? "";
        releaseUrl = release.html_url ?? "";
        const asset = release.assets?.find((entry) => entry.name?.toLowerCase().endsWith(".exe"));
        downloadUrl = asset?.id ? `${releasesApi()}/assets/${asset.id}` : null;
      }

      return {
        state: "available",
        message: forced ? "Esta version ya no es compatible. Debes actualizar para continuar." : "Hay una actualizacion disponible para descargar.",
        update: { version: config.latestVersion, releaseUrl, downloadUrl, releaseNotes, forced },
      };
    } catch (error) {
      runtimeLogger.info("UpdateService", "No se pudo verificar actualizaciones; se continua normalmente.", { reason: errorMessage(error) });
      return { state: "unavailable", message: "No pudimos conectarnos para buscar actualizaciones. Puedes intentarlo de nuevo mas tarde.", update: null };
    }
  }

  async listReleases(): Promise<ReleaseEntry[]> {
    if (import.meta.env.DEV || !appConfig.githubRepo()) return [];
    try {
      const response = await fetch(`${releasesApi()}?per_page=30`, { headers: githubHeaders(), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return [];
      const releases = await response.json() as GithubRelease[];
      return releases.map((release) => ({ version: normalizeVersion(release.tag_name) ?? "Sin version", date: release.published_at?.slice(0, 10) ?? "", notes: release.body?.trim() ?? "" }));
    } catch { return []; }
  }

  async install(update: UpdateInfo) {
    if (!update.downloadUrl) throw new Error("Esta actualizacion aun no tiene un instalador disponible.");
    const result = await invoke<{ started: boolean; message: string }>("install_update", { downloadUrl: update.downloadUrl });
    if (!result.started) throw new Error(result.message);
    runtimeLogger.info("UpdateService", result.message, { version: update.version });
  }
}

function releasesApi() { return `https://api.github.com/repos/${appConfig.githubRepo()}/releases`; }
function githubHeaders() { return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(appConfig.githubToken() ? { Authorization: `Bearer ${appConfig.githubToken()}` } : {}) }; }
function normalizeVersion(version: string | undefined) { const normalized = version?.replace(/^v/i, "").trim(); return normalized || null; }
function isNewer(latest: string, current: string) { const left = parseVersion(latest); const right = parseVersion(current); if (!left || !right) return false; for (let index = 0; index < 3; index++) { if (left[index] > right[index]) return true; if (left[index] < right[index]) return false; } return false; }
function parseVersion(version: string) { const parts = version.split(".").slice(0, 3).map((part) => part.replace(/[^0-9]/g, "")); if (!parts.length || parts.some((part) => !part)) return null; while (parts.length < 3) parts.push("0"); return parts.map(Number); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

export const updateService = new UpdateService();
