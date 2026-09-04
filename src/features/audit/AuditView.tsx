import { Badge, Box, Button, Flex, Heading, Table, Text } from "@chakra-ui/react";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AuditEntry } from "./AuditEntry";
import { auditService } from "./AuditService";
import { PaginationControls } from "../../components/ui/PaginationControls";
import { ScrollableSelect } from "../../components/ui/ScrollableSelect";

const periods = [{ label: "Hoy", days: 1 }, { label: "Ultimos 7 dias", days: 7 }, { label: "Ultimos 30 dias", days: 30 }, { label: "Ultimos 90 dias", days: 90 }];

export function AuditView() {
  const [action, setAction] = useState("ALL"); const [days, setDays] = useState(7); const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]); const [pageSize, setPageSize] = useState(10); const [page, setPage] = useState(1); const [loading, setLoading] = useState(true);
  const pageCount = Math.max(1, pageSize ? Math.ceil(entries.length / pageSize) : 1);
  const pageItems = useMemo(() => pageSize ? entries.slice((page - 1) * pageSize, page * pageSize) : entries, [entries, page, pageSize]);

  useEffect(() => { void load(); }, [action, days]);
  async function load() { setLoading(true); setPage(1); try { const [items, actionValues] = await Promise.all([auditService.list({ action: action === "ALL" ? null : action, days }), auditService.distinctActions()]); setEntries(items); setActions(actionValues); } finally { setLoading(false); } }
  function changePageSize(value: number) { setPageSize(value); setPage(1); }

  return <Box w="full" maxW="1280px" mx="auto"><Flex justify="space-between" align={{ base: "start", md: "end" }} gap="4" wrap="wrap" mb="6"><Box><Heading size="lg">Registro de auditoria</Heading><Text mt="1" color="gray.500">Acciones relevantes realizadas en esta instalacion.</Text></Box><Flex gap="3" wrap="wrap" align="end"><Filter label="Accion"><Box w="200px"><ScrollableSelect placement="bottom" value={action} placeholder="Todas" options={[{ value: "ALL", label: "Todas" }, ...actions.map((item) => ({ value: item, label: item }))]} onValueChange={setAction} /></Box></Filter><Filter label="Periodo"><Box w="160px"><ScrollableSelect placement="bottom" value={String(days)} placeholder="Ultimos 7 dias" options={periods.map((item) => ({ value: String(item.days), label: item.label }))} onValueChange={(value) => setDays(Number(value))} /></Box></Filter><Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={17} />Actualizar</Button></Flex></Flex>
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden"><Box overflowX="auto"><Table.Root size="sm" minW="850px"><Table.Header><Table.Row><Table.ColumnHeader w="150px">Fecha / Hora</Table.ColumnHeader><Table.ColumnHeader w="130px">Usuario</Table.ColumnHeader><Table.ColumnHeader w="180px">Accion</Table.ColumnHeader><Table.ColumnHeader w="100px">Tipo</Table.ColumnHeader><Table.ColumnHeader>Detalle</Table.ColumnHeader></Table.Row></Table.Header><Table.Body>{pageItems.map((entry) => <Table.Row key={entry.id}><Table.Cell whiteSpace="nowrap">{formatDate(entry.createdAt)}</Table.Cell><Table.Cell>{entry.userName || "Sistema"}</Table.Cell><Table.Cell><Badge colorPalette="purple" fontFamily="mono" fontSize="2xs">{entry.action}</Badge></Table.Cell><Table.Cell>{entry.entityType}</Table.Cell><Table.Cell maxW="500px"><Text truncate title={entry.details ?? ""}>{entry.details || "-"}</Text></Table.Cell></Table.Row>)}{!loading && !pageItems.length ? <Table.Row><Table.Cell colSpan={5}><Text py="9" textAlign="center" color="gray.500">No hay acciones registradas para los filtros seleccionados.</Text></Table.Cell></Table.Row> : null}{loading ? <Table.Row><Table.Cell colSpan={5}><Text py="9" textAlign="center" color="gray.500">Cargando registro de auditoria...</Text></Table.Cell></Table.Row> : null}</Table.Body></Table.Root></Box><PaginationControls total={entries.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={changePageSize} /></Box>
  </Box>;
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) { return <Box><Text mb="1" color="gray.500" fontSize="xs" fontWeight="bold">{label.toUpperCase()}</Text>{children}</Box>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
