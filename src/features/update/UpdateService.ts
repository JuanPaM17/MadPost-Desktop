import { invoke } from "@tauri-apps/api/core";
import { appConfig } from "../../config/AppConfig";
import { runtimeLogger } from "../runtime/RuntimeLogger";

export const APP_VERSION = __MADPOST_VERSION__;
export type UpdateInfo = { version: string; releaseUrl: string; downloadUrl: string | null; releaseNotes: string };
export type ReleaseEntry = { version: string; date: string; notes: string };
export type UpdateCheckResult = { state: "upToDate" | "available" | "unavailable"; message: string; update: UpdateInfo | null };
type GithubRelease = { tag_name?: string; html_url?: string; body?: string | null; published_at?: string | null; assets?: { id?: number; name?: string }[] };

class UpdateService {
  async checkForUpdate(): Promise<UpdateInfo | null> { return (await this.check()).update; }

  async check(): Promise<UpdateCheckResult> {
    if (import.meta.env.DEV) return { state: "upToDate", message: "Estas usando una version de desarrollo.", update: null };
    if (!appConfig.githubRepo()) return { state: "unavailable", message: "Las actualizaciones no estan disponibles en este momento.", update: null };
    try {
      const response = await fetch(`${releasesApi()}/latest`, { headers: githubHeaders(), signal: AbortSignal.timeout(8_000) });
      if (response.status === 404) return { state: "unavailable", message: "Aun no hay una actualizacion publicada para tu aplicacion.", update: null };
      if (!response.ok) return { state: "unavailable", message: "No pudimos consultar actualizaciones ahora. Puedes seguir trabajando con normalidad.", update: null };
      const release = await response.json() as GithubRelease;
      const version = normalizeVersion(release.tag_name);
      if (!version) return { state: "unavailable", message: "Aun no hay una actualizacion publicada para tu aplicacion.", update: null };
      if (!isNewer(version, APP_VERSION)) return { state: "upToDate", message: "Tienes la version mas reciente instalada.", update: null };
      const asset = release.assets?.find((entry) => entry.name?.toLowerCase().endsWith(".exe"));
      return { state: "available", message: "Hay una actualizacion disponible para descargar.", update: { version, releaseUrl: release.html_url ?? "", downloadUrl: asset?.id ? `${releasesApi()}/assets/${asset.id}` : null, releaseNotes: release.body ?? "" } };
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
