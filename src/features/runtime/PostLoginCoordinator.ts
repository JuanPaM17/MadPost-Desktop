import { runtimeLogger } from "./RuntimeLogger";
import { invoke } from "@tauri-apps/api/core";
import { syncService } from "../sync/SyncService";
import { deleteSyncService } from "../sync/DeleteSyncService";
import { backupScheduler } from "../backup/BackupScheduler";
import { syncCommandPoller } from "../sync/SyncCommandPoller";
import { mobileDevicesService } from "../api/MobileDevicesService";
import { posService } from "../pos/PosService";
import { businessConfigService, printerService } from "../config/BusinessConfigService";
import { appCache } from "../../infrastructure/AppCache";
import { rolesService } from "../roles/RolesService";

export type RuntimeContext = {
  tenantId: string;
  tenantName: string;
  syncEnabled: boolean;
  isDemo?: boolean;
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
    if (this.activeTenantId === context.tenantId && !context.isDemo) {
      runtimeLogger.info("PostLoginCoordinator", "Servicios ya inicializados para la sesion actual.", { tenantId: context.tenantId });
      return;
    }
    if (this.activeTenantId) await this.stop();
    this.activeTenantId = context.tenantId;
    runtimeLogger.info("PostLoginCoordinator", "Iniciando servicios posteriores al login.", { tenantId: context.tenantId, syncEnabled: context.syncEnabled, isDemo: context.isDemo ?? false });

    // En modo demo no se arrancan servicios de fondo: sync, backup, comandos remotos ni API movil
    if (!context.isDemo) {
      const mobileEnabled = import.meta.env.DEV && await mobileDevicesService.loadAutoStart().catch(() => false);
      for (const service of this.services) {
        if (!mobileEnabled && (service instanceof MadPostApiServer || service instanceof MdnsPublisher)) {
          runtimeLogger.info("PostLoginCoordinator", "Servidor local omitido por configuracion.", {});
          continue;
        }
        try { await service.start(context); } catch (error) { runtimeLogger.error("PostLoginCoordinator", "No fue posible inicializar un servicio.", error); }
      }
      void rolesService.ensureSystemRoles(context.tenantId).catch((error) =>
        runtimeLogger.error("PostLoginCoordinator", "No fue posible inicializar roles del sistema.", error),
      );
      const { ensureDemoUser } = await import("../auth/AuthService");
      void ensureDemoUser(context.tenantId).catch((error) =>
        runtimeLogger.error("PostLoginCoordinator", "No fue posible inicializar el usuario demo.", error),
      );
    }

    void this.warmupCache();
    runtimeLogger.info("PostLoginCoordinator", "Inicializacion posterior al login completada.", { tenantId: context.tenantId });
  }

  private async warmupCache() {
    await Promise.allSettled([
      posService.categories(),
      posService.additions(),
      posService.sauces(),
      businessConfigService.load(),
      businessConfigService.deliveryTypes(),
      printerService.list(),
    ]);
    runtimeLogger.info("PostLoginCoordinator", "Cache precargado.", {});
  }

  async stop() {
    for (const service of [...this.services].reverse()) await service.stop();
    appCache.invalidateAll();
    this.activeTenantId = null;
    runtimeLogger.info("PostLoginCoordinator", "Servicios de sesion detenidos.");
  }
}

export const postLoginCoordinator = new PostLoginCoordinator();
