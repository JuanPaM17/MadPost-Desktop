import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  Input,
  Stack,
  Table,
  Text,
} from "@chakra-ui/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Download,
  FileText,
  Filter,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { jsPDF } from "jspdf";
import { sessionContext } from "../../core/session/SessionContext";
import { PaginationControls } from "../../components/ui/PaginationControls";
import { ScrollableSelect } from "../../components/ui/ScrollableSelect";
import { notify } from "../../components/ui/AppToaster";
import { businessConfigService } from "../config/BusinessConfigService";
import {
  cashRegisterService,
  type CashExpense,
  type CashSession,
  type CashSummary,
  type CashTopProduct,
} from "./CashRegisterService";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { backupScheduler } from "../backup/BackupScheduler";

type CashFilters = { dateFrom: string; dateTo: string; cajero: string };
const EMPTY_CASH_FILTERS: CashFilters = { dateFrom: "", dateTo: "", cajero: "" };

export function CashRegisterView() {
  const current = sessionContext.current();
  const isSuperAdmin = current?.user.role === "SUPERADMIN";
  const isDemo = sessionContext.isDemo();
  const [open, setOpen] = useState<CashSession | null>(null);
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [expenses, setExpenses] = useState<CashExpense[]>([]);
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CashFilters>(EMPTY_CASH_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<CashFilters>(EMPTY_CASH_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [dialog, setDialog] = useState<"open" | "close" | "close-empty" | "delete" | null>(
    null,
  );
  const [detail, setDetail] = useState<{
    cash: CashSession;
    summary: CashSummary;
    expenses: CashExpense[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const active = await cashRegisterService.getOpenSession();
      setOpen(active);
      if (active) {
        const [s, e] = await Promise.all([
          cashRegisterService.summary(active.id),
          cashRegisterService.listExpenses(active.id),
        ]);
        setSummary(s);
        setExpenses(e);
      } else {
        setSummary(null);
        setExpenses([]);
      }
      setSessions(await cashRegisterService.listSessions());
    } catch (error) {
      notify.error(
        "No fue posible cargar la caja.",
        error instanceof Error ? error.message : undefined,
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const cajeroOptions = useMemo(() => {
    const names = sessions
      .map((s) => s.userName)
      .filter((n): n is string => Boolean(n));
    const unique = [...new Set(names)].filter((name) => {
      if (isSuperAdmin) return name !== "Modo Demo";
      if (isDemo) return name !== "juanpamacast" && name !== "Juan Pablo Madrigal Castañeda";
      return name !== "juanpamacast" && name !== "Juan Pablo Madrigal Castañeda" && name !== "Modo Demo";
    });
    return unique.sort();
  }, [sessions, isSuperAdmin, isDemo]);

  const filtered = useMemo(() => {
    const query = search.toLowerCase().trim();
    return sessions.filter((cash) => {
      if (query && !`#${cash.sessionNumber} ${cash.userName ?? ""} ${cash.status === "OPEN" ? "abierta" : "cerrada"}`.toLowerCase().includes(query)) return false;
      if (appliedFilters.cajero && cash.userName !== appliedFilters.cajero) return false;
      if (appliedFilters.dateFrom && cash.openedAt < appliedFilters.dateFrom + "T00:00:00.000Z") return false;
      const dateTo = appliedFilters.dateTo || new Date().toISOString().slice(0, 10);
      if (cash.openedAt > dateTo + "T23:59:59.999Z") return false;
      return true;
    });
  }, [sessions, search, appliedFilters]);
  const pages = Math.max(
    1,
    pageSize ? Math.ceil(filtered.length / pageSize) : 1,
  );
  const visible = pageSize
    ? filtered.slice(
        (Math.min(page, pages) - 1) * pageSize,
        Math.min(page, pages) * pageSize,
      )
    : filtered;
  async function createOpening(amount: number) {
    setBusy(true);
    try {
      await cashRegisterService.openSession(amount);
      void backupScheduler.onCashSessionOpened(sessionContext.current()?.tenantId ?? "");
      notify.success("Caja abierta correctamente.");
      setDialog(null);
      await refresh();
    } catch (error) {
      notify.error(
        "No fue posible abrir la caja.",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  async function requestClose() {
    try {
      const db = await databaseManager.database();
      const rows = await db.select<{ total: number }[]>(
        "SELECT COUNT(*) AS total FROM table_orders WHERE status='OPEN'",
      );
      const openTables = Number(rows[0]?.total ?? 0);
      if (openTables > 0) {
        notify.error(
          "No fue posible cerrar la caja.",
          `Hay ${openTables} mesa(s) con cuenta abierta. Cobralas antes de cerrar la caja.`,
        );
        return;
      }
    } catch {
      // si falla la query de mesas dejamos pasar
    }
    setDialog(summary?.saleCount === 0 ? "close-empty" : "close");
  }

  async function close(amount: number, baseAmount?: number) {
    if (!open) return;
    setBusy(true);
    try {
      await cashRegisterService.closeSession(open, amount, baseAmount);
      void backupScheduler.onCashSessionClosed(sessionContext.current()?.tenantId ?? "");
      notify.success("Caja cerrada correctamente.");
      setDialog(null);
      await refresh();
    } catch (error) {
      notify.error(
        "No fue posible cerrar la caja.",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  async function closeAndDelete() {
    if (!open) return;
    setBusy(true);
    try {
      const exp = await cashRegisterService.listExpenses(open.id);
      const totalExp = exp.reduce((s, e) => s + e.amount, 0);
      const closed = await cashRegisterService.closeSession(open, open.openingAmount - totalExp);
      void backupScheduler.onCashSessionClosed(sessionContext.current()?.tenantId ?? "");
      await cashRegisterService.deleteClosedSession(closed.cash, true);
      notify.success("Caja eliminada sin registrar.");
      setDialog(null);
      await refresh();
    } catch (error) {
      notify.error(
        "No fue posible eliminar la caja.",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!open || dialog !== "delete") return;
    setBusy(true);
    try {
      const s = await cashRegisterService.summary(open.id);
      await cashRegisterService.deleteClosedSession(open, s.saleCount === 0);
      setDialog(null);
      await refresh();
      notify.success("Caja eliminada.");
    } catch (error) {
      notify.error(
        "No fue posible eliminar la caja.",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  async function showDetail(cash: CashSession) {
    try {
      const [s, e] = await Promise.all([
        cashRegisterService.summary(cash.id),
        cashRegisterService.listExpenses(cash.id),
      ]);
      setDetail({ cash, summary: s, expenses: e });
    } catch {
      notify.error("No fue posible cargar el detalle de la caja.");
    }
  }
  return (
    <Box maxW="1280px" mx="auto">
      <StatusCard
        cash={open}
        onOpen={() => setDialog("open")}
        onClose={() => void requestClose()}
      />
      {open && summary ? <SummaryGrid summary={summary} /> : null}
      {open ? (
        <ExpensesPanel
          session={open}
          expenses={expenses}
          onRefresh={refresh}
        />
      ) : null}
      <Flex mt="8" mb="4" gap="3" align="center" wrap="wrap">
        <Box flex="1" minW="240px" position="relative">
          <Search size={17} color="#6b7280" style={{ position: "absolute", left: 12, top: 11, zIndex: 1 }} />
          <Input pl="10" placeholder="Buscar por caja, cajero o estado..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
        </Box>
        <Button variant="outline" onClick={() => setFiltersOpen(true)}><Filter size={17} />Filtros</Button>
        {Object.values(appliedFilters).some(Boolean) ? (
          <Button variant="outline" colorPalette="red" onClick={() => { setFilters(EMPTY_CASH_FILTERS); setAppliedFilters(EMPTY_CASH_FILTERS); setPage(1); }}><X size={16} />Limpiar filtros</Button>
        ) : null}
      </Flex>
      {Object.values(appliedFilters).some(Boolean) ? (
        <Flex mb="4" px="3" py="2" bg="purple.50" borderWidth="1px" borderColor="purple.100" borderRadius="md" align="center" justify="space-between" gap="3" wrap="wrap">
          <Text color="purple.800" fontSize="sm">
            Filtros activos: {[
              appliedFilters.cajero ? `Cajero: ${appliedFilters.cajero}` : null,
              appliedFilters.dateFrom ? `Desde: ${appliedFilters.dateFrom}` : null,
              appliedFilters.dateTo ? `Hasta: ${appliedFilters.dateTo}` : null,
            ].filter(Boolean).join(" · ")}
          </Text>
        </Flex>
      ) : null}
      <Box
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="md"
        overflow="hidden"
      >
        <Box overflowX="auto">
          <Table.Root size="sm" minW="900px">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>#</Table.ColumnHeader>
                <Table.ColumnHeader>Apertura</Table.ColumnHeader>
                <Table.ColumnHeader>Cajero</Table.ColumnHeader>
                <Table.ColumnHeader>Estado</Table.ColumnHeader>
                <Table.ColumnHeader>Ventas</Table.ColumnHeader>
                <Table.ColumnHeader>Total</Table.ColumnHeader>
                <Table.ColumnHeader>Diferencia</Table.ColumnHeader>
                <Table.ColumnHeader>Acciones</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible.map((cash) => (
                <HistoryRow
                  key={cash.id}
                  cash={cash}
                  canDelete={current?.user.role === "SUPERADMIN"}
                  onDetail={() => void showDetail(cash)}
                  onDelete={() => {
                    setOpen(cash);
                    setDialog("delete");
                  }}
                />
              ))}
              {!visible.length ? <EmptyRow /> : null}
            </Table.Body>
          </Table.Root>
        </Box>
        <PaginationControls
          total={filtered.length}
          page={Math.min(page, pages)}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </Box>
      {dialog === "open" ? (
        <AmountDialog
          title="Abrir caja"
          label="Monto de apertura"
          initial={0}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={createOpening}
        />
      ) : null}
      {dialog === "close" && open && summary ? (
        <CloseDialog
          cash={open}
          summary={summary}
          expenses={expenses}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={close}
        />
      ) : null}
      {dialog === "close-empty" && open ? (
        <CloseEmptyDialog
          cash={open}
          busy={busy}
          onClose={() => setDialog(null)}
          onKeep={() => { setDialog("close"); }}
          onDelete={() => void closeAndDelete()}
        />
      ) : null}
      {dialog === "delete" && open ? (
        <ConfirmDelete
          cash={open}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={() => void remove()}
        />
      ) : null}
      {detail ? (
        <CashDetailDialog
          cash={detail.cash}
          summary={detail.summary}
          expenses={detail.expenses}
          onClose={() => setDetail(null)}
        />
      ) : null}
      {filtersOpen ? (
        <CashFiltersModal
          filters={filters}
          cajeroOptions={cajeroOptions}
          onChange={setFilters}
          onApply={() => { setAppliedFilters({ ...filters }); setFiltersOpen(false); setPage(1); }}
          onClose={() => setFiltersOpen(false)}
        />
      ) : null}
    </Box>
  );
}

function CashFiltersModal({ filters, cajeroOptions, onChange, onApply, onClose }: {
  filters: CashFilters;
  cajeroOptions: string[];
  onChange: (f: CashFilters) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const set = (key: keyof CashFilters) => (value: string) => onChange({ ...filters, [key]: value });
  const dateError = filters.dateFrom && filters.dateTo && filters.dateTo < filters.dateFrom;

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="420px" bg="white" borderRadius="md" boxShadow="2xl" p="6">
        <Flex justify="space-between" align="center" mb="5">
          <Text fontWeight="bold" fontSize="lg">Filtros</Text>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>

        <Stack gap="4">
          <Box>
            <Text mb="1" fontSize="sm" fontWeight="semibold" color="gray.700">Cajero</Text>
            <ScrollableSelect
              placement="bottom"
              value={filters.cajero || "ALL"}
              placeholder="Todos"
              options={[{ value: "ALL", label: "Todos" }, ...cajeroOptions.map((n) => ({ value: n, label: n }))]}
              onValueChange={(v) => set("cajero")(v === "ALL" ? "" : v)}
            />
          </Box>

          <Grid templateColumns="1fr 1fr" gap="4">
            <Box>
              <Text mb="1" fontSize="sm" fontWeight="semibold" color="gray.700">Desde</Text>
              <Input type="date" value={filters.dateFrom} onChange={(e) => set("dateFrom")(e.target.value)} />
            </Box>
            <Box>
              <Text mb="1" fontSize="sm" fontWeight="semibold" color="gray.700">Hasta</Text>
              <Input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(e) => set("dateTo")(e.target.value)} />
            </Box>
          </Grid>
          {dateError ? (
            <Text fontSize="xs" color="red.500">La fecha Hasta no puede ser menor que Desde.</Text>
          ) : null}
        </Stack>

        <Flex mt="6" justify="end" gap="3">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button colorPalette="purple" disabled={!!dateError} onClick={onApply}>Aplicar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

function StatusCard({
  cash,
  onOpen,
  onClose,
}: {
  cash: CashSession | null;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <Box
      bg={cash ? "green.50" : "gray.100"}
      borderWidth="1px"
      borderColor={cash ? "green.200" : "gray.200"}
      borderRadius="md"
      p={{ base: "5", md: "6" }}
    >
      <Flex
        justify="space-between"
        align={{ base: "start", md: "center" }}
        gap="4"
        wrap="wrap"
      >
        <Flex gap="4" align="center">
          <Box
            w="48px"
            h="48px"
            borderRadius="full"
            bg={cash ? "green.100" : "gray.200"}
            color={cash ? "green.700" : "gray.600"}
            display="grid"
            placeItems="center"
          >
            <CircleDollarSign size={26} />
          </Box>
          <Box>
            <Heading size="md">
              {cash ? `Caja #${cash.sessionNumber} - ABIERTA` : "Caja cerrada"}
            </Heading>
            <Text mt="1" color="gray.600" fontSize="sm">
              {cash
                ? `${formatDate(cash.openedAt)} · Apertura ${money(cash.openingAmount)} · ${cash.userName ?? ""}`
                : "Abre una caja para registrar y controlar las ventas del turno."}
            </Text>
          </Box>
        </Flex>
        {cash ? (
          <Button colorPalette="red" onClick={onClose}>
            <X size={17} />
            Cerrar caja
          </Button>
        ) : (
          <Button colorPalette="purple" onClick={onOpen}>
            <Plus size={17} />
            Abrir caja
          </Button>
        )}
      </Flex>
    </Box>
  );
}
function SummaryGrid({ summary }: { summary: CashSummary }) {
  return (
    <Grid
      mt="5"
      templateColumns={{ base: "1fr", md: "repeat(3, 1fr)" }}
      gap="4"
    >
      <Metric
        label="Ventas totales"
        value={String(summary.saleCount)}
        detail={money(summary.total)}
      />
      <Metric
        label="Efectivo"
        value={money(summary.cash)}
        detail={`${summary.cashCount} ventas`}
      />
      <Metric
        label="Tarjeta"
        value={money(summary.card)}
        detail={`${summary.cardCount} ventas`}
      />
      <Metric
        label="Domicilios"
        value={money(summary.delivery)}
        detail={`${summary.deliveryCount} domicilios`}
      />
      <Metric
        label="Cobro domicilios"
        value={money(summary.deliveryCollection)}
        detail="Valor de envio"
      />
      <Metric
        label="Total vendido"
        value={money(summary.total)}
        detail="Durante esta caja"
      />
    </Grid>
  );
}
function HistoryRow({
  cash,
  canDelete,
  onDetail,
  onDelete,
}: {
  cash: CashSession;
  canDelete: boolean;
  onDetail: () => void;
  onDelete: () => void;
}) {
  const [summary, setSummary] = useState<CashSummary | null>(null);
  useEffect(() => {
    void cashRegisterService.summary(cash.id).then(setSummary);
  }, [cash.id]);
  const difference =
    cash.closingAmount !== null && cash.expectedAmount !== null
      ? cash.closingAmount - cash.expectedAmount
      : null;
  return (
    <Table.Row>
      <Table.Cell fontWeight="semibold">#{cash.sessionNumber}</Table.Cell>
      <Table.Cell whiteSpace="nowrap">{formatDate(cash.openedAt)}</Table.Cell>
      <Table.Cell>{cash.userName ?? "-"}</Table.Cell>
      <Table.Cell>
        <Badge colorPalette={cash.status === "OPEN" ? "green" : "gray"}>
          {cash.status === "OPEN" ? "Abierta" : "Cerrada"}
        </Badge>
      </Table.Cell>
      <Table.Cell>{summary?.saleCount ?? "-"}</Table.Cell>
      <Table.Cell>{summary ? money(summary.total) : "-"}</Table.Cell>
      <Table.Cell
        color={
          difference === null
            ? "gray.500"
            : difference >= 0
              ? "green.600"
              : "red.600"
        }
        fontWeight="semibold"
      >
        {difference === null
          ? "-"
          : `${difference > 0 ? "+" : ""}${money(difference)}`}
      </Table.Cell>
      <Table.Cell>
        <Flex gap="2">
          {cash.status === "CLOSED" ? (
            <Button size="xs" variant="outline" onClick={onDetail}>
              <FileText size={14} />
              Detalle
            </Button>
          ) : (
            "-"
          )}
          {cash.status === "CLOSED" && (canDelete || summary?.saleCount === 0) ? (
            <Button
              size="xs"
              variant="outline"
              colorPalette="red"
              onClick={onDelete}
            >
              <Trash2 size={14} />
              {summary?.saleCount === 0 ? "Sin ventas — Eliminar" : "Eliminar"}
            </Button>
          ) : null}
        </Flex>
      </Table.Cell>
    </Table.Row>
  );
}
function CashDetailDialog({
  cash,
  summary,
  expenses,
  onClose,
}: {
  cash: CashSession;
  summary: CashSummary;
  expenses: CashExpense[];
  onClose: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [topProducts, setTopProducts] = useState<CashTopProduct[]>([]);
  const [business, setBusiness] = useState<{ name: string; invoiceFooter: string } | null>(null);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const difference = (cash.closingAmount ?? 0) - (cash.expectedAmount ?? 0);
  useEffect(() => { void Promise.all([cashRegisterService.topProducts(cash.id), businessConfigService.load()]).then(([top, settings]) => { setTopProducts(top); setBusiness({ name: settings.name, invoiceFooter: settings.invoiceFooter }); }); }, [cash.id]);
  async function downloadPdf() {
    setGenerating(true);
    try {
      const expensesHeight = expenses.length > 0 ? 8 + expenses.length * 4 : 0;
      const baseHeight = cash.baseAmount !== null ? 4 : 0;
      const estimatedHeight = 88 + (summary.deliveryCount > 0 ? 24 : 0) + topProducts.length * 4 + expensesHeight + baseHeight + Math.ceil((business?.invoiceFooter?.length ?? 22) / 32) * 4;
      const pdf = new jsPDF({ unit: "mm", format: [58, Math.max(115, estimatedHeight)] }); const center = 29; let y = 8;
      const centered = (text: string, bold = false) => { pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(8); pdf.text(text, center, y, { align: "center", maxWidth: 52 }); y += 4.5; };
      const row = (label: string, value: string, bold = false) => { pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(7); pdf.text(label, 3, y); pdf.text(value, 55, y, { align: "right" }); y += 4; };
      const separator = () => { pdf.setDrawColor(80); pdf.line(3, y, 55, y); y += 4; };
      centered(business?.name || sessionContext.current()?.tenantName || "MadPost", true); centered("*** CIERRE DE CAJA ***", true); centered(`Caja #${cash.sessionNumber}`); centered(formatDate(cash.closedAt ?? cash.openedAt)); separator();
      row("Cajero:", cash.userName ?? "-"); row("Apertura:", money(cash.openingAmount)); separator();
      centered("RESUMEN DE VENTAS", true); row("Ventas realizadas:", String(summary.saleCount)); row("Total vendido:", money(summary.total)); row("Efectivo:", money(summary.cash)); row("Tarjeta:", money(summary.card)); separator();
      if (summary.deliveryCount > 0) { centered("DOMICILIOS", true); row("Domicilios:", String(summary.deliveryCount)); row("Total domicilios:", money(summary.delivery)); if (summary.deliveryCashCount > 0) row("Efectivo:", `${summary.deliveryCashCount} (${money(summary.deliveryCash)})`); if (summary.deliveryCardCount > 0) row("Tarjeta:", `${summary.deliveryCardCount} (${money(summary.deliveryCard)})`); row("Cobro domicilios:", money(summary.deliveryCollection)); separator(); }
      if (topProducts.length) { centered("TOP PRODUCTOS", true); topProducts.forEach((item, index) => row(`${index + 1}. ${truncate(item.name, 22)}`, `${item.quantity}x`)); separator(); }
      if (expenses.length > 0) { centered("GASTOS DE CAJA", true); expenses.forEach((e) => row(truncate(e.description, 22), `-${money(e.amount)}`)); row("Total gastos:", `-${money(totalExpenses)}`, true); separator(); }
      centered("CIERRE", true);
      row("Efectivo esperado:", money(cash.expectedAmount ?? 0));
      if (expenses.length > 0) row("(Incluye descuento de gastos)", "");
      row("Efectivo real:", money(cash.closingAmount ?? 0));
      if (cash.baseAmount !== null) { row("Base dejada:", money(cash.baseAmount)); row("Remesa retirada:", money((cash.closingAmount ?? 0) - cash.baseAmount), true); }
      row("Diferencia:", `${difference > 0 ? "+" : ""}${money(difference)}`, true);
      separator(); centered(business?.invoiceFooter || "Gracias por su compra!");
      const bytes = Array.from(new Uint8Array(pdf.output("arraybuffer")));
      const fileName = `cierre-caja-${cash.sessionNumber}-${cash.id.slice(0, 8)}.pdf`;
      await invoke<string>("save_and_open_cash_close_pdf", { fileName, bytes });
      notify.success("Reporte de cierre generado.");
    } catch (error) {
      notify.error(
        "No se pudo generar el PDF.",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setGenerating(false);
    }
  }
  return (
    <Modal>
      <Heading size="md">Detalle de caja #{cash.sessionNumber}</Heading>
      <Text mt="2" color="gray.500">
        {cash.userName ?? "-"} · {formatDate(cash.openedAt)}
      </Text>
      <DetailCard
        title="Sesion"
        rows={[
          ["Cajero", cash.userName ?? "-"],
          ["Apertura", money(cash.openingAmount)],
          ["Cierre", formatDate(cash.closedAt ?? cash.openedAt)],
        ]}
      />
      <DetailCard
        title="Resumen de ventas"
        rows={[
          ["Ventas realizadas", String(summary.saleCount)],
          ["Total vendido", money(summary.total)],
          ["Efectivo", `${money(summary.cash)} (${summary.cashCount})`],
          ["Tarjeta", `${money(summary.card)} (${summary.cardCount})`],
        ]}
      />
      {summary.deliveryCount > 0 ? (
        <DetailCard
          title="Domicilios"
          rows={[
            ["Domicilios", String(summary.deliveryCount)],
            ["Total domicilios", money(summary.delivery)],
            ["Efectivo", `${summary.deliveryCashCount} (${money(summary.deliveryCash)})`],
            ["Tarjeta", `${summary.deliveryCardCount} (${money(summary.deliveryCard)})`],
            ["Cobro domicilios", money(summary.deliveryCollection)],
          ]}
        />
      ) : null}
      {topProducts.length ? (
        <DetailCard
          title="Top productos"
          rows={topProducts.map((item, index) => [
            `${index + 1}. ${item.name}`,
            `${item.quantity}x`,
          ])}
        />
      ) : null}
      {expenses.length > 0 ? (
        <DetailCard
          title="Gastos de caja"
          rows={[
            ...expenses.map((e) => [e.description, `-${money(e.amount)}`]),
            ["Total gastos", `-${money(totalExpenses)}`],
          ]}
        />
      ) : null}
      <CashClosePreview
        expectedNet={cash.expectedAmount ?? 0}
        totalExpenses={totalExpenses}
        countedAmount={cash.closingAmount}
        baseAmount={cash.baseAmount}
        defaultOpen={true}
      />
      <Flex mt="7" justify="space-between" gap="3">
        <Button
          colorPalette="purple"
          loading={generating}
          onClick={() => void downloadPdf()}
        >
          <Download size={17} />
          Descargar PDF
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cerrar
        </Button>
      </Flex>
    </Modal>
  );
}
function ExpensesPanel({
  session,
  expenses,
  onRefresh,
}: {
  session: CashSession;
  expenses: CashExpense[];
  onRefresh: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);

  async function add() {
    const parsed = parseMoney(amount);
    if (!desc.trim() || parsed === null || parsed <= 0) return;
    setBusy(true);
    try {
      await cashRegisterService.addExpense(session.id, desc, parsed);
      setDesc("");
      setAmount("");
      setShowForm(false);
      await onRefresh();
    } catch (error) {
      notify.error("No se pudo agregar el gasto.", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(e: CashExpense) {
    setEditingId(e.id);
    setEditDesc(e.description);
    setEditAmount(String(e.amount));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDesc("");
    setEditAmount("");
  }

  async function saveEdit(id: string) {
    const parsed = parseMoney(editAmount);
    if (!editDesc.trim() || parsed === null || parsed <= 0) return;
    setBusy(true);
    try {
      await cashRegisterService.updateExpense(id, editDesc, parsed);
      setEditingId(null);
      await onRefresh();
    } catch (error) {
      notify.error("No se pudo editar el gasto.", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await cashRegisterService.deleteExpense(id);
      await onRefresh();
    } catch {
      notify.error("No se pudo eliminar el gasto.");
    }
  }

  return (
    <Box
      mt="5"
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      p="5"
    >
      <Flex justify="space-between" align="center" mb="3">
        <Text fontWeight="bold" fontSize="sm">
          Gastos de caja
          {total > 0 ? (
            <Text as="span" color="red.600" ml="2">
              -{money(total)}
            </Text>
          ) : null}
        </Text>
        {!showForm ? (
          <Button size="xs" variant="outline" onClick={() => setShowForm(true)}>
            <Plus size={13} />
            Agregar gasto
          </Button>
        ) : null}
      </Flex>
      {showForm ? (
        <Flex gap="2" mb="3" wrap="wrap">
          <Input
            flex="1"
            minW="140px"
            placeholder="Descripcion (ej. Hielo)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            size="sm"
          />
          <Input
            w="130px"
            placeholder="Monto"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            size="sm"
          />
          <Button size="sm" colorPalette="purple" loading={busy} onClick={() => void add()}>
            <Check size={14} />
            Agregar
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setShowForm(false); setDesc(""); setAmount(""); }}>
            Cancelar
          </Button>
        </Flex>
      ) : null}
      {expenses.length === 0 ? (
        <Text color="gray.400" fontSize="sm">
          Sin gastos registrados en esta caja.
        </Text>
      ) : (
        <Stack gap="1">
          {expenses.map((e) => (
            <Box key={e.id}>
              {editingId === e.id ? (
                <Flex gap="2" wrap="wrap" align="center">
                  <Input
                    flex="1"
                    minW="140px"
                    value={editDesc}
                    onChange={(ev) => setEditDesc(ev.target.value)}
                    size="sm"
                    autoFocus
                  />
                  <Input
                    w="130px"
                    inputMode="decimal"
                    value={editAmount}
                    onChange={(ev) => setEditAmount(ev.target.value)}
                    onKeyDown={(ev) => { if (ev.key === "Enter") void saveEdit(e.id); if (ev.key === "Escape") cancelEdit(); }}
                    size="sm"
                  />
                  <Button size="sm" colorPalette="purple" loading={busy} onClick={() => void saveEdit(e.id)}>
                    <Check size={14} />
                    Guardar
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEdit}>
                    Cancelar
                  </Button>
                </Flex>
              ) : (
                <Flex justify="space-between" align="center" gap="3">
                  <Text fontSize="sm" color="gray.700" flex="1">
                    {e.description}
                  </Text>
                  <Text fontSize="sm" fontWeight="semibold" color="red.600">
                    -{money(e.amount)}
                  </Text>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => startEdit(e)}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    colorPalette="red"
                    onClick={() => void remove(e.id)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </Flex>
              )}
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}
function CloseDialog({
  cash,
  summary,
  expenses,
  busy,
  onClose,
  onConfirm,
}: {
  cash: CashSession;
  summary: CashSummary;
  expenses: CashExpense[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (amount: number, baseAmount?: number) => void;
}) {
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const expectedNet = cash.openingAmount + summary.cash - totalExpenses;
  const [value, setValue] = useState(String(expectedNet));
  const [withBase, setWithBase] = useState(false);
  const [baseValue, setBaseValue] = useState(String(cash.openingAmount));
  const [error, setError] = useState("");

  const countedAmount = parseMoney(value);
  const baseAmount = parseMoney(baseValue);
  const remesa =
    withBase && countedAmount !== null && baseAmount !== null
      ? countedAmount - baseAmount
      : null;

  function submit() {
    const amount = parseMoney(value);
    if (amount === null || amount < 0) { setError("Ingresa un monto valido."); return; }
    if (withBase) {
      const base = parseMoney(baseValue);
      if (base === null || base < 0) { setError("Ingresa un monto de base valido."); return; }
      onConfirm(amount, base);
    } else {
      onConfirm(amount);
    }
  }

  const detailLines = [
    `Apertura: ${money(cash.openingAmount)}`,
    `Efectivo ventas: ${money(summary.cash)}`,
    ...(totalExpenses > 0 ? [`Gastos: -${money(totalExpenses)}`] : []),
    `Efectivo neto esperado: ${money(expectedNet)}`,
    `${summary.saleCount} ventas`,
  ];

  return (
    <Modal>
      <Heading size="md">Cerrar caja</Heading>
      <Text mt="2" color="gray.500" fontSize="sm">
        {detailLines.join(" · ")}
      </Text>
      <Text mt="6" mb="2" fontWeight="semibold" fontSize="sm">
        Efectivo fisico contado en caja
      </Text>
      <Input
        autoFocus
        value={value}
        inputMode="decimal"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !withBase) submit(); }}
      />
      <Flex mt="4" align="center" gap="2">
        <input
          type="checkbox"
          id="with-base"
          checked={withBase}
          onChange={(e) => setWithBase(e.target.checked)}
        />
        <Text as="label" htmlFor="with-base" fontSize="sm" cursor="pointer">
          Dejar base para el siguiente turno
        </Text>
      </Flex>
      {withBase ? (
        <>
          <Text mt="3" mb="2" fontWeight="semibold" fontSize="sm">
            Monto de base a dejar
          </Text>
          <Input
            autoFocus
            value={baseValue}
            inputMode="decimal"
            placeholder="0"
            onChange={(e) => setBaseValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          {remesa !== null && (
            <Text mt="2" fontSize="sm" color="gray.600">
              Remesa a retirar: <Text as="span" fontWeight="bold" color="green.600">{money(remesa)}</Text>
            </Text>
          )}
        </>
      ) : null}
      <CashClosePreview
        expectedNet={expectedNet}
        totalExpenses={totalExpenses}
        countedAmount={countedAmount}
        baseAmount={withBase ? baseAmount : null}
      />
      {error ? (
        <Text mt="2" color="red.600" fontSize="sm">{error}</Text>
      ) : null}
      <Flex mt="6" justify="end" gap="3">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancelar
        </Button>
        <Button colorPalette="purple" loading={busy} onClick={submit}>
          <Check size={17} />
          Confirmar
        </Button>
      </Flex>
    </Modal>
  );
}
function CashClosePreview({ expectedNet, totalExpenses, countedAmount, baseAmount, defaultOpen = false }: { expectedNet: number; totalExpenses: number; countedAmount: number | null; baseAmount: number | null; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (countedAmount === null) return null;
  const difference = countedAmount - expectedNet;
  const remesa = baseAmount !== null ? countedAmount - baseAmount : null;
  const rows: [string, string, string?][] = [
    ["Efectivo esperado", money(expectedNet)],
    ...(totalExpenses > 0 ? [["(Gastos descontados)", `-${money(totalExpenses)}`] as [string, string]] : []),
    ["Efectivo real", money(countedAmount)],
    ...(baseAmount !== null ? [["Base dejada", money(baseAmount)] as [string, string]] : []),
    ...(remesa !== null ? [["Remesa retirada", money(remesa)] as [string, string]] : []),
    ["Diferencia", `${difference > 0 ? "+" : ""}${money(difference)}`, difference < 0 ? "red" : difference > 0 ? "green" : "gray"] as [string, string, string],
  ];
  return (
    <Box mt="4" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
      <Flex px="3" py="2" bg="gray.50" align="center" justify="space-between" cursor="pointer" onClick={() => setOpen((v) => !v)}>
        <Text fontWeight="semibold" fontSize="sm">Cierre</Text>
        {open ? <ChevronUp size={15} color="#6b7280" /> : <ChevronDown size={15} color="#6b7280" />}
      </Flex>
      {open ? (
        <Stack gap="2" px="3" py="3">
          {rows.map(([label, value, color], i) => (
            <Flex key={i} justify="space-between" gap="4">
              <Text color="gray.600" fontSize="sm">{label}</Text>
              <Text textAlign="right" fontWeight="semibold" fontSize="sm" color={color === "red" ? "red.600" : color === "green" ? "green.600" : undefined}>{value}</Text>
            </Flex>
          ))}
        </Stack>
      ) : null}
    </Box>
  );
}
function DetailCard({ title, rows }: { title: string; rows: string[][] }) { return <Box mt="5" p="4" bg="gray.50" borderWidth="1px" borderColor="gray.200" borderRadius="md"><Text fontWeight="bold" fontSize="sm" mb="3">{title}</Text><Stack gap="2">{rows.map(([label, value], i) => <Flex key={i} justify="space-between" gap="4"><Text color="gray.600" fontSize="sm">{label}</Text><Text textAlign="right" fontWeight="semibold" fontSize="sm">{value}</Text></Flex>)}</Stack></Box>; }
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      p="4"
    >
      <Text color="gray.500" fontSize="sm">
        {label}
      </Text>
      <Text mt="1" fontSize="xl" fontWeight="bold">
        {value}
      </Text>
      <Text mt="1" color="gray.500" fontSize="xs">
        {detail}
      </Text>
    </Box>
  );
}
function AmountDialog({
  title,
  label,
  initial,
  detail,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  label: string;
  initial: number;
  detail?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (amount: number) => void;
}) {
  const [value, setValue] = useState(String(initial));
  const [error, setError] = useState("");
  function submit() {
    const amount = parseMoney(value);
    if (amount === null || amount < 0) {
      setError("Ingresa un monto valido.");
      return;
    }
    onConfirm(amount);
  }
  return (
    <Modal>
      <Heading size="md">{title}</Heading>
      {detail ? (
        <Text mt="2" color="gray.500" fontSize="sm">
          {detail}
        </Text>
      ) : null}
      <Text mt="6" mb="2" fontWeight="semibold" fontSize="sm">
        {label}
      </Text>
      <Input
        autoFocus
        value={value}
        inputMode="decimal"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      {error ? (
        <Text mt="2" color="red.600" fontSize="sm">
          {error}
        </Text>
      ) : null}
      <Flex mt="6" justify="end" gap="3">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancelar
        </Button>
        <Button colorPalette="purple" loading={busy} onClick={submit}>
          <Check size={17} />
          Confirmar
        </Button>
      </Flex>
    </Modal>
  );
}
function ConfirmDelete({
  cash,
  busy,
  onClose,
  onConfirm,
}: {
  cash: CashSession;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal>
      <Heading size="md">Eliminar caja #{cash.sessionNumber}</Heading>
      <Text mt="3" color="gray.600">
        Se eliminaran esta caja, sus ventas y pedidos asociados. Esta accion no
        se puede deshacer.
      </Text>
      <Flex mt="6" justify="end" gap="3">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancelar
        </Button>
        <Button colorPalette="red" loading={busy} onClick={onConfirm}>
          <Trash2 size={17} />
          Eliminar
        </Button>
      </Flex>
    </Modal>
  );
}
function CloseEmptyDialog({
  cash,
  busy,
  onClose,
  onKeep,
  onDelete,
}: {
  cash: CashSession;
  busy: boolean;
  onClose: () => void;
  onKeep: () => void;
  onDelete: () => void;
}) {
  return (
    <Modal>
      <Flex gap="3" align="center">
        <Box color="orange.500"><AlertTriangle size={24} /></Box>
        <Heading size="md">Caja #{cash.sessionNumber} sin ventas</Heading>
      </Flex>
      <Text mt="4" color="gray.600">
        Esta caja no tiene ninguna venta registrada. Puedes cerrarla y dejarla
        en el historial, o eliminarla directamente para que no quede registrada.
      </Text>
      <Flex mt="7" justify="end" gap="3" wrap="wrap">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="outline" colorPalette="gray" loading={busy} onClick={onKeep}>
          Cerrar y guardar
        </Button>
        <Button colorPalette="red" loading={busy} onClick={onDelete}>
          <Trash2 size={17} />
          Eliminar sin registrar
        </Button>
      </Flex>
    </Modal>
  );
}
function EmptyRow() {
  return (
    <Table.Row>
      <Table.Cell colSpan={8}>
        <Text py="9" textAlign="center" color="gray.500">
          No hay cajas para mostrar.
        </Text>
      </Table.Cell>
    </Table.Row>
  );
}
function Modal({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      position="fixed"
      zIndex="modal"
      inset="0"
      p="4"
      bg="blackAlpha.500"
      align="center"
      justify="center"
    >
      <Box
        w="full"
        maxW="720px"
        maxH="calc(100vh - 32px)"
        overflowY="auto"
        bg="white"
        borderRadius="md"
        boxShadow="2xl"
        p="7"
      >
        {children}
      </Box>
    </Flex>
  );
}
function parseMoney(value: string) {
  const compact = value.trim().replace(/\s/g, "");
  if (!compact) return null;
  const normalized = compact.includes(",")
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact.replace(/\./g, "");
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}
function money(value: number) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(value);
}
function truncate(value: string, maxLength: number) {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}
