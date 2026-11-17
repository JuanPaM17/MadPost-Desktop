import { Badge, Box, Button, Flex, Heading, Spinner, Stack, Text } from "@chakra-ui/react";
import { ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw, ScrollText, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { APP_VERSION, type ReleaseEntry, updateService } from "./UpdateService";
import { tauriUpdaterService, type UpdateV2Info } from "./TauriUpdaterService";
import { backupService } from "../backup/BackupService";
import { sessionContext } from "../../core/session/SessionContext";
import { licenseService } from "../license/LicenseService";
import { type InstallStep, type LogEntry, type StepStatus, LogsModal, StepIcon, StepsList, makeInitialSteps } from "./UpdateStepsModal";

export function UpdateView() {
  const [checking, setChecking] = useState(true);
  const [resultV2, setResultV2] = useState<UpdateV2Info | null>(null);
  const [releases, setReleases] = useState<ReleaseEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [steps, setSteps] = useState<InstallStep[]>(makeInitialSteps());
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [checkLogs, setCheckLogs] = useState<LogEntry[]>([]);
  const [showCheckLogs, setShowCheckLogs] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);

  const [lastCrashLog, setLastCrashLog] = useState(() => localStorage.getItem("update_crash_log") ?? "");
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => { void refresh(); }, []);

  function addCheckLog(text: string, ok: boolean | null = null) {
    setCheckLogs((prev) => [...prev, { text, ok }]);
  }

  function updateStep(index: number, patch: Partial<InstallStep>) {
    setSteps((prev) => prev.map((s, i) => i === index ? { ...s, ...patch } : s));
  }

  function addStepLog(index: number, log: string) {
    setSteps((prev) => prev.map((s, i) => i === index ? { ...s, logs: [...s.logs, log] } : s));
  }

  async function refresh() {
    setChecking(true);
    setResultV2(null);
    setCheckLogs([]);
    setSteps(makeInitialSteps());
    setShowSteps(false);
    setInstalling(false);
    tauriUpdaterService.clearPending();

    const [v2, history] = await Promise.all([
      checkV2(),
      updateService.listReleases(),
    ]);
    setResultV2(v2);
    setReleases(history);
    setChecking(false);
  }

  async function checkV2(): Promise<UpdateV2Info> {
    try {
      addCheckLog(`Version instalada: v${APP_VERSION}`);
      const prereleaseAccess = await licenseService.hasPrereleaseAccess();
      const channel = prereleaseAccess ? "beta" : "stable";
      addCheckLog(`Canal de actualizaciones: ${channel}`);
      addCheckLog("Consultando servidor de actualizaciones...");
      const result = await tauriUpdaterService.checkV2(channel);
      if (result.available && result.version) {
        addCheckLog(`Version disponible encontrada: v${result.version}`, true);
      } else {
        addCheckLog("Sin actualizaciones. Tienes la version mas reciente.", true);
      }
      return result;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const clean = raw.replace("Error al verificar actualizaciones: ", "");
      if (clean.includes("decoding response body")) {
        addCheckLog("El servidor respondio pero el formato del manifiesto no es compatible.", false);
        addCheckLog(`Detalle: ${clean}`, false);
      } else if (clean.includes("error sending request") || clean.includes("connect")) {
        addCheckLog("No se pudo conectar con el servidor. Verifica tu conexion a internet.", false);
        addCheckLog(`Detalle: ${clean}`, false);
      } else {
        addCheckLog(`Error: ${clean}`, false);
      }
      return { available: false, version: null, currentVersion: APP_VERSION, releaseNotes: null, pubDate: null };
    }
  }

  async function install() {
    if (!resultV2?.available) return;
    setInstalling(true);
    setShowSteps(true);
    setDownloadedBytes(0);
    setTotalBytes(null);
    setSteps(makeInitialSteps());
    localStorage.removeItem("update_crash_log");
    setLastCrashLog("");

    // Paso 0: Backup
    localStorage.setItem("update_crash_log", "Proceso interrumpido en: Crear copia de seguridad");
    updateStep(0, { status: "running" });
    try {
      const tenantId = sessionContext.current()?.tenantId;
      if (tenantId) {
        addStepLog(0, "Iniciando copia de seguridad...");
        await backupService.createBackup(tenantId);
        addStepLog(0, "Copia de seguridad creada correctamente.");
      } else {
        addStepLog(0, "Sin sesion activa, se omite la copia de seguridad.");
      }
      updateStep(0, { status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addStepLog(0, `Error al crear la copia: ${msg}`);
      localStorage.setItem("update_crash_log", `Fallo en Crear copia de seguridad: ${msg}`);
      updateStep(0, { status: "error" });
      setInstalling(false);
      return;
    }

    // Paso 1: Descarga
    localStorage.setItem("update_crash_log", "Proceso interrumpido en: Descargar actualizacion");
    updateStep(1, { status: "running" });
    addStepLog(1, "Iniciando descarga...");
    try {
      await tauriUpdaterService.download((progress) => {
        if (progress.event === "started") {
          setTotalBytes(progress.totalBytes);
          addStepLog(1, `Descarga iniciada${progress.totalBytes ? ` (${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB)` : ""}.`);
        } else if (progress.event === "progress") {
          setDownloadedBytes((prev) => prev + progress.downloadedBytes);
        } else if (progress.event === "finished") {
          addStepLog(1, "Descarga completada.");
        }
      });
      updateStep(1, { status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addStepLog(1, `Error: ${msg}`);
      localStorage.setItem("update_crash_log", `Fallo en Descargar actualizacion: ${msg}`);
      updateStep(1, { status: "error" });
      setInstalling(false);
      return;
    }

    // Paso 2: Instalacion -- marcar running y dar tiempo a React para renderizar
    // antes de llamar install() que cierra el proceso actual via NSIS.
    localStorage.setItem("update_crash_log", "Proceso interrumpido en: Instalar (NSIS activo)");
    updateStep(2, { status: "running" });
    addStepLog(2, "Ejecutando instalador...");
    await new Promise((resolve) => setTimeout(resolve, 300));

    try {
      await tauriUpdaterService.install();
      // Si llega aqui NSIS no cerro el proceso (error o modo distinto)
      localStorage.setItem("update_crash_log", "Proceso interrumpido en: Relanzar aplicacion");
      updateStep(2, { status: "ok" });
      addStepLog(2, "Instalacion completada.");
      updateStep(3, { status: "running" });
      addStepLog(3, "Relanzando aplicacion...");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tauriUpdaterService.relaunch();
      localStorage.removeItem("update_crash_log");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addStepLog(2, `Error: ${msg}`);
      localStorage.setItem("update_crash_log", `Fallo en Instalar: ${msg}`);
      updateStep(2, { status: "error" });
      setInstalling(false);
    }
  }

  const hasCheckError = checkLogs.some((l) => l.ok === false);

  return <><Flex w="full" maxW="1180px" mx="auto" gap="6" direction={{ base: "column", xl: "row" }}>
    <Stack w={{ base: "full", xl: "410px" }} flexShrink="0" gap="5">
      {lastCrashLog ? (
        <Box bg="red.50" borderWidth="1px" borderColor="red.200" borderRadius="md" p="4">
          <Flex justify="space-between" align="start" gap="2">
            <Box>
              <Text fontSize="xs" fontWeight="bold" color="red.600" mb="1">FALLO EN ACTUALIZACION ANTERIOR</Text>
              <Text fontSize="sm" color="red.700" whiteSpace="pre-wrap">{lastCrashLog}</Text>
            </Box>
            <Button size="xs" variant="ghost" color="red.400" onClick={() => { localStorage.removeItem("update_crash_log"); setLastCrashLog(""); }}>
              <X size={14} />
            </Button>
          </Flex>
        </Box>
      ) : null}
      <Panel>
        <Text color="gray.500" fontWeight="bold" fontSize="xs">VERSION INSTALADA</Text>
        <Heading mt="2" size="2xl">v{APP_VERSION}</Heading>
      </Panel>
      <Panel>
        {checking
          ? <Flex align="center" gap="3"><Spinner color="#6366f1" /><Box><Heading size="md">Verificando...</Heading><Text color="gray.500" fontSize="sm">Conectando con el servidor</Text></Box></Flex>
          : <UpdateStatus info={resultV2} hasError={hasCheckError} />
        }
        {!checking ? (
          <Button mt="4" size="sm" variant="ghost" color="gray.500" onClick={() => setShowCheckLogs(true)}>
            <ScrollText size={14} />Ver registro de verificacion
          </Button>
        ) : null}
      </Panel>

      {!checking && (resultV2?.available || showSteps) ? (
        <Panel>
          <Text color="gray.500" fontWeight="bold" fontSize="xs">NOVEDADES</Text>
          <Text mt="3" whiteSpace="pre-wrap" color="gray.700" fontSize="sm">
            {resultV2?.releaseNotes || "Esta version incluye mejoras para MadPost."}
          </Text>

          {showSteps ? (
            <Box mt="5">
              <StepsList
                steps={steps}
                downloadedBytes={downloadedBytes}
                totalBytes={totalBytes}
                onSelectStep={setSelectedStep}
              />
            </Box>
          ) : (
            <Button mt="5" w="full" colorPalette="purple" onClick={() => void install()}>
              <Download size={18} />Descargar e instalar
            </Button>
          )}
        </Panel>
      ) : null}

      {!checking ? (
        <Button variant="outline" alignSelf="start" onClick={() => void refresh()}>
          <RefreshCw size={17} />Verificar de nuevo
        </Button>
      ) : null}
    </Stack>

    <Panel flex="1" minH="0">
      <Heading size="md">Historial de versiones</Heading>
      <Text mt="1" color="gray.500" fontSize="sm">Novedades publicadas para MadPost.</Text>
      <Box mt="5" maxH="560px" overflowY="auto">
        {releases.length
          ? releases.map((release) => (
            <ReleaseRow
              key={`${release.version}-${release.date}`}
              release={release}
              expanded={expanded === release.version}
              onToggle={() => setExpanded((current) => current === release.version ? null : release.version)}
            />
          ))
          : <Text color="gray.500" py="8" textAlign="center">El historial estara disponible cuando se publiquen versiones.</Text>
        }
      </Box>
    </Panel>
  </Flex>

  {showCheckLogs ? (
    <LogsModal title="Registro de verificacion" logs={checkLogs} onClose={() => setShowCheckLogs(false)} />
  ) : null}
  {selectedStep !== null ? (
    <LogsModal
      title={`Paso ${selectedStep + 1}: ${steps[selectedStep].label}`}
      logs={steps[selectedStep].logs.map((t) => ({ text: t, ok: null }))}
      onClose={() => setSelectedStep(null)}
    />
  ) : null}
  </>;
}


function UpdateStatus({ info, hasError }: { info: UpdateV2Info | null; hasError: boolean }) {
  if (hasError) return <Flex align="center" gap="3"><Flex w="42px" h="42px" borderRadius="full" bg="red.50" color="red.500" align="center" justify="center"><WifiOff size={20} /></Flex><Box><Heading size="md" color="red.500">No se pudo verificar</Heading><Text color="gray.600" fontSize="sm">Revisa el registro para mas detalles.</Text></Box></Flex>;
  if (!info) return <Flex align="center" gap="3"><Flex w="42px" h="42px" borderRadius="full" bg="gray.100" color="gray.500" align="center" justify="center"><WifiOff size={20} /></Flex><Box><Heading size="md">Actualizaciones</Heading><Text color="gray.600" fontSize="sm">No pudimos conectarnos para buscar actualizaciones.</Text></Box></Flex>;
  if (info.available && info.version) return <Flex align="center" gap="3"><Flex w="42px" h="42px" borderRadius="full" bg="purple.50" color="#6366f1" align="center" justify="center"><ArrowUp size={22} /></Flex><Box><Heading size="md" color="#6366f1">Nueva version: v{info.version}</Heading><Text color="gray.600" fontSize="sm">Hay una actualizacion disponible para descargar.</Text></Box></Flex>;
  return <Flex align="center" gap="3"><Flex w="42px" h="42px" borderRadius="full" bg="green.50" color="#10b981" align="center" justify="center"><CheckCircle2 size={22} /></Flex><Box><Heading size="md" color="#10b981">Todo al dia</Heading><Text color="gray.600" fontSize="sm">Tienes la version mas reciente instalada.</Text></Box></Flex>;
}


function ReleaseRow({ release, expanded, onToggle }: { release: ReleaseEntry; expanded: boolean; onToggle: () => void }) {
  const installed = release.version === APP_VERSION;
  return <Box borderBottomWidth="1px" borderColor="gray.100"><Button w="full" variant="ghost" justifyContent="start" py="6" _hover={{ bg: "gray.50" }} onClick={onToggle}>{expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}<Text color={installed ? "#6366f1" : "gray.700"} fontWeight="semibold">v{release.version}</Text>{installed ? <Badge colorPalette="purple">Instalada</Badge> : null}<Text ml="auto" color="gray.500" fontSize="sm">{release.date}</Text></Button>{expanded ? <Text px="9" pb="5" whiteSpace="pre-wrap" color="gray.600" fontSize="sm">{release.notes || "Sin notas para esta version."}</Text> : null}</Box>;
}

function Panel(props: React.ComponentProps<typeof Box>) { return <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="6" {...props} />; }
