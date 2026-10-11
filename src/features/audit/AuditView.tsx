import { Badge, Box, Button, Flex, Input, Stack, Table, Text } from "@chakra-ui/react";
import type { AuditItem } from "./AuditEntry";
import { Check, Filter, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AuditEntry } from "./AuditEntry";
import { auditService } from "./AuditService";
import { PaginationControls } from "../../components/ui/PaginationControls";
import { ScrollableSelect } from "../../components/ui/ScrollableSelect";

type ActiveFilters = { dateFrom: string; dateTo: string; action: string; entityType: string; userName: string };
const EMPTY_FILTERS: ActiveFilters = { dateFrom: "", dateTo: "", action: "ALL", entityType: "ALL", userName: "ALL" };

export function AuditView() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detail, setDetail] = useState<AuditEntry | null>(null);
  const [active, setActive] = useState<ActiveFilters>(EMPTY_FILTERS);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.details?.toLowerCase().includes(q) || e.userName?.toLowerCase().includes(q) || e.entityType.toLowerCase().includes(q));
  }, [entries, search]);
  const pageItems = useMemo(() => pageSize ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered, [filtered, page, pageSize]);

  const activeFilterCount = [active.dateFrom, active.dateTo, active.action !== "ALL" ? active.action : "", active.entityType !== "ALL" ? active.entityType : "", active.userName !== "ALL" ? active.userName : ""].filter(Boolean).length;
  const filterLabels = [active.dateFrom ? `Desde: ${formatDay(active.dateFrom)}` : null, active.dateTo ? `Hasta: ${formatDay(active.dateTo)}` : null, active.action !== "ALL" ? `Accion: ${active.action}` : null, active.entityType !== "ALL" ? `Tipo: ${active.entityType}` : null, active.userName !== "ALL" ? `Usuario: ${active.userName}` : null].filter((l): l is string => Boolean(l));

  useEffect(() => { void load(active); }, []);

  async function load(filters: ActiveFilters) {
    setLoading(true); setPage(1);
    try {
      const [items, acts, types, userNames] = await Promise.all([
        auditService.list({ dateFrom: filters.dateFrom || undefined, dateTo: filters.dateTo || undefined, action: filters.action !== "ALL" ? filters.action : undefined, entityType: filters.entityType !== "ALL" ? filters.entityType : undefined, userName: filters.userName !== "ALL" ? filters.userName : undefined }),
        auditService.distinctActions(),
        auditService.distinctEntityTypes(),
        auditService.distinctUserNames(),
      ]);
      setEntries(items); setActions(acts); setEntityTypes(types); setUsers(userNames);
    } finally { setLoading(false); }
  }

  async function applyFilters(next: ActiveFilters) { setActive(next); await load(next); setFiltersOpen(false); }
  async function clearFilters() { setSearch(""); setActive(EMPTY_FILTERS); await load(EMPTY_FILTERS); }

  return (
    <Box w="full" maxW="1280px" mx="auto">
      <Flex gap="3" wrap="wrap" mb="5" align="center">
        <Box flex="1" minW={{ base: "full", md: "280px" }} position="relative">
          <Search size={17} color="#6b7280" style={{ position: "absolute", left: 12, top: 11, zIndex: 1 }} />
          <Input pl="10" placeholder="Buscar por detalle, usuario o tipo..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </Box>
        <Button variant="outline" onClick={() => setFiltersOpen(true)}>
          <Filter size={18} />Filtros{activeFilterCount ? ` (${activeFilterCount})` : ""}
        </Button>
      </Flex>

      {filterLabels.length ? (
        <Flex mb="4" px="3" py="2" bg="purple.50" borderWidth="1px" borderColor="purple.100" borderRadius="md" align="center" justify="space-between" gap="3" wrap="wrap">
          <Text color="purple.800" fontSize="sm">Filtros activos: {filterLabels.join(" · ")}</Text>
          <Button size="sm" variant="ghost" colorPalette="purple" onClick={() => void clearFilters()}>Limpiar filtros</Button>
        </Flex>
      ) : null}

      <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
        <Box overflowX="auto">
          <Table.Root size="sm" minW="750px">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader w="150px">Fecha / Hora</Table.ColumnHeader>
                <Table.ColumnHeader w="130px">Usuario</Table.ColumnHeader>
                <Table.ColumnHeader w="180px">Accion</Table.ColumnHeader>
                <Table.ColumnHeader w="120px">Tipo</Table.ColumnHeader>
                <Table.ColumnHeader w="110px" textAlign="right">Acciones</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {pageItems.map((entry) => (
                <Table.Row key={entry.id}>
                  <Table.Cell whiteSpace="nowrap">{formatDate(entry.createdAt)}</Table.Cell>
                  <Table.Cell>{entry.userName || "Sistema"}</Table.Cell>
                  <Table.Cell><Badge colorPalette="purple" fontFamily="mono" fontSize="2xs">{entry.action}</Badge></Table.Cell>
                  <Table.Cell>{entry.entityType}</Table.Cell>
                  <Table.Cell textAlign="right">
                    <Button size="sm" variant="outline" onClick={() => setDetail(entry)}>Ver detalle</Button>
                  </Table.Cell>
                </Table.Row>
              ))}
              {!loading && !pageItems.length ? <Table.Row><Table.Cell colSpan={5}><Text py="9" textAlign="center" color="gray.500">No hay acciones registradas para los filtros seleccionados.</Text></Table.Cell></Table.Row> : null}
              {loading ? <Table.Row><Table.Cell colSpan={5}><Text py="9" textAlign="center" color="gray.500">Cargando...</Text></Table.Cell></Table.Row> : null}
            </Table.Body>
          </Table.Root>
        </Box>
        <PaginationControls total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
      </Box>

      {filtersOpen ? <AuditFiltersDialog actions={actions} entityTypes={entityTypes} users={users} initial={active} onClose={() => setFiltersOpen(false)} onApply={(f) => void applyFilters(f)} onClear={() => void clearFilters()} maxW="640px" /> : null}
      {detail ? <AuditDetailDialog entry={detail} onClose={() => setDetail(null)} /> : null}
    </Box>
  );
}

function AuditFiltersDialog({ actions, entityTypes, users, initial, onClose, onApply, onClear, maxW }: { actions: string[]; entityTypes: string[]; users: string[]; initial: ActiveFilters; onClose: () => void; onApply: (f: ActiveFilters) => void; onClear: () => void; maxW?: string }) {
  const [from, setFrom] = useState(initial.dateFrom);
  const [to, setTo] = useState(initial.dateTo);
  const [action, setAction] = useState(initial.action);
  const [entityType, setEntityType] = useState(initial.entityType);
  const [userName, setUserName] = useState(initial.userName);
  const [error, setError] = useState("");
  function apply() { if (to && from && to < from) { setError("La fecha final no puede ser anterior a la inicial."); return; } onApply({ dateFrom: from, dateTo: to, action, entityType, userName }); }
  return (
    <Modal maxW={maxW ?? "500px"}>
      <Text fontWeight="bold" fontSize="lg" mb="1">Filtros</Text>
      <Text color="gray.500" fontSize="sm" mb="6">Combina los filtros que necesites.</Text>
      <Box display="grid" gridTemplateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="5">
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Accion"><ScrollableSelect placement="top" placeholder="Todas" value={action} options={[{ value: "ALL", label: "Todas" }, ...actions.map((a) => ({ value: a, label: a }))]} onValueChange={setAction} /></Field>
        <Field label="Tipo"><ScrollableSelect placement="top" placeholder="Todos" value={entityType} options={[{ value: "ALL", label: "Todos" }, ...entityTypes.map((t) => ({ value: t, label: t }))]} onValueChange={setEntityType} /></Field>
        {users.length > 0 ? <Field label="Usuario"><ScrollableSelect placement="top" placeholder="Todos" value={userName} options={[{ value: "ALL", label: "Todos" }, ...users.map((u) => ({ value: u, label: u }))]} onValueChange={setUserName} /></Field> : null}
      </Box>
      {error ? <Text mt="3" color="red.600" fontSize="sm">{error}</Text> : null}
      <Flex justify="space-between" mt="7" gap="3">
        <Button variant="outline" onClick={() => { onClear(); onClose(); }}>Limpiar todo</Button>
        <Flex gap="3"><Button variant="outline" onClick={onClose}>Cancelar</Button><Button colorPalette="purple" onClick={apply}><Check size={17} />Aplicar</Button></Flex>
      </Flex>
    </Modal>
  );
}

function AuditDetailDialog({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  return (
    <Modal maxW="640px">
      <Text fontWeight="bold" fontSize="lg" mb="5">Detalle del registro</Text>
      <Stack gap="4">
        <DetailRow label="Fecha / Hora" value={formatDate(entry.createdAt)} />
        <DetailRow label="Usuario" value={entry.userName || "Sistema"} />
        <DetailRow label="Accion" value={entry.action} mono />
        <DetailRow label="Tipo" value={entry.entityType} />
        {entry.details ? (
          <Box>
            <Text fontSize="xs" fontWeight="semibold" color="gray.500" mb="1">DETALLE</Text>
            <Box bg="gray.50" borderWidth="1px" borderColor="gray.200" borderRadius="md" px="3" py="2">
              <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">{entry.details}</Text>
            </Box>
          </Box>
        ) : null}
        {entry.items?.length ? <AuditItemsTable items={entry.items} /> : null}
      </Stack>
      <Flex justify="end" mt="7"><Button onClick={onClose}>Cerrar</Button></Flex>
    </Modal>
  );
}

function groupItems(items: AuditItem[]): AuditItem[] {
  const map = new Map<string, AuditItem>();
  for (const item of items) {
    const key = `${item.label ?? ""}__${item.unitPrice ?? ""}`;
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        quantity: existing.quantity !== null && item.quantity !== null ? existing.quantity + item.quantity : existing.quantity,
        subtotal: existing.subtotal !== null && item.subtotal !== null ? existing.subtotal + item.subtotal : existing.subtotal,
      });
    } else {
      map.set(key, { ...item });
    }
  }
  return Array.from(map.values());
}

function AuditItemsTable({ items }: { items: AuditItem[] }) {
  const grouped = groupItems(items);
  const hasPrices = grouped.some((i) => i.unitPrice !== null || i.subtotal !== null);
  const hasQty = grouped.some((i) => i.quantity !== null);
  const hasNote = grouped.some((i) => i.note !== null);
  return (
    <Box>
      <Text fontSize="xs" fontWeight="semibold" color="gray.500" mb="1">ITEMS</Text>
      <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
        <Box overflowX="auto">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row bg="gray.50">
                <Table.ColumnHeader>Producto</Table.ColumnHeader>
                {hasQty ? <Table.ColumnHeader textAlign="right">Cant.</Table.ColumnHeader> : null}
                {hasPrices ? <Table.ColumnHeader textAlign="right">Precio unit.</Table.ColumnHeader> : null}
                {hasPrices ? <Table.ColumnHeader textAlign="right">Subtotal</Table.ColumnHeader> : null}
                {hasNote ? <Table.ColumnHeader>Nota</Table.ColumnHeader> : null}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {grouped.map((item) => (
                <Table.Row key={item.id}>
                  <Table.Cell>{item.label ?? "-"}</Table.Cell>
                  {hasQty ? <Table.Cell textAlign="right">{item.quantity ?? "-"}</Table.Cell> : null}
                  {hasPrices ? <Table.Cell textAlign="right">{item.unitPrice !== null ? fmtMoney(item.unitPrice) : "-"}</Table.Cell> : null}
                  {hasPrices ? <Table.Cell textAlign="right">{item.subtotal !== null ? fmtMoney(item.subtotal) : "-"}</Table.Cell> : null}
                  {hasNote ? <Table.Cell>{item.note ?? ""}</Table.Cell> : null}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      </Box>
    </Box>
  );
}

function fmtMoney(value: number) { return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value); }

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <Box>
      <Text fontSize="xs" fontWeight="semibold" color="gray.500" mb="0.5">{label.toUpperCase()}</Text>
      <Text fontSize="sm" fontFamily={mono ? "mono" : undefined}>{value}</Text>
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <Box><Text mb="2" fontSize="sm" fontWeight="semibold">{label}</Text>{children}</Box>; }
function Modal({ children, maxW }: { children: React.ReactNode; maxW: string }) { return <Flex position="fixed" zIndex="modal" inset="0" bg="blackAlpha.500" align="center" justify="center" p="4"><Box w="full" maxW={maxW} maxH="calc(100vh - 32px)" overflowY="auto" bg="white" borderRadius="md" boxShadow="2xl" p={{ base: "5", md: "7" }}>{children}</Box></Flex>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function formatDay(value: string) { const [y, m, d] = value.split("-"); return `${d}/${m}/${y}`; }
