import { Badge, Box, Button, Flex, Heading, Separator, Spinner, Stack, Text } from "@chakra-ui/react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, CloudOff, DatabaseBackup, FolderOpen, RefreshCw, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sessionContext } from "../../core/session/SessionContext";
import { notify } from "../../components/ui/AppToaster";
import { connectivityMonitor } from "../sync/ConnectivityMonitor";
import { backupScheduler } from "./BackupScheduler";
import { backupService, type BackupEntry } from "./BackupService";
import type { R2ConnectionCheck } from "./R2Client";

type R2Status = { state: "checking" | "connected" | "unavailable" | "unconfigured"; detail?: R2ConnectionCheck };

export function BackupView() {
  const tenantId = sessionContext.current()?.tenantId ?? "";
  const [online, setOnline] = useState(connectivityMonitor.isOnline());
  const [r2Status, setR2Status] = useState<R2Status>({ state: "checking" });
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [creating, setCreating] = useState(false);

  const verifyR2 = useCallback(async () => {
    setR2Status({ state: "checking" });
    const result = await backupService.checkR2Connection();
    setR2Status({ state: result.connected ? "connected" : result.missing.length ? "unconfigured" : "unavailable", detail: result });
  }, [tenantId]);

  const refreshHistory = useCallback(async () => {
    setLoadingHistory(true);
    try { setEntries(await backupService.listAllBackups(tenantId)); }
    catch { notify.error("No fue posible cargar el historial de copias."); }
    finally { setLoadingHistory(false); }
  }, [tenantId]);

  useEffect(() => {
    void verifyR2();
    void refreshHistory();
    const unsubscribe = connectivityMonitor.subscribe((isOnline) => setOnline(isOnline));
    return () => { unsubscribe(); };
  }, [refreshHistory, verifyR2]);

  async function createBackup() {
    setCreating(true);
    try {
      const result = await backupService.createBackup(tenantId);
      if (!result.fileName) notify.error("No fue posible crear la copia de seguridad.", result.error ?? undefined);
      else if (result.uploadedToR2) notify.success("Copia guardada localmente y en la nube.");
      else notify.success("Copia guardada localmente.", result.error ?? "Se subira a la nube cuando este disponible.");
      await refreshHistory();
      void verifyR2();
    } catch (error) { notify.error("No fue posible crear la copia de seguridad.", error instanceof Error ? error.message : undefined); }
    finally { setCreating(false); }
  }

  async function openFolder() {
    try { await invoke("open_backups_folder"); }
    catch (error) { notify.error("No fue posible abrir la carpeta de copias.", error instanceof Error ? error.message : undefined); }
  }

  const next = backupScheduler.getNextScheduledTime();
  return <Box maxW="1080px" mx="auto"><Stack gap="5">
    <Card><Heading size="sm">Estado</Heading><Flex mt="5" gap="5" direction={{ base: "column", md: "row" }}>
      <StatusItem icon={<DatabaseBackup size={19} />} title="Proximo backup automatico" detail={next ? formatDate(next) : "Calculando..."} note="Programados a las 2:00 PM y 11:00 PM diariamente." />
      <StatusItem icon={online ? <Wifi size={19} /> : <WifiOff size={19} />} title="Conectividad a internet" detail={online ? "Internet disponible" : "Sin internet"} tone={online ? "green" : "orange"} note={online ? "Las copias pendientes pueden subirse a la nube." : "Las copias quedan locales hasta recuperar la conexion."} />
      <Box flex="1"><Flex align="center" justify="space-between" gap="3"><Flex gap="2" align="center"><Cloud size={19} /><Text fontWeight="semibold">Solo Nube</Text></Flex><Button size="xs" variant="outline" onClick={() => void verifyR2()} disabled={r2Status.state === "checking"}>Verificar</Button></Flex><R2Badge status={r2Status} /></Box>
    </Flex></Card>

    <Card><Heading size="sm">Acciones</Heading><Flex mt="4" gap="3" wrap="wrap"><Button colorPalette="purple" disabled={creating} onClick={() => void createBackup()}><DatabaseBackup size={17} />{creating ? "Creando copia..." : "Realizar copia ahora"}</Button><Button variant="outline" onClick={() => void openFolder()}><FolderOpen size={17} />Abrir carpeta de copias</Button></Flex>{creating ? <Flex mt="4" gap="2" align="center"><Spinner size="sm" color="purple.600" /><Text color="gray.600" fontSize="sm">Creando y verificando la copia de seguridad...</Text></Flex> : null}</Card>

    <Card><Flex align="center" justify="space-between" gap="3"><Heading size="sm">Historial</Heading><Button size="sm" variant="outline" disabled={loadingHistory} onClick={() => void refreshHistory()}><RefreshCw size={16} />Actualizar</Button></Flex><Box mt="4">{loadingHistory ? <Flex py="8" justify="center"><Spinner color="purple.600" /></Flex> : entries.length === 0 ? <Text py="6" textAlign="center" color="gray.500">Aun no hay copias de seguridad.</Text> : <Stack gap="0" borderTopWidth="1px" borderColor="gray.100">{entries.map((entry) => <BackupRow key={entry.fileName} entry={entry} />)}</Stack>}</Box></Card>
  </Stack></Box>;
}

function Card({ children }: { children: React.ReactNode }) { return <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5">{children}</Box>; }
function StatusItem({ icon, title, detail, note, tone = "gray" }: { icon: React.ReactNode; title: string; detail: string; note: string; tone?: "gray" | "green" | "orange" }) { const color = tone === "green" ? "green.600" : tone === "orange" ? "orange.600" : "gray.800"; return <Box flex="1"><Flex align="center" gap="2" color="gray.600">{icon}<Text fontWeight="semibold">{title}</Text></Flex><Text mt="2" fontWeight="bold" color={color}>{detail}</Text><Text mt="1" fontSize="sm" color="gray.500">{note}</Text></Box>; }
function R2Badge({ status }: { status: R2Status }) { if (status.state === "checking") return <Flex mt="3" gap="2" align="center"><Spinner size="xs" /><Text fontSize="sm" color="gray.500">Verificando conexion...</Text></Flex>; const connected = status.state === "connected"; const unconfigured = status.state === "unconfigured"; const detail = status.detail; const message = connected ? "Las copias se guardan tambien en la nube." : unconfigured ? detail?.missing.length ? `Faltan variables: ${detail.missing.join(", ")}.` : "La nube aun no esta configurada." : detail?.reason ?? "No fue posible establecer la conexion."; return <Box mt="3"><Flex gap="2" align="center"><Badge colorPalette={connected ? "green" : unconfigured ? "gray" : "red"}>{connected ? "Conectada" : unconfigured ? "Sin configurar" : "Sin acceso"}</Badge><Text fontSize="sm" color="gray.500">{message}</Text>{connected ? <ShieldCheck size={16} color="#10b981" /> : <CloudOff size={16} color={unconfigured ? "#94a3b8" : "#ef4444"} />}</Flex>{detail?.endpoint || detail?.bucket ? <Text mt="1" fontSize="xs" color="gray.500">Probando: {detail.endpoint ?? "endpoint no disponible"} · bucket: {detail.bucket ?? "no disponible"}</Text> : null}</Box>; }
function BackupRow({ entry }: { entry: BackupEntry }) { return <Flex py="3" gap="4" align="center" borderBottomWidth="1px" borderColor="gray.100" wrap={{ base: "wrap", sm: "nowrap" }}><Text flex="1" minW="0" fontFamily="mono" fontSize="sm" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">{entry.fileName}</Text><Text w={{ base: "auto", sm: "150px" }} color="gray.600" fontSize="sm">{formatDate(entry.createdAt)}</Text><Badge colorPalette={entry.isLocal && entry.isRemote ? "green" : entry.isRemote ? "blue" : "orange"}>{entry.isLocal && entry.isRemote ? "Local + Nube" : entry.isRemote ? "Nube" : "Local"}</Badge></Flex>; }
function formatDate(value: Date) { return new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short" }).format(value); }
