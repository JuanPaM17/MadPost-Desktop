import { runtimeLogger } from "./RuntimeLogger";
import { invoke } from "@tauri-apps/api/core";
import { syncService } from "../sync/SyncService";
import { deleteSyncService } from "../sync/DeleteSyncService";
import { backupScheduler } from "../backup/BackupScheduler";
import { syncCommandPoller } from "../sync/SyncCommandPoller";

export type RuntimeContext = {
  tenantId: string;
  tenantName: string;
  syncEnabled: boolean;
};

interface RuntimeService {
  start(context: RuntimeContext): Promise<void>;
  stop(): Promise<void>;
}

class MadPostApiServer implements RuntimeService {
  async start(context: RuntimeContext) {
    const result = await invoke<NativeRuntimeResult>("start_mobile_api", { tenantId: context.tenantId, tenantName: context.tenantName });
    runtimeLogger.info("MadPostApiServer", result.message, { active: result.active, tenantId: context.tenantId });
  }
  async stop() { const result = await invoke<NativeRuntimeResult>("stop_mobile_api"); runtimeLogger.info("MadPostApiServer", result.message, { active: result.active }); }
}

class MdnsPublisher implements RuntimeService {
  async start(context: RuntimeContext) {
    const result = await invoke<NativeRuntimeResult>("publish_mdns", { tenantId: context.tenantId, tenantName: context.tenantName });
    runtimeLogger.info("MdnsPublisher", result.message, { active: result.active, tenantName: context.tenantName });
  }
  async stop() { const result = await invoke<NativeRuntimeResult>("unpublish_mdns"); runtimeLogger.info("MdnsPublisher", result.message, { active: result.active }); }
}

type NativeRuntimeResult = { active: boolean; message: string };

class WindowsBackupTaskManager implements RuntimeService {
  async start() {
    try {
      const result = await invoke<{ skipped: boolean; messages: string[] }>("ensure_scheduled_tasks_registered");
      for (const message of result.messages) runtimeLogger.info("WindowsBackupTaskManager", message, { skipped: result.skipped });
    } catch (error) {
      runtimeLogger.error("WindowsBackupTaskManager", "No fue posible registrar tareas de backup.", error);
    }
  }
  async stop() {}
}

class PostLoginCoordinator {
  private activeTenantId: string | null = null;
  private readonly services: RuntimeService[] = [
    syncService, deleteSyncService, backupScheduler, new MadPostApiServer(),
    new MdnsPublisher(), new WindowsBackupTaskManager(), syncCommandPoller,
  ];

  async start(context: RuntimeContext) {
    if (this.activeTenantId === context.tenantId) {
      runtimeLogger.info("PostLoginCoordinator", "Servicios ya inicializados para la sesion actual.", { tenantId: context.tenantId });
      return;
    }
    if (this.activeTenantId) await this.stop();
    this.activeTenantId = context.tenantId;
    runtimeLogger.info("PostLoginCoordinator", "Iniciando servicios posteriores al login.", { tenantId: context.tenantId, syncEnabled: context.syncEnabled });
    for (const service of this.services) {
      try { await service.start(context); } catch (error) { runtimeLogger.error("PostLoginCoordinator", "No fue posible inicializar un servicio.", error); }
    }
    runtimeLogger.info("PostLoginCoordinator", "Inicializacion posterior al login completada.", { tenantId: context.tenantId });
  }

  async stop() {
    for (const service of [...this.services].reverse()) await service.stop();
    this.activeTenantId = null;
    runtimeLogger.info("PostLoginCoordinator", "Servicios de sesion detenidos.");
  }
}

export const postLoginCoordinator = new PostLoginCoordinator();
