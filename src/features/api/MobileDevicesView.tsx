import { Badge, Box, Button, Flex, Heading, Input, Stack, Switch, Table, Text } from "@chakra-ui/react";
import { Check, Clipboard, Play, QrCode, RefreshCw, RotateCw, Server, Square, Wifi } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppTabs } from "../../components/ui/AppTabs";
import { notify } from "../../components/ui/AppToaster";
import { Tip } from "../../components/ui/Tip";
import { mobileDevicesService, type DeviceAlias, type MobileApiStatus } from "./MobileDevicesService";

type DeviceRow = { ip: string; alias: string; connected: boolean; connectedAt: string | null };

export function MobileDevicesView() { return <AppTabs defaultValue="connection" tabs={[{ value: "connection", label: "Conexion", content: <ConnectionTab /> }, { value: "devices", label: "Dispositivos", content: <DevicesTab /> }]} />; }

function ConnectionTab() {
  const [status, setStatus] = useState<MobileApiStatus | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [copied, setCopied] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await mobileDevicesService.status()); } catch { notify.error("No fue posible consultar el servidor local."); }
  }, []);

  useEffect(() => {
    void refresh();
    void mobileDevicesService.loadAutoStart().then(setAutoStart).catch(() => {});
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const address = status?.active && status.local_ip ? `${status.local_ip}:${status.port}` : null;
  const qrValue = status?.local_ip ? `madpost://connect?host=${status.local_ip}&port=${status.port}` : "";

  async function copyAddress() {
    if (!status?.local_ip) return;
    try { await navigator.clipboard.writeText(status.local_ip); setCopied(true); window.setTimeout(() => setCopied(false), 2_000); }
    catch { notify.error("No fue posible copiar la direccion."); }
  }

  async function toggleAutoStart(enabled: boolean) {
    setAutoStart(enabled);
    try { await mobileDevicesService.saveAutoStart(enabled); notify.success(enabled ? "Red local activada al iniciar sesion." : "Red local desactivada al iniciar sesion."); }
    catch (e) { notify.error("No fue posible guardar la configuracion.", e instanceof Error ? e.message : undefined); setAutoStart(!enabled); }
  }

  async function handleStart() {
    setServerBusy(true);
    try { await mobileDevicesService.startServer(); await refresh(); notify.success("Servidor local iniciado."); }
    catch (e) { notify.error("No fue posible iniciar el servidor.", e instanceof Error ? e.message : undefined); }
    finally { setServerBusy(false); }
  }

  async function handleStop() {
    setServerBusy(true);
    try { await mobileDevicesService.stopServer(); await refresh(); notify.success("Servidor local detenido."); }
    catch (e) { notify.error("No fue posible detener el servidor.", e instanceof Error ? e.message : undefined); }
    finally { setServerBusy(false); }
  }

  async function handleRestart() {
    setServerBusy(true);
    try {
      await mobileDevicesService.stopServer();
      await mobileDevicesService.startServer();
      await refresh();
      notify.success("Servidor reiniciado correctamente.");
    } catch (e) { notify.error("No fue posible reiniciar el servidor.", e instanceof Error ? e.message : undefined); }
    finally { setServerBusy(false); }
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
              {address && (
                <Flex align="center" gap="2" ml="2">
                  <Text fontFamily="mono" fontWeight="bold">{address}</Text>
                  <Button size="xs" variant="outline" onClick={() => void copyAddress()}>
                    <Clipboard size={13} />{copied ? "Copiado" : "Copiar"}
                  </Button>
                </Flex>
              )}
            </Flex>
            <Flex gap="2">
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
        </Card>

        <Card>
          <Heading size="sm">Codigo QR</Heading>
          {status?.active && status.local_ip ? (
            <Flex mt="4" direction={{ base: "column", md: "row" }} align="center" gap="6">
              <Box p="3" bg="white" borderWidth="1px" borderColor="gray.200"><QRCodeSVG value={qrValue} size={220} level="M" marginSize={2} /></Box>
              <Box>
                <Text fontWeight="semibold">Conecta tu dispositivo sin escribir la direccion.</Text>
                <Text mt="2" color="gray.600">O ingresa manualmente: <Text as="span" fontFamily="mono">{address}</Text></Text>
                <Button mt="3" size="sm" variant="outline" onClick={() => void copyAddress()}>
                  <Clipboard size={14} />{copied ? "Copiado" : "Copiar IP"}
                </Button>
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

function DevicesTab() {
  const [status, setStatus] = useState<MobileApiStatus | null>(null); const [aliases, setAliases] = useState<DeviceAlias[]>([]); const [drafts, setDrafts] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => { try { const [nextStatus, nextAliases] = await Promise.all([mobileDevicesService.status(), mobileDevicesService.aliases()]); setStatus(nextStatus); setAliases(nextAliases); } catch { notify.error("No fue posible actualizar los dispositivos."); } }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, [refresh]);
  const rows = useMemo<DeviceRow[]>(() => { const result = new Map<string, DeviceRow>(); for (const alias of aliases) result.set(alias.ip, { ip: alias.ip, alias: alias.alias, connected: false, connectedAt: null }); for (const client of status?.clients ?? []) result.set(client.ip, { ip: client.ip, alias: result.get(client.ip)?.alias ?? "", connected: true, connectedAt: client.connected_at }); return [...result.values()].sort((left, right) => Number(right.connected) - Number(left.connected) || left.ip.localeCompare(right.ip)); }, [aliases, status]);
  async function saveAlias(row: DeviceRow) { const alias = drafts[row.ip] ?? row.alias; try { await mobileDevicesService.setAlias(row.ip, alias); setAliases((current) => [...current.filter((item) => item.ip !== row.ip), { ip: row.ip, alias }]); notify.success("Alias del dispositivo guardado."); } catch (error) { notify.error("No fue posible guardar el alias.", error instanceof Error ? error.message : undefined); } }
  return <Box maxW="1080px" mx="auto"><Flex justify="end" mb="4"><Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw size={16} />Refrescar</Button></Flex><Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden"><Table.Root size="sm"><Table.Header><Table.Row><Table.ColumnHeader w="34px" /><Table.ColumnHeader>Direccion IP</Table.ColumnHeader><Table.ColumnHeader>Alias</Table.ColumnHeader><Table.ColumnHeader>Conectado desde</Table.ColumnHeader><Table.ColumnHeader>Estado</Table.ColumnHeader></Table.Row></Table.Header><Table.Body>{rows.map((row) => <Table.Row key={row.ip}><Table.Cell><Box w="9px" h="9px" borderRadius="full" bg={row.connected ? "#22c55e" : "#94a3b8"} /></Table.Cell><Table.Cell fontFamily="mono">{row.ip}</Table.Cell><Table.Cell><Flex gap="2"><Input size="sm" value={drafts[row.ip] ?? row.alias} placeholder="Sin alias" onChange={(event) => setDrafts((current) => ({ ...current, [row.ip]: event.target.value }))} onBlur={() => void saveAlias(row)} onKeyDown={(event) => { if (event.key === "Enter") { event.currentTarget.blur(); } }} /><Button size="sm" variant="ghost" onClick={() => void saveAlias(row)}><Check size={16} /></Button></Flex></Table.Cell><Table.Cell>{row.connectedAt ? formatDate(row.connectedAt) : "-"}</Table.Cell><Table.Cell><Badge colorPalette={row.connected ? "green" : "gray"}>{row.connected ? "Conectado" : "Desconectado"}</Badge></Table.Cell></Table.Row>)}{!rows.length ? <Table.Row><Table.Cell colSpan={5}><Text py="8" textAlign="center" color="gray.500">Aun no hay dispositivos conectados.</Text></Table.Cell></Table.Row> : null}</Table.Body></Table.Root></Box></Box>;
}

function Card({ children }: { children: React.ReactNode }) { return <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5">{children}</Box>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
