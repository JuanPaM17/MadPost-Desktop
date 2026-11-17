import { Badge, Box, Button, Code, Flex, Heading, Input, Stack, Switch, Table, Text } from "@chakra-ui/react";
import { Check, Play, QrCode, RefreshCw, RotateCw, Server, Square, Trash2, Wifi } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import { AppTabs } from "../../components/ui/AppTabs";
import { notify } from "../../components/ui/AppToaster";
import { Tip } from "../../components/ui/Tip";
import { businessConfigService } from "../config/BusinessConfigService";
import { mobileDevicesService, type MobileApiStatus, type MobileDevice } from "./MobileDevicesService";

export function MobileDevicesView() {
  const [pendingCount, setPendingCount] = useState(0);
  const refreshPending = useCallback(() => {
    mobileDevicesService.listDevices().then((devs) => setPendingCount(devs.filter((d) => d.status === "pending").length)).catch(() => {});
  }, []);
  useEffect(() => { refreshPending(); const t = window.setInterval(refreshPending, 6_000); return () => window.clearInterval(t); }, [refreshPending]);

  const devicesLabel = pendingCount > 0
    ? <Flex align="center" gap="2">Dispositivos<Badge colorPalette="orange">{pendingCount}</Badge></Flex>
    : "Dispositivos";

  return <AppTabs defaultValue="connection" tabs={[
    { value: "connection", label: "Conexion", content: <ConnectionTab /> },
    { value: "devices", label: devicesLabel as unknown as string, content: <DevicesTab onChanged={refreshPending} /> },
  ]} />;
}

const LOGS_KEY = "madpost_mobile_server_logs";
const MAX_LOGS = 50;

type ServerLog = { ts: string; ok: boolean; message: string };

function loadLogs(): ServerLog[] {
  try { return JSON.parse(sessionStorage.getItem(LOGS_KEY) ?? "[]"); } catch { return []; }
}
function appendLog(entry: ServerLog) {
  const logs = loadLogs();
  logs.unshift(entry);
  sessionStorage.setItem(LOGS_KEY, JSON.stringify(logs.slice(0, MAX_LOGS)));
}

function ConnectionTab() {
  const [status, setStatus] = useState<MobileApiStatus | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [tenantName, setTenantName] = useState("");
  const [tenantAddress, setTenantAddress] = useState("");
  const [logs, setLogs] = useState<ServerLog[]>(loadLogs);
  const [showLogs, setShowLogs] = useState(false);

  function addLog(ok: boolean, message: string) {
    const entry: ServerLog = { ts: new Date().toLocaleTimeString("es-CO"), ok, message };
    appendLog(entry);
    setLogs(loadLogs());
  }

  const refresh = useCallback(async () => {
    try { setStatus(await mobileDevicesService.status()); } catch { notify.error("No fue posible consultar el servidor local."); }
  }, []);

  useEffect(() => {
    void refresh();
    void mobileDevicesService.loadAutoStart().then(setAutoStart).catch(() => {});
    void businessConfigService.load().then((c) => { setTenantName(c.name); setTenantAddress(c.address); }).catch(() => {});
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const address = status?.active && status.local_ip ? `${status.local_ip}:${status.port}` : null;
  const qrValue = status?.local_ip ? `madpost://connect?host=${status.local_ip}&port=${status.port}&name=${encodeURIComponent(tenantName)}&address=${encodeURIComponent(tenantAddress)}` : "";

  async function toggleAutoStart(enabled: boolean) {
    setAutoStart(enabled);
    try { await mobileDevicesService.saveAutoStart(enabled); notify.success(enabled ? "Red local activada al iniciar sesion." : "Red local desactivada al iniciar sesion."); }
    catch (e) { notify.error("No fue posible guardar la configuracion.", e instanceof Error ? e.message : undefined); setAutoStart(!enabled); }
  }

  async function handleStart() {
    setServerBusy(true);
    try {
      const result = await mobileDevicesService.startServer();
      addLog(result.ok, result.message);
      if (!result.ok) {
        notify.error("No se pudo iniciar el servidor.", result.message);
        await refresh();
        return;
      }
      // Esperar que el servidor arranque antes de probar
      await new Promise((r) => window.setTimeout(r, 800));
      // Ping al discovery endpoint para confirmar
      try {
        const ping = await fetch(`http://127.0.0.1:8765/madpost-discovery`, { signal: AbortSignal.timeout(2000) });
        addLog(ping.ok, ping.ok ? `Ping OK — servidor respondiendo en puerto 8765` : `Ping fallo — status ${ping.status}`);
      } catch (pe) {
        addLog(false, `Ping fallo: ${pe instanceof Error ? pe.message : String(pe)}`);
      }
      await refresh();
      notify.success("Servidor local iniciado.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(false, msg);
      notify.error("No fue posible iniciar el servidor.", msg);
    } finally { setServerBusy(false); }
  }

  async function handleStop() {
    setServerBusy(true);
    try {
      await mobileDevicesService.stopServer();
      addLog(true, "Servidor detenido manualmente.");
      await refresh();
      notify.success("Servidor local detenido.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(false, msg);
      notify.error("No fue posible detener el servidor.", msg);
    } finally { setServerBusy(false); }
  }

  async function handleRestart() {
    setServerBusy(true);
    try {
      await mobileDevicesService.stopServer();
      const result = await mobileDevicesService.startServer();
      addLog(result.ok, `Reinicio: ${result.message}`);
      await refresh();
      if (result.ok) { notify.success("Servidor reiniciado correctamente."); }
      else { notify.error("El servidor no pudo reiniciarse.", result.message); }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(false, msg);
      notify.error("No fue posible reiniciar el servidor.", msg);
    } finally { setServerBusy(false); }
  }

  return (
    <Box maxW="980px" mx="auto">
      <Stack gap="5">
        <Card>
          <Flex align="center" justify="space-between" gap="4" wrap="wrap">
            <Flex align="center" gap="3">
              <Server size={20} color={status?.active ? "#22c55e" : "#94a3b8"} />
              <Box>
                <Heading size="sm">Red local para celulares</Heading>
                <Text mt="0.5" fontSize="sm" color="gray.500">Permite que dispositivos moviles en la misma WiFi se conecten a este negocio.</Text>
              </Box>
            </Flex>
            <Tip text={autoStart ? "Al iniciar sesion la red local se activa automaticamente" : "La red local no se activa automaticamente al iniciar sesion"}>
              <Switch.Root checked={autoStart} onCheckedChange={(details) => void toggleAutoStart(details.checked)} colorPalette="purple">
                <Switch.HiddenInput />
                <Switch.Control><Switch.Thumb /></Switch.Control>
                <Switch.Label fontSize="sm">Activar al iniciar sesion</Switch.Label>
              </Switch.Root>
            </Tip>
          </Flex>

          <Flex mt="5" align="center" gap="3" wrap="wrap" justify="space-between">
            <Flex align="center" gap="2">
              <Box w="9px" h="9px" borderRadius="full" bg={status?.active ? "#22c55e" : "#94a3b8"} flexShrink={0} />
              <Text fontWeight="semibold" color={status?.active ? "green.600" : "gray.500"}>
                {status === null ? "Consultando estado..." : status.active ? "Servidor activo" : "Servidor detenido"}
              </Text>
              {address && <Text fontFamily="mono" fontWeight="bold" ml="2">{address}</Text>}
            </Flex>
            <Flex gap="2">
              <Tip text="Ver log de intentos de inicio del servidor">
                <Button size="sm" variant="ghost" colorPalette={logs.some((l) => !l.ok) ? "red" : "gray"} onClick={() => setShowLogs((v) => !v)}>
                  <RefreshCw size={14} />{showLogs ? "Ocultar logs" : "Logs"}
                  {logs.some((l) => !l.ok) && <Badge colorPalette="red" ml="1">{logs.filter((l) => !l.ok).length}</Badge>}
                </Button>
              </Tip>
              <Tip text="Inicia el servidor y la deteccion automatica en red local">
                <Button size="sm" variant="outline" colorPalette="green" disabled={!!status?.active || serverBusy} onClick={() => void handleStart()}>
                  <Play size={15} />Iniciar
                </Button>
              </Tip>
              <Tip text="Detiene el servidor. Los celulares conectados perderan la conexion">
                <Button size="sm" variant="outline" colorPalette="red" disabled={!status?.active || serverBusy} onClick={() => void handleStop()}>
                  <Square size={15} />Detener
                </Button>
              </Tip>
              <Tip text="Detiene y vuelve a iniciar el servidor. Util si la conexion presenta problemas">
                <Button size="sm" variant="outline" disabled={serverBusy} onClick={() => void handleRestart()}>
                  <RotateCw size={15} />Reiniciar
                </Button>
              </Tip>
            </Flex>
          </Flex>

          {showLogs && (
            <Box mt="4" bg="gray.50" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="3" maxH="200px" overflowY="auto">
              {logs.length === 0
                ? <Text fontSize="xs" color="gray.400">Sin logs todavia.</Text>
                : logs.map((l, i) => (
                  <Flex key={i} gap="2" align="baseline" mb="1">
                    <Text fontSize="xs" color="gray.400" flexShrink={0}>{l.ts}</Text>
                    <Box w="6px" h="6px" borderRadius="full" bg={l.ok ? "green.500" : "red.500"} flexShrink={0} mt="1" />
                    <Text fontSize="xs" color={l.ok ? "green.700" : "red.700"} fontFamily="mono">{l.message}</Text>
                  </Flex>
                ))
              }
            </Box>
          )}
        </Card>

        <Card>
          <Heading size="sm">Codigo QR</Heading>
          {status?.active && status.local_ip ? (
            <Flex mt="4" direction={{ base: "column", md: "row" }} align="center" gap="6">
              <Box p="3" bg="white" borderWidth="1px" borderColor="gray.200"><QRCodeSVG value={qrValue} size={220} level="M" marginSize={2} /></Box>
              <Box>
                <Text fontWeight="semibold">Escanea el codigo QR desde MadPost en tu celular.</Text>
              </Box>
            </Flex>
          ) : (
            <Flex minH="180px" align="center" justify="center" direction="column" gap="3" color="gray.400">
              <QrCode size={34} />
              <Text>Inicia el servidor para ver el codigo QR.</Text>
            </Flex>
          )}
        </Card>

        <Card>
          <Heading size="sm">Como conectar un celular</Heading>
          <Stack mt="4" gap="2">
            {["Conecta el celular a la misma red WiFi que esta computadora.", "Activa el servidor usando el boton Iniciar de arriba.", "Abre MadPost en el celular.", "La aplicacion detectara el negocio o podras escanear el codigo QR.", "Inicia sesion con tu usuario y contrasena de MadPost.", "Las mesas y ventas se actualizaran en tiempo real."].map((text, index) => (
              <Flex key={text} gap="3"><Badge colorPalette="purple">{index + 1}</Badge><Text>{text}</Text></Flex>
            ))}
          </Stack>
          <Flex mt="5" gap="2" p="3" bg="yellow.50" color="yellow.800" borderRadius="sm">
            <Wifi size={18} />
            <Text fontSize="sm">La caja debe estar abierta desde el PC para que el movil pueda registrar ventas.</Text>
          </Flex>
        </Card>
      </Stack>
    </Box>
  );
}

function DevicesTab({ onChanged }: { onChanged?: () => void }) {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try { setDevices(await mobileDevicesService.listDevices()); }
    catch { notify.error("No fue posible actualizar los dispositivos."); }
  }, []);

  useEffect(() => { void refresh(); const t = window.setInterval(() => void refresh(), 6_000); return () => window.clearInterval(t); }, [refresh]);

  async function saveAlias(device: MobileDevice) {
    const alias = drafts[device.id] ?? device.alias;
    try {
      await mobileDevicesService.patchDevice(device.id, { alias });
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, alias } : d));
      notify.success("Alias guardado.");
    } catch { notify.error("No fue posible guardar el alias."); }
  }

  async function setStatus(device: MobileDevice, status: "approved" | "revoked") {
    setBusy((prev) => ({ ...prev, [device.id]: true }));
    try {
      await mobileDevicesService.patchDevice(device.id, { status });
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, status } : d));
      notify.success(status === "approved" ? "Dispositivo aprobado." : "Dispositivo revocado.");
      onChanged?.();
    } catch { notify.error("No fue posible actualizar el estado."); }
    finally { setBusy((prev) => ({ ...prev, [device.id]: false })); }
  }

  async function deleteDevice(device: MobileDevice) {
    setBusy((prev) => ({ ...prev, [device.id]: true }));
    try {
      await mobileDevicesService.deleteDevice(device.id);
      setDevices((prev) => prev.filter((d) => d.id !== device.id));
      notify.success("Dispositivo eliminado.");
      onChanged?.();
    } catch { notify.error("No fue posible eliminar el dispositivo."); }
    finally { setBusy((prev) => ({ ...prev, [device.id]: false })); }
  }

  const statusColor = (s: string) => s === "approved" ? "green" : s === "revoked" ? "red" : "orange";
  const statusLabel = (s: string) => s === "approved" ? "Aprobado" : s === "revoked" ? "Revocado" : "Pendiente";

  return (
    <Box maxW="1080px" mx="auto">
      <Flex justify="end" mb="4">
        <Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw size={16} />Refrescar</Button>
      </Flex>
      <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>ID del dispositivo</Table.ColumnHeader>
              <Table.ColumnHeader>Alias</Table.ColumnHeader>
              <Table.ColumnHeader>Ultima vez visto</Table.ColumnHeader>
              <Table.ColumnHeader>Estado</Table.ColumnHeader>
              <Table.ColumnHeader>Registrado</Table.ColumnHeader>
              <Table.ColumnHeader w="180px" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {devices.map((device) => (
              <Table.Row key={device.id} bg={device.status === "pending" ? "orange.50" : undefined}>
                <Table.Cell fontFamily="mono" fontSize="xs" color="gray.500">{device.id.slice(0, 8)}…</Table.Cell>
                <Table.Cell>
                  <Flex gap="2">
                    <Input size="sm" value={drafts[device.id] ?? device.alias} placeholder="Sin alias"
                      onChange={(e) => setDrafts((p) => ({ ...p, [device.id]: e.target.value }))}
                      onBlur={() => void saveAlias(device)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                    <Button size="sm" variant="ghost" onClick={() => void saveAlias(device)}><Check size={15} /></Button>
                  </Flex>
                </Table.Cell>
                <Table.Cell fontSize="xs">{device.last_seen_at ? formatDate(device.last_seen_at) : "-"}</Table.Cell>
                <Table.Cell><Badge colorPalette={statusColor(device.status)}>{statusLabel(device.status)}</Badge></Table.Cell>
                <Table.Cell fontSize="xs">{formatDate(device.registered_at)}</Table.Cell>
                <Table.Cell>
                  <Flex gap="1" justify="end">
                    {device.status !== "approved" && (
                      <Tip text="Aprobar dispositivo">
                        <Button size="xs" colorPalette="green" variant="outline" disabled={busy[device.id]} onClick={() => void setStatus(device, "approved")}>Aprobar</Button>
                      </Tip>
                    )}
                    {device.status !== "revoked" && (
                      <Tip text="Revocar acceso">
                        <Button size="xs" colorPalette="red" variant="outline" disabled={busy[device.id]} onClick={() => void setStatus(device, "revoked")}>Revocar</Button>
                      </Tip>
                    )}
                    <Tip text="Eliminar registro">
                      <Button size="xs" variant="ghost" colorPalette="gray" disabled={busy[device.id]} onClick={() => void deleteDevice(device)}><Trash2 size={13} /></Button>
                    </Tip>
                  </Flex>
                </Table.Cell>
              </Table.Row>
            ))}
            {!devices.length && (
              <Table.Row>
                <Table.Cell colSpan={7}>
                  <Text py="8" textAlign="center" color="gray.500">Aun no hay dispositivos registrados.</Text>
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Root>
      </Box>
    </Box>
  );
}

function Card({ children }: { children: React.ReactNode }) { return <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5">{children}</Box>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
