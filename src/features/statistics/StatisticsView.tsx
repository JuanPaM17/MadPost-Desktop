import { Box, Button, Flex, Grid, Spinner, Table, Text } from "@chakra-ui/react";
import { Check, ChevronDown, ChevronRight, Download, Filter, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactApexChart from "react-apexcharts";
import { cashRegisterService, type CashSession } from "../cashregister/CashRegisterService";
import { ScrollableSelect } from "../../components/ui/ScrollableSelect";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { sessionContext } from "../../core/session/SessionContext";

type Filters = { sessionId: string | null; dateFrom: string; dateTo: string };

type Stats = {
  totalCount: number;
  totalRevenue: number;
  avgSale: number;
  cashTotal: number;
  cashCount: number;
  cardTotal: number;
  cardCount: number;
  tableCount: number;
  tableTotal: number;
  deliveryCount: number;
  deliveryTotal: number;
  deliveryCashCount: number;
  deliveryCashTotal: number;
  deliveryCardCount: number;
  deliveryCardTotal: number;
  deliveryFeeTotal: number;
};

const EMPTY_STATS: Stats = {
  totalCount: 0, totalRevenue: 0, avgSale: 0,
  cashTotal: 0, cashCount: 0, cardTotal: 0, cardCount: 0,
  tableCount: 0, tableTotal: 0,
  deliveryCount: 0, deliveryTotal: 0,
  deliveryCashCount: 0, deliveryCashTotal: 0,
  deliveryCardCount: 0, deliveryCardTotal: 0,
  deliveryFeeTotal: 0,
};

function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("es-CO");
}

function formatSessionLabel(s: CashSession): string {
  const opened = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date(s.openedAt));
  const status = s.status === "OPEN" ? " (Abierta)" : "";
  return `Caja #${s.sessionNumber} — ${opened}${status}`;
}

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date(`${iso}T00:00:00`));
}

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

type DayPoint = { label: string; revenue: number; count: number };

async function loadLast7Days(): Promise<DayPoint[]> {
  const db = await databaseManager.database();
  const session = sessionContext.current();
  if (!session) return [];

  // Generar los últimos 7 días en zona Colombia
  const days: { iso: string; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
    const label = d.toLocaleDateString("es-CO", { timeZone: "America/Bogota", weekday: "short", day: "2-digit", month: "2-digit" })
      .replace(".", "").replace(/^\w/, (c) => c.toUpperCase());
    days.push({ iso, label });
  }

  const from = days[0].iso;
  const to = days[days.length - 1].iso;

  const rows = await db.select<{ day: string; revenue: number; count: number }[]>(
    `SELECT DATE(s.created_at) AS day,
            COALESCE(SUM(s.total), 0) AS revenue,
            COUNT(*) AS count
     FROM sales s
     WHERE s.tenant_id=$1
       AND s.created_at >= $2
       AND s.created_at <= $3
     GROUP BY DATE(s.created_at)`,
    [session.tenantId, from + "T00:00:00.000Z", to + "T23:59:59.999Z"],
  );

  const map = new Map(rows.map((r) => [r.day, { revenue: Number(r.revenue), count: Number(r.count) }]));
  return days.map((d) => ({ label: d.label, revenue: map.get(d.iso)?.revenue ?? 0, count: map.get(d.iso)?.count ?? 0 }));
}

type HourPoint = { hour: number; label: string; revenue: number; count: number };

async function loadByHour(filters: Filters): Promise<HourPoint[]> {
  const db = await databaseManager.database();
  const session = sessionContext.current();
  if (!session) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.sessionId) {
    conditions.push("s.cash_session_id=$" + params.push(filters.sessionId));
  } else {
    conditions.push("s.tenant_id=$" + params.push(session.tenantId));
    if (filters.dateFrom) conditions.push("s.created_at >= $" + params.push(filters.dateFrom + "T00:00:00.000Z"));
    const to = filters.dateTo || todayIso();
    conditions.push("s.created_at <= $" + params.push(to + "T23:59:59.999Z"));
  }

  const where = "WHERE " + conditions.join(" AND ");

  const rows = await db.select<{ hour: number; revenue: number; count: number }[]>(
    `SELECT CAST(strftime('%H', s.created_at, 'localtime') AS INTEGER) AS hour,
            COALESCE(SUM(s.total), 0) AS revenue,
            COUNT(*) AS count
     FROM sales s ${where}
     GROUP BY hour ORDER BY hour ASC`,
    params,
  );

  if (!rows.length) return [];

  const minHour = Math.max(0, Number(rows[0].hour) - 1);
  const maxHour = Math.min(23, Number(rows[rows.length - 1].hour) + 1);
  const map = new Map(rows.map((r) => [Number(r.hour), { revenue: Number(r.revenue), count: Number(r.count) }]));

  const result: HourPoint[] = [];
  for (let h = minHour; h <= maxHour; h++) {
    const ampm = h < 12 ? "am" : "pm";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    result.push({ hour: h, label: `${h12}${ampm}`, revenue: map.get(h)?.revenue ?? 0, count: map.get(h)?.count ?? 0 });
  }
  return result;
}

type ProductOption = { option: string | null; qty: number; subtotal: number };
type ProductRow = { name: string; qty: number; subtotal: number; options: ProductOption[] };

async function loadProducts(filters: Filters): Promise<ProductRow[]> {
  const db = await databaseManager.database();
  const session = sessionContext.current();
  if (!session) return [];

  const conditions: string[] = ["si.combo_sale_item_id IS NULL"];
  const params: unknown[] = [];

  if (filters.sessionId) {
    conditions.push("s.cash_session_id=$" + params.push(filters.sessionId));
  } else {
    conditions.push("s.tenant_id=$" + params.push(session.tenantId));
    if (filters.dateFrom) conditions.push("s.created_at >= $" + params.push(filters.dateFrom + "T00:00:00.000Z"));
    const to = filters.dateTo || todayIso();
    conditions.push("s.created_at <= $" + params.push(to + "T23:59:59.999Z"));
  }

  const where = "WHERE " + conditions.join(" AND ");

  const rows = await db.select<{ product_name: string; selected_option: string | null; qty: number; subtotal: number }[]>(
    `SELECT si.product_name, si.selected_option,
            SUM(si.quantity) AS qty, COALESCE(SUM(si.subtotal), 0) AS subtotal
     FROM sale_items si
     JOIN sales s ON si.sale_id = s.id
     ${where}
     GROUP BY si.product_name, si.selected_option
     ORDER BY SUM(si.quantity) DESC`,
    params,
  );

  // Agrupar por product_name
  const map = new Map<string, ProductRow>();
  for (const r of rows) {
    const existing = map.get(r.product_name);
    const opt: ProductOption = { option: r.selected_option, qty: Number(r.qty), subtotal: Number(r.subtotal) };
    if (existing) {
      existing.qty += opt.qty;
      existing.subtotal += opt.subtotal;
      existing.options.push(opt);
    } else {
      map.set(r.product_name, { name: r.product_name, qty: opt.qty, subtotal: opt.subtotal, options: [opt] });
    }
  }

  // Ordenar por cantidad total desc
  return Array.from(map.values()).sort((a, b) => b.qty - a.qty);
}

type AdditionRow = { name: string; qty: number; subtotal: number };

async function loadAdditions(filters: Filters): Promise<AdditionRow[]> {
  const db = await databaseManager.database();
  const session = sessionContext.current();
  if (!session) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.sessionId) {
    conditions.push("s.cash_session_id=$" + params.push(filters.sessionId));
  } else {
    conditions.push("s.tenant_id=$" + params.push(session.tenantId));
    if (filters.dateFrom) conditions.push("s.created_at >= $" + params.push(filters.dateFrom + "T00:00:00.000Z"));
    const to = filters.dateTo || todayIso();
    conditions.push("s.created_at <= $" + params.push(to + "T23:59:59.999Z"));
  }

  const where = "WHERE " + conditions.join(" AND ");

  const rows = await db.select<{ name: string; qty: number; subtotal: number }[]>(
    `SELECT sia.addition_name AS name,
            SUM(sia.quantity) AS qty,
            COALESCE(SUM(sia.price * sia.quantity), 0) AS subtotal
     FROM sale_item_additions sia
     JOIN sale_items si ON sia.sale_item_id = si.id
     JOIN sales s ON si.sale_id = s.id
     ${where}
     GROUP BY sia.addition_name
     ORDER BY SUM(sia.quantity) DESC`,
    params,
  );

  return rows.map((r) => ({ name: r.name, qty: Number(r.qty), subtotal: Number(r.subtotal) }));
}

async function loadStats(filters: Filters): Promise<Stats> {
  const db = await databaseManager.database();
  const session = sessionContext.current();
  if (!session) throw new Error("Sin sesion");

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.sessionId) {
    conditions.push("s.cash_session_id=$" + params.push(filters.sessionId));
  } else {
    conditions.push("s.tenant_id=$" + params.push(session.tenantId));
    if (filters.dateFrom) conditions.push("s.created_at >= $" + params.push(filters.dateFrom + "T00:00:00.000Z"));
    const to = filters.dateTo || todayIso();
    conditions.push("s.created_at <= $" + params.push(to + "T23:59:59.999Z"));
  }

  const where = "WHERE " + conditions.join(" AND ");

  type Row = {
    total_count: number;
    total_revenue: number;
    cash_total: number; cash_count: number;
    card_total: number; card_count: number;
    table_count: number; table_total: number;
    delivery_count: number; delivery_total: number;
    delivery_cash_count: number; delivery_cash_total: number;
    delivery_card_count: number; delivery_card_total: number;
    delivery_fee_total: number;
  };

  const rows = await db.select<Row[]>(`
    SELECT
      COUNT(*) AS total_count,
      COALESCE(SUM(s.total), 0) AS total_revenue,
      COALESCE(SUM(CASE WHEN s.is_delivery=0 THEN COALESCE(s.cash_amount, CASE WHEN s.payment_method='CASH' THEN s.total ELSE 0 END) ELSE 0 END), 0) AS cash_total,
      COUNT(CASE WHEN s.is_delivery=0 AND COALESCE(s.cash_amount, CASE WHEN s.payment_method='CASH' THEN s.total ELSE 0 END) > 0 THEN 1 END) AS cash_count,
      COALESCE(SUM(CASE WHEN s.is_delivery=0 THEN COALESCE(s.card_amount, CASE WHEN s.payment_method='CARD' THEN s.total ELSE 0 END) ELSE 0 END), 0) AS card_total,
      COUNT(CASE WHEN s.is_delivery=0 AND COALESCE(s.card_amount, CASE WHEN s.payment_method='CARD' THEN s.total ELSE 0 END) > 0 THEN 1 END) AS card_count,
      COUNT(CASE WHEN s.is_delivery=0 AND s.table_order_id IS NOT NULL THEN 1 END) AS table_count,
      COALESCE(SUM(CASE WHEN s.is_delivery=0 AND s.table_order_id IS NOT NULL THEN s.total ELSE 0 END), 0) AS table_total,
      COUNT(CASE WHEN s.is_delivery=1 THEN 1 END) AS delivery_count,
      COALESCE(SUM(CASE WHEN s.is_delivery=1 THEN s.total ELSE 0 END), 0) AS delivery_total,
      COUNT(CASE WHEN s.is_delivery=1 AND COALESCE(s.cash_amount, CASE WHEN s.payment_method='CASH' THEN s.total ELSE 0 END) > 0 THEN 1 END) AS delivery_cash_count,
      COALESCE(SUM(CASE WHEN s.is_delivery=1 THEN COALESCE(s.cash_amount, CASE WHEN s.payment_method='CASH' THEN s.total ELSE 0 END) ELSE 0 END), 0) AS delivery_cash_total,
      COUNT(CASE WHEN s.is_delivery=1 AND COALESCE(s.card_amount, CASE WHEN s.payment_method='CARD' THEN s.total ELSE 0 END) > 0 THEN 1 END) AS delivery_card_count,
      COALESCE(SUM(CASE WHEN s.is_delivery=1 THEN COALESCE(s.card_amount, CASE WHEN s.payment_method='CARD' THEN s.total ELSE 0 END) ELSE 0 END), 0) AS delivery_card_total,
      COALESCE(SUM(CASE WHEN s.is_delivery=1 THEN COALESCE(s.delivery_price, 0) ELSE 0 END), 0) AS delivery_fee_total
    FROM sales s
    ${where}
  `, params);

  const r = rows[0];
  if (!r) return EMPTY_STATS;
  const totalCount = Number(r.total_count);
  const totalRevenue = Number(r.total_revenue);
  return {
    totalCount,
    totalRevenue,
    avgSale: totalCount > 0 ? totalRevenue / totalCount : 0,
    cashTotal: Number(r.cash_total), cashCount: Number(r.cash_count),
    cardTotal: Number(r.card_total), cardCount: Number(r.card_count),
    tableCount: Number(r.table_count), tableTotal: Number(r.table_total),
    deliveryCount: Number(r.delivery_count), deliveryTotal: Number(r.delivery_total),
    deliveryCashCount: Number(r.delivery_cash_count), deliveryCashTotal: Number(r.delivery_cash_total),
    deliveryCardCount: Number(r.delivery_card_count), deliveryCardTotal: Number(r.delivery_card_total),
    deliveryFeeTotal: Number(r.delivery_fee_total),
  };
}

export function StatisticsView() {
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [filters, setFilters] = useState<Filters>({ sessionId: null, dateFrom: "", dateTo: "" });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [chartData, setChartData] = useState<DayPoint[]>([]);
  const [hourData, setHourData] = useState<HourPoint[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [additions, setAdditions] = useState<AdditionRow[]>([]);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void Promise.all([
      cashRegisterService.listSessions(),
      loadLast7Days(),
    ]).then(([list, chart]) => {
      setSessions(list);
      setChartData(chart);
      const initial: Filters = list.length > 0
        ? { sessionId: list[0].id, dateFrom: "", dateTo: "" }
        : { sessionId: null, dateFrom: "", dateTo: "" };
      setFilters(initial);
      return Promise.all([loadStats(initial), loadByHour(initial), loadProducts(initial), loadAdditions(initial)]);
    }).then(([s, h, p, a]) => { if (s) setStats(s); setHourData(h); setProducts(p); setAdditions(a); }).finally(() => setLoading(false));
  }, []);

  async function applyFilters(f: Filters) {
    setFilters(f);
    setFiltersOpen(false);
    setLoading(true);
    try {
      const [s, h, p, a] = await Promise.all([loadStats(f), loadByHour(f), loadProducts(f), loadAdditions(f)]);
      setStats(s); setHourData(h); setProducts(p); setAdditions(a);
    } finally { setLoading(false); }
  }

  async function clearFilters() {
    const f: Filters = { sessionId: null, dateFrom: "", dateTo: "" };
    setFilters(f);
    setLoading(true);
    try {
      const [s, h, p, a] = await Promise.all([loadStats(f), loadByHour(f), loadProducts(f), loadAdditions(f)]);
      setStats(s); setHourData(h); setProducts(p); setAdditions(a);
    } finally { setLoading(false); }
  }

  const activeSession = sessions.find((s) => s.id === filters.sessionId) ?? null;
  const usingDateRange = !filters.sessionId && !!filters.dateFrom;
  const hasFilters = !!filters.sessionId || !!filters.dateFrom;

  const filterLabels: string[] = [
    activeSession ? formatSessionLabel(activeSession) : null,
    filters.dateFrom ? `Desde: ${formatDay(filters.dateFrom)}` : null,
    filters.dateFrom
      ? (filters.dateTo ? `Hasta: ${formatDay(filters.dateTo)}` : `Hasta: hoy (${formatDay(todayIso())})`)
      : null,
  ].filter((l): l is string => Boolean(l));

  if (loading && !sessions.length) return <Flex h="full" align="center" justify="center"><Spinner /></Flex>;

  return (
    <Box w="full" maxW="1280px" mx="auto">
      <Flex gap="3" wrap="wrap" mb="4" align="center">
        <Button variant="outline" onClick={() => setFiltersOpen(true)}>
          <Filter size={17} />Filtros
        </Button>
        <Button colorPalette="green" variant="outline" onClick={() => {}}>
          <Download size={17} />Exportar Excel
        </Button>
        {loading && <Spinner size="sm" />}
      </Flex>

      {hasFilters && (
        <Flex mb="5" px="3" py="2" bg="purple.50" borderWidth="1px" borderColor="purple.100" borderRadius="md"
          align="center" justify="space-between" gap="3" wrap="wrap">
          <Box>
            <Text color="purple.800" fontSize="sm">Filtros activos: {filterLabels.join(" · ")}</Text>
            {usingDateRange && !filters.dateTo && (
              <Text color="purple.500" fontSize="xs" mt="0.5">Sin fecha final: se usa la fecha actual como limite.</Text>
            )}
          </Box>
          <Button size="sm" variant="ghost" colorPalette="purple" onClick={() => void clearFilters()}>Limpiar filtros</Button>
        </Flex>
      )}

      {/* Cards col-4 */}
      <Grid templateColumns="repeat(3, 1fr)" gap="4" mb="4">
        <StatCard title="Ventas Totales" value={String(stats.totalCount)} sub="ventas" />
        <StatCard title="Ingreso Total" value={fmtMoney(stats.totalRevenue)} />
        <StatCard title="Venta Promedio" value={fmtMoney(stats.avgSale)} />
        <StatCard title="Efectivo" value={fmtMoney(stats.cashTotal)} sub={`${stats.cashCount} ${stats.cashCount === 1 ? "venta" : "ventas"}`} />
        <StatCard title="Tarjeta" value={fmtMoney(stats.cardTotal)} sub={`${stats.cardCount} ${stats.cardCount === 1 ? "venta" : "ventas"}`} />
        <StatCard
          title="Mesas"
          value={`${stats.tableCount} ${stats.tableCount === 1 ? "Mesa" : "Mesas"}`}
          sub={fmtMoney(stats.tableTotal)}
        />
      </Grid>

      {/* Card domicilios col-12 */}
      <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5">
        <Text fontWeight="bold" fontSize="sm" color="gray.500" mb="3" textTransform="uppercase" letterSpacing="wide">Domicilios</Text>
        {stats.deliveryCount === 0 ? (
          <Text color="gray.400" fontSize="sm">Sin domicilios en el periodo seleccionado.</Text>
        ) : (
          <Flex gap="6" wrap="wrap" align="center">
            <Box>
              <Text fontWeight="bold" fontSize="xl">{stats.deliveryCount} {stats.deliveryCount === 1 ? "Domicilio" : "Domicilios"}</Text>
              <Text fontSize="sm" color="gray.500">{fmtMoney(stats.deliveryTotal)}</Text>
            </Box>
            <Box w="1px" h="40px" bg="gray.200" />
            <Box>
              <Text fontSize="sm" color="gray.500">Efectivo</Text>
              <Text fontWeight="semibold">{stats.deliveryCashCount} ({fmtMoney(stats.deliveryCashTotal)})</Text>
            </Box>
            <Box>
              <Text fontSize="sm" color="gray.500">Tarjeta</Text>
              <Text fontWeight="semibold">{stats.deliveryCardCount} ({fmtMoney(stats.deliveryCardTotal)})</Text>
            </Box>
            <Box w="1px" h="40px" bg="gray.200" />
            <Box>
              <Text fontSize="sm" color="gray.500">Cobro Domicilio</Text>
              <Text fontWeight="semibold">{fmtMoney(stats.deliveryFeeTotal)}</Text>
            </Box>
          </Flex>
        )}
      </Box>

      {/* Grafica 7 dias - col 12 */}
      <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5" mt="4">
        <Text fontWeight="bold" fontSize="sm" color="gray.500" mb="4" textTransform="uppercase" letterSpacing="wide">
          Ventas ultimos 7 dias
        </Text>
        <RevenueChart data={chartData} />
      </Box>

      {/* Grafica por hora - col 12 */}
      <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5" mt="4">
        <Text fontWeight="bold" fontSize="sm" color="gray.500" mb="4" textTransform="uppercase" letterSpacing="wide">
          Ventas por hora del dia
        </Text>
        <HourChart data={hourData} />
      </Box>

      {/* Productos y Adiciones - col 6 cada uno */}
      <Grid templateColumns="repeat(2, 1fr)" gap="4" mt="4">
        <SoldTable
          title="Productos vendidos"
          empty="Sin productos en el periodo seleccionado."
        >
          {products.map((p) => <ProductTableRow key={p.name} row={p} />)}
        </SoldTable>

        <SoldTable
          title="Adiciones vendidas"
          empty="Sin adiciones en el periodo seleccionado."
        >
          {additions.map((a) => (
            <Table.Row key={a.name}>
              <Table.Cell><Text fontWeight="medium">{a.name}</Text></Table.Cell>
              <Table.Cell textAlign="right">{a.qty}</Table.Cell>
              <Table.Cell textAlign="right">{fmtMoney(a.subtotal)}</Table.Cell>
            </Table.Row>
          ))}
        </SoldTable>
      </Grid>

      {filtersOpen && (
        <FiltersModal
          sessions={sessions}
          initial={filters}
          onClose={() => setFiltersOpen(false)}
          onApply={(f) => void applyFilters(f)}
        />
      )}
    </Box>
  );
}

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5">
      <Text fontWeight="bold" fontSize="sm" color="gray.500" mb="2" textTransform="uppercase" letterSpacing="wide">{title}</Text>
      <Text fontWeight="bold" fontSize="2xl">{value}</Text>
      {sub && <Text fontSize="sm" color="gray.500" mt="0.5">{sub}</Text>}
    </Box>
  );
}

function RevenueChart({ data }: { data: DayPoint[] }) {
  const options: ApexCharts.ApexOptions = {
    chart: { type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
    plotOptions: { bar: { borderRadius: 6, columnWidth: "50%" } },
    colors: ["#7c3aed"],
    dataLabels: { enabled: false },
    xaxis: {
      categories: data.map((d) => d.label),
      labels: { style: { fontSize: "12px", colors: "#6b7280" } },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: {
      tickAmount: 5,
      labels: {
        style: { fontSize: "12px", colors: "#6b7280" },
        formatter: (v) => String(Math.round(v)),
      },
    },
    grid: { borderColor: "#f3f4f6", strokeDashArray: 4 },
    tooltip: {
      y: {
        title: { formatter: () => "Ingresos:" },
        formatter: (_v, { dataPointIndex }) => {
          const pt = data[dataPointIndex];
          return "$" + Math.round(pt?.revenue ?? 0).toLocaleString("es-CO");
        },
      },
    },
  };

  const series = [{ name: "Ventas", data: data.map((d) => d.count) }];

  if (!data.length) return <Flex h="200px" align="center" justify="center"><Text color="gray.400">Sin datos.</Text></Flex>;

  return <ReactApexChart type="bar" height={220} options={options} series={series} />;
}

function HourChart({ data }: { data: HourPoint[] }) {
  if (!data.length) {
    return (
      <Flex h="220px" align="center" justify="center">
        <Text color="gray.400" fontSize="sm">Sin ventas en el periodo seleccionado.</Text>
      </Flex>
    );
  }

  const options: ApexCharts.ApexOptions = {
    chart: { type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
    plotOptions: { bar: { borderRadius: 5, columnWidth: "55%" } },
    colors: ["#0ea5e9"],
    dataLabels: { enabled: false },
    xaxis: {
      categories: data.map((d) => d.label),
      labels: { style: { fontSize: "11px", colors: "#6b7280" } },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: {
      tickAmount: 4,
      labels: {
        style: { fontSize: "11px", colors: "#6b7280" },
        formatter: (v) => String(Math.round(v)),
      },
    },
    grid: { borderColor: "#f3f4f6", strokeDashArray: 4 },
    tooltip: {
      y: {
        title: { formatter: () => "Ingresos:" },
        formatter: (_v, { dataPointIndex }) => {
          const pt = data[dataPointIndex];
          return "$" + Math.round(pt?.revenue ?? 0).toLocaleString("es-CO");
        },
      },
    },
  };

  const series = [{ name: "Ventas", data: data.map((d) => d.count) }];

  return <ReactApexChart type="bar" height={220} options={options} series={series} />;
}

function SoldTable({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const hasRows = !!children && (Array.isArray(children) ? children.some(Boolean) : true);
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
      <Box px="5" py="4" borderBottomWidth="1px" borderColor="gray.100">
        <Text fontWeight="bold" fontSize="sm" color="gray.500" textTransform="uppercase" letterSpacing="wide">{title}</Text>
      </Box>
      {!hasRows ? (
        <Flex h="100px" align="center" justify="center">
          <Text color="gray.400" fontSize="sm">{empty}</Text>
        </Flex>
      ) : (
        <Box overflowX="auto" maxH="420px" overflowY="auto">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Nombre</Table.ColumnHeader>
                <Table.ColumnHeader w="90px" textAlign="right">Cantidad</Table.ColumnHeader>
                <Table.ColumnHeader w="130px" textAlign="right">Total</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>{children}</Table.Body>
          </Table.Root>
        </Box>
      )}
    </Box>
  );
}

function ProductTableRow({ row }: { row: ProductRow }) {
  const [open, setOpen] = useState(false);
  const hasOptions = row.options.length > 1 || (row.options.length === 1 && row.options[0].option !== null);

  return (
    <>
      <Table.Row
        cursor={hasOptions ? "pointer" : "default"}
        _hover={{ bg: hasOptions ? "gray.50" : undefined }}
        onClick={() => hasOptions && setOpen((v) => !v)}
      >
        <Table.Cell>
          <Flex align="center" gap="2">
            {hasOptions
              ? (open ? <ChevronDown size={14} color="#6b7280" /> : <ChevronRight size={14} color="#6b7280" />)
              : <Box w="14px" />}
            <Text fontWeight="medium">{row.name}</Text>
          </Flex>
        </Table.Cell>
        <Table.Cell textAlign="right">{row.qty}</Table.Cell>
        <Table.Cell textAlign="right">{fmtMoney(row.subtotal)}</Table.Cell>
      </Table.Row>
      {hasOptions && open && row.options.map((opt) => (
        <Table.Row key={opt.option ?? "__none__"} bg="gray.50">
          <Table.Cell pl="10" color="gray.600" fontSize="xs">{opt.option ?? "Sin opcion"}</Table.Cell>
          <Table.Cell textAlign="right" fontSize="xs" color="gray.600">{opt.qty}</Table.Cell>
          <Table.Cell textAlign="right" fontSize="xs" color="gray.600">{fmtMoney(opt.subtotal)}</Table.Cell>
        </Table.Row>
      ))}
    </>
  );
}

function FiltersModal({ sessions, initial, onClose, onApply }: {
  sessions: CashSession[];
  initial: Filters;
  onClose: () => void;
  onApply: (f: Filters) => void;
}) {
  const [mode, setMode] = useState<"session" | "dates">(initial.sessionId ? "session" : "dates");
  const [sessionId, setSessionId] = useState<string | null>(initial.sessionId);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [error, setError] = useState("");

  function switchToSession(id: string | null) {
    setMode("session"); setSessionId(id); setDateFrom(""); setDateTo(""); setError("");
  }

  function switchToDates(from: string, to: string) {
    setMode("dates"); setSessionId(null); setDateFrom(from); setDateTo(to); setError("");
  }

  function apply() {
    if (mode === "dates") {
      if (!dateFrom) { setError("Selecciona una fecha inicial."); return; }
      if (dateTo && dateTo < dateFrom) { setError("La fecha final no puede ser anterior a la inicial."); return; }
      onApply({ sessionId: null, dateFrom, dateTo });
    } else {
      onApply({ sessionId, dateFrom: "", dateTo: "" });
    }
  }

  const sessionOptions = sessions.map((s) => ({ value: s.id, label: formatSessionLabel(s) }));
  const usingDates = mode === "dates";

  return (
    <Flex position="fixed" zIndex="modal" inset="0" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="500px" bg="white" borderRadius="md" boxShadow="2xl" p="7">
        <Text fontWeight="bold" fontSize="lg" mb="1">Filtros</Text>
        <Text fontSize="sm" color="gray.500" mb="5">Selecciona filtro por caja o por rango de fechas. Solo uno aplica a la vez.</Text>

        <Box mb="4" p="4" borderWidth="1px" borderRadius="md"
          borderColor={!usingDates ? "purple.300" : "gray.200"}
          bg={!usingDates ? "purple.50" : "white"}>
          <Text mb="2" fontSize="sm" fontWeight="semibold" color={!usingDates ? "purple.700" : "gray.700"}>Por caja</Text>
          <ScrollableSelect
            value={sessionId ?? ""}
            placeholder="Selecciona una caja"
            options={sessionOptions}
            onValueChange={(v) => switchToSession(v || null)}
          />
        </Box>

        <Box mb="5" p="4" borderWidth="1px" borderRadius="md"
          borderColor={usingDates ? "purple.300" : "gray.200"}
          bg={usingDates ? "purple.50" : "white"}>
          <Text mb="3" fontSize="sm" fontWeight="semibold" color={usingDates ? "purple.700" : "gray.700"}>Por rango de fechas</Text>
          <Box mb="3">
            <Text mb="1" fontSize="xs" color="gray.500">Desde *</Text>
            <input type="date" value={dateFrom}
              onChange={(e) => switchToDates(e.target.value, dateTo)}
              style={{ width: "100%", padding: "7px 12px", border: `1px solid ${usingDates ? "#c4b5fd" : "#e2e8f0"}`, borderRadius: "6px", fontSize: "14px", background: "transparent" }}
            />
          </Box>
          <Box>
            <Text mb="1" fontSize="xs" color="gray.500">Hasta (opcional)</Text>
            <input type="date" value={dateTo}
              onChange={(e) => switchToDates(dateFrom, e.target.value)}
              style={{ width: "100%", padding: "7px 12px", border: `1px solid ${usingDates ? "#c4b5fd" : "#e2e8f0"}`, borderRadius: "6px", fontSize: "14px", background: "transparent" }}
            />
            {usingDates && !dateTo && (
              <Text mt="1" fontSize="xs" color="purple.500">
                Si no se selecciona, se usa la fecha de hoy como limite ({formatDay(todayIso())}).
              </Text>
            )}
          </Box>
        </Box>

        {error && <Text mb="3" color="red.600" fontSize="sm">{error}</Text>}

        <Flex justify="end" gap="3">
          <Button variant="outline" onClick={onClose}><X size={16} />Cancelar</Button>
          <Button colorPalette="purple" onClick={apply}><Check size={16} />Aplicar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}
