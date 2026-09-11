import { Badge, Box, Button, Flex, Grid, Input, Separator, Table, Text, Textarea } from "@chakra-ui/react";
import { Filter, MessageCircle, Pencil, Printer, Receipt, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { sessionContext } from "../../core/session/SessionContext";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { PaginationControls } from "../../components/ui/PaginationControls";
import { ScrollableSelect } from "../../components/ui/ScrollableSelect";
import { Tip } from "../../components/ui/Tip";
import { businessConfigService, printerService } from "../config/BusinessConfigService";
import { notify } from "../../components/ui/AppToaster";
import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory, exists } from "@tauri-apps/plugin-fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type SaleRow = {
  id: string;
  invoice_number: string;
  created_at: string;
  attended_by: string | null;
  collected_by: string | null;
  payment_method: string;
  is_delivery: number;
  total: number;
  notes: string | null;
  cash_session_id: string;
  session_number: number | null;
};

type CashOption = { id: string; label: string };

type SaleDetail = {
  sale: SaleRow & {
    cash_given: number | null;
    change_given: number | null;
    cash_amount: number | null;
    card_amount: number | null;
    delivery_price: number | null;
    delivery_type_name: string | null;
    client_name: string | null;
  };
  items: SaleDetailItem[];
};

type SaleDetailItem = {
  id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  original_unit_price: number;
  subtotal: number;
  notes: string | null;
  selected_option: string | null;
  combo_id: string | null;
  combo_sale_item_id: string | null;
  additions: { name: string; price: number; quantity: number }[];
  sauces: { name: string }[];
};

type Filters = {
  sessionId: string;
  dateFrom: string;
  dateTo: string;
  collectedBy: string;
  attendedBy: string;
  paymentMethod: string;
};

const EMPTY_FILTERS: Filters = { sessionId: "", dateFrom: "", dateTo: "", collectedBy: "", attendedBy: "", paymentMethod: "" };

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadSales(tenantId: string, userId: string, isAdmin: boolean, filters: Filters): Promise<SaleRow[]> {
  const database = await databaseManager.database();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.sessionId) {
    conditions.push("s.cash_session_id=$" + (params.push(filters.sessionId)));
  } else {
    conditions.push("s.tenant_id=$" + (params.push(tenantId)));
    if (!isAdmin) conditions.push("s.user_id=$" + (params.push(userId)));
  }

  if (filters.dateFrom) conditions.push("s.created_at >= $" + (params.push(filters.dateFrom + "T00:00:00.000Z")));
  if (filters.dateTo) conditions.push("s.created_at <= $" + (params.push(filters.dateTo + "T23:59:59.999Z")));
  if (filters.paymentMethod) conditions.push("s.payment_method=$" + (params.push(filters.paymentMethod)));
  if (filters.collectedBy) conditions.push("s.collected_by_user_id=$" + (params.push(filters.collectedBy)));
  if (filters.attendedBy) conditions.push("s.user_id=$" + (params.push(filters.attendedBy)));

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const limit = filters.sessionId ? "" : "LIMIT 500";

  return database.select<SaleRow[]>(
    `SELECT s.id, s.invoice_number, s.created_at, s.payment_method, s.is_delivery, s.total, s.notes,
            s.cash_session_id, s.collected_by_display_name AS collected_by,
            COALESCE(u.display_name, u.username) AS attended_by,
            cs.session_number
     FROM sales s
     LEFT JOIN users u ON s.user_id=u.id
     LEFT JOIN cash_sessions cs ON s.cash_session_id=cs.id
     ${where}
     ORDER BY s.created_at DESC ${limit}`,
    params,
  );
}

async function loadCashOptions(tenantId: string, userId: string, isAdmin: boolean): Promise<CashOption[]> {
  const database = await databaseManager.database();
  const where = isAdmin ? "WHERE tenant_id=$1" : "WHERE tenant_id=$1 AND user_id=$2";
  const params = isAdmin ? [tenantId] : [tenantId, userId];
  const rows = await database.select<{ id: string; session_number: number; opened_at: string }[]>(
    `SELECT id, session_number, opened_at FROM cash_sessions ${where} ORDER BY opened_at DESC`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    label: `Caja #${r.session_number} — ${formatDate(r.opened_at)}`,
  }));
}

async function loadUsers(tenantId: string, isSuperAdmin: boolean): Promise<{ id: string; label: string }[]> {
  const database = await databaseManager.database();
  const where = isSuperAdmin ? "tenant_id=$1 AND active=1" : "tenant_id=$1 AND active=1 AND role != 'SUPERADMIN'";
  const rows = await database.select<{ id: string; display_name: string | null; username: string }[]>(
    `SELECT id, display_name, username FROM users WHERE ${where} ORDER BY display_name, username`,
    [tenantId],
  );
  return rows.map((r) => ({ id: r.id, label: r.display_name || r.username }));
}

async function loadSaleDetail(saleId: string): Promise<SaleDetail> {
  const database = await databaseManager.database();

  const saleRows = await database.select<(SaleRow & { cash_given: number | null; change_given: number | null; cash_amount: number | null; card_amount: number | null; delivery_price: number | null; delivery_type_name: string | null; client_name: string | null })[]>(
    `SELECT s.id, s.invoice_number, s.created_at, s.payment_method, s.is_delivery, s.total, s.notes,
            s.cash_session_id, s.cash_given, s.change_given, s.cash_amount, s.card_amount,
            s.delivery_price, s.delivery_type_name, s.client_name,
            s.collected_by_display_name AS collected_by,
            COALESCE(u.display_name, u.username) AS attended_by,
            cs.session_number
     FROM sales s
     LEFT JOIN users u ON s.user_id=u.id
     LEFT JOIN cash_sessions cs ON s.cash_session_id=cs.id
     WHERE s.id=$1`,
    [saleId],
  );

  const itemRows = await database.select<Omit<SaleDetailItem, "additions" | "sauces">[]>(
    `SELECT id, product_id, product_name, quantity, unit_price, original_unit_price, subtotal, notes, selected_option, combo_id, combo_sale_item_id
     FROM sale_items WHERE sale_id=$1`,
    [saleId],
  );

  const additionRows = await database.select<{ sale_item_id: string; addition_name: string; price: number; quantity: number }[]>(
    `SELECT sale_item_id, addition_name, price, quantity FROM sale_item_additions
     WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id=$1)`,
    [saleId],
  );

  const sauceRows = await database.select<{ sale_item_id: string; sauce_name: string }[]>(
    `SELECT sale_item_id, sauce_name FROM sale_item_sauces
     WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id=$1)`,
    [saleId],
  );

  const items: SaleDetailItem[] = itemRows.map((row) => ({
    ...row,
    additions: additionRows.filter((a) => a.sale_item_id === row.id).map((a) => ({ name: a.addition_name, price: a.price, quantity: a.quantity })),
    sauces: sauceRows.filter((s) => s.sale_item_id === row.id).map((s) => ({ name: s.sauce_name })),
  }));

  return { sale: saleRows[0], items };
}

// ---------------------------------------------------------------------------
// HistoryView
// ---------------------------------------------------------------------------
export function HistoryView({ initialInvoice }: { initialInvoice?: string } = {}) {
  const session = sessionContext.current();
  const tenantId = session?.tenantId ?? "";
  const userId = session?.user.id ?? "";
  const isAdmin = session?.user.role === "ADMIN" || session?.user.role === "SUPERADMIN";
  const isSuperAdmin = session?.user.role === "SUPERADMIN";

  const [sales, setSales] = useState<SaleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cashOptions, setCashOptions] = useState<CashOption[]>([]);
  const [userOptions, setUserOptions] = useState<{ id: string; label: string }[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState(initialInvoice ?? "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const requestId = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    void Promise.all([
      loadCashOptions(tenantId, userId, isAdmin),
      isAdmin ? loadUsers(tenantId, isSuperAdmin) : Promise.resolve([]),
    ]).then(([cash, users]) => {
      setCashOptions(cash);
      setUserOptions(users);
    });
  }, []);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    void loadSales(tenantId, userId, isAdmin, appliedFilters).then((rows) => {
      if (id !== requestId.current) return;
      setSales(rows);
      setPage(1);
      if (initialInvoice && !autoSelectedRef.current) {
        autoSelectedRef.current = true;
        const match = rows.find((s) => s.invoice_number === initialInvoice);
        if (match) {
          setSelectedId(match.id);
          setDetailLoading(true);
          void loadSaleDetail(match.id).then(setDetail).catch(() => setDetail(null)).finally(() => setDetailLoading(false));
        }
      }
    }).finally(() => { if (id === requestId.current) setLoading(false); });
  }, [appliedFilters]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sales;
    return sales.filter((s) =>
      s.invoice_number.toLowerCase().includes(q) ||
      (s.attended_by ?? "").toLowerCase().includes(q) ||
      (s.notes ?? "").toLowerCase().includes(q) ||
      String(s.total).includes(q),
    );
  }, [sales, search]);

  const pageItems = useMemo(() => {
    const p = Math.max(1, Math.min(page, Math.max(1, pageSize ? Math.ceil(filtered.length / pageSize) : 1)));
    return pageSize ? filtered.slice((p - 1) * pageSize, p * pageSize) : filtered;
  }, [filtered, page, pageSize]);

  const hasFilters = Object.values(appliedFilters).some(Boolean);

  function applyFilters() {
    setAppliedFilters({ ...filters });
    setFiltersOpen(false);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setSearch("");
  }

  function selectRow(id: string) {
    if (selectedId === id) { setSelectedId(null); setDetail(null); return; }
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    void loadSaleDetail(id).then(setDetail).catch(() => setDetail(null)).finally(() => setDetailLoading(false));
  }

  const filterLabels = [
    appliedFilters.sessionId ? `Caja: ${cashOptions.find((c) => c.id === appliedFilters.sessionId)?.label ?? ""}` : null,
    appliedFilters.dateFrom ? `Desde: ${appliedFilters.dateFrom}` : null,
    appliedFilters.dateTo ? `Hasta: ${appliedFilters.dateTo}` : null,
    appliedFilters.paymentMethod ? `Pago: ${payLabel(appliedFilters.paymentMethod)}` : null,
    appliedFilters.collectedBy ? `Cobrado por: ${userOptions.find((u) => u.id === appliedFilters.collectedBy)?.label ?? ""}` : null,
    appliedFilters.attendedBy ? `Atendido por: ${userOptions.find((u) => u.id === appliedFilters.attendedBy)?.label ?? ""}` : null,
  ].filter((l): l is string => Boolean(l));

  return (
    <Box w="full" position="relative">
      {/* Table area */}
      <Box w="full">
        {/* Toolbar */}
        <Flex gap="3" wrap="wrap" mb="4" align="center">
          <Box flex="1" minW="240px" position="relative">
            <Search size={17} color="#6b7280" style={{ position: "absolute", left: 12, top: 11, zIndex: 1 }} />
            <Input pl="10" placeholder="Buscar por factura, atendido, nota o valor..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </Box>
          <Button variant="outline" onClick={() => setFiltersOpen(true)}><Filter size={17} />Filtros</Button>
          {hasFilters ? <Button variant="outline" colorPalette="red" onClick={clearFilters}><X size={16} />Limpiar filtros</Button> : null}
        </Flex>

        {/* Filter chips */}
        {filterLabels.length ? (
          <Flex mb="4" px="3" py="2" bg="purple.50" borderWidth="1px" borderColor="purple.100" borderRadius="md" align="center" gap="2" wrap="wrap">
            <Text color="purple.800" fontSize="sm" flex="1">Filtros: {filterLabels.join(" · ")}</Text>
          </Flex>
        ) : null}

        {/* Table */}
        <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
          <Box overflowX="auto">
            <Table.Root size="sm" minW="600px">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader w="140px">Factura</Table.ColumnHeader>
                  <Table.ColumnHeader w="160px">Fecha</Table.ColumnHeader>
                  <Table.ColumnHeader>Atendido por</Table.ColumnHeader>
                  <Table.ColumnHeader w="120px">Pago</Table.ColumnHeader>
                  <Table.ColumnHeader w="90px">Tipo</Table.ColumnHeader>
                  <Table.ColumnHeader w="130px" textAlign="right">Total</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {pageItems.map((sale) => (
                  <Table.Row
                    key={sale.id}
                    cursor="pointer"
                    bg={selectedId === sale.id ? "purple.50" : undefined}
                    borderLeftWidth={selectedId === sale.id ? "3px" : "3px"}
                    borderLeftColor={selectedId === sale.id ? "purple.500" : "transparent"}
                    _hover={{ bg: selectedId === sale.id ? "purple.50" : "gray.50" }}
                    onClick={() => selectRow(sale.id)}
                  >
                    <Table.Cell fontFamily="mono" fontSize="xs">{sale.invoice_number}</Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatDate(sale.created_at)}</Table.Cell>
                    <Table.Cell>{sale.attended_by ?? "-"}</Table.Cell>
                    <Table.Cell><Badge colorPalette={methodColor(sale.payment_method)}>{payLabel(sale.payment_method)}</Badge></Table.Cell>
                    <Table.Cell>{sale.is_delivery ? <Badge colorPalette="blue">Domicilio</Badge> : <Badge colorPalette="gray">Salon</Badge>}</Table.Cell>
                    <Table.Cell textAlign="right" fontWeight="semibold">{money(sale.total)}</Table.Cell>
                  </Table.Row>
                ))}
                {!loading && !pageItems.length ? (
                  <Table.Row><Table.Cell colSpan={6}><Text py="9" textAlign="center" color="gray.500">No hay ventas para los filtros seleccionados.</Text></Table.Cell></Table.Row>
                ) : null}
                {loading ? (
                  <Table.Row><Table.Cell colSpan={6}><Text py="9" textAlign="center" color="gray.500">Cargando historial...</Text></Table.Cell></Table.Row>
                ) : null}
              </Table.Body>
            </Table.Root>
          </Box>
          <PaginationControls total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        </Box>
      </Box>

      {/* Floating detail panel */}
      {selectedId ? (
        <Box position="fixed" top="72px" right="0" bottom="0" zIndex="10" w="440px" boxShadow="-4px 0 24px rgba(0,0,0,0.10)" overflow="hidden">
          <SaleDetailPanel
            detail={detail}
            loading={detailLoading}
            onClose={() => { setSelectedId(null); setDetail(null); }}
            onDeleted={(id) => { setSales((prev) => prev.filter((s) => s.id !== id)); setSelectedId(null); setDetail(null); }}
            onUpdated={(updated) => {
              setDetail((prev) => prev ? { ...prev, sale: { ...prev.sale, ...updated } } : prev);
              setSales((prev) => prev.map((s) => s.id === updated.id ? { ...s, payment_method: updated.payment_method ?? s.payment_method } : s));
            }}
          />
        </Box>
      ) : null}

      {/* Filters modal */}
      {filtersOpen ? (
        <FiltersModal
          filters={filters}
          cashOptions={cashOptions}
          userOptions={isAdmin ? userOptions : []}
          isAdmin={isAdmin}
          onChange={setFilters}
          onApply={applyFilters}
          onClose={() => setFiltersOpen(false)}
        />
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type SyntheticAddition = import("../pos/PosService").PosAddition;
type SyntheticSauce = import("../pos/PosService").PosSauce;

function buildSaleRequest(detail: SaleDetail): {
  req: import("../pos/SaleService").SaleRequest;
  allAdditions: SyntheticAddition[];
  allSauces: SyntheticSauce[];
} {
  const sale = detail.sale;
  const rootItems = detail.items.filter((i) => !i.combo_sale_item_id);

  // Build synthetic additions/sauces from stored names so PDF renders them correctly
  const additionMap = new Map<string, SyntheticAddition>();
  const sauceMap = new Map<string, SyntheticSauce>();
  for (const item of detail.items) {
    for (const a of item.additions) {
      if (!additionMap.has(a.name)) additionMap.set(a.name, { id: a.name, name: a.name, price: a.price, stock: null });
    }
    for (const s of item.sauces) {
      if (!sauceMap.has(s.name)) sauceMap.set(s.name, { id: s.name, name: s.name });
    }
  }
  const allAdditions = [...additionMap.values()];
  const allSauces = [...sauceMap.values()];

  const items: import("../pos/SaleService").SaleItemRequest[] = rootItems.map((item) => {
    const children = detail.items.filter((c) => c.combo_sale_item_id === item.id);
    const additions: Record<string, number> = {};
    for (const a of item.additions) additions[a.name] = a.quantity;
    return {
      key: item.id,
      name: item.product_name,
      price: item.unit_price,
      originalPrice: item.original_unit_price || item.unit_price,
      quantity: item.quantity,
      kind: children.length > 0 ? "combo" : "product",
      selectedOption: item.selected_option,
      note: item.notes ?? "",
      additions,
      sauces: item.sauces.map((s) => s.name),
      productId: item.id,
      categoryName: null,
      children: children.map((c) => ({
        productId: c.id,
        name: c.product_name,
        quantity: c.quantity,
        additions: Object.fromEntries(c.additions.map((a) => [a.name, a.quantity])),
        sauces: c.sauces.map((s) => s.name),
        selectedOption: c.selected_option,
      })),
    };
  });

  const paymentMethod: import("../pos/SaleService").SalePaymentMethod =
    sale.payment_method === "CARD" ? "CARD" : sale.payment_method === "SPLIT" ? "SPLIT" : "CASH";

  const req: import("../pos/SaleService").SaleRequest = {
    cash: { id: sale.cash_session_id, tenantId: "", userId: null, sessionNumber: sale.session_number ?? 0, openingAmount: 0, closingAmount: null, expectedAmount: null, status: "OPEN", openedAt: "", closedAt: null, userName: null },
    items,
    paymentMethod,
    total: sale.total,
    cashGiven: sale.cash_given ?? undefined,
    changeGiven: sale.change_given ?? undefined,
    cashAmount: sale.cash_amount ?? undefined,
    cardAmount: sale.card_amount ?? undefined,
    notes: sale.notes ?? undefined,
    delivery: sale.is_delivery ? { type: { id: "", name: sale.delivery_type_name ?? "Domicilio", price: sale.delivery_price ?? 0, sortOrder: 0 }, paymentMethod } : undefined,
  };

  return { req, allAdditions, allSauces };
}

// ---------------------------------------------------------------------------
// SaleDetailPanel
// ---------------------------------------------------------------------------
type SaleMetaUpdate = {
  paymentMethod: import("../pos/SaleService").SalePaymentMethod;
  cashGiven: number | null;
  changeGiven: number | null;
  cashAmount: number | null;
  cardAmount: number | null;
  notes: string | null;
  clientName: string | null;
};

function SaleDetailPanel({ detail, loading, onClose, onDeleted, onUpdated }: { detail: SaleDetail | null; loading: boolean; onClose: () => void; onDeleted: (id: string) => void; onUpdated: (updated: Partial<SaleDetail["sale"]>) => void }) {
  const session = sessionContext.current();
  const isSuperAdmin = session?.user.role === "SUPERADMIN";
  const sale = detail?.sale ?? null;

  const [activeTab, setActiveTab] = useState<"info" | "stock">("info");
  useEffect(() => { setActiveTab("info"); }, [detail?.sale.id]);
  const [bizConfig, setBizConfig] = useState<{ phone: string; printerReceipt: string; name: string; address: string; taxId: string; invoiceFooter: string; logoPath: string | null } | null>(null);
  const [hasPrinter, setHasPrinter] = useState(false);
  const [hasPhone, setHasPhone] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    void Promise.all([businessConfigService.load(), printerService.list()]).then(([cfg, printers]) => {
      setBizConfig({ phone: cfg.phone, printerReceipt: cfg.printerReceipt, name: cfg.name, address: cfg.address, taxId: cfg.taxId, invoiceFooter: cfg.invoiceFooter, logoPath: cfg.logoPath });
      setHasPrinter(Boolean(cfg.printerReceipt && printers.includes(cfg.printerReceipt)));
      const digits = cfg.phone.replace(/\D/g, "");
      setHasPhone(digits.length >= 7);
    }).catch(() => {});
  }, []);

  const rootItems = detail?.items.filter((i) => !i.combo_sale_item_id) ?? [];
  const totalAdditionsPrice = (item: SaleDetailItem) =>
    item.additions.reduce((sum, a) => sum + a.price * a.quantity, 0);

  async function handlePrint() {
    if (!sale || !bizConfig) return;
    setPdfBusy(true);
    try {
      const { saleService } = await import("../pos/SaleService");
      const { req, allAdditions, allSauces } = buildSaleRequest(detail!);
      await saleService.generateAndSaveInvoice(
        { saleId: sale.id, invoiceNumber: sale.invoice_number, changeGiven: sale.change_given ?? 0 },
        req,
        sale.session_number ?? 0,
        bizConfig,
        allAdditions,
        allSauces,
        true,
        { attendedBy: sale.attended_by ?? undefined, collectedBy: sale.collected_by ?? undefined, clientName: sale.client_name },
      );
    } catch (e) {
      notify.error("No fue posible generar el PDF.", e instanceof Error ? e.message : undefined);
    } finally {
      setPdfBusy(false);
    }
  }

  async function handleViewPdf() {
    if (!sale || !bizConfig) return;
    const folder = `facturas/caja-${sale.session_number ?? 0}`;
    const filePath = `${folder}/${sale.invoice_number}.pdf`;
    const fileExists = await exists(filePath, { baseDir: BaseDirectory.AppData }).catch(() => false);
    if (fileExists) {
      try {
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(filePath, { baseDir: BaseDirectory.AppData });
        await invoke("save_and_open_invoice_pdf", { sessionNumber: sale.session_number ?? 0, fileName: `${sale.invoice_number}.pdf`, bytes: Array.from(bytes) });
      } catch { /* non-fatal */ }
      return;
    }
    setPdfBusy(true);
    try {
      const { saleService } = await import("../pos/SaleService");
      const { req, allAdditions, allSauces } = buildSaleRequest(detail!);
      await saleService.generateAndSaveInvoice(
        { saleId: sale.id, invoiceNumber: sale.invoice_number, changeGiven: sale.change_given ?? 0 },
        req,
        sale.session_number ?? 0,
        bizConfig,
        allAdditions,
        allSauces,
        true,
        { attendedBy: sale.attended_by ?? undefined, collectedBy: sale.collected_by ?? undefined, clientName: sale.client_name },
      );
    } catch (e) {
      notify.error("No fue posible generar el PDF.", e instanceof Error ? e.message : undefined);
    } finally {
      setPdfBusy(false);
    }
  }

  async function handleWhatsApp() {
    if (!sale || !bizConfig?.phone) return;
    const { saleService } = await import("../pos/SaleService");
    const { req, allAdditions, allSauces } = buildSaleRequest(detail!);
    const url = saleService.buildWhatsAppUrl(bizConfig.phone, bizConfig.name, sale.invoice_number, req, allAdditions, allSauces, sale.client_name);
    void invoke("open_help_url", { url }).catch(() => window.open(url, "_blank"));
  }

  async function handleDelete() {
    if (!sale || !detail) return;
    setDeleting(true);
    try {
      const database = await databaseManager.database();
      const { syncQueueRepository, pendingDeletesRepository } = await import("../../infrastructure/sqlite/repositories");
      const { auditService } = await import("../audit/AuditService");
      const invoiceNumber = sale.invoice_number;
      const sessionNumber = sale.session_number ?? 0;
      const tenantId = session?.tenantId ?? "";
      const currentUserId = session?.user.id ?? "";
      const currentUserName = session?.user.display_name || session?.user.username || "";

      // a) Restaurar stock de productos e insumos
      const nowStr = () => new Date().toISOString();
      for (const item of detail.items) {
        const productId = item.product_id;
        if (productId) {
          const stockRows = await database.select<{ stock: number | null }[]>(
            "SELECT stock FROM products WHERE id=$1 AND stock IS NOT NULL",
            [productId],
          );
          if (stockRows.length > 0) {
            const before = Number(stockRows[0].stock ?? 0);
            const after = before + item.quantity;
            await database.execute("UPDATE products SET stock=stock+$1 WHERE id=$2 AND stock IS NOT NULL", [item.quantity, productId]);
            await database.execute(
              "INSERT INTO stock_logs(id,tenant_id,user_id,user_name,item_type,item_id,item_name,delta,stock_before,stock_after,created_at) VALUES($1,$2,$3,$4,'PRODUCT',$5,$6,$7,$8,$9,$10)",
              [crypto.randomUUID(), tenantId, currentUserId, currentUserName, productId, `${item.product_name} [Eliminacion venta ${invoiceNumber}]`, item.quantity, before, after, nowStr()],
            );
            await syncQueueRepository.enqueue("products", productId, "UPDATE", { id: productId, stock: after, updated_at: nowStr() });
          }

          // Insumos vinculados al producto
          const supplies = await database.select<{ supply_id: string; name: string; quantity_per_sale: number }[]>(
            "SELECT ps.supply_id, s.name, ps.quantity_per_sale FROM product_supplies ps JOIN supplies s ON s.id=ps.supply_id WHERE ps.product_id=$1",
            [productId],
          );
          for (const link of supplies) {
            const toRestore = Number(link.quantity_per_sale) * item.quantity;
            const supplyRows = await database.select<{ stock: number }[]>("SELECT stock FROM supplies WHERE id=$1", [link.supply_id]);
            const sBefore = Number(supplyRows[0]?.stock ?? 0);
            const sAfter = sBefore + toRestore;
            await database.execute("UPDATE supplies SET stock=stock+$1,updated_at=$2 WHERE id=$3", [toRestore, nowStr(), link.supply_id]);
            await database.execute(
              "INSERT INTO stock_logs(id,tenant_id,user_id,user_name,item_type,item_id,item_name,delta,stock_before,stock_after,created_at) VALUES($1,$2,$3,$4,'SUPPLY',$5,$6,$7,$8,$9,$10)",
              [crypto.randomUUID(), tenantId, currentUserId, currentUserName, link.supply_id, `${link.name} (${item.product_name}) [Eliminacion venta ${invoiceNumber}]`, toRestore, sBefore, sAfter, nowStr()],
            );
            await syncQueueRepository.enqueue("supplies", link.supply_id, "UPDATE", { id: link.supply_id, stock: sAfter, updated_at: nowStr() });
          }
        }

        // Stock de adiciones del item
        for (const addition of item.additions) {
          if (addition.quantity <= 0) continue;
          // Buscar la adicion por nombre para obtener id, stock y quantity_per_sale
          const addRows = await database.select<{ id: string; stock: number | null; quantity_per_sale: number | null }[]>(
            "SELECT id, stock, quantity_per_sale FROM additions WHERE name=$1 LIMIT 1",
            [addition.name],
          );
          if (!addRows.length || addRows[0].stock == null) continue;
          const addId = addRows[0].id;
          // qps: cuantas unidades de stock consume 1 unidad de adicion vendida
          const qps = Number(addRows[0].quantity_per_sale ?? 1) || 1;
          // quantity en SaleService se guarda como item.quantity * additionQty al descontar,
          // entonces para restaurar el mismo total: qps * additionQty * itemQty
          const toRestore = qps * addition.quantity * item.quantity;
          const aBefore = Number(addRows[0].stock);
          const aAfter = aBefore + toRestore;
          await database.execute("UPDATE additions SET stock=stock+$1 WHERE id=$2 AND stock IS NOT NULL", [toRestore, addId]);
          await database.execute(
            "INSERT INTO stock_logs(id,tenant_id,user_id,user_name,item_type,item_id,item_name,delta,stock_before,stock_after,created_at) VALUES($1,$2,$3,$4,'ADDITION',$5,$6,$7,$8,$9,$10)",
            [crypto.randomUUID(), tenantId, currentUserId, currentUserName, addId, `${addition.name} [Eliminacion venta ${invoiceNumber}]`, toRestore, aBefore, aAfter, nowStr()],
          );
          await syncQueueRepository.enqueue("additions", addId, "UPDATE", { id: addId, stock: aAfter, updated_at: nowStr() });
        }
      }

      // b) Borrar en orden FK inverso
      await database.execute("DELETE FROM sale_item_sauces WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id=$1)", [sale.id]);
      await database.execute("DELETE FROM sale_item_additions WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id=$1)", [sale.id]);
      await database.execute("DELETE FROM sale_items WHERE sale_id=$1", [sale.id]);
      await database.execute("DELETE FROM sales WHERE id=$1", [sale.id]);

      // c) Encolar pending delete para Supabase
      await pendingDeletesRepository.enqueue("sales", sale.id);

      // d) Audit
      await auditService.log("ELIMINAR_VENTA", "VENTA", `Factura #${invoiceNumber}`, sale.id);

      // e) Borrar PDF cacheado (best-effort)
      try {
        const { remove, exists: fsExists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
        const pdfPath = `facturas/caja-${sessionNumber}/${invoiceNumber}.pdf`;
        if (await fsExists(pdfPath, { baseDir: BaseDirectory.AppData })) {
          await remove(pdfPath, { baseDir: BaseDirectory.AppData });
        }
      } catch { /* non-fatal */ }

      notify.success(`Venta ${invoiceNumber} eliminada.`);
      onDeleted(sale.id);
    } catch (e) {
      notify.error("No fue posible eliminar la venta.", e instanceof Error ? e.message : undefined);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <Flex
      w="full"
      h="full"
      direction="column"
      bg="white"
      borderLeftWidth="1px"
      borderColor="gray.200"
      overflow="hidden"
    >
      {/* Header */}
      <Flex px="5" py="4" borderBottomWidth="1px" borderColor="gray.200" align="center" justify="space-between">
        <Flex align="center" gap="2">
          <Receipt size={18} color="#6366f1" />
          <Text fontWeight="bold" fontSize="sm">
            {sale ? `Factura #${sale.invoice_number}` : "Detalle"}
          </Text>
        </Flex>
        <Button size="xs" variant="outline" colorPalette="gray" onClick={onClose}><X size={14} />Cerrar</Button>
      </Flex>

      {loading || !detail || !sale ? (
        <Flex flex="1" align="center" justify="center">
          <Text color="gray.400" fontSize="sm">{loading ? "Cargando..." : "Sin datos"}</Text>
        </Flex>
      ) : (
        <Box flex="1" minH="0" overflow="hidden" display="flex" flexDirection="column">
          {/* Tabs horizontales arriba del contenido */}
          <Flex borderBottomWidth="1px" borderColor="gray.200">
            {(["info", "stock"] as const).map((tab) => (
              <Box
                key={tab}
                as="button"
                flex="1"
                onClick={() => setActiveTab(tab)}
                py="3"
                fontSize="sm"
                fontWeight="semibold"
                textAlign="center"
                color={activeTab === tab ? "purple.600" : "gray.500"}
                bg={activeTab === tab ? "purple.50" : "white"}
                style={{ cursor: "pointer", background: activeTab === tab ? undefined : "none", border: "none", borderBottom: `2px solid ${activeTab === tab ? "#7c3aed" : "transparent"}` }}
              >
                {tab === "info" ? "Informacion" : "Inventario"}
              </Box>
            ))}
          </Flex>

          <Box flex="1" overflowY="auto" p="5">
          {activeTab === "stock" ? (
            <SaleStockLogs invoiceNumber={sale.invoice_number} />
          ) : null}

          {activeTab === "info" ? <>
          {/* Info cards */}
          <Flex direction="column" gap="1" mb="4">
            <InfoRow label="Fecha" value={formatDate(sale.created_at)} />
            {sale.attended_by ? <InfoRow label="Atendido por" value={sale.attended_by} /> : null}
            {sale.collected_by ? <InfoRow label="Cobrado por" value={sale.collected_by} /> : null}
            {sale.session_number != null ? <InfoRow label="Caja" value={`#${sale.session_number}`} /> : null}
            {sale.client_name ? <InfoRow label="Cliente" value={sale.client_name} /> : null}
            <InfoRow label="Pago" value={payLabel(sale.payment_method)} />
          </Flex>

          {/* Payment breakdown */}
          {sale.payment_method === "CASH" && sale.cash_given != null ? (
            <Box mb="4" px="3" py="2" bg="green.50" borderRadius="md" borderWidth="1px" borderColor="green.100">
              <InfoRow label="Recibido" value={money(sale.cash_given)} />
              <InfoRow label="Cambio" value={money(Math.max(0, (sale.change_given ?? 0)))} />
            </Box>
          ) : null}

          {sale.payment_method === "SPLIT" && sale.cash_amount != null ? (
            <Box mb="4" px="3" py="2" bg="orange.50" borderRadius="md" borderWidth="1px" borderColor="orange.100">
              <InfoRow label="Efectivo" value={money(sale.cash_amount)} />
              <InfoRow label="Tarjeta" value={money(sale.card_amount ?? 0)} />
              {sale.cash_given != null ? <InfoRow label="Recibido" value={money(sale.cash_given)} /> : null}
              {sale.change_given != null ? <InfoRow label="Cambio" value={money(Math.max(0, sale.change_given))} /> : null}
            </Box>
          ) : null}

          {sale.is_delivery ? (
            <Box mb="4" px="3" py="2" bg="blue.50" borderRadius="md" borderWidth="1px" borderColor="blue.100">
              <InfoRow label="Tipo domicilio" value={sale.delivery_type_name ?? "Domicilio"} />
              {sale.delivery_price ? <InfoRow label="Costo domicilio" value={money(sale.delivery_price)} /> : null}
            </Box>
          ) : null}

          <Separator mb="4" />

          {/* Items */}
          <Flex direction="column" gap="4">
            {rootItems.map((item) => {
              const children = detail.items.filter((i) => i.combo_sale_item_id === item.id);
              const discounted = item.original_unit_price > 0 && item.unit_price !== item.original_unit_price;
              const additionsExtra = totalAdditionsPrice(item);

              return (
                <Box key={item.id}>
                  {/* Product name + subtotal */}
                  <Flex justify="space-between" align="baseline" gap="2">
                    <Text fontWeight="bold" fontSize="sm">
                      {item.quantity > 1 ? `${item.quantity}x ` : ""}{item.product_name}
                    </Text>
                    <Text fontWeight="bold" fontSize="sm" whiteSpace="nowrap">{money(item.subtotal + additionsExtra * item.quantity)}</Text>
                  </Flex>

                  {/* Discount */}
                  {discounted ? (
                    <Text fontSize="xs" color="green.600">
                      Precio original: {money(item.original_unit_price)} → {money(item.unit_price)}
                    </Text>
                  ) : null}

                  {/* Option */}
                  {item.selected_option ? (
                    <Text fontSize="xs" fontStyle="italic" color="#6366f1">{`>> ${item.selected_option}`}</Text>
                  ) : null}

                  {/* Combo children */}
                  {children.map((child) => (
                    <Box key={child.id} pl="3" mt="1">
                      <Text fontSize="xs" color="gray.600">
                        {"  - "}{child.quantity > 1 ? `${child.quantity}x ` : ""}{child.product_name}
                      </Text>
                      {child.selected_option ? (
                        <Text fontSize="xs" fontStyle="italic" color="#6366f1" pl="3">{`>> ${child.selected_option}`}</Text>
                      ) : null}
                      {child.additions.filter((a) => a.quantity > 0).map((a, i) => (
                        <Text key={i} fontSize="xs" color="gray.500" pl="3">
                          {"   + "}{a.quantity > 1 ? `${a.quantity}x ` : ""}{a.name}{a.price > 0 ? ` +${money(a.price * a.quantity)}` : ""}
                        </Text>
                      ))}
                      {child.sauces.length > 0 ? (
                        <Text fontSize="xs" pl="3" color="#d97706">
                          {"   Salsas: "}{child.sauces.map((s) => s.name).join(", ")}
                        </Text>
                      ) : null}
                    </Box>
                  ))}

                  {/* Additions */}
                  {item.additions.filter((a) => a.quantity > 0).map((a, i) => (
                    <Text key={i} fontSize="xs" color="gray.500">
                      {"   + "}{a.quantity > 1 ? `${a.quantity}x ` : ""}{a.name}{a.price > 0 ? ` +${money(a.price * a.quantity)}` : ""}
                    </Text>
                  ))}

                  {/* Sauces */}
                  {item.sauces.length > 0 ? (
                    <Text fontSize="xs" color="#d97706">
                      {"   Salsas: "}{item.sauces.map((s) => s.name).join(", ")}
                    </Text>
                  ) : null}

                  {/* Item note */}
                  {item.notes ? (
                    <Text fontSize="xs" fontStyle="italic" color="#854d0e">{`   >> ${item.notes}`}</Text>
                  ) : null}
                </Box>
              );
            })}
          </Flex>

          {/* Order note */}
          {sale.notes ? (
            <>
              <Separator my="4" />
              <Text fontSize="xs" color="gray.500" fontWeight="semibold" mb="1">Nota del pedido</Text>
              <Text fontSize="xs" color="gray.600">{sale.notes}</Text>
            </>
          ) : null}

          {/* Total */}
          <Separator my="4" />
          <Flex justify="space-between" align="baseline">
            <Text fontWeight="bold" fontSize="md">TOTAL</Text>
            <Text fontWeight="bold" fontSize="xl" color="purple.700">{money(sale.total)}</Text>
          </Flex>

          {/* Acciones */}
          <Separator my="4" />
          <Grid templateColumns="1fr 1fr" gap="2">
            {/* Reimprimir */}
            <Tip text={hasPrinter ? "Imprimir ticket en caja" : "Sin impresora de caja configurada"}>
              <Button size="sm" variant="outline" w="full" disabled={!hasPrinter || pdfBusy} loading={pdfBusy} onClick={() => void handlePrint()}>
                <Printer size={15} />Imprimir
              </Button>
            </Tip>

            {/* Ver PDF */}
            <Button size="sm" variant="outline" w="full" loading={pdfBusy} disabled={pdfBusy} onClick={() => void handleViewPdf()}>
              <Receipt size={15} />Ver PDF
            </Button>

            {/* WhatsApp */}
            <Tip text={hasPhone ? "Enviar detalle por WhatsApp" : "Sin telefono valido configurado"}>
              <Button
                size="sm" w="full"
                bg={hasPhone ? "#25d366" : undefined}
                color={hasPhone ? "white" : undefined}
                variant={hasPhone ? "solid" : "outline"}
                opacity={hasPhone ? 1 : 0.45}
                disabled={!hasPhone}
                onClick={() => void handleWhatsApp()}
              >
                <MessageCircle size={15} />WhatsApp
              </Button>
            </Tip>

            {/* Editar Venta */}
            <Button size="sm" variant="outline" colorPalette="purple" w="full" onClick={() => setEditOpen(true)}>
              <Pencil size={15} />Editar Venta
            </Button>

            {/* Eliminar — solo SUPERADMIN */}
            {isSuperAdmin ? (
              <Button size="sm" variant="outline" colorPalette="red" w="full" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} />Eliminar
              </Button>
            ) : null}
          </Grid>

          {/* Edit modal */}
          {editOpen && sale ? (
            <EditSaleModal
              sale={sale}
              onClose={() => setEditOpen(false)}
              onSaved={(updated) => {
                setEditOpen(false);
                onUpdated(updated);
              }}
            />
          ) : null}

          {/* Confirm delete */}
          {confirmDelete ? (
            <ConfirmDeleteModal
              invoiceNumber={sale.invoice_number}
              deleting={deleting}
              onClose={() => setConfirmDelete(false)}
              onConfirm={() => void handleDelete()}
            />
          ) : null}
          </> : null}
        </Box>
        </Box>
      )}
    </Flex>
  );
}


// ---------------------------------------------------------------------------
// SaleStockLogs
// ---------------------------------------------------------------------------
type StockLogRow = { id: string; item_type: string; item_name: string; delta: number; stock_before: number | null; stock_after: number | null; created_at: string };

function SaleStockLogs({ invoiceNumber }: { invoiceNumber: string }) {
  const [logs, setLogs] = useState<StockLogRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void databaseManager.database().then((db) =>
      db.select<StockLogRow[]>(
        `SELECT id, item_type, item_name, delta, stock_before, stock_after, created_at
         FROM stock_logs
         WHERE item_name LIKE $1 OR item_name LIKE $2
         ORDER BY created_at DESC`,
        [`%[Factura ${invoiceNumber}]%`, `%[Eliminacion venta ${invoiceNumber}]%`],
      )
    ).then(setLogs).catch(() => setLogs([])).finally(() => setLoading(false));
  }, [invoiceNumber]);

  if (loading) return <Flex py="10" justify="center"><Text color="gray.400" fontSize="sm">Cargando...</Text></Flex>;

  if (!logs.length) return (
    <Flex direction="column" align="center" justify="center" py="10" gap="2">
      <Text color="gray.400" fontSize="sm">Sin movimientos de inventario</Text>
      <Text color="gray.300" fontSize="xs">Esta venta no genero cambios de stock registrados.</Text>
    </Flex>
  );

  // Agrupar por tipo
  const groups: Record<string, StockLogRow[]> = {};
  for (const log of logs) {
    const key = log.item_type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(log);
  }

  const typeLabel = (t: string) => t === "PRODUCT" ? "Productos" : t === "SUPPLY" ? "Insumos" : t === "ADDITION" ? "Adiciones" : t;
  const typeColor = (t: string) => t === "PRODUCT" ? "purple" : t === "SUPPLY" ? "blue" : "orange";
  const fmtStock = (v: number | null) => v == null ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(1);
  const fmtDelta = (v: number) => `${v > 0 ? "+" : ""}${fmtStock(v)}`;

  // Extraer nombre limpio (quitar sufijo [Factura X] o [Eliminacion venta X])
  const cleanName = (name: string) => name.replace(/\s*\[(?:Factura|Eliminacion venta)\s+[^\]]+\]/, "").trim();

  return (
    <Flex direction="column" gap="5">
      {Object.entries(groups).map(([type, items]) => (
        <Box key={type}>
          <Flex align="center" gap="2" mb="2">
            <Badge colorPalette={typeColor(type)} size="sm">{typeLabel(type)}</Badge>
          </Flex>
          <Flex direction="column" gap="2">
            {items.map((log) => (
              <Box key={log.id} px="3" py="2" bg="gray.50" borderRadius="md" borderWidth="1px" borderColor="gray.100">
                <Flex justify="space-between" align="baseline" gap="2">
                  <Text fontSize="xs" fontWeight="semibold" color="gray.700" flex="1">{cleanName(log.item_name)}</Text>
                  <Text fontSize="sm" fontWeight="bold" color={log.delta >= 0 ? "green.600" : "red.600"}>{fmtDelta(log.delta)}</Text>
                </Flex>
                <Flex gap="3" mt="1">
                  <Text fontSize="xs" color="gray.400">Antes: {fmtStock(log.stock_before)}</Text>
                  <Text fontSize="xs" color="gray.400">Despues: {fmtStock(log.stock_after)}</Text>
                </Flex>
              </Box>
            ))}
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDeleteModal
// ---------------------------------------------------------------------------
function ConfirmDeleteModal({ invoiceNumber, deleting, onClose, onConfirm }: { invoiceNumber: string; deleting: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
      <Box w="full" maxW="400px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
        <Flex justify="space-between" align="center" mb="4">
          <Text fontWeight="bold" fontSize="md">Eliminar venta</Text>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button>
        </Flex>
        <Text color="gray.600" fontSize="sm">Eliminar la venta <strong>{invoiceNumber}</strong>? Se restaurara el stock de los productos. Esta accion no se puede deshacer.</Text>
        <Flex mt="6" justify="end" gap="3">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button colorPalette="red" loading={deleting} onClick={onConfirm}>Eliminar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// EditSaleModal
// ---------------------------------------------------------------------------
function EditSaleModal({ sale, onClose, onSaved }: {
  sale: SaleDetail["sale"];
  onClose: () => void;
  onSaved: (updated: Partial<SaleDetail["sale"]>) => void;
}) {
  type PM = import("../pos/SaleService").SalePaymentMethod;
  const originalMethod = (sale.payment_method === "CARD" ? "CARD" : sale.payment_method === "SPLIT" ? "SPLIT" : "CASH") as PM;
  const total = sale.total;
  const BILLS = [10_000, 20_000, 50_000, 100_000];

  const [method, setMethod] = useState<PM>(originalMethod);
  // Efectivo (CASH): recibido. Si el original era CASH se precarga, sino se pone el total
  const [cashGiven, setCashGiven] = useState(
    sale.cash_given != null ? String(sale.cash_given) : String(total),
  );
  const [cashGivenTouched, setCashGivenTouched] = useState(false);
  // Split: monto en efectivo. Si el original era SPLIT se precarga, sino vacio
  const [splitCash, setSplitCash] = useState(sale.cash_amount != null ? String(sale.cash_amount) : "");
  // Efectivo recibido en split. Si el original era SPLIT se precarga, sino vacio
  const [splitCashGiven, setSplitCashGiven] = useState(sale.cash_given != null && originalMethod === "SPLIT" ? String(sale.cash_given) : "");
  const [splitCashGivenTouched, setSplitCashGivenTouched] = useState(false);

  // Al cambiar a CASH: poner total exacto si no fue tocado
  useEffect(() => {
    if (method === "CASH" && !cashGivenTouched) {
      setCashGiven(String(total));
    }
  }, [method]);

  // Split: sincronizar efectivo recibido con monto efectivo mientras no sea tocado
  useEffect(() => {
    if (method === "SPLIT" && !splitCashGivenTouched) {
      setSplitCashGiven(splitCash);
    }
  }, [splitCash, method]);

  const [notes, setNotes] = useState(sale.notes ?? "");
  const [clientName, setClientName] = useState(sale.client_name ?? "");
  const [saving, setSaving] = useState(false);

  // Calculos
  const cashNum = Number(cashGiven) || 0;
  const splitCashNum = Math.min(Number(splitCash) || 0, total);
  const splitCardNum = total - splitCashNum;
  const splitCashGivenNum = Number(splitCashGiven) || 0;
  const changeCash = method === "CASH" ? cashNum - total : splitCashGivenNum - splitCashNum;
  const cashInsufficient = method === "CASH" ? cashNum < total : (splitCashNum > 0 ? splitCashGivenNum < splitCashNum : false);
  const splitInvalid = method === "SPLIT" && (splitCashNum <= 0 || splitCardNum <= 0);

  function applyBill(bill: number) {
    if (method === "CASH") {
      setCashGiven((prev) => { const base = cashGivenTouched ? (Number(prev) || 0) : 0; setCashGivenTouched(true); return String(base + bill); });
    } else {
      setSplitCashGiven((prev) => { const base = splitCashGivenTouched ? (Number(prev) || 0) : 0; setSplitCashGivenTouched(true); return String(base + bill); });
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const { saleService } = await import("../pos/SaleService");
      const updated: SaleMetaUpdate = {
        paymentMethod: method,
        cashGiven: method !== "CARD" ? (method === "CASH" ? cashNum : splitCashGivenNum) || null : null,
        changeGiven: method !== "CARD" ? Math.max(0, changeCash) : null,
        cashAmount: method === "SPLIT" ? splitCashNum || null : null,
        cardAmount: method === "SPLIT" ? splitCardNum || null : null,
        notes: notes.trim() || null,
        clientName: clientName.trim() || null,
      };
      const original: SaleMetaUpdate = {
        paymentMethod: originalMethod,
        cashGiven: sale.cash_given,
        changeGiven: sale.change_given,
        cashAmount: sale.cash_amount,
        cardAmount: sale.card_amount,
        notes: sale.notes,
        clientName: sale.client_name,
      };
      const didChange = await saleService.updateSalePaymentAndMeta(
        sale.id, sale.invoice_number, sale.session_number ?? 0,
        original, updated,
      );
      if (didChange) {
        notify.success(`Venta ${sale.invoice_number} actualizada.`);
        onSaved({
          id: sale.id,
          payment_method: updated.paymentMethod,
          cash_given: updated.cashGiven,
          change_given: updated.changeGiven,
          cash_amount: updated.cashAmount,
          card_amount: updated.cardAmount,
          notes: updated.notes,
          client_name: updated.clientName,
        });
      } else {
        onClose();
      }
    } catch (e) {
      notify.error("No fue posible guardar los cambios.", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="460px" maxH="calc(100vh - 32px)" overflowY="auto" bg="white" borderRadius="lg" boxShadow="2xl">
        {/* Encabezado */}
        <Flex px="6" pt="6" pb="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.100">
          <Text fontWeight="bold" fontSize="lg">Editar Venta #{sale.invoice_number}</Text>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>

        <Box px="6" py="5">
          {/* Total */}
          <Flex direction="column" align="center" mb="6">
            <Text fontSize="sm" color="gray.500" fontWeight="medium">Total</Text>
            <Text fontSize="4xl" fontWeight="bold" color="purple.700" lineHeight="1.1">{money(total)}</Text>
          </Flex>

          {/* Metodo de pago */}
          <Box mb="5">
            <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="2">Metodo de pago</Text>
            <Flex gap="2">
              {(["CASH", "CARD", "SPLIT"] as PM[]).map((m) => (
                <Button key={m} size="sm" flex="1"
                  variant={method === m ? "solid" : "outline"}
                  colorPalette={method === m ? "purple" : "gray"}
                  onClick={() => setMethod(m)}
                >
                  {m === "CASH" ? "Efectivo" : m === "CARD" ? "Tarjeta" : "Dividido"}
                </Button>
              ))}
            </Flex>
          </Box>

          {/* Efectivo recibido */}
          {method === "CASH" ? (
            <Box mb="5">
              <Text fontSize="sm" color="gray.600" mb="1">Efectivo recibido</Text>
              <Input
                value={cashGiven}
                onChange={(e) => { setCashGiven(e.target.value); setCashGivenTouched(true); }}
                type="number" placeholder="0"
              />
              <Flex mt="2" gap="2" flexWrap="wrap">
                {BILLS.map((b) => (
                  <Button key={b} size="xs" variant="outline" colorPalette="gray" onClick={() => applyBill(b)}>
                    ${(b / 1000).toFixed(0)}k
                  </Button>
                ))}
                <Button size="xs" variant="outline" colorPalette="gray" onClick={() => { setCashGiven(String(total)); setCashGivenTouched(false); }}>Exacto</Button>
              </Flex>
              <Flex mt="3" align="center" justify="space-between">
                <Text fontSize="sm" color="gray.600">Cambio</Text>
                {cashInsufficient
                  ? <Text fontSize="sm" fontWeight="semibold" color="red.500">Monto insuficiente</Text>
                  : <Text fontSize="sm" fontWeight="bold" color="green.600">{money(Math.max(0, changeCash))}</Text>}
              </Flex>
            </Box>
          ) : null}

          {/* Dividido */}
          {method === "SPLIT" ? (
            <Box mb="5">
              <Text fontSize="sm" color="gray.600" mb="1">Monto en efectivo</Text>
              <Input value={splitCash} onChange={(e) => setSplitCash(e.target.value)} type="number" placeholder="0" />
              {splitCashNum > 0 && splitCardNum > 0 ? (
                <Flex mt="2" gap="3">
                  <Flex align="center" gap="1"><Text fontSize="xs" color="gray.500">Efectivo:</Text><Text fontSize="xs" fontWeight="semibold">{money(splitCashNum)}</Text></Flex>
                  <Flex align="center" gap="1"><Text fontSize="xs" color="gray.500">Tarjeta:</Text><Text fontSize="xs" fontWeight="semibold">{money(splitCardNum)}</Text></Flex>
                </Flex>
              ) : null}
              {splitInvalid && splitCash !== "" ? <Text fontSize="xs" color="red.500" mt="1">Ambas partes deben ser mayores a 0</Text> : null}
              {splitCashNum > 0 ? (
                <Box mt="4">
                  <Text fontSize="sm" color="gray.600" mb="1">Efectivo recibido</Text>
                  <Input value={splitCashGiven} onChange={(e) => { setSplitCashGiven(e.target.value); setSplitCashGivenTouched(true); }} type="number" placeholder="0" />
                  <Flex mt="2" gap="2" flexWrap="wrap">
                    {BILLS.map((b) => (
                      <Button key={b} size="xs" variant="outline" colorPalette="gray" onClick={() => applyBill(b)}>
                        ${(b / 1000).toFixed(0)}k
                      </Button>
                    ))}
                    <Button size="xs" variant="outline" colorPalette="gray" onClick={() => { setSplitCashGiven(String(splitCashNum)); setSplitCashGivenTouched(false); }}>Exacto</Button>
                  </Flex>
                  <Flex mt="3" align="center" justify="space-between">
                    <Text fontSize="sm" color="gray.600">Cambio efectivo</Text>
                    {cashInsufficient
                      ? <Text fontSize="sm" fontWeight="semibold" color="red.500">Monto insuficiente</Text>
                      : <Text fontSize="sm" fontWeight="bold" color="green.600">{money(Math.max(0, changeCash))}</Text>}
                  </Flex>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {/* Cliente */}
          <Box mb="4">
            <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="1">Cliente</Text>
            <Input placeholder="Nombre del cliente (opcional)" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </Box>

          {/* Nota general */}
          <Box mb="6">
            <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="1">Nota del pedido</Text>
            <Textarea placeholder="Opcional..." value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </Box>

          <Button
            w="full" colorPalette="purple" size="lg"
            loading={saving}
            disabled={cashInsufficient || splitInvalid || saving}
            onClick={() => void handleSave()}
          >
            Guardar cambios
          </Button>
        </Box>
      </Box>
    </Flex>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex justify="space-between" gap="3" align="baseline">
      <Text fontSize="xs" color="gray.500">{label}</Text>
      <Text fontSize="xs" fontWeight="medium" textAlign="right">{value}</Text>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// FiltersModal
// ---------------------------------------------------------------------------
function FiltersModal({ filters, cashOptions, userOptions, isAdmin, onChange, onApply, onClose }: {
  filters: Filters;
  cashOptions: CashOption[];
  userOptions: { id: string; label: string }[];
  isAdmin: boolean;
  onChange: (f: Filters) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const set = (key: keyof Filters) => (value: string) => onChange({ ...filters, [key]: value });

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="480px" maxH="calc(100vh - 32px)" overflowY="auto" bg="white" borderRadius="md" boxShadow="2xl" p="6">
        <Flex justify="space-between" align="center" mb="5">
          <Text fontWeight="bold" fontSize="lg">Filtros</Text>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>

        <Grid templateColumns="1fr 1fr" gap="4">
          <FieldLabel label="Caja">
            <ScrollableSelect placement="bottom" value={filters.sessionId || "ALL"} placeholder="Todas las cajas" options={[{ value: "ALL", label: "Todas las cajas" }, ...cashOptions.map((c) => ({ value: c.id, label: c.label }))]} onValueChange={(v) => set("sessionId")(v === "ALL" ? "" : v)} />
          </FieldLabel>

          <FieldLabel label="Metodo de pago">
            <ScrollableSelect placement="bottom" value={filters.paymentMethod || "ALL"} placeholder="Todos" options={[{ value: "ALL", label: "Todos" }, { value: "CASH", label: "Efectivo" }, { value: "CARD", label: "Tarjeta" }, { value: "SPLIT", label: "Dividido" }]} onValueChange={(v) => set("paymentMethod")(v === "ALL" ? "" : v)} />
          </FieldLabel>

          <FieldLabel label="Desde">
            <Input type="date" value={filters.dateFrom} onChange={(e) => set("dateFrom")(e.target.value)} />
          </FieldLabel>

          <FieldLabel label="Hasta">
            <Input type="date" value={filters.dateTo} onChange={(e) => set("dateTo")(e.target.value)} />
          </FieldLabel>

          {isAdmin ? (
            <>
              <FieldLabel label="Cobrado por">
                <ScrollableSelect placement="top" value={filters.collectedBy || "ALL"} placeholder="Todos" options={[{ value: "ALL", label: "Todos" }, ...userOptions.map((u) => ({ value: u.id, label: u.label }))]} onValueChange={(v) => set("collectedBy")(v === "ALL" ? "" : v)} />
              </FieldLabel>
              <FieldLabel label="Atendido por">
                <ScrollableSelect placement="top" value={filters.attendedBy || "ALL"} placeholder="Todos" options={[{ value: "ALL", label: "Todos" }, ...userOptions.map((u) => ({ value: u.id, label: u.label }))]} onValueChange={(v) => set("attendedBy")(v === "ALL" ? "" : v)} />
              </FieldLabel>
            </>
          ) : null}
        </Grid>

        <Flex mt="6" justify="end" gap="3">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button colorPalette="purple" onClick={onApply}>Aplicar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return <Box mb="4"><Text mb="1" fontSize="sm" fontWeight="semibold" color="gray.700">{label}</Text>{children}</Box>;
}

function payLabel(method: string) {
  return method === "CASH" ? "Efectivo" : method === "CARD" ? "Tarjeta" : method === "SPLIT" ? "Dividido" : method;
}

function methodColor(method: string) {
  return method === "CASH" ? "green" : method === "CARD" ? "blue" : "orange";
}

function money(value: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(value));
}
