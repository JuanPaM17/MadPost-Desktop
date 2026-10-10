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
  CircleDollarSign,
  Download,
  FileText,
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
import { notify } from "../../components/ui/AppToaster";
import { businessConfigService } from "../config/BusinessConfigService";
import {
  cashRegisterService,
  type CashSession,
  type CashSummary,
  type CashTopProduct,
} from "./CashRegisterService";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";

export function CashRegisterView() {
  const current = sessionContext.current();
  const [open, setOpen] = useState<CashSession | null>(null);
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [dialog, setDialog] = useState<"open" | "close" | "close-empty" | "delete" | null>(
    null,
  );
  const [detail, setDetail] = useState<{
    cash: CashSession;
    summary: CashSummary;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const active = await cashRegisterService.getOpenSession();
      setOpen(active);
      setSummary(active ? await cashRegisterService.summary(active.id) : null);
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
  const filtered = useMemo(() => {
    const query = search.toLowerCase().trim();
    return sessions.filter(
      (cash) =>
        !query ||
        `#${cash.sessionNumber} ${cash.userName ?? ""} ${cash.status === "OPEN" ? "abierta" : "cerrada"}`
          .toLowerCase()
          .includes(query),
    );
  }, [sessions, search]);
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

  async function close(amount: number) {
    if (!open) return;
    setBusy(true);
    try {
      await cashRegisterService.closeSession(open, amount);
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
      const closed = await cashRegisterService.closeSession(open, open.openingAmount);
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
      setDetail({ cash, summary: await cashRegisterService.summary(cash.id) });
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
      <Box mt="8" mb="4" maxW="420px" position="relative">
        <Search
          size={17}
          color="#6b7280"
          style={{ position: "absolute", left: 12, top: 11, zIndex: 1 }}
        />
        <Input
          pl="10"
          placeholder="Buscar por caja, cajero o estado..."
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </Box>
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
        <AmountDialog
          title="Cerrar caja"
          label="Monto real en caja al cerrar"
          initial={open.openingAmount + summary.cash}
          detail={`Efectivo esperado: ${money(open.openingAmount + summary.cash)} · ${summary.saleCount} ventas`}
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
          onClose={() => setDetail(null)}
        />
      ) : null}
    </Box>
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
  onClose,
}: {
  cash: CashSession;
  summary: CashSummary;
  onClose: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [topProducts, setTopProducts] = useState<CashTopProduct[]>([]);
  const [business, setBusiness] = useState<{ name: string; invoiceFooter: string } | null>(null);
  const difference = (cash.closingAmount ?? 0) - (cash.expectedAmount ?? 0);
  useEffect(() => { void Promise.all([cashRegisterService.topProducts(cash.id), businessConfigService.load()]).then(([top, settings]) => { setTopProducts(top); setBusiness({ name: settings.name, invoiceFooter: settings.invoiceFooter }); }); }, [cash.id]);
  async function downloadPdf() {
    setGenerating(true);
    try {
      const estimatedHeight = 88 + (summary.deliveryCount > 0 ? 24 : 0) + topProducts.length * 4 + Math.ceil((business?.invoiceFooter?.length ?? 22) / 32) * 4;
      const pdf = new jsPDF({ unit: "mm", format: [58, Math.max(115, estimatedHeight)] }); const center = 29; let y = 8;
      const centered = (text: string, bold = false) => { pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(8); pdf.text(text, center, y, { align: "center", maxWidth: 52 }); y += 4.5; };
      const row = (label: string, value: string, bold = false) => { pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(7); pdf.text(label, 3, y); pdf.text(value, 55, y, { align: "right" }); y += 4; };
      const separator = () => { pdf.setDrawColor(80); pdf.line(3, y, 55, y); y += 4; };
      centered(business?.name || sessionContext.current()?.tenantName || "MadPost", true); centered("*** CIERRE DE CAJA ***", true); centered(`Caja #${cash.sessionNumber}`); centered(formatDate(cash.closedAt ?? cash.openedAt)); separator();
      row("Cajero:", cash.userName ?? "-"); row("Apertura:", money(cash.openingAmount)); separator();
      centered("RESUMEN DE VENTAS", true); row("Ventas realizadas:", String(summary.saleCount)); row("Total vendido:", money(summary.total)); row("Efectivo:", money(summary.cash)); row("Tarjeta:", money(summary.card)); separator();
      if (summary.deliveryCount > 0) { centered("DOMICILIOS", true); row("Domicilios:", String(summary.deliveryCount)); row("Total domicilios:", money(summary.delivery)); if (summary.deliveryCashCount > 0) row("Efectivo:", `${summary.deliveryCashCount} (${money(summary.deliveryCash)})`); if (summary.deliveryCardCount > 0) row("Tarjeta:", `${summary.deliveryCardCount} (${money(summary.deliveryCard)})`); row("Cobro domicilios:", money(summary.deliveryCollection)); separator(); }
      if (topProducts.length) { centered("TOP PRODUCTOS", true); topProducts.forEach((item, index) => row(`${index + 1}. ${truncate(item.name, 22)}`, `${item.quantity}x`)); separator(); }
      centered("CIERRE", true); row("Efectivo esperado:", money(cash.expectedAmount ?? 0)); row("Efectivo real:", money(cash.closingAmount ?? 0)); row("Diferencia:", `${difference > 0 ? "+" : ""}${money(difference)}`, true); separator(); centered(business?.invoiceFooter || "Gracias por su compra!");
      const bytes = Array.from(new Uint8Array(pdf.output("arraybuffer")));
      const fileName = `cierre-caja-${cash.sessionNumber}-${cash.id.slice(0, 8)}.pdf`;
      const path = await invoke<string>("save_and_open_cash_close_pdf", {
        fileName,
        bytes,
      });
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
            [
              "Efectivo",
              `${summary.deliveryCashCount} (${money(summary.deliveryCash)})`,
            ],
            [
              "Tarjeta",
              `${summary.deliveryCardCount} (${money(summary.deliveryCard)})`,
            ],
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
      <DetailCard
        title="Cierre"
        rows={[
          ["Efectivo esperado", money(cash.expectedAmount ?? 0)],
          ["Efectivo real", money(cash.closingAmount ?? 0)],
          [
            "Diferencia",
            `${difference > 0 ? "+" : ""}${money(difference)}`,
          ],
        ]}
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
function DetailCard({ title, rows }: { title: string; rows: string[][] }) { return <Box mt="5" p="4" bg="gray.50" borderWidth="1px" borderColor="gray.200" borderRadius="md"><Text fontWeight="bold" fontSize="sm" mb="3">{title}</Text><Stack gap="2">{rows.map(([label, value]) => <Flex key={label} justify="space-between" gap="4"><Text color="gray.600" fontSize="sm">{label}</Text><Text textAlign="right" fontWeight="semibold" fontSize="sm">{value}</Text></Flex>)}</Stack></Box>; }
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
