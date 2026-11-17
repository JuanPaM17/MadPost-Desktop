import { Box, Button, Flex, Heading, Spinner, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { startApplication } from "./app/ApplicationBootstrap";
import { migrationService, type MigrationProgress } from "./features/migration/MigrationService";
import type { LocalUser } from "./core/types";
import { authService } from "./features/auth/AuthService";
import { LoginView, SetupView, type SetupValues } from "./features/auth/AuthView";
import { RecoveryView } from "./features/auth/RecoveryView";
import { recoveryService, type RecoveryMode } from "./features/auth/RecoveryService";
import { LicenseView } from "./features/license/LicenseView";
import { licenseService } from "./features/license/LicenseService";
import { MainView } from "./features/main/MainView";
import { postLoginCoordinator } from "./features/runtime/PostLoginCoordinator";
import { configService } from "./features/setup/ConfigService";
import { rolesService } from "./features/roles/RolesService";
import { tauriUpdaterService, type UpdateV2Info } from "./features/update/TauriUpdaterService";
import { UpdateStepsModal, makeInitialSteps, type InstallStep } from "./features/update/UpdateStepsModal";
import { backupService } from "./features/backup/BackupService";
import { sessionContext } from "./core/session/SessionContext";
import { auditService } from "./features/audit/AuditService";
import { databaseManager } from "./infrastructure/sqlite/DatabaseManager";

type Screen = "loading" | "migrating" | "license" | "blocked" | "login" | "recovery" | "setup" | "main" | "demo-loading";

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [tenant, setTenant] = useState({ id: "", name: "", address: "", phone: "", taxId: "" });
  const [user, setUser] = useState<LocalUser | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<UpdateV2Info | null>(null);
  const [updateSteps, setUpdateSteps] = useState<InstallStep[]>(makeInitialSteps());
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateDownloadedBytes, setUpdateDownloadedBytes] = useState(0);
  const [updateTotalBytes, setUpdateTotalBytes] = useState<number | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [migrationCountdown, setMigrationCountdown] = useState<number | null>(null);

  useEffect(() => { void boot(); }, []);

  async function boot() {
    setScreen("loading");
    await databaseManager.cleanupOrphanDemoDb();
    // if (await migrationService.javaDbExists() && await migrationService.hasChanges()) {
    //   setScreen("migrating");
    //   await migrationService.bootCheck((p) => setMigrationProgress(p));
    //   await new Promise<void>((resolve) => {
    //     let secs = 5;
    //     setMigrationProgress({ phase: "done" });
    //     setMigrationCountdown(secs);
    //     const interval = setInterval(() => {
    //       secs -= 1;
    //       setMigrationCountdown(secs);
    //       if (secs <= 0) { clearInterval(interval); resolve(); }
    //     }, 1000);
    //   });
    //   window.location.reload();
    //   return;
    // }
    const result = await startApplication((reason) => {
      setTenant({ id: "", name: "", address: "", phone: "", taxId: "" });
      setScreen(reason === "blocked" ? "blocked" : "license");
    });
    if (result.screen === "license") { setOnline(result.online); setScreen("license"); return; }
    if (result.screen === "blocked") { setScreen("blocked"); return; }
    const hasAdmin = await authService.hasAdminUser(result.tenantId);
    let address = result.address ?? ""; let phone = result.phone ?? ""; let taxId = result.taxId ?? "";
    if (!hasAdmin) {
      const remote = await licenseService.fetchRemoteTenantData(result.tenantId);
      if (remote.address) address = remote.address;
      if (remote.phone) phone = remote.phone;
      if (remote.taxId) taxId = remote.taxId;
    }
    setTenant({ id: result.tenantId, name: result.tenantName, address, phone, taxId });
    setScreen(hasAdmin ? "login" : "setup");
  }

  async function activate(key: string) {
    const result = await licenseService.activate(key);
    setTenant({ id: result.tenantId, name: result.tenantName, address: result.address ?? "", phone: result.phone ?? "", taxId: result.taxId ?? "" });
    setScreen((await authService.hasAdminUser(result.tenantId)) ? "login" : "setup");
  }

  async function finishSetup(values: SetupValues) {
    const admin = await authService.createUser(tenant.id, values.username, values.password, values.name, "ADMIN");
    const code = await authService.generateRecoveryCode(admin.id);
    await configService.save({ tenantId: tenant.id, name: values.businessName, address: values.address, phone: values.phone, taxId: values.taxId });
    setTenant((current) => ({ ...current, name: values.businessName }));
    await showMain(await authService.login(tenant.id, values.username, values.password));
    setRecoveryCode(code);
  }

  async function recover(username: string, code: string, password: string, mode: RecoveryMode) {
    await recoveryService.recover({ tenantId: tenant.id, username, code, password, mode });
    await showMain(await authService.login(tenant.id, username, password));
  }

  async function checkForUpdateV2() {
    try {
      const { licenseService } = await import("./features/license/LicenseService");
      const prereleaseAccess = await licenseService.hasPrereleaseAccess();
      const channel = prereleaseAccess ? "beta" : "stable";
      const result = await tauriUpdaterService.checkV2(channel);
      if (result.available) setPendingUpdate(result);
    } catch {
      // silencioso -- no interrumpir el flujo de login por un fallo de actualizacion
    }
  }

  async function installUpdateV2() {
    if (!pendingUpdate) return;
    setUpdateInstalling(true);
    setUpdateDownloadedBytes(0);
    setUpdateTotalBytes(null);
    setUpdateSteps(makeInitialSteps());
    localStorage.removeItem("update_crash_log");

    const updateStep = (i: number, patch: Partial<InstallStep>) =>
      setUpdateSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
    const addLog = (i: number, log: string) =>
      setUpdateSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, logs: [...s.logs, log] } : s));

    // Paso 0: Backup
    localStorage.setItem("update_crash_log", "Proceso interrumpido en: Crear copia de seguridad");
    updateStep(0, { status: "running" });
    try {
      const tenantId = sessionContext.current()?.tenantId;
      if (tenantId) {
        addLog(0, "Iniciando copia de seguridad...");
        await backupService.createBackup(tenantId);
        addLog(0, "Copia de seguridad creada correctamente.");
      } else {
        addLog(0, "Sin sesion activa, se omite la copia de seguridad.");
      }
      updateStep(0, { status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(0, `Error: ${msg}`);
      localStorage.setItem("update_crash_log", `Fallo en Crear copia de seguridad: ${msg}`);
      updateStep(0, { status: "error" });
      setUpdateInstalling(false);
      return;
    }

    // Paso 1: Descarga
    localStorage.setItem("update_crash_log", "Proceso interrumpido en: Descargar actualizacion");
    updateStep(1, { status: "running" });
    addLog(1, "Iniciando descarga...");
    try {
      await tauriUpdaterService.download((progress) => {
        if (progress.event === "started") {
          setUpdateTotalBytes(progress.totalBytes);
          addLog(1, `Descarga iniciada${progress.totalBytes ? ` (${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB)` : ""}.`);
        } else if (progress.event === "progress") {
          setUpdateDownloadedBytes((prev) => prev + progress.downloadedBytes);
        } else if (progress.event === "finished") {
          addLog(1, "Descarga completada.");
        }
      });
      updateStep(1, { status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(1, `Error: ${msg}`);
      localStorage.setItem("update_crash_log", `Fallo en Descargar actualizacion: ${msg}`);
      updateStep(1, { status: "error" });
      setUpdateInstalling(false);
      return;
    }

    // Paso 2: Instalar
    localStorage.setItem("update_crash_log", "Proceso interrumpido en: Instalar (NSIS activo)");
    updateStep(2, { status: "running" });
    addLog(2, "Ejecutando instalador...");
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await tauriUpdaterService.install();
      localStorage.setItem("update_crash_log", "Proceso interrumpido en: Relanzar aplicacion");
      updateStep(2, { status: "ok" });
      addLog(2, "Instalacion completada.");
      updateStep(3, { status: "running" });
      addLog(3, "Relanzando aplicacion...");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tauriUpdaterService.relaunch();
      localStorage.removeItem("update_crash_log");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(2, `Error: ${msg}`);
      localStorage.setItem("update_crash_log", `Fallo en Instalar: ${msg}`);
      updateStep(2, { status: "error" });
      setUpdateInstalling(false);
    }
  }

  async function showMain(authenticatedUser: LocalUser) {
    const isDemo = authenticatedUser.role === "DEMO";

    if (isDemo) {
      setScreen("demo-loading");
      try {
        await databaseManager.switchToDemoDb();
      } catch (error) {
        setScreen("login");
        const { notify } = await import("./components/ui/AppToaster");
        notify.error("No fue posible preparar el modo demo. Intenta de nuevo.", error instanceof Error ? error.message : undefined);
        return;
      }
    }

    const permissions = await rolesService.loadUserPermissions(authenticatedUser.tenant_id, authenticatedUser.role);
    sessionContext.login(authenticatedUser, tenant.name, permissions, isDemo);
    const cachedLicense = await licenseService.hasValidCachedLicense();
    await postLoginCoordinator.start({
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantAddress: tenant.address ?? "",
      syncEnabled: cachedLicense?.sync_enabled === 1,
      isDemo,
    });
    await auditService.log("INICIO_SESION", "SESION", `Usuario: ${authenticatedUser.display_name || authenticatedUser.username}`, authenticatedUser.id).catch(() => {});
    setUser(authenticatedUser);
    setScreen("main");
    if (!isDemo) {
      void checkForUpdateV2();
    }
  }

  const content = screen === "loading" ? <LoadingView />
    : screen === "demo-loading" ? <DemoLoadingView />
    : screen === "migrating" ? <MigratingView progress={migrationProgress} countdown={migrationCountdown} />
    : screen === "blocked" ? <BlockedDeviceView />
    : screen === "license" ? <LicenseView online={online} onActivate={activate} onRetry={async () => setOnline(await licenseService.isReachable())} />
    : screen === "login" ? <LoginView tenantName={tenant.name} onLogin={async (username, password) => { await showMain(await authService.login(tenant.id, username, password)); }} onRecovery={() => setScreen("recovery")} />
    : screen === "recovery" ? <RecoveryView onRecover={recover} onBack={() => setScreen("login")} />
    : screen === "setup" ? <SetupView tenantName={tenant.name} initialAddress={tenant.address} initialPhone={tenant.phone} initialTaxId={tenant.taxId} onFinish={finishSetup} />
    : <MainView user={user!} tenantName={tenant.name} onUserUpdated={(updatedUser) => { sessionContext.login(updatedUser, tenant.name, sessionContext.current()?.permissions ?? []); setUser(updatedUser); }} onLogout={() => { const session = sessionContext.current(); const wasDemo = session?.isDemo ?? false; void auditService.log("CIERRE_SESION", "SESION", `Usuario: ${(session?.user.display_name || session?.user.username) ?? ""}`, session?.user.id ?? null).catch(() => {}).finally(() => { sessionContext.logout(); void postLoginCoordinator.stop(); setUser(null); setScreen("login"); if (wasDemo) { void databaseManager.switchToProductionDb(); } }); }} onSwitchUser={async (nextUser) => { const prev = sessionContext.current(); const wasDemo = prev?.isDemo ?? false; await auditService.log("CIERRE_SESION", "SESION", `Usuario: ${(prev?.user.display_name || prev?.user.username) ?? ""} (cambio de usuario)`, prev?.user.id ?? null).catch(() => {}); sessionContext.logout(); void postLoginCoordinator.stop(); setUser(null); setScreen("loading"); if (wasDemo) { await databaseManager.switchToProductionDb(); } await showMain(nextUser); }} />;

  return <>{content}
    {recoveryCode ? <RecoveryCodeDialog code={recoveryCode} onClose={() => setRecoveryCode(null)} /> : null}
    {pendingUpdate && !updateInstalling ? (
      <UpdateBanner
        version={pendingUpdate.version!}
        releaseNotes={pendingUpdate.releaseNotes}
        onInstall={() => void installUpdateV2()}
        onDismiss={() => { setPendingUpdate(null); tauriUpdaterService.clearPending(); }}
      />
    ) : null}
    {updateInstalling ? (
      <UpdateStepsModal
        version={pendingUpdate?.version ?? ""}
        releaseNotes={pendingUpdate?.releaseNotes ?? null}
        steps={updateSteps}
        downloadedBytes={updateDownloadedBytes}
        totalBytes={updateTotalBytes}
        onClose={() => { setUpdateInstalling(false); setPendingUpdate(null); }}
      />
    ) : null}
  </>;
}

function UpdateBanner({ version, releaseNotes, onInstall, onDismiss }: { version: string; releaseNotes: string | null; onInstall: () => void; onDismiss: () => void }) {
  return (
    <Flex position="fixed" bottom="6" right="6" zIndex="toast" maxW="360px" w="full"
      bg="white" borderWidth="1px" borderColor="purple.200" borderRadius="lg" boxShadow="lg" p="4" gap="3" direction="column">
      <Flex justify="space-between" align="start" gap="2">
        <Box>
          <Text fontSize="sm" fontWeight="bold" color="#6366f1">Nueva version disponible: v{version}</Text>
          {releaseNotes ? <Text fontSize="xs" color="gray.500" mt="0.5" overflow="hidden" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{releaseNotes}</Text> : null}
        </Box>
        <Button size="xs" variant="ghost" color="gray.400" onClick={onDismiss} flexShrink="0"><X size={14} /></Button>
      </Flex>
      <Flex gap="2">
        <Button size="sm" colorPalette="purple" flex="1" onClick={onInstall}>Actualizar ahora</Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>Despues</Button>
      </Flex>
    </Flex>
  );
}

function MigratingView({ progress, countdown }: { progress: MigrationProgress | null; countdown: number | null }) {
  const label = !progress ? "Preparando..."
    : progress.phase === "checking" ? "Verificando datos..."
    : progress.phase === "copying" ? `Sincronizando datos... ${progress.percent}%`
    : progress.phase === "done" ? countdown !== null ? `Datos actualizados. Reiniciando en ${countdown} segundo${countdown !== 1 ? "s" : ""}...` : "Listo"
    : progress.phase === "error" ? `Error: ${progress.message}`
    : "Sin fuente";
  const percent = progress?.phase === "copying" ? progress.percent : progress?.phase === "done" ? 100 : 0;
  return (
    <Flex minH="100vh" direction="column" align="center" justify="center" bg="gray.50">
      <Box w="72px" h="72px" borderRadius="md" overflow="hidden"><img src="/logo.png" alt="MadPost" style={{ width: "100%", height: "100%", objectFit: "contain" }} /></Box>
      <Heading mt="6" size="lg">MadPost</Heading>
      <Text mt="2" color="gray.500">{label}</Text>
      <Box mt="5" w="280px" h="6px" bg="gray.200" borderRadius="full" overflow="hidden">
        <Box h="full" bg="#6366f1" borderRadius="full" style={{ width: `${percent}%`, transition: "width 0.3s ease" }} />
      </Box>
    </Flex>
  );
}

function LoadingView() {
  return <Flex minH="100vh" direction="column" align="center" justify="center" bg="gray.50"><Box className="app-loading-mark" w="72px" h="72px" borderRadius="md" overflow="hidden"><img src="/logo.png" alt="MadPost" style={{ width: "100%", height: "100%", objectFit: "contain" }} /></Box><Spinner mt="7" size="lg" color="#6366f1" borderWidth="3px" /><Heading mt="6" size="lg">MadPost</Heading><Text mt="2" color="gray.500">Preparando tu espacio de trabajo</Text></Flex>;
}

function DemoLoadingView() {
  return <Flex minH="100vh" direction="column" align="center" justify="center" bg="gray.50"><Box w="72px" h="72px" borderRadius="md" overflow="hidden"><img src="/logo.png" alt="MadPost" style={{ width: "100%", height: "100%", objectFit: "contain" }} /></Box><Spinner mt="7" size="lg" color="#6366f1" borderWidth="3px" /><Heading mt="6" size="lg">Modo Demo</Heading><Text mt="2" color="gray.500">Preparando entorno de prueba...</Text></Flex>;
}

function BlockedDeviceView() {
  return (
    <Flex minH="100vh" direction="column" align="center" justify="center" bg="gray.50" p="8">
      <Box w="72px" h="72px" borderRadius="md" overflow="hidden">
        <img src="/logo.png" alt="MadPost" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </Box>
      <Heading mt="6" size="lg" textAlign="center">Equipo desactivado</Heading>
      <Text mt="3" color="gray.500" textAlign="center" maxW="360px">
        Este equipo fue desactivado por el administrador y no puede acceder al sistema.
        Comunicate con tu proveedor para reactivarlo.
      </Text>
      <Box mt="6" px="5" py="3" bg="red.50" borderWidth="1px" borderColor="red.200" borderRadius="md" maxW="360px">
        <Text fontSize="sm" color="red.600" textAlign="center">
          Si crees que esto es un error, contacta al administrador de tu licencia.
        </Text>
      </Box>
    </Flex>
  );
}

function RecoveryCodeDialog({ code, onClose }: { code: string; onClose: () => void }) {
  return <Flex position="fixed" inset="0" bg="blackAlpha.600" align="center" justify="center" p="6"><Box maxW="460px" w="full" bg="white" p="7" boxShadow="2xl"><Heading size="lg">Guarda tu codigo de recuperacion</Heading><Text mt="3" color="gray.600">Se muestra una sola vez. Guardalo en un lugar seguro.</Text><Box mt="5" p="4" bg="purple.50" borderWidth="1px" borderColor="purple.200" fontFamily="mono" fontSize="lg" fontWeight="bold" textAlign="center">{code}</Box><Button mt="6" w="full" colorPalette="purple" onClick={onClose}>Ya lo guarde</Button></Box></Flex>;
}

export default App;
