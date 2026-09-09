import { Box, Button, Flex, Grid, Heading, Spinner, Text } from "@chakra-ui/react";
import { AlertTriangle, Package, Pencil, ShoppingCart, Table2, TrendingUp, WalletCards, X, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { sessionContext } from "../../core/session/SessionContext";
import { cashRegisterService, type CashSession } from "../cashregister/CashRegisterService";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { quickLinksRepository } from "../../infrastructure/sqlite/repositories";
import { MENU_ITEMS } from "../main/menuConfig";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
type HomeData = {
  cash: CashSession | null;
  todaySales: number;
  todayTotal: number;
  activeProducts: number;
  lowStockCount: number;
  activeTables: number;
  openOrders: number;
};

// ---------------------------------------------------------------------------
// Data loader
// ---------------------------------------------------------------------------
async function loadHomeData(tenantId: string, cashSessionId: string | null, isAdmin: boolean): Promise<HomeData> {
  const database = await databaseManager.database();
  const cash = await cashRegisterService.getOpenSession();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  const [productsRow, lowStockRow, tablesRow, ordersRow] = await Promise.all([
    database.select<{ count: number }[]>("SELECT COUNT(*) AS count FROM products WHERE tenant_id=$1 AND active=1", [tenantId]),
    database.select<{ count: number }[]>(
      "SELECT COUNT(*) AS count FROM supplies WHERE tenant_id=$1 AND stock IS NOT NULL AND low_stock_threshold IS NOT NULL AND stock <= low_stock_threshold",
      [tenantId],
    ),
    database.select<{ count: number }[]>("SELECT COUNT(*) AS count FROM restaurant_tables WHERE tenant_id=$1 AND active=1 AND type='TABLE'", [tenantId]),
    database.select<{ count: number }[]>("SELECT COUNT(*) AS count FROM table_orders WHERE tenant_id=$1 AND status='OPEN'", [tenantId]),
  ]);

  let todaySales = 0;
  let todayTotal = 0;
  if (isAdmin && cash) {
    const salesRow = await database.select<{ count: number; total: number }[]>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sales WHERE cash_session_id=$1 AND created_at >= $2",
      [cash.id, todayIso],
    );
    todaySales = Number(salesRow[0]?.count ?? 0);
    todayTotal = Number(salesRow[0]?.total ?? 0);
  }

  return {
    cash,
    todaySales,
    todayTotal,
    activeProducts: Number(productsRow[0]?.count ?? 0),
    lowStockCount: Number(lowStockRow[0]?.count ?? 0),
    activeTables: Number(tablesRow[0]?.count ?? 0),
    openOrders: Number(ordersRow[0]?.count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// HomeView
// ---------------------------------------------------------------------------
export function HomeView({ onNavigate }: { onNavigate: (view: string) => void }) {
  const session = sessionContext.current();
  const isAdmin = session?.user.role === "ADMIN" || session?.user.role === "SUPERADMIN";
  const isSuperAdminOrDev = session?.user.role === "SUPERADMIN" || import.meta.env.DEV;
  const userId = session?.user.id ?? "";

  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [extraLinks, setExtraLinks] = useState<string[]>([]);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (!session) return;
    void Promise.all([
      loadHomeData(session.tenantId, null, isAdmin),
      quickLinksRepository.load(userId),
    ]).then(([homeData, links]) => {
      setData(homeData);
      setExtraLinks(links);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const userName = session?.user.display_name || session?.user.username || "";

  // Opciones configurables: excluye las hardcodeadas como acceso directo y filtra por rol
  const availableOptions = MENU_ITEMS.filter((item) => {
    if (item.homeOnly) return false;
    if (item.id === "home") return false;
    if (item.superAdminOrDev) return isSuperAdminOrDev;
    if (item.adminOnly) return isAdmin;
    return true;
  });

  async function saveLinks(ids: string[]) {
    await quickLinksRepository.save(userId, ids);
    setExtraLinks(ids);
    setEditOpen(false);
  }

  return (
    <Box w="full" maxW="960px" mx="auto">
      <Heading size="lg" mb="1">Bienvenido, {userName}</Heading>
      <Text color="gray.500" mb="8">Resumen del estado actual del sistema.</Text>

      {loading ? (
        <Flex justify="center" py="16"><Spinner color="#6366f1" /></Flex>
      ) : (
        <>
          {/* Stats */}
          <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)", lg: "repeat(3, 1fr)" }} gap="4" mb="8">
            <StatCard
              icon={<WalletCards size={16} />}
              color={data?.cash ? "green" : "orange"}
              title="Caja"
              value={data?.cash ? `Caja #${data.cash.sessionNumber}` : "Cerrada"}
              subtitle={data?.cash ? `Abierta por ${data.cash.userName ?? ""}` : "No hay caja abierta"}
              action="Ir a Caja"
              onAction={() => onNavigate("cash")}
            />
            {isAdmin && data?.cash ? (
              <StatCard
                icon={<TrendingUp size={16} />}
                color="purple"
                title="Ventas hoy"
                value={`${data.todaySales} ventas`}
                subtitle={money(data.todayTotal)}
                action="Ver Historial"
                onAction={() => onNavigate("history")}
              />
            ) : null}
            <StatCard
              icon={<Package size={16} />}
              color="blue"
              title="Productos"
              value={`${data?.activeProducts ?? 0} activos`}
              subtitle="Productos disponibles para venta"
              action="Ver Productos"
              onAction={() => onNavigate("products")}
            />
            <StatCard
              icon={<Table2 size={16} />}
              color="teal"
              title="Mesas"
              value={`${data?.activeTables ?? 0} mesas`}
              subtitle={data?.openOrders ? `${data.openOrders} con orden abierta` : "Sin ordenes activas"}
              action="Ver Mesas"
              onAction={() => onNavigate("tables")}
            />
            <StatCard
              icon={<AlertTriangle size={16} />}
              color={data?.lowStockCount ? "red" : "green"}
              title="Stock bajo"
              value={data?.lowStockCount ? `${data.lowStockCount} insumos` : "Todo en orden"}
              subtitle={data?.lowStockCount ? "Requieren reabastecimiento" : "Sin alertas de inventario"}
              action="Ver Inventario"
              onAction={() => onNavigate("inventory")}
            />
          </Grid>

          {/* Accesos rapidos */}
          <Flex align="center" justify="space-between" mb="3">
            <Text fontWeight="semibold" color="gray.600" fontSize="sm">ACCESOS RAPIDOS</Text>
            <Button size="xs" variant="ghost" colorPalette="gray" onClick={() => setEditOpen(true)}>
              <Pencil size={13} />Editar
            </Button>
          </Flex>
          <Flex gap="3" flexWrap="wrap">
            {/* Hardcodeados */}
            <QuickButton icon={<ShoppingCart size={16} />} label="Punto de Venta" onClick={() => onNavigate("pos")} colorPalette="purple" />
            <QuickButton icon={<WalletCards size={16} />} label="Caja" onClick={() => onNavigate("cash")} colorPalette="green" />
            <QuickButton icon={<Package size={16} />} label="Productos" onClick={() => onNavigate("products")} colorPalette="blue" />
            <QuickButton icon={<Table2 size={16} />} label="Mesas" onClick={() => onNavigate("tables")} colorPalette="teal" />
            <QuickButton icon={<AlertTriangle size={16} />} label="Inventario" onClick={() => onNavigate("inventory")} colorPalette="orange" />
            {/* Extras configurados por el usuario */}
            {extraLinks.map((id) => {
              const opt = availableOptions.find((o) => o.id === id);
              if (!opt) return null;
              const Icon = opt.icon;
              return <QuickButton key={id} icon={<Icon size={16} />} label={opt.label} onClick={() => onNavigate(id)} colorPalette="gray" />;
            })}
          </Flex>
        </>
      )}

      {editOpen ? (
        <EditLinksModal
          options={availableOptions}
          selected={extraLinks}
          onClose={() => setEditOpen(false)}
          onSave={(ids) => void saveLinks(ids)}
        />
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// EditLinksModal
// ---------------------------------------------------------------------------
function EditLinksModal({ options, selected, onClose, onSave }: {
  options: QuickLinkOption[];
  selected: string[];
  onClose: () => void;
  onSave: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(selected);

  function toggle(id: string) {
    setDraft((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="420px" bg="white" borderRadius="md" boxShadow="2xl" p="6">
        <Flex justify="space-between" align="center" mb="1">
          <Heading size="md">Accesos directos</Heading>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>
        <Text color="gray.500" fontSize="sm" mb="5">Selecciona los accesos extra que quieres ver en el inicio.</Text>
        <Flex direction="column" gap="2" mb="6">
          {options.map((opt) => {
            const active = draft.includes(opt.id);
            return (
              <Flex
                key={opt.id}
                align="center"
                justify="space-between"
                px="3" py="2"
                borderWidth="1px"
                borderColor={active ? "purple.300" : "gray.200"}
                bg={active ? "purple.50" : "white"}
                borderRadius="md"
                cursor="pointer"
                onClick={() => toggle(opt.id)}
              >
                <Text fontSize="sm" fontWeight={active ? "semibold" : "normal"}>{opt.label}</Text>
                {active ? <Check size={16} color="#7c3aed" /> : null}
              </Flex>
            );
          })}
        </Flex>
        <Flex justify="end" gap="3">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button colorPalette="purple" onClick={() => onSave(draft)}><Check size={16} />Guardar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StatCard({ icon, color, title, value, subtitle, action, onAction }: {
  icon: React.ReactNode; color: string; title: string; value: string; subtitle: string; action: string; onAction: () => void;
}) {
  const colors: Record<string, { bg: string; iconBg: string; iconColor: string }> = {
    green:  { bg: "green.50",  iconBg: "green.100",  iconColor: "#16a34a" },
    orange: { bg: "orange.50", iconBg: "orange.100", iconColor: "#ea580c" },
    purple: { bg: "purple.50", iconBg: "purple.100", iconColor: "#7c3aed" },
    blue:   { bg: "blue.50",   iconBg: "blue.100",   iconColor: "#2563eb" },
    red:    { bg: "red.50",    iconBg: "red.100",    iconColor: "#dc2626" },
    teal:   { bg: "teal.50",  iconBg: "teal.100",   iconColor: "#0f766e" },
  };
  const c = colors[color] ?? colors.blue;
  return (
    <Box bg={c.bg} borderRadius="md" p="4" borderWidth="1px" borderColor="gray.200">
      <Flex align="center" justify="space-between" mb="2">
        <Flex align="center" gap="2">
          <Flex w="28px" h="28px" align="center" justify="center" borderRadius="md" bg={c.iconBg} color={c.iconColor}>{icon}</Flex>
          <Text fontWeight="semibold" color="gray.500" fontSize="xs">{title}</Text>
        </Flex>
        <Button size="xs" variant="ghost" colorPalette="gray" onClick={onAction}>{action}</Button>
      </Flex>
      <Text fontWeight="bold" fontSize="lg" lineHeight="1.2">{value}</Text>
      <Text color="gray.400" fontSize="xs" mt="0.5">{subtitle}</Text>
    </Box>
  );
}

function QuickButton({ icon, label, onClick, colorPalette }: { icon: React.ReactNode; label: string; onClick: () => void; colorPalette: string }) {
  return <Button variant="outline" colorPalette={colorPalette} size="sm" onClick={onClick}>{icon}{label}</Button>;
}

function money(value: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}
