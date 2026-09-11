import { Box, Button, Flex, Heading, Spinner, Text } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
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
import { UpdateDialog } from "./features/update/UpdateDialog";
import { updateService, type UpdateInfo } from "./features/update/UpdateService";
import { sessionContext } from "./core/session/SessionContext";

type Screen = "loading" | "migrating" | "license" | "login" | "recovery" | "setup" | "main";

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [tenant, setTenant] = useState({ id: "", name: "" });
  const [user, setUser] = useState<LocalUser | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [migrationCountdown, setMigrationCountdown] = useState<number | null>(null);
  const updateDecision = useRef<(() => void) | null>(null);

  useEffect(() => { void boot(); }, []);

  async function boot() {
    setScreen("loading");
    if (await migrationService.isMigrated() && await migrationService.javaDbExists() && await migrationService.hasChanges()) {
      setScreen("migrating");
      await migrationService.bootCheck((p) => setMigrationProgress(p));
      await new Promise<void>((resolve) => {
        let secs = 5;
        setMigrationProgress({ phase: "done" });
        setMigrationCountdown(secs);
        const interval = setInterval(() => {
          secs -= 1;
          setMigrationCountdown(secs);
          if (secs <= 0) { clearInterval(interval); resolve(); }
        }, 1000);
      });
      window.location.reload();
      return;
    }
    const result = await startApplication(() => { setTenant({ id: "", name: "" }); setOnline(false); setScreen("license"); });
    if (result.screen === "license") { setOnline(result.online); setScreen("license"); return; }
    setTenant({ id: result.tenantId, name: result.tenantName });
    const update = await updateService.checkForUpdate();
    if (update) await new Promise<void>((resolve) => { updateDecision.current = resolve; setPendingUpdate(update); });
    setScreen((await authService.hasAdminUser(result.tenantId)) ? "login" : "setup");
  }

  async function activate(key: string) {
    const result = await licenseService.activate(key);
    setTenant({ id: result.tenantId, name: result.tenantName });
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

  async function showMain(authenticatedUser: LocalUser) {
    sessionContext.login(authenticatedUser, tenant.name);
    const cachedLicense = await licenseService.hasValidCachedLicense();
    await postLoginCoordinator.start({
      tenantId: tenant.id,
      tenantName: tenant.name,
      syncEnabled: cachedLicense?.sync_enabled === 1,
    });
    setUser(authenticatedUser);
    setScreen("main");
  }

  const content = screen === "loading" ? <LoadingView />
    : screen === "migrating" ? <MigratingView progress={migrationProgress} countdown={migrationCountdown} />
    : screen === "license" ? <LicenseView online={online} onActivate={activate} onRetry={async () => setOnline(await licenseService.isReachable())} />
    : screen === "login" ? <LoginView tenantName={tenant.name} onLogin={async (username, password) => { await showMain(await authService.login(tenant.id, username, password)); }} onRecovery={() => setScreen("recovery")} />
    : screen === "recovery" ? <RecoveryView onRecover={recover} onBack={() => setScreen("login")} />
    : screen === "setup" ? <SetupView tenantName={tenant.name} onFinish={finishSetup} />
    : <MainView user={user!} tenantName={tenant.name} onUserUpdated={(updatedUser) => { sessionContext.login(updatedUser, tenant.name); setUser(updatedUser); }} onLogout={() => { sessionContext.logout(); void postLoginCoordinator.stop(); setUser(null); setScreen("login"); }} />;

  return <>{content}
    {recoveryCode ? <RecoveryCodeDialog code={recoveryCode} onClose={() => setRecoveryCode(null)} /> : null}
    {pendingUpdate ? <UpdateDialog update={pendingUpdate} onOmit={pendingUpdate.forced ? undefined : () => { setPendingUpdate(null); updateDecision.current?.(); updateDecision.current = null; }} onInstall={() => updateService.install(pendingUpdate)} /> : null}
  </>;
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

function RecoveryCodeDialog({ code, onClose }: { code: string; onClose: () => void }) {
  return <Flex position="fixed" inset="0" bg="blackAlpha.600" align="center" justify="center" p="6"><Box maxW="460px" w="full" bg="white" p="7" boxShadow="2xl"><Heading size="lg">Guarda tu codigo de recuperacion</Heading><Text mt="3" color="gray.600">Se muestra una sola vez. Guardalo en un lugar seguro.</Text><Box mt="5" p="4" bg="purple.50" borderWidth="1px" borderColor="purple.200" fontFamily="mono" fontSize="lg" fontWeight="bold" textAlign="center">{code}</Box><Button mt="6" w="full" colorPalette="purple" onClick={onClose}>Ya lo guarde</Button></Box></Flex>;
}

export default App;
