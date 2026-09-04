import { Badge, Box, Button, Flex, Heading, Spinner, Stack, Text } from "@chakra-ui/react";
import { ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { APP_VERSION, type ReleaseEntry, updateService, type UpdateCheckResult } from "./UpdateService";

export function UpdateView() {
  const [checking, setChecking] = useState(true); const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [releases, setReleases] = useState<ReleaseEntry[]>([]); const [expanded, setExpanded] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false); const [installError, setInstallError] = useState("");
  useEffect(() => { void refresh(); }, []);

  async function refresh() { setChecking(true); setResult(null); setInstallError(""); const [check, history] = await Promise.all([updateService.check(), updateService.listReleases()]); setResult(check); setReleases(history); setChecking(false); }
  async function install() { if (!result?.update) return; setInstalling(true); setInstallError(""); try { await updateService.install(result.update); } catch (error) { setInstallError(error instanceof Error ? error.message : "No fue posible iniciar la actualizacion."); setInstalling(false); } }

  return <Flex w="full" maxW="1180px" mx="auto" gap="6" direction={{ base: "column", xl: "row" }}>
    <Stack w={{ base: "full", xl: "410px" }} flexShrink="0" gap="5"><Panel><Text color="gray.500" fontWeight="bold" fontSize="xs">VERSION INSTALADA</Text><Heading mt="2" size="2xl">v{APP_VERSION}</Heading></Panel>
      <Panel>{checking ? <Flex align="center" gap="3"><Spinner color="#6366f1" /><Box><Heading size="md">Verificando...</Heading><Text color="gray.500" fontSize="sm">Conectando con el servidor</Text></Box></Flex> : <UpdateStatus result={result!} />}</Panel>
      {!checking && result?.state === "available" && result.update ? <Panel><Text color="gray.500" fontWeight="bold" fontSize="xs">NOVEDADES</Text><Text mt="3" whiteSpace="pre-wrap" color="gray.700" fontSize="sm">{result.update.releaseNotes || "Esta version incluye mejoras para MadPost."}</Text>{installError ? <Text mt="4" color="red.600" fontSize="sm">{installError}</Text> : null}<Button mt="5" w="full" colorPalette="purple" disabled={installing || !result.update.downloadUrl} onClick={() => void install()}><Download size={18} />{installing ? "Descargando..." : "Descargar e instalar"}</Button>{!result.update.downloadUrl ? <Text mt="2" color="gray.500" fontSize="xs">El instalador estara disponible pronto.</Text> : null}</Panel> : null}
      {!checking ? <Button variant="outline" alignSelf="start" onClick={() => void refresh()}><RefreshCw size={17} />Verificar de nuevo</Button> : null}
    </Stack>
    <Panel flex="1" minH="0"><Heading size="md">Historial de versiones</Heading><Text mt="1" color="gray.500" fontSize="sm">Novedades publicadas para MadPost.</Text><Box mt="5" maxH="560px" overflowY="auto">{releases.length ? releases.map((release) => <ReleaseRow key={`${release.version}-${release.date}`} release={release} expanded={expanded === release.version} onToggle={() => setExpanded((current) => current === release.version ? null : release.version)} />) : <Text color="gray.500" py="8" textAlign="center">El historial estara disponible cuando se publiquen versiones.</Text>}</Box></Panel>
  </Flex>;
}

function UpdateStatus({ result }: { result: UpdateCheckResult }) {
  if (result.state === "available" && result.update) return <Flex align="center" gap="3"><Flex w="42px" h="42px" borderRadius="full" bg="purple.50" color="#6366f1" align="center" justify="center"><ArrowUp size={22} /></Flex><Box><Heading size="md" color="#6366f1">Nueva version: v{result.update.version}</Heading><Text color="gray.600" fontSize="sm">{result.message}</Text></Box></Flex>;
  if (result.state === "upToDate") return <Flex align="center" gap="3"><Flex w="42px" h="42px" borderRadius="full" bg="green.50" color="#10b981" align="center" justify="center"><CheckCircle2 size={22} /></Flex><Box><Heading size="md" color="#10b981">Todo al dia</Heading><Text color="gray.600" fontSize="sm">{result.message}</Text></Box></Flex>;
  return <Flex align="center" gap="3"><Flex w="42px" h="42px" borderRadius="full" bg="gray.100" color="gray.500" align="center" justify="center"><WifiOff size={20} /></Flex><Box><Heading size="md">Actualizaciones</Heading><Text color="gray.600" fontSize="sm">{result.message}</Text></Box></Flex>;
}

function ReleaseRow({ release, expanded, onToggle }: { release: ReleaseEntry; expanded: boolean; onToggle: () => void }) {
  const installed = release.version === APP_VERSION;
  return <Box borderBottomWidth="1px" borderColor="gray.100"><Button w="full" variant="ghost" justifyContent="start" py="6" _hover={{ bg: "gray.50" }} onClick={onToggle}>{expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}<Text color={installed ? "#6366f1" : "gray.700"} fontWeight="semibold">v{release.version}</Text>{installed ? <Badge colorPalette="purple">Instalada</Badge> : null}<Text ml="auto" color="gray.500" fontSize="sm">{release.date}</Text></Button>{expanded ? <Text px="9" pb="5" whiteSpace="pre-wrap" color="gray.600" fontSize="sm">{release.notes || "Sin notas para esta version."}</Text> : null}</Box>;
}

function Panel(props: React.ComponentProps<typeof Box>) { return <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="6" {...props} />; }
