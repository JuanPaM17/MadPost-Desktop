import { invoke } from "@tauri-apps/api/core";

type R2Object = { key: string; lastModified: Date; size: number };
export type R2ConnectionCheck = { connected: boolean; missing: string[]; endpoint?: string; bucket?: string; reason?: string };

class R2Client {
  async isConfigured() { return (await invoke<R2ConnectionCheck>("r2_configuration")).missing.length === 0; }
  async testConnection(): Promise<R2ConnectionCheck> { return invoke<R2ConnectionCheck>("r2_test_connection"); }
  async putObject(key: string, body: Uint8Array) { await invoke("r2_put_object", { key, body: Array.from(body) }); }
  async deleteObject(key: string) { await invoke("r2_delete_object", { key }); }
  async listObjects(prefix: string): Promise<R2Object[]> {
    const response = await invoke<string>("r2_list_objects", { prefix });
    const xml = new DOMParser().parseFromString(response, "application/xml");
    return [...xml.getElementsByTagName("Contents")].map((node) => ({
      key: node.getElementsByTagName("Key")[0]?.textContent ?? "",
      lastModified: new Date(node.getElementsByTagName("LastModified")[0]?.textContent ?? 0),
      size: Number(node.getElementsByTagName("Size")[0]?.textContent ?? 0),
    }));
  }
}

export const r2Client = new R2Client();
