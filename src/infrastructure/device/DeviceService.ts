import { invoke } from "@tauri-apps/api/core";
import { metaRepository } from "../sqlite/repositories";

class DeviceService {
  async getDeviceId() {
    const saved = await metaRepository.get("device_id");
    if (saved) return saved;
    const deviceId = crypto.randomUUID();
    await metaRepository.set("device_id", deviceId);
    return deviceId;
  }

  async getHostname() {
    try {
      return await invoke<string>("get_hostname");
    } catch {
      return "unknown-device";
    }
  }
}

export const deviceService = new DeviceService();
