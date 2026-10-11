import { Badge, Box, Button, Flex, Heading, Input, Separator, Spinner, Stack, Text } from "@chakra-ui/react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Check, ChevronLeft, ChevronRight, Flame, LayoutGrid, LayoutTemplate, LockKeyhole, MessageSquare, Minus, MoreHorizontal, Pencil, Plus, Printer, Settings2, Trash2, X } from "lucide-react";
import { AdditionsModal, OptionModal, ProductCatalogPanel, SaucesModal, type CatalogConfirmResult } from "../pos/ProductCatalog";
import { posService, type PosAddition, type PosSauce } from "../pos/PosService";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionContext } from "../../core/session/SessionContext";
import { notify } from "../../components/ui/AppToaster";
import { tablesService, type RestaurantTable } from "./TablesService";
import { tableOrderService, type TableOrder, type TableOrderClient, type TableOrderItem } from "./TableOrderService";
import { businessConfigService, printerService, type DeliveryType } from "../config/BusinessConfigService";
import { auditService } from "../audit/AuditService";
import { Tip } from "../../components/ui/Tip";
import { cashRegisterService, type CashSession } from "../cashregister/CashRegisterService";
import { comandaService, setDevComandaPreviewCallback } from "./ComandaService";

function formatClock(date: Date): string {
  const day = date.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${day} - ${time}`;
}

export function TablesHeaderBar({ userName }: { userName: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Flex w="full" align="center" justify="space-between" gap="5">
      <Heading size="lg">Mesas</Heading>
      <Text flex="1" textAlign="center" color="gray.600" fontSize="sm">{formatClock(now)}</Text>
      <Text textAlign="right" fontWeight="medium">{userName}</Text>
    </Flex>
  );
}

type TableStatus = "free" | "occupied" | "sent" | "overdue";
type ContextMenu = { x: number; y: number; openUp: boolean; table: RestaurantTable };
type NameModal = { mode: "create" | "edit" | "clone"; table: RestaurantTable | null; name: string };
type ConfirmModal = { title: string; message: string; onConfirm: () => void };
type TableCanvasInfo = { clientNames: string[]; total: number };

const STATUS_COLORS: Record<TableStatus, string> = {
  free: "#4ade80",
  occupied: "#fde047",
  sent: "#fb923c",
  overdue: "#f87171",
};

const STATUS_LABELS: Record<TableStatus, string> = {
  free: "Libre",
  occupied: "Ocupada",
  sent: "Comanda enviada",
  overdue: "+45 min",
};

const MIN_SIZE_WALL = 20;
const DEFAULT_TABLE_W = 100;
const DEFAULT_TABLE_H = 100;
const DEFAULT_WALL_W = 200;
const DEFAULT_WALL_H = 30;

const OVERDUE_MS = 45 * 60 * 1000;

function getTableStatus(order: TableOrder | undefined): TableStatus {
  if (!order) return "free";
  if (order.comanda_sent) return "sent";
  if (Date.now() - new Date(order.opened_at).getTime() > OVERDUE_MS) return "overdue";
  return "occupied";
}

function MergeTableModal({ srcTable, srcOrder, cash, tenantId, session, allTables, openOrders, onClose, onMerged }: {
  srcTable: RestaurantTable;
  srcOrder: TableOrder | null;
  cash: CashSession | null;
  tenantId: string;
  session: { user: { id: string } } | null;
  allTables: RestaurantTable[];
  openOrders: Map<string, TableOrder>;
  onClose: () => void;
  onMerged: (srcTableId: string, srcOrderUpdated: TableOrder, destOrder: TableOrder, destCanvasInfo: TableCanvasInfo) => void;
}) {
  const [clients, setClients] = useState<TableOrderClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!srcOrder) { setLoading(false); return; }
    setLoading(true);
    tableOrderService.getClients(srcOrder.id)
      .then((c) => {
        setClients(c);
        if (c.length > 1) setError("No se puede unir una mesa con multiples clientes. Transfiere clientes individualmente o cobra primero.");
      })
      .catch(() => setError("No fue posible cargar los datos de la mesa."))
      .finally(() => setLoading(false));
  }, [srcOrder?.id]);

  async function handleMerge(destTable: RestaurantTable) {
    if (!srcOrder || !session) return;
    const destOrder = openOrders.get(destTable.id);
    if (!destOrder) return;
    setSaving(true);
    try {
      // Limpiar clientes vacios del destino
      await tableOrderService.deleteEmptyClients(destOrder.id);

      // Calcular siguiente numero de cliente en destino
      const destClientsNow = await tableOrderService.getClients(destOrder.id);
      const nextClientNumber = (Math.max(0, ...destClientsNow.map((c) => c.client_number)) + 1);

      const srcClient = clients[0] ?? null;
      if (srcClient) {
        await tableOrderService.moveClientToOrder(srcClient.id, destOrder.id, nextClientNumber);
      } else {
        // Path legacy: sin cliente activo, mover items directamente
        const items = await tableOrderService.getItemsForOrder(srcOrder.id);
        const rootIds = items.filter((i) => !i.combo_table_order_item_id).map((i) => i.id);
        if (rootIds.length && destClientsNow[0]) {
          await tableOrderService.moveItems(rootIds, destOrder.id, destClientsNow[0].id);
        }
      }

      // Marcar orden origen como MERGED
      const mergedNotes = `MERGED:${destOrder.id}:${destTable.name}`;
      await tableOrderService.setNotes(srcOrder.id, mergedNotes);
      const srcOrderUpdated: TableOrder = { ...srcOrder, notes: mergedNotes };

      // Calcular canvasInfo destino fresco
      const [destClientsRefresh, destItemsRefresh, deliveryTypes] = await Promise.all([
        tableOrderService.getClients(destOrder.id),
        tableOrderService.getItemsForOrder(destOrder.id),
        businessConfigService.deliveryTypes().catch(() => [] as DeliveryType[]),
      ]);
      const destItemsTotal = destItemsRefresh.filter((i) => !i.combo_table_order_item_id).reduce((s, i) => s + i.subtotal, 0);
      const destDomTotal = destClientsRefresh.reduce((s, c) => s + (deliveryTypes.find((d) => d.id === c.delivery_type_id)?.price ?? 0), 0);
      const destCanvasInfo: TableCanvasInfo = {
        clientNames: resolveClientNames(destClientsRefresh, destTable.name),
        total: destItemsTotal + destDomTotal,
      };

      notify.success(`Mesa ${srcTable.name} unida a ${destTable.name}.`);
      onMerged(srcTable.id, srcOrderUpdated, destOrder, destCanvasInfo);
    } catch (err) {
      notify.error(`Error al unir mesas: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!srcOrder) {
    return (
      <ModalOverlay title="Unir mesa" onClose={onClose}>
        <Text color="gray.600">Esta mesa no tiene una orden activa.</Text>
        <Flex mt="6" justify="end"><Button colorPalette="purple" onClick={onClose}>Cerrar</Button></Flex>
      </ModalOverlay>
    );
  }

  if (!cash) {
    return (
      <ModalOverlay title="Sin caja abierta" onClose={onClose}>
        <Text color="gray.600">Debes tener una caja abierta para unir mesas.</Text>
        <Flex mt="6" justify="end"><Button colorPalette="purple" onClick={onClose}>Entendido</Button></Flex>
      </ModalOverlay>
    );
  }

  if (loading) {
    return (
      <ModalOverlay title="Unir mesa" onClose={onClose}>
        <Flex justify="center" py="8"><Spinner /></Flex>
      </ModalOverlay>
    );
  }

  if (error) {
    return (
      <ModalOverlay title="Unir mesa" onClose={onClose}>
        <Text color="red.600" fontSize="sm">{error}</Text>
        <Flex mt="6" justify="end"><Button colorPalette="purple" onClick={onClose}>Entendido</Button></Flex>
      </ModalOverlay>
    );
  }

  // Filtrar mesas elegibles: deben tener orden abierta, no ser la origen, y no estar en MERGED
  const eligibleTables = allTables.filter((t) => {
    if (t.id === srcTable.id || t.type !== "TABLE") return false;
    const o = openOrders.get(t.id);
    if (!o) return false;
    if (o.notes?.startsWith("MERGED:")) return false;
    return true;
  });

  const allDestTables = allTables.filter((t) => t.id !== srcTable.id && t.type === "TABLE");

  const byFloor = new Map<number, RestaurantTable[]>();
  for (const t of allDestTables) {
    if (!byFloor.has(t.floor)) byFloor.set(t.floor, []);
    byFloor.get(t.floor)!.push(t);
  }

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
      <Box w="full" maxW="520px" bg="white" borderRadius="md" p="6" boxShadow="2xl" maxH="90vh" display="flex" flexDirection="column">
        <Flex justify="space-between" align="center" mb="2">
          <Heading size="md">Unir mesa — {srcTable.name}</Heading>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button>
        </Flex>
        <Text fontSize="sm" color="gray.500" mb="4">
          Selecciona la mesa destino. Solo mesas con orden abierta pueden recibir la union.
        </Text>
        <Box flex="1" overflowY="auto" className="content-scroll">
          {Array.from(byFloor.entries()).sort(([a], [b]) => a - b).map(([floor, floorTables]) => (
            <Box key={floor} mb="4">
              {byFloor.size > 1 && (
                <Text fontSize="xs" fontWeight="bold" color="gray.400" mb="2" textTransform="uppercase">Piso {floor}</Text>
              )}
              <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(140px, 1fr))" gap="2">
                {floorTables.map((t) => {
                  const order = openOrders.get(t.id);
                  const eligible = eligibleTables.some((e) => e.id === t.id);
                  const status = getTableStatus(order);
                  const color = order ? STATUS_COLORS[status] : "#e5e7eb";
                  const label = order ? STATUS_LABELS[status] : "Sin orden";
                  const disabledReason = !order ? "Esta mesa no tiene una orden abierta" : order.notes?.startsWith("MERGED:") ? "Esta mesa ya esta unida a otra" : null;
                  const inner = (
                    <Box
                      key={t.id}
                      as={eligible ? "button" : "div"}
                      w="full"
                      borderWidth="2px"
                      borderColor="gray.200"
                      borderRadius="md"
                      p="3"
                      textAlign="left"
                      opacity={eligible ? 1 : 0.45}
                      cursor={eligible && !saving ? "pointer" : "not-allowed"}
                      _hover={eligible ? { borderColor: "purple.400", bg: "purple.50" } : undefined}
                      onClick={() => eligible && !saving && void handleMerge(t)}
                    >
                      <Text fontSize="sm" fontWeight="semibold" mb="1" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">{t.name}</Text>
                      <Flex align="center" gap="1">
                        <Box w="9px" h="9px" borderRadius="full" bg={color} flexShrink="0" />
                        <Text fontSize="xs" color="gray.500">{label}</Text>
                      </Flex>
                    </Box>
                  );
                  return (
                    <Box key={t.id}>
                      {disabledReason ? <Tip text={disabledReason}>{inner}</Tip> : inner}
                    </Box>
                  );
                })}
              </Box>
            </Box>
          ))}
        </Box>
        <Flex mt="4" justify="start">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

function resolveClientNames(clients: { client_name: string | null }[], fallback: string): string[] {
  const named = clients.map((c) => c.client_name?.trim() ?? "").filter(Boolean);
  return named.length > 0 ? named : [fallback];
}

function elapsedLabel(openedAt: string): string {
  const min = Math.floor((Date.now() - new Date(openedAt).getTime()) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  const remM = min % 60;
  return remH === 0 ? `${d}d ${remM}m` : remM === 0 ? `${d}d ${remH}h` : `${d}d ${remH}h ${remM}m`;
}

function TableShape({ table, status, order, info, selected, editMode }: {
  table: RestaurantTable;
  status: TableStatus;
  order: TableOrder | undefined;
  info: TableCanvasInfo | undefined;
  selected: boolean;
  editMode: boolean;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!order) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 60_000);
    return () => window.clearInterval(t);
  }, [order?.id]);

  const color = table.type === "WALL" ? "#d1d5db" : STATUS_COLORS[status];
  const isRound = table.shape === "ROUND";
  const isOccupied = status !== "free";
  const small = table.width < 90 || table.height < 90;
  const names = info?.clientNames ?? [];
  const total = info?.total ?? 0;
  const shownNames = names.slice(0, 3);
  const extra = names.length > 3 ? names.length - 3 : 0;

  return (
    <Box
      w="full"
      h="full"
      bg={color}
      borderRadius={isRound ? "50%" : "8px"}
      border={selected ? "3px solid #7c3aed" : "2px solid rgba(0,0,0,0.15)"}
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      userSelect="none"
      boxSizing="border-box"
      overflow="hidden"
      px="1"
      py="1"
      _hover={{ filter: "brightness(0.95)" }}
    >
      {table.type === "TABLE" && (!isOccupied || editMode) && (
        <Text fontSize={small ? "xs" : "sm"} fontWeight="bold" color="gray.800" textAlign="center" lineHeight="1.2">
          {table.name}
        </Text>
      )}
      {table.type === "TABLE" && isOccupied && !editMode && (
        <Flex direction="column" align="center" justify="center" gap="0" w="full" overflow="hidden">
          {names.length <= 1 ? (
            <Text fontSize={small ? "9px" : "xs"} fontWeight="bold" color="gray.800" textAlign="center" lineHeight="1.2" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" maxW="90%">
              {names[0] ?? table.name}
            </Text>
          ) : (
            <Flex direction="column" align="center" w="full">
              {shownNames.map((n, i) => (
                <Text key={i} fontSize="9px" fontWeight={i === 0 ? "bold" : "normal"} color="gray.800" textAlign="center" lineHeight="1.3" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" maxW="90%">
                  {n}
                </Text>
              ))}
              {extra > 0 && <Text fontSize="9px" color="gray.500" lineHeight="1.2">+{extra} mas</Text>}
            </Flex>
          )}
          <Text fontSize="9px" color="gray.700" lineHeight="1.3" mt="0.5">{order ? elapsedLabel(order.opened_at) : ""}</Text>
          <Text fontSize={small ? "9px" : "xs"} fontWeight="bold" color="gray.900" lineHeight="1.2">{fmtMoney(total)}</Text>
        </Flex>
      )}
    </Box>
  );
}


export function TablesView({ onNavigate }: { onNavigate: (view: string, param?: string) => void }) {
  const session = sessionContext.current();
  const tenantId = session?.tenantId ?? "";
  const isAdmin = session?.user.role === "ADMIN" || session?.user.role === "SUPERADMIN";

  const [viewMode, setViewMode] = useState<"free" | "grid">(() => (localStorage.getItem("tables-view-mode") as "free" | "grid") ?? "free");
  const [gridSize, setGridSize] = useState<number>(() => Math.min(220, Math.max(100, Number(localStorage.getItem("tables-grid-size") ?? 140))));

  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [floors, setFloors] = useState<number[]>([1]);
  const [currentFloor, setCurrentFloor] = useState(1);
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [nameModal, setNameModal] = useState<NameModal | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModal | null>(null);
  const [cloneFloorConfirm, setCloneFloorConfirm] = useState(false);
  const [panelTable, setPanelTable] = useState<RestaurantTable | null>(null);
  const [openOrders, setOpenOrders] = useState<Map<string, TableOrder>>(new Map());
  const [canvasInfo, setCanvasInfo] = useState<Map<string, TableCanvasInfo>>(new Map());
  const [cash, setCash] = useState<CashSession | null>(null);
  const [transferSrcTable, setTransferSrcTable] = useState<RestaurantTable | null>(null);
  const [mergeSrcTable, setMergeSrcTable] = useState<RestaurantTable | null>(null);
  const [panelReloadKey, setPanelReloadKey] = useState(0);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startMouseX: number; startMouseY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeRef = useRef<{ id: string; edge: "nw" | "ne" | "sw" | "se"; startMouseX: number; startMouseY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);

  const loadTables = useCallback(async () => {
    try {
      const [rows, floorList] = await Promise.all([
        tablesService.listByFloor(tenantId, currentFloor),
        tablesService.listFloors(tenantId),
      ]);
      setTables(rows);
      const base = floorList.length ? floorList : [];
      const merged = Array.from(new Set([1, ...base, currentFloor])).sort((a, b) => a - b);
      setFloors(merged);
      const tableIds = rows.filter((t) => t.type === "TABLE").map((t) => t.id);
      const orders = await tableOrderService.getOpenOrdersByTableIds(tableIds);
      setOpenOrders(new Map(orders.map((o) => [o.table_id, o])));
      const infoMap = new Map<string, TableCanvasInfo>();
      const deliveryTypes = await businessConfigService.deliveryTypes().catch(() => [] as DeliveryType[]);
      await Promise.all(orders.map(async (o) => {
        const [clients, items] = await Promise.all([
          tableOrderService.getClients(o.id),
          tableOrderService.getItemsForOrder(o.id),
        ]);
        const tableName = rows.find((t) => t.id === o.table_id)?.name ?? "";
        const names = resolveClientNames(clients, tableName);
        const itemsTotal = items.filter((i) => !i.combo_table_order_item_id).reduce((s, i) => s + i.subtotal, 0);
        const domTotal = clients.reduce((s, c) => s + (deliveryTypes.find((d) => d.id === c.delivery_type_id)?.price ?? 0), 0);
        infoMap.set(o.table_id, { clientNames: names, total: itemsTotal + domTotal });
      }));
      setCanvasInfo(infoMap);
    } catch {
      notify.error("No fue posible cargar las mesas.");
    }
  }, [tenantId, currentFloor]);

  useEffect(() => { void loadTables(); }, [loadTables]);

  useEffect(() => { void cashRegisterService.getOpenSession().then(setCash); }, []);

  // Close context menu on outside click (left button only — right click opens a new one)
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: PointerEvent) => {
      if (e.button === 2) return;
      const menu = document.getElementById("table-context-menu");
      if (menu && menu.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [contextMenu]);

  function handleCanvasClick(event: React.MouseEvent) {
    if ((event.target as HTMLElement) === canvasRef.current) {
      setSelected(null);
      setContextMenu(null);
      setPanelTable(null);
    }
  }

  function handleTablePointerDown(event: React.PointerEvent, table: RestaurantTable) {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelected(table.id);
    if (editMode) {
      event.preventDefault();
      dragRef.current = { id: table.id, startMouseX: event.clientX, startMouseY: event.clientY, startPosX: table.pos_x, startPosY: table.pos_y };
    }
  }

  function handleTablePointerUp(event: React.PointerEvent) {
    if (event.button !== 0) return;
    void handleDragResizeEnd();
  }

  function handleTablePointerMove(event: React.PointerEvent) {
    if (!editMode) return;
    if (dragRef.current) {
      const { id, startMouseX, startMouseY, startPosX, startPosY } = dragRef.current;
      const dx = event.clientX - startMouseX;
      const dy = event.clientY - startMouseY;
      setTables((prev) => prev.map((t) => t.id === id ? { ...t, pos_x: Math.max(0, startPosX + dx), pos_y: Math.max(0, startPosY + dy) } : t));
    }
    if (resizeRef.current) {
      const { id, edge, startMouseX, startMouseY, startW, startH, startPosX, startPosY } = resizeRef.current;
      const dx = event.clientX - startMouseX;
      const dy = event.clientY - startMouseY;
      setTables((prev) => prev.map((t) => {
        if (t.id !== id) return t;
        const minW = t.type === "TABLE" ? DEFAULT_TABLE_W : MIN_SIZE_WALL;
        const minH = t.type === "TABLE" ? DEFAULT_TABLE_H : MIN_SIZE_WALL;
        const newW = Math.max(minW, edge === "nw" || edge === "sw" ? startW - dx : startW + dx);
        const newH = Math.max(minH, edge === "nw" || edge === "ne" ? startH - dy : startH + dy);
        const newX = edge === "nw" || edge === "sw" ? startPosX + (startW - newW) : startPosX;
        const newY = edge === "nw" || edge === "ne" ? startPosY + (startH - newH) : startPosY;
        return { ...t, width: newW, height: newH, pos_x: newX, pos_y: newY };
      }));
    }
  }

  function handleResizePointerDown(event: React.PointerEvent, table: RestaurantTable, edge: "nw" | "ne" | "sw" | "se") {
    event.preventDefault();
    event.stopPropagation();
    setSelected(table.id);
    resizeRef.current = { id: table.id, edge, startMouseX: event.clientX, startMouseY: event.clientY, startW: table.width, startH: table.height, startPosX: table.pos_x, startPosY: table.pos_y };
  }

  async function handleDragResizeEnd() {
    if (dragRef.current) {
      const { id } = dragRef.current;
      const table = tables.find((t) => t.id === id);
      if (table) await tablesService.updatePosition(id, table.pos_x, table.pos_y).catch(() => notify.error("No fue posible guardar la posicion."));
      dragRef.current = null;
    }
    if (resizeRef.current) {
      const { id, edge } = resizeRef.current;
      const table = tables.find((t) => t.id === id);
      if (table) {
        await tablesService.updateSize(id, table.width, table.height).catch(() => notify.error("No fue posible guardar el tamaño."));
        if (edge !== "se") await tablesService.updatePosition(id, table.pos_x, table.pos_y).catch(() => {});
      }
      resizeRef.current = null;
    }
  }

  function handleTableClick(event: React.MouseEvent, table: RestaurantTable) {
    event.stopPropagation();
    if (editMode) { setSelected(table.id); return; }
    setSelected(table.id);
    setPanelTable(table);
  }

  function handleTableContextMenu(event: React.MouseEvent, table: RestaurantTable) {
    event.preventDefault();
    event.stopPropagation();
    setSelected(table.id);
    const menuHeight = editMode ? 130 : 90;
    const openUp = event.clientY + menuHeight > window.innerHeight;
    setContextMenu({ x: event.clientX, y: event.clientY, openUp, table });
  }

  function suggestCloneName(original: string): string {
    const match = /^(.*?)\s*\((\d+)\)$/.exec(original);
    const base = match ? match[1].trim() : original;
    const existingNames = new Set(tables.map((t) => t.name));
    let n = 2;
    while (existingNames.has(`${base} (${n})`)) n++;
    return `${base} (${n})`;
  }

  function openAddTable() {
    const suggested = `Mesa ${tables.filter((t) => t.type === "TABLE").length + 1}`;
    setNameModal({ mode: "create", table: null, name: suggested });
  }

  async function addWall() {
    try {
      const created = await tablesService.create(tenantId, {
        name: "Pared",
        shape: "SQUARE",
        width: DEFAULT_WALL_W,
        height: DEFAULT_WALL_H,
        pos_x: 50,
        pos_y: 50,
        type: "WALL",
        floor: currentFloor,
      });
      setTables((prev) => [...prev, created]);
    } catch {
      notify.error("No fue posible crear la pared.");
    }
  }

  function openEditModal(table: RestaurantTable) {
    setNameModal({ mode: "edit", table, name: table.name });
    setContextMenu(null);
  }

  function openCloneModal(table: RestaurantTable) {
    setNameModal({ mode: "clone", table, name: suggestCloneName(table.name) });
    setContextMenu(null);
  }

  async function saveNameModal() {
    if (!nameModal || !nameModal.name.trim()) return;
    const name = nameModal.name.trim();
    try {
      if (nameModal.mode === "create") {
        const isWall = (nameModal.table as RestaurantTable | null)?.type === "WALL";
        const created = await tablesService.create(tenantId, {
          name,
          shape: "SQUARE",
          width: isWall ? DEFAULT_WALL_W : DEFAULT_TABLE_W,
          height: isWall ? DEFAULT_WALL_H : DEFAULT_TABLE_H,
          pos_x: 50,
          pos_y: 50,
          type: isWall ? "WALL" : "TABLE",
          floor: currentFloor,
        });
        setTables((prev) => [...prev, created]);
      } else if (nameModal.mode === "edit" && nameModal.table) {
        const updated = { ...nameModal.table, name };
        await tablesService.update(updated);
        setTables((prev) => prev.map((t) => t.id === updated.id ? updated : t));
      } else if (nameModal.mode === "clone" && nameModal.table) {
        const cloned = await tablesService.clone(nameModal.table, { name, pos_x: nameModal.table.pos_x, pos_y: nameModal.table.pos_y });
        setTables((prev) => [...prev, cloned]);
      }
      setNameModal(null);
    } catch {
      notify.error("No fue posible guardar.");
    }
  }

  async function handleDeleteTable(table: RestaurantTable) {
    setContextMenu(null);
    if (table.type === "TABLE") {
      const openOrder = await tableOrderService.getOpenOrderByTable(table.id).catch(() => null);
      if (openOrder) {
        notify.error(`No se puede eliminar "${table.name}" porque tiene una orden abierta.`);
        return;
      }
    }
    setConfirmModal({
      title: `Eliminar mesa "${table.name}"`,
      message: `Esta accion no se puede deshacer.`,
      onConfirm: async () => {
        try {
          await tablesService.delete(table.id);
          setTables((prev) => prev.filter((t) => t.id !== table.id));
          setSelected(null);
          notify.success(`"${table.name}" eliminada.`);
        } catch {
          notify.error("No fue posible eliminar la mesa.");
        }
        setConfirmModal(null);
      },
    });
  }

  function addFloor() {
    const nextFloor = floors.length ? Math.max(...floors) + 1 : 2;
    setCurrentFloor(nextFloor);
    setTables([]);
  }

  async function cloneFloor() {
    const nextFloor = Math.max(...floors) + 1;
    try {
      await tablesService.cloneFloor(tenantId, currentFloor, nextFloor);
      setCurrentFloor(nextFloor);
      void loadTables();
      notify.success(`Piso ${currentFloor} clonado como Piso ${nextFloor}.`);
    } catch {
      notify.error("No fue posible clonar el piso.");
    }
    setCloneFloorConfirm(false);
  }

  function requestDeleteFloor() {
    if (currentFloor === 1) { notify.error("El Piso 1 no se puede eliminar."); return; }
    setConfirmModal({
      title: "Eliminar Piso",
      message: `Eliminar Piso ${currentFloor} y todas sus mesas y paredes?`,
      onConfirm: async () => {
        try {
          const deletedFloor = currentFloor;
          await tablesService.deleteFloor(tenantId, deletedFloor);
          setCurrentFloor(deletedFloor - 1);
          void loadTables();
          notify.success(`Piso ${deletedFloor} eliminado.`);
        } catch {
          notify.error("No fue posible eliminar el piso.");
        }
        setConfirmModal(null);
      },
    });
  }

  const GRID_MIN = 100;
  const GRID_MAX = 220;
  const GRID_STEP = 20;

  function changeViewMode(mode: "free" | "grid") {
    setViewMode(mode);
    localStorage.setItem("tables-view-mode", mode);
    if (mode === "grid") { setEditMode(false); setSelected(null); setContextMenu(null); }
  }

  function changeGridSize(delta: number) {
    setGridSize((prev) => {
      const next = Math.min(GRID_MAX, Math.max(GRID_MIN, prev + delta));
      localStorage.setItem("tables-grid-size", String(next));
      return next;
    });
  }

  const selectedTable = selected ? tables.find((t) => t.id === selected) : null;

  return (
    <Box h="full" display="flex" flexDirection="column" overflow="hidden">
      {/* Toolbar */}
      <Flex px="6" py="3" bg="white" borderBottomWidth="1px" borderColor="gray.200" align="center" gap="3" wrap="wrap" shrink="0">
        {/* Floor carousel */}
        <FloorCarousel floors={floors} currentFloor={currentFloor} onSelect={setCurrentFloor} />

        {editMode ? (
          <Flex gap="2" align="center" ml="4">
            <Button size="sm" variant="outline" onClick={addFloor}><Plus size={14} />Piso</Button>
            <Button size="sm" variant="outline" onClick={() => setCloneFloorConfirm(true)}>Clonar Piso</Button>
            <Button size="sm" variant="outline" onClick={openAddTable}><Plus size={14} />Mesa</Button>
            <Button size="sm" variant="outline" colorPalette="red" onClick={requestDeleteFloor}><Trash2 size={14} />Eliminar Piso</Button>
          </Flex>
        ) : (
          <Flex gap="3" align="center" ml="4">
            {(Object.entries(STATUS_COLORS) as [TableStatus, string][]).map(([status, color]) => (
              <Flex key={status} align="center" gap="1">
                <Box w="12px" h="12px" borderRadius="3px" bg={color} border="1px solid rgba(0,0,0,0.15)" flexShrink="0" />
                <Text fontSize="xs" color="gray.600">{STATUS_LABELS[status]}</Text>
              </Flex>
            ))}
          </Flex>
        )}

        <Box flex="1" />

        {/* Grid size controls — solo en modo cuadricula */}
        {viewMode === "grid" && (
          <Flex align="center" gap="1" borderWidth="1px" borderColor="gray.200" borderRadius="md" px="1" py="0.5">
            <Tip text="Reducir tamano de cuadros">
              <Button size="xs" variant="ghost" disabled={gridSize <= GRID_MIN} onClick={() => changeGridSize(-GRID_STEP)}><Minus size={13} /></Button>
            </Tip>
            <Text fontSize="xs" color="gray.500" minW="36px" textAlign="center">{gridSize}px</Text>
            <Tip text="Aumentar tamano de cuadros">
              <Button size="xs" variant="ghost" disabled={gridSize >= GRID_MAX} onClick={() => changeGridSize(GRID_STEP)}><Plus size={13} /></Button>
            </Tip>
          </Flex>
        )}

        {/* Toggle de vista */}
        <Flex borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
          <Tip text="Vista libre">
            <Button size="sm" variant="ghost" borderRadius="0" bg={viewMode === "free" ? "gray.100" : undefined} onClick={() => changeViewMode("free")}>
              <LayoutTemplate size={15} />
            </Button>
          </Tip>
          <Tip text="Vista cuadricula">
            <Button size="sm" variant="ghost" borderRadius="0" bg={viewMode === "grid" ? "gray.100" : undefined} onClick={() => changeViewMode("grid")}>
              <LayoutGrid size={15} />
            </Button>
          </Tip>
        </Flex>

        {isAdmin && viewMode === "free" && (
          <Button size="sm" variant={editMode ? "solid" : "outline"} colorPalette={editMode ? "purple" : "gray"}
            onClick={() => { setEditMode((v) => !v); setSelected(null); setContextMenu(null); setPanelTable(null); }}>
            <Pencil size={14} />{editMode ? "Salir de edicion" : "Editar Negocio"}
          </Button>
        )}
      </Flex>

      {/* Grid view */}
      {viewMode === "grid" && (
        <Box flex="1" overflow="auto" bg="gray.100" p="5">
          {tables.filter((t) => t.type === "TABLE").length === 0 ? (
            <Flex h="full" align="center" justify="center">
              <Text color="gray.400" fontSize="lg">No hay mesas en este piso.</Text>
            </Flex>
          ) : (
            <Box display="grid" gridTemplateColumns={`repeat(auto-fill, ${gridSize}px)`} gap="3" justifyContent="start">
              {tables.filter((t) => t.type === "TABLE").sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" })).map((table) => {
                const tableStatus = getTableStatus(openOrders.get(table.id));
                const info = canvasInfo.get(table.id);
                const order = openOrders.get(table.id);
                const isSelected = selected === table.id;
                return (
                  <Box
                    key={table.id}
                    w={`${gridSize}px`}
                    h={`${gridSize}px`}
                    bg={STATUS_COLORS[tableStatus]}
                    borderRadius="10px"
                    border={isSelected ? "3px solid #7c3aed" : "2px solid rgba(0,0,0,0.15)"}
                    cursor="pointer"
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                    justifyContent="center"
                    px="2"
                    gap="1"
                    userSelect="none"
                    _hover={{ filter: "brightness(0.95)" }}
                    onClick={() => { setSelected(table.id); setPanelTable(table); }}
                    onContextMenu={(e) => handleTableContextMenu(e, table)}
                  >
                    <Text fontSize="sm" fontWeight="bold" color="gray.800" textAlign="center" lineHeight="1.2" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" maxW="90%">
                      {table.name}
                    </Text>
                    {tableStatus !== "free" && info && (
                      <>
                        {info.clientNames.slice(0, 2).map((n, i) => (
                          <Text key={i} fontSize="xs" color="gray.700" textAlign="center" lineHeight="1.2" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" maxW="90%">{n}</Text>
                        ))}
                        {info.clientNames.length > 2 && <Text fontSize="xs" color="gray.600">+{info.clientNames.length - 2} mas</Text>}
                        {order && <Text fontSize="xs" color="gray.700" lineHeight="1.2">{elapsedLabel(order.opened_at)}</Text>}
                        <Text fontSize="sm" fontWeight="bold" color="gray.900">{fmtMoney(info.total)}</Text>
                      </>
                    )}
                    {tableStatus === "free" && <Text fontSize="xs" color="gray.600">Libre</Text>}
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      )}

      {/* Canvas area */}
      {viewMode === "free" && <Box
        flex="1"
        overflow="auto"
        bg="gray.100"
        position="relative"
        onPointerMove={handleTablePointerMove}
        onPointerUp={(e) => handleTablePointerUp(e)}
        onPointerLeave={() => { void handleDragResizeEnd(); }}
      >
        <Box
          ref={canvasRef}
          position="relative"
          w="2000px"
          h="1400px"
          onClick={handleCanvasClick}
        >
          {tables.map((table) => {
            const isSelected = selected === table.id;
            const tableStatus = getTableStatus(openOrders.get(table.id));
            // In edit mode the wrapper always has 6px padding so handles sit exactly
            // on the corners: nw=(pos_x, pos_y), ne=(pos_x+w, pos_y), etc.
            const P = editMode ? 6 : 0;
            return (
              <Box
                key={table.id}
                position="absolute"
                left={`${table.pos_x - P}px`}
                top={`${table.pos_y - P}px`}
                w={`${table.width + P * 2}px`}
                h={`${table.height + P * 2}px`}
              >
                {/* Table shape fills the inner area (inset by P) */}
                <Box
                  position="absolute"
                  top={`${P}px`}
                  left={`${P}px`}
                  w={`${table.width}px`}
                  h={`${table.height}px`}
                  borderRadius={table.shape === "ROUND" ? "50%" : "8px"}
                  cursor={editMode ? "grab" : "pointer"}
                  onPointerDown={(e) => handleTablePointerDown(e, table)}
                  onClick={(e) => handleTableClick(e, table)}
                  onContextMenu={(e) => handleTableContextMenu(e, table)}
                >
                  <TableShape table={table} status={tableStatus} order={openOrders.get(table.id)} info={canvasInfo.get(table.id)} selected={isSelected} editMode={editMode} />
                </Box>

                {/* Corner handles at exact corners: nw=(0,0), ne=(w+2P,0), sw=(0,h+2P), se=(w+2P,h+2P) */}
                {editMode && isSelected && (["nw", "ne", "sw", "se"] as const).map((edge) => (
                  <Box
                    key={edge}
                    position="absolute"
                    top={edge === "nw" || edge === "ne" ? "-1px" : undefined}
                    bottom={edge === "sw" || edge === "se" ? "-1px" : undefined}
                    left={edge === "nw" || edge === "sw" ? "-1px" : undefined}
                    right={edge === "ne" || edge === "se" ? "-1px" : undefined}
                    w="12px"
                    h="12px"
                    bg="white"
                    border="2px solid #7c3aed"
                    borderRadius="2px"
                    cursor={`${edge}-resize`}
                    zIndex="1"
                    onPointerDown={(e) => handleResizePointerDown(e, table, edge)}
                  />
                ))}
              </Box>
            );
          })}
        </Box>

        {tables.length === 0 && (
          <Flex position="absolute" inset="0" align="center" justify="center" pointerEvents="none">
            <Text color="gray.400" fontSize="lg">
              {editMode ? 'Usa "+ Mesa" o "+ Pared" para agregar elementos' : "No hay mesas en este piso."}
            </Text>
          </Flex>
        )}
      </Box>}

      {/* Table detail panel */}
      {panelTable && !editMode && (
        <TablePanel
          table={panelTable}
          onClose={() => { setPanelTable(null); setSelected(null); }}
          onTableOpened={(order) => { setOpenOrders((prev) => new Map(prev).set(order.table_id, order)); }}
          onTableClosed={(tableId) => {
            const mergedToDelete: string[] = [];
            setOpenOrders((prev) => {
              const closedOrderId = prev.get(tableId)?.id;
              const next = new Map(prev);
              next.delete(tableId);
              if (closedOrderId) {
                const prefix = `MERGED:${closedOrderId}:`;
                for (const [tid, o] of next) {
                  if (o.notes?.startsWith(prefix)) {
                    void tableOrderService.deleteOrder(o.id).catch(() => {});
                    next.delete(tid);
                    mergedToDelete.push(tid);
                  }
                }
              }
              return next;
            });
            setCanvasInfo((prev) => {
              const next = new Map(prev);
              next.delete(tableId);
              for (const tid of mergedToDelete) next.delete(tid);
              return next;
            });
          }}
          onComandaSent={(tableId) => {
            setOpenOrders((prev) => {
              const order = prev.get(tableId);
              if (!order) return prev;
              return new Map(prev).set(tableId, { ...order, comanda_sent: 1 });
            });
          }}
          onCanvasInfoChange={(tableId, info) => setCanvasInfo((prev) => new Map(prev).set(tableId, info))}
          onNavigate={onNavigate}
          reloadKey={panelReloadKey}
          onGoToTable={(tableId) => {
            const t = tables.find((t) => t.id === tableId);
            if (t) { setPanelTable(t); setSelected(tableId); }
          }}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <Box
          id="table-context-menu"
          position="fixed"
          left={`${contextMenu.x}px`}
          top={contextMenu.openUp ? undefined : `${contextMenu.y}px`}
          bottom={contextMenu.openUp ? `${window.innerHeight - contextMenu.y}px` : undefined}
          zIndex="popover"
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="md"
          boxShadow="lg"
          py="1"
          minW="160px"
          onClick={(e) => e.stopPropagation()}
        >
          {editMode ? (
            <>
              <ContextMenuItem label="Editar" onClick={() => openEditModal(contextMenu.table)} />
              <ContextMenuItem label="Clonar" onClick={() => openCloneModal(contextMenu.table)} />
              <ContextMenuItem label="Eliminar" danger onClick={() => void handleDeleteTable(contextMenu.table)} />
            </>
          ) : (
            <>
              <ContextMenuItem label="Transferir mesa" onClick={() => { setTransferSrcTable(contextMenu.table); setContextMenu(null); }} />
              <ContextMenuItem label="Unir mesa" onClick={() => { setMergeSrcTable(contextMenu.table); setContextMenu(null); }} />
            </>
          )}
        </Box>
      )}

      {/* Name modal (create / edit / clone) */}
      {nameModal && (
        <ModalOverlay
          title={nameModal.mode === "create" ? "Nueva mesa" : nameModal.mode === "edit" ? "Editar mesa" : "Clonar mesa"}
          onClose={() => setNameModal(null)}
        >
          <Stack gap="4">
            <FieldBox label="Nombre">
              <Input
                autoFocus
                value={nameModal.name}
                onChange={(e) => setNameModal((m) => m ? { ...m, name: e.target.value } : m)}
                onKeyDown={(e) => { if (e.key === "Enter") void saveNameModal(); }}
              />
            </FieldBox>
            {nameModal.mode === "create" && viewMode === "free" && (
              <Text fontSize="xs" color="gray.500">
                Arrastra la mesa en el editor para moverla. Usa las esquinas para cambiar el tamaño.
              </Text>
            )}
            <Flex justify="end" gap="3">
              <Button variant="outline" onClick={() => setNameModal(null)}>Cancelar</Button>
              <Button colorPalette="purple" disabled={!nameModal.name.trim()} onClick={() => void saveNameModal()}><Check size={17} />Guardar</Button>
            </Flex>
          </Stack>
        </ModalOverlay>
      )}

      {/* Clone floor confirm */}
      {cloneFloorConfirm && (
        <ModalOverlay title="Clonar Piso" onClose={() => setCloneFloorConfirm(false)}>
          <Text color="gray.600">Clonar Piso {currentFloor} como Piso {Math.max(...floors) + 1}?</Text>
          <Flex mt="6" justify="end" gap="3">
            <Button variant="outline" onClick={() => setCloneFloorConfirm(false)}>Cancelar</Button>
            <Button colorPalette="purple" onClick={() => void cloneFloor()}>Clonar</Button>
          </Flex>
        </ModalOverlay>
      )}

      {/* Generic confirm modal */}
      {confirmModal && (
        <ModalOverlay title={confirmModal.title} onClose={() => setConfirmModal(null)}>
          <Text color="gray.600">{confirmModal.message}</Text>
          <Flex mt="6" justify="end" gap="3">
            <Button variant="outline" onClick={() => setConfirmModal(null)}>Cancelar</Button>
            <Button colorPalette="red" onClick={confirmModal.onConfirm}>Confirmar</Button>
          </Flex>
        </ModalOverlay>
      )}

      {/* Transfer table modal */}
      {transferSrcTable && cash && (
        <TransferTableModal
          srcTable={transferSrcTable}
          srcOrder={openOrders.get(transferSrcTable.id) ?? null}
          cash={cash}
          tenantId={tenantId}
          session={session}
          onClose={() => setTransferSrcTable(null)}
          onTransferred={(srcTableId, destOrder, srcFullyEmpty, destCanvasInfo, srcCanvasInfo) => {
            setTransferSrcTable(null);
            setOpenOrders((prev) => {
              const next = new Map(prev);
              if (srcFullyEmpty) next.delete(srcTableId);
              next.set(destOrder.table_id, destOrder);
              return next;
            });
            setCanvasInfo((prev) => {
              const next = new Map(prev);
              if (srcFullyEmpty) next.delete(srcTableId);
              else if (srcCanvasInfo) next.set(srcTableId, srcCanvasInfo);
              next.set(destOrder.table_id, destCanvasInfo);
              return next;
            });
            if (srcFullyEmpty) {
              setPanelTable(null);
              setSelected(null);
            } else {
              setPanelReloadKey((k) => k + 1);
            }
          }}
        />
      )}
      {transferSrcTable && !cash && (
        <ModalOverlay title="Sin caja abierta" onClose={() => setTransferSrcTable(null)}>
          <Text color="gray.600">Debes tener una caja abierta para transferir mesas.</Text>
          <Flex mt="6" justify="end"><Button colorPalette="purple" onClick={() => setTransferSrcTable(null)}>Entendido</Button></Flex>
        </ModalOverlay>
      )}

      {/* Merge table modal */}
      {mergeSrcTable && (
        <MergeTableModal
          srcTable={mergeSrcTable}
          srcOrder={openOrders.get(mergeSrcTable.id) ?? null}
          cash={cash}
          tenantId={tenantId}
          session={session}
          allTables={tables}
          openOrders={openOrders}
          onClose={() => setMergeSrcTable(null)}
          onMerged={(srcTableId, srcOrderUpdated, destOrder, destCanvasInfo) => {
            setMergeSrcTable(null);
            setOpenOrders((prev) => new Map(prev).set(srcTableId, srcOrderUpdated).set(destOrder.table_id, destOrder));
            setCanvasInfo((prev) => {
              const next = new Map(prev);
              const srcName = tables.find((t) => t.id === srcTableId)?.name ?? "";
              next.set(srcTableId, { clientNames: [srcName], total: 0 });
              next.set(destOrder.table_id, destCanvasInfo);
              return next;
            });
            setPanelReloadKey((k) => k + 1);
          }}
        />
      )}
    </Box>
  );
}

function TablePanel({ table, onClose, onTableOpened, onTableClosed, onComandaSent, onCanvasInfoChange, onNavigate, reloadKey, onGoToTable }: { table: RestaurantTable; onClose: () => void; onTableOpened: (order: TableOrder) => void; onTableClosed: (tableId: string) => void; onComandaSent: (tableId: string) => void; onCanvasInfoChange: (tableId: string, info: TableCanvasInfo) => void; onNavigate: (view: string, param?: string) => void; reloadKey?: number; onGoToTable?: (tableId: string) => void }) {
  const [activeTab, setActiveTab] = useState<"cuenta" | "historial">("cuenta");
  const [cash, setCash] = useState<CashSession | null | "loading">("loading");
  const [order, setOrder] = useState<TableOrder | null | "loading">("loading");

  useEffect(() => { setActiveTab("cuenta"); }, [table.id]);

  useEffect(() => {
    let mounted = true;
    setCash("loading");
    setOrder("loading");
    Promise.all([
      cashRegisterService.getOpenSession(),
      tableOrderService.getOpenOrderByTable(table.id),
    ]).then(([s, o]) => {
      if (!mounted) return;
      setCash(s);
      setOrder(o);
    }).catch(() => { if (mounted) { setCash(null); setOrder(null); } });
    return () => { mounted = false; };
  }, [table.id, reloadKey]);

  const resolvedOrder = order === "loading" ? undefined : order ?? undefined;
  const status = getTableStatus(resolvedOrder);
  const badgeColor = status === "free" ? "green" : status === "overdue" ? "red" : status === "sent" ? "orange" : "yellow";

  return (
    <Box
      position="fixed"
      top="72px"
      right="0"
      bottom="0"
      zIndex="10"
      w="420px"
      bg="white"
      boxShadow="-4px 0 24px rgba(0,0,0,0.10)"
      display="flex"
      flexDirection="column"
      overflow="hidden"
    >
      <Flex px="5" py="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.200" shrink="0">
        <Flex align="center" gap="3">
          <Text fontWeight="bold" fontSize="lg">{table.name}</Text>
          <Badge colorPalette={badgeColor}>{STATUS_LABELS[status]}</Badge>
        </Flex>
        <Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button>
      </Flex>

      <Flex borderBottomWidth="1px" borderColor="gray.200" shrink="0">
        {(["cuenta", "historial"] as const).map((tab) => (
          <Box
            key={tab}
            as="button"
            flex="1"
            py="3"
            fontSize="sm"
            fontWeight="semibold"
            textAlign="center"
            color={activeTab === tab ? "purple.600" : "gray.500"}
            bg={activeTab === tab ? "purple.50" : "white"}
            onClick={() => setActiveTab(tab)}
            style={{ cursor: "pointer", border: "none", borderBottom: `2px solid ${activeTab === tab ? "#7c3aed" : "transparent"}` }}
          >
            {tab === "cuenta" ? "Cuenta" : "Historial"}
          </Box>
        ))}
      </Flex>

      <Box flex="1" overflowY="auto" p="5" display="flex" flexDirection="column">
        {activeTab === "cuenta" ? (
          <CuentaTab
            table={table}
            cash={cash}
            order={order}
            onOrderOpened={(o) => { setOrder(o); onTableOpened(o); }}
            onOrderClosed={() => { setOrder(null); onTableClosed(table.id); }}
            onComandaSent={() => { setOrder((prev) => prev && prev !== "loading" ? { ...prev, comanda_sent: 1 } : prev); onComandaSent(table.id); }}
            onCanvasInfoChange={(info) => onCanvasInfoChange(table.id, info)}
            onGoToTable={onGoToTable}
          />
        ) : (
          <HistorialTab table={table} cash={cash} onNavigate={onNavigate} />
        )}
      </Box>
    </Box>
  );
}

function CuentaTab({ table, cash, order, onOrderOpened, onOrderClosed, onComandaSent, onCanvasInfoChange, onGoToTable }: {
  table: RestaurantTable;
  cash: CashSession | null | "loading";
  order: TableOrder | null | "loading";
  onOrderOpened: (order: TableOrder) => void;
  onOrderClosed: () => void;
  onComandaSent?: () => void;
  onCanvasInfoChange?: (info: TableCanvasInfo) => void;
  onGoToTable?: (tableId: string) => void;
}) {
  const session = sessionContext.current();
  const [openModal, setOpenModal] = useState(false);
  const [clientName, setClientName] = useState("");
  const [saving, setSaving] = useState(false);
  const [openedJustNow, setOpenedJustNow] = useState(false);

  useEffect(() => { setOpenedJustNow(false); }, [table.id]);

  if (cash === "loading" || order === "loading") {
    return <Flex h="full" align="center" justify="center"><Spinner /></Flex>;
  }

  if (!cash) {
    return (
      <Flex h="full" align="center" justify="center" px="4">
        <Box w="full" maxW="500px" borderWidth="1px" borderColor="orange.200" bg="orange.50" p={{ base: "6", md: "8" }} textAlign="center">
          <Flex mx="auto" w="54px" h="54px" align="center" justify="center" borderRadius="full" bg="orange.100" color="orange.600"><LockKeyhole size={26} /></Flex>
          <Heading mt="5" size="md">Caja cerrada</Heading>
          <Text mt="3" color="gray.600">Debes abrir una caja antes de usar las mesas.</Text>
        </Box>
      </Flex>
    );
  }

  // MERGED case
  if (order?.notes?.startsWith("MERGED:")) {
    const parts = order.notes.split(":");
    const destOrderId = parts[1] ?? null;
    const destName = parts[2] ?? "otra mesa";
    return (
      <Flex h="full" direction="column" align="center" justify="center" gap="4">
        <Badge colorPalette="purple" fontSize="sm">Unida</Badge>
        <Text color="gray.600" textAlign="center" fontSize="sm">Esta mesa esta unida con <strong>{destName}</strong>.</Text>
        <Text color="gray.400" textAlign="center" fontSize="xs">Los items y el cobro estan en {destName}. Esta mesa sigue ocupada fisicamente.</Text>
        {destOrderId && onGoToTable && (
          <Button colorPalette="purple" variant="outline" onClick={async () => {
            const db_order = await tableOrderService.getOrderById(destOrderId).catch(() => null);
            if (db_order) onGoToTable(db_order.table_id);
            else notify.error("No se encontro la mesa destino.");
          }}>Ver cuenta de {destName}</Button>
        )}
        <Button variant="outline" colorPalette="red" onClick={async () => {
          if (!order) return;
          try {
            await tableOrderService.deleteOrder(order.id);
            onOrderClosed();
            notify.success("Mesa desunida y cerrada.");
          } catch {
            notify.error("No fue posible desunir la mesa.");
          }
        }}>Desunir mesa</Button>
      </Flex>
    );
  }

  if (!order) {
    async function handleOpen() {
      if (!cash || cash === "loading" || !session) return;
      setSaving(true);
      try {
        const created = await tableOrderService.openOrder(session.tenantId, table.id, cash.id, session.user.id, clientName || null);
        setOpenedJustNow(true);
        onOrderOpened(created);
        setOpenModal(false);
        setClientName("");
      } catch {
        notify.error("No fue posible abrir la mesa.");
      } finally {
        setSaving(false);
      }
    }

    return (
      <>
        <Flex h="full" direction="column" align="center" justify="center" gap="4">
          <Text fontSize="3xl">🍽️</Text>
          <Text fontWeight="semibold" color="gray.700">Mesa disponible</Text>
          <Text color="gray.500" textAlign="center" fontSize="sm">Sin orden activa. Abre la mesa para empezar a tomar el pedido.</Text>
          <Button colorPalette="purple" onClick={() => setOpenModal(true)}>Abrir Mesa</Button>
          <Text color="gray.400" fontSize="xs">Caja #{cash.sessionNumber}</Text>
        </Flex>

        {openModal && (
          <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
            <Box w="full" maxW="400px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
              <Flex justify="space-between" align="center" mb="5">
                <Text fontWeight="bold" fontSize="md">Abrir {table.name}</Text>
                <Button size="sm" variant="ghost" onClick={() => { setOpenModal(false); setClientName(""); }}><X size={17} /></Button>
              </Flex>
              <Stack gap="4">
                <Box>
                  <Text mb="2" fontWeight="semibold" fontSize="sm">Nombre del cliente (opcional)</Text>
                  <Input
                    autoFocus
                    placeholder="Ej: Juan, Mesa VIP..."
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleOpen(); }}
                  />
                </Box>
                <Flex justify="end" gap="3">
                  <Button variant="outline" onClick={() => { setOpenModal(false); setClientName(""); }}>Cancelar</Button>
                  <Button colorPalette="purple" loading={saving} onClick={() => void handleOpen()}>
                    <Check size={17} />Abrir Mesa
                  </Button>
                </Flex>
              </Stack>
            </Box>
          </Flex>
        )}
      </>
    );
  }

  return (
    <OccupiedCuentaTab
      table={table}
      order={order}
      cash={cash}
      openedJustNow={openedJustNow}
      onOrderClosed={onOrderClosed}
      onComandaSent={onComandaSent}
      onCanvasInfoChange={onCanvasInfoChange}
    />
  );
}

type SplitSlot = { id: string; items: TableOrderItem[]; deliveryType: DeliveryType | null };

// Pasa openedJustNow=true solo cuando la orden acaba de crearse desde el botón Abrir Mesa
function OccupiedCuentaTab({ table, order, cash, openedJustNow, onOrderClosed, onComandaSent, onCanvasInfoChange }: {
  table: RestaurantTable;
  order: TableOrder;
  cash: CashSession;
  openedJustNow: boolean;
  onOrderClosed: () => void;
  onComandaSent?: () => void;
  onCanvasInfoChange?: (info: TableCanvasInfo) => void;
}) {
  const [clients, setClients] = useState<TableOrderClient[]>([]);
  const [itemsByClient, setItemsByClient] = useState<Map<string, TableOrderItem[]>>(new Map());
  const [deliveryTypes, setDeliveryTypes] = useState<DeliveryType[]>([]);
  const [loading, setLoading] = useState(true);
  const [addProductsModal, setAddProductsModal] = useState(false);
  const [addProductsClientId, setAddProductsClientId] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // null = cerrado | "selector" = modal de modo | "todo" = cobrar todo | "split" = cuentas separadas | string = clientId específico
  const [checkout, setCheckout] = useState<null | "selector" | "todo" | "split" | string>(null);
  // Para cuentas separadas: items del scope y slots ya definidos
  const [splitState, setSplitState] = useState<{ scopeItems: TableOrderItem[]; slots: SplitSlot[]; slotIndex: number } | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  // Comanda
  const [kitchenPrinter, setKitchenPrinter] = useState<string | null>(null);
  const [comandaCopies, setComandaCopies] = useState(1);
  const [sendingComanda, setSendingComanda] = useState(false);
  const [comandaModal, setComandaModal] = useState<"client-select" | "reprint-client-select" | "reprint-options" | null>(null);
  const [reprintClientId, setReprintClientId] = useState<string | null>(null);
  const [devPreviewLines, setDevPreviewLines] = useState<string[] | null>(null);

  // En dev, interceptar printComanda y mostrar preview
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    setDevComandaPreviewCallback((lines) => setDevPreviewLines(lines));
  }, []);

  const reload = async (): Promise<TableOrderClient[]> => {
    const [c, byClient, dts] = await Promise.all([
      tableOrderService.getClients(order.id),
      tableOrderService.getItemsByClient(order.id),
      businessConfigService.deliveryTypes(),
    ]);
    setClients(c);
    setItemsByClient(byClient);
    setDeliveryTypes(dts);
    const allI = Array.from(byClient.values()).flat().filter((i) => !i.combo_table_order_item_id);
    const itemsTotal = allI.reduce((s, i) => s + i.subtotal, 0);
    const domTotal = c.reduce((s, cl) => s + (dts.find((d) => d.id === cl.delivery_type_id)?.price ?? 0), 0);
    onCanvasInfoChange?.({ clientNames: resolveClientNames(c, table.name), total: itemsTotal + domTotal });
    return c;
  };

  useEffect(() => {
    setLoading(true);
    void reload().then((c) => {
      if (openedJustNow) {
        setAddProductsClientId(c[0]?.id ?? null);
        setAddProductsModal(true);
      }
    }).finally(() => setLoading(false));
  }, [order.id]);

  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen]);

  useEffect(() => {
    void Promise.all([businessConfigService.load(), printerService.list()]).then(([settings, printers]) => {
      const kitchen = settings.printerKitchen && printers.includes(settings.printerKitchen) ? settings.printerKitchen : null;
      setKitchenPrinter(kitchen);
      setComandaCopies(settings.comandaCopies > 0 ? settings.comandaCopies : 1);
    });
  }, []);

  async function handleEnviarCocina(clientId: string | null) {
    setSendingComanda(true);
    try {
      const activeClients = clients.filter((c) => c.id !== null);
      const client = clientId ? (activeClients.find((c) => c.id === clientId) ?? null) : null;
      const clientDelivery = client ? (deliveryTypes.find((d) => d.id === client.delivery_type_id) ?? null) : null;
      const comanda = await comandaService.generateComanda({
        tableOrderId: order.id,
        tableName: table.name,
        clientId: clientId,
        clientName: client?.client_name ?? null,
        customerNotes: order.notes,
        isDelivery: !!clientDelivery,
        deliveryPrice: clientDelivery?.price ?? null,
      });
      if (!comanda) { notify.success("No hay productos nuevos para enviar a cocina."); return; }
      await comandaService.printComanda(comanda, kitchenPrinter ?? "", comandaCopies, activeClients.map((c) => ({ id: c.id, client_name: c.client_name, client_number: c.client_number })));
      onComandaSent?.();
      notify.success(`Comanda #${comanda.comanda_number} enviada a cocina.`);
    } catch (err) {
      notify.error(`Error al enviar comanda: ${String(err)}`);
    } finally {
      setSendingComanda(false);
      setComandaModal(null);
    }
  }

  async function handleReprintAll(clientId: string | null) {
    if (!kitchenPrinter && !import.meta.env.DEV) return;
    setSendingComanda(true);
    try {
      const client = clientId ? (clients.find((c) => c.id === clientId) ?? null) : null;
      const comanda = await comandaService.buildFullOrderComanda({
        tableOrderId: order.id,
        tableName: table.name,
        clientId,
        clientName: client?.client_name ?? null,
        customerNotes: order.notes,
        isDelivery: false,
        deliveryPrice: null,
      });
      if (!comanda) { notify.success("No hay productos en la orden."); return; }
      await comandaService.printComanda(comanda, kitchenPrinter ?? "", comandaCopies, clients.map((c) => ({ id: c.id, client_name: c.client_name, client_number: c.client_number })));
      notify.success("Comanda completa reimpresa.");
    } catch (err) {
      notify.error(`Error al reimprimir: ${String(err)}`);
    } finally {
      setSendingComanda(false);
      setComandaModal(null);
      setReprintClientId(null);
    }
  }

  async function handleReprintLast(clientId: string | null) {
    if (!kitchenPrinter && !import.meta.env.DEV) return;
    setSendingComanda(true);
    try {
      const all = await comandaService.getAllComandas(order.id);
      const last = all[all.length - 1] ?? null;
      if (!last) { notify.success("No hay comandas enviadas para esta mesa."); return; }
      await comandaService.printComanda(last, kitchenPrinter ?? "", comandaCopies, clients.map((c) => ({ id: c.id, client_name: c.client_name, client_number: c.client_number })));
      notify.success(`Ultima comanda #${last.comanda_number} reimpresa.`);
    } catch (err) {
      notify.error(`Error al reimprimir: ${String(err)}`);
    } finally {
      setSendingComanda(false);
      setComandaModal(null);
      setReprintClientId(null);
    }
  }

  async function openReprintMenu() {
    setMoreOpen(false);
    const hasComanda = await comandaService.hasComanda(order.id);
    if (!hasComanda) { notify.success("No hay comandas enviadas para esta mesa."); return; }
    const activeClients = clients.filter((c) => c.id !== null);
    if (activeClients.length > 1) {
      setComandaModal("reprint-client-select");
    } else {
      setReprintClientId(activeClients[0]?.id ?? null);
      setComandaModal("reprint-options");
    }
  }

  async function handleSendCocina() {
    if (!kitchenPrinter && !import.meta.env.DEV) return;
    const activeClients = clients.filter((c) => c.id !== null);
    if (activeClients.length > 1) {
      setComandaModal("client-select");
    } else {
      await handleEnviarCocina(activeClients[0]?.id ?? null);
    }
  }

  async function handleCancelOrder() {
    setCancelling(true);
    try {
      const allItems = Array.from(itemsByClient.values()).flat();
      const rootItems = allItems.filter((i) => !i.combo_table_order_item_id);
      if (rootItems.length > 0) {
        const lostTotal = rootItems.reduce((s, i) => s + i.subtotal, 0);
        await auditService.log(
          "CANCELAR_MESA", "MESA",
          `Mesa ${table.name} cancelada con ${rootItems.length} producto(s) sin cobrar | Total perdido: ${fmtMoney(lostTotal)}`,
          order.id,
          groupAuditItems(rootItems),
        ).catch(() => {});
      }
      await tableOrderService.deleteOrder(order.id);
      onOrderClosed();
      notify.success(`${table.name} cancelada.`);
    } catch {
      notify.error("No fue posible cancelar la mesa.");
    } finally {
      setCancelling(false);
      setCancelConfirm(false);
    }
  }

  async function handleCatalogConfirm(result: CatalogConfirmResult) {
    const { items, additions, sauces } = result;
    for (const cartItem of items) {
      if (cartItem.kind === "combo") {
        // Extraer comboId del key: "combo:ID:timestamp"
        const comboId = cartItem.key.split(":")[1] ?? null;
        const parentId = await tableOrderService.addItem({
          orderId: order.id,
          clientId: addProductsClientId,
          productId: comboId,
          productName: cartItem.name,
          quantity: cartItem.quantity,
          unitPrice: cartItem.price,
          selectedOption: null,
          comboId,
          comboParentItemId: null,
          additions: [],
          sauces: [],
        });
        for (const child of cartItem.children) {
          const additionList = additions
            .filter((a) => (child.additions[a.id] ?? 0) > 0)
            .map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: child.additions[a.id] }));
          const sauceList = sauces
            .filter((s) => child.sauces.includes(s.id))
            .map((s) => ({ id: s.id, name: s.name }));
          await tableOrderService.addItem({
            orderId: order.id,
            clientId: addProductsClientId,
            productId: child.productId,
            productName: child.name,
            quantity: child.quantity,
            unitPrice: 0,
            selectedOption: child.selectedOption,
            comboId,
            comboParentItemId: parentId,
            additions: additionList,
            sauces: sauceList,
          });
        }
        await tableOrderService.recalcComboParentSubtotal(parentId);
      } else {
        const additionList = additions
          .filter((a) => (cartItem.additions[a.id] ?? 0) > 0)
          .map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: cartItem.additions[a.id] }));
        const sauceList = sauces
          .filter((s) => cartItem.sauces.includes(s.id))
          .map((s) => ({ id: s.id, name: s.name }));
        await tableOrderService.addItem({
          orderId: order.id,
          clientId: addProductsClientId,
          productId: cartItem.key.split(":")[1] ?? null,
          productName: cartItem.name,
          quantity: cartItem.quantity,
          unitPrice: cartItem.price,
          selectedOption: cartItem.selectedOption,
          comboId: null,
          comboParentItemId: null,
          additions: additionList,
          sauces: sauceList,
        });
      }
    }
    setAddProductsModal(false);
    void reload();
  }

  async function handleAddClient(name: string | null) {
    const client = await tableOrderService.addClient(order.id, name);
    setClients((prev) => [...prev, client]);
  }

  async function handleCancelClient(clientId: string) {
    await tableOrderService.cancelClient(clientId);
    const remaining = clients.filter((c) => c.id !== clientId);
    setClients(remaining);
    if (remaining.length === 0) {
      await tableOrderService.deleteOrder(order.id);
      onOrderClosed();
      notify.success(`${table.name} cerrada.`);
    } else {
      const allI = Array.from(itemsByClient.values()).flat().filter((i) => !i.combo_table_order_item_id);
      const itemsTotal = allI.reduce((s, i) => s + i.subtotal, 0);
      const domTotal = remaining.reduce((s, c) => s + (deliveryTypes.find((d) => d.id === c.delivery_type_id)?.price ?? 0), 0);
      onCanvasInfoChange?.({ clientNames: resolveClientNames(remaining, table.name), total: itemsTotal + domTotal });
    }
  }

  const allItems = Array.from(itemsByClient.values()).flat();
  const rootItems = allItems.filter((i) => !i.combo_table_order_item_id);
  const deliveryTotal = clients.reduce((s, c) => s + (deliveryTypes.find((d) => d.id === c.delivery_type_id)?.price ?? 0), 0);
  const orderTotal = rootItems.reduce((s, i) => s + i.subtotal, 0) + deliveryTotal;
  const hasItems = rootItems.length > 0;

  if (loading) return <Flex flex="1" align="center" justify="center"><Spinner /></Flex>;

  return (
    <Flex direction="column" flex="1" minH="0">
      {/* Clientes — collapsible */}
      <Box flex="1" overflowY="auto" pb="2">
        {clients.map((client) => (
          <ClientCard
            key={client.id}
            client={client}
            allItems={allItems}
            itemsByClient={itemsByClient}
            deliveryTypes={deliveryTypes}
            onClientChange={(updated) => {
              const next = clients.map((c) => c.id === updated.id ? updated : c);
              setClients(next);
              const allI = Array.from(itemsByClient.values()).flat().filter((i) => !i.combo_table_order_item_id);
              const itemsTotal = allI.reduce((s, i) => s + i.subtotal, 0);
              const domTotal = next.reduce((s, c) => s + (deliveryTypes.find((d) => d.id === c.delivery_type_id)?.price ?? 0), 0);
              onCanvasInfoChange?.({ clientNames: resolveClientNames(next, table.name), total: itemsTotal + domTotal });
            }}
            onItemsChange={() => void reload()}
            onCancel={() => void handleCancelClient(client.id)}
            tableName={table.name}
          />
        ))}

        {/* Items sin cliente */}
        {(() => {
          const unassigned = (itemsByClient.get("__none__") ?? []).filter((i) => !i.combo_table_order_item_id);
          if (!unassigned.length) return null;
          return (
            <ClientSection label="Sin cliente asignado" total={unassigned.reduce((s, i) => s + i.subtotal, 0)} colorPalette="gray" defaultOpen>
              <OrderItemList items={unassigned} allItems={allItems} onItemsChange={() => void reload()} tableName={table.name} />
            </ClientSection>
          );
        })()}

        {!hasItems && clients.length === 0 && (
          <Flex align="center" justify="center" py="6">
            <Text fontSize="sm" color="gray.400">Mesa abierta. Agrega productos para empezar.</Text>
          </Flex>
        )}

        {/* + Agregar Cliente */}
        <AddClientInline onAdd={(name) => void handleAddClient(name)} clientCount={clients.length} />
      </Box>

      {/* Total + barra de acciones */}
      <Box flexShrink="0">
        <Flex px="1" py="2" justify="space-between" align="center" borderTopWidth="1px" borderColor="gray.100">
          <Text fontWeight="semibold" fontSize="sm" color="gray.700">Total mesa</Text>
          <Text fontWeight="bold" fontSize="md">{fmtMoney(orderTotal)}</Text>
        </Flex>
        <Separator />
        <Box pt="3" pb="1">
          <Flex gap="2">
            <Button size="sm" colorPalette="purple" flex="1" onClick={() => { setAddProductsClientId(clients[0]?.id ?? null); setAddProductsModal(true); }}>
              <Plus size={14} />Agregar Productos
            </Button>
            {(kitchenPrinter || import.meta.env.DEV) ? (
              <Button size="sm" colorPalette="orange" variant="outline" flex="1" loading={sendingComanda} disabled={!hasItems} onClick={() => void handleSendCocina()}>
                <Flame size={14} />Enviar a Cocina
              </Button>
            ) : (
              <Tip text="Configura una impresora de cocina en Configuracion">
                <Button size="sm" colorPalette="orange" variant="outline" flex="1" disabled onClick={() => {}}>
                  Enviar a Cocina
                </Button>
              </Tip>
            )}
          </Flex>
          <Flex gap="2" mt="2">
            {!hasItems ? (
              <Tip text="Agrega productos antes de cobrar">
                <Button size="sm" colorPalette="green" flex="1" disabled onClick={() => {}}>Cobrar</Button>
              </Tip>
            ) : (
              <Button size="sm" colorPalette="green" flex="1" onClick={() => {
                // Releer items frescos de SQLite antes de abrir checkout para capturar
                // notas y cambios recientes que aún no se reflejaron en el estado en memoria.
                void reload().then(() => {
                  if (rootItems.length === 1) { setCheckout("todo"); return; }
                  setCheckout("selector");
                });
              }}>Cobrar</Button>
            )}
            <Box position="relative" ref={moreRef}>
              <Button size="sm" variant="outline" colorPalette="gray" onClick={() => setMoreOpen((v) => !v)}>
                <MoreHorizontal size={15} />
              </Button>
              {moreOpen && (
                <Box position="absolute" bottom="110%" right="0" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" boxShadow="lg" py="1" minW="170px" zIndex="popover">
                  {(kitchenPrinter || import.meta.env.DEV) && <ContextMenuItem label="Reimprimir Comanda" onClick={() => void openReprintMenu()} />}
                  <ContextMenuItem label="Cerrar mesa" danger onClick={() => { setMoreOpen(false); setCancelConfirm(true); }} />
                </Box>
              )}
            </Box>
          </Flex>
        </Box>
      </Box>

      {/* Cancel confirm */}
      {cancelConfirm && (
        <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
          <Box w="full" maxW="380px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
            <Flex align="center" gap="3" mb="4"><AlertCircle size={20} color="#dc2626" /><Text fontWeight="bold" fontSize="md">Cerrar mesa</Text></Flex>
            <Text color="gray.600" fontSize="sm" mb="6">Cerrar {table.name} cerrara la cuenta sin cobrar. Esta accion no se puede deshacer.</Text>
            <Flex justify="end" gap="3">
              <Button variant="outline" onClick={() => setCancelConfirm(false)}>Volver</Button>
              <Button colorPalette="red" loading={cancelling} onClick={() => void handleCancelOrder()}>Cerrar mesa</Button>
            </Flex>
          </Box>
        </Flex>
      )}

      {/* Comanda: selector de cliente para enviar */}
      {comandaModal === "client-select" && (
        <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
          <Box w="full" maxW="380px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
            <Flex align="center" gap="3" mb="4"><Flame size={18} color="#ea580c" /><Text fontWeight="bold" fontSize="md">Enviar a Cocina</Text></Flex>
            <Text color="gray.600" fontSize="sm" mb="4">Selecciona el cliente para filtrar la comanda, o envia todo el pedido:</Text>
            <Stack gap="2">
              <Button variant="outline" colorPalette="orange" onClick={() => void handleEnviarCocina(null)}>Todo el pedido</Button>
              {clients.map((c) => (
                <Button key={c.id} variant="outline" onClick={() => void handleEnviarCocina(c.id)}>
                  {c.client_name ? `${c.client_name} (Cuenta ${c.client_number})` : `Cuenta ${c.client_number}`}
                </Button>
              ))}
            </Stack>
            <Flex justify="end" mt="4">
              <Button variant="ghost" onClick={() => setComandaModal(null)}>Cancelar</Button>
            </Flex>
          </Box>
        </Flex>
      )}

      {/* Reimprimir: selector de cliente (2+ clientes) */}
      {comandaModal === "reprint-client-select" && (
        <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
          <Box w="full" maxW="380px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
            <Flex align="center" gap="3" mb="4"><Printer size={18} /><Text fontWeight="bold" fontSize="md">Reimprimir Comanda</Text></Flex>
            <Text color="gray.600" fontSize="sm" mb="4">Selecciona el cliente o reimprimir todo el pedido:</Text>
            <Stack gap="2">
              <Button variant="outline" colorPalette="purple" onClick={() => { setReprintClientId(null); setComandaModal("reprint-options"); }}>Todo el pedido</Button>
              {clients.map((c) => (
                <Button key={c.id} variant="outline" onClick={() => { setReprintClientId(c.id); setComandaModal("reprint-options"); }}>
                  {c.client_name ? `${c.client_name} (Cuenta ${c.client_number})` : `Cuenta ${c.client_number}`}
                </Button>
              ))}
            </Stack>
            <Flex justify="end" mt="4">
              <Button variant="ghost" onClick={() => setComandaModal(null)}>Cancelar</Button>
            </Flex>
          </Box>
        </Flex>
      )}

      {/* Reimprimir: opciones todo / ultima */}
      {comandaModal === "reprint-options" && (
        <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
          <Box w="full" maxW="380px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
            <Flex align="center" gap="3" mb="4"><Printer size={18} /><Text fontWeight="bold" fontSize="md">Reimprimir Comanda</Text></Flex>
            <Stack gap="2">
              <Button variant="outline" colorPalette="purple" loading={sendingComanda} onClick={() => void handleReprintAll(reprintClientId)}>Todo el pedido (comanda completa)</Button>
              <Button variant="outline" colorPalette="orange" loading={sendingComanda} onClick={() => void handleReprintLast(reprintClientId)}>Ultima comanda enviada</Button>
            </Stack>
            <Flex justify="end" mt="4">
              <Button variant="ghost" onClick={() => setComandaModal(null)}>Cancelar</Button>
            </Flex>
          </Box>
        </Flex>
      )}

      {/* Dev: preview de comanda */}
      {import.meta.env.DEV && devPreviewLines && (
        <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
          <Box w="full" maxW="420px" bg="white" borderRadius="md" boxShadow="2xl" overflow="hidden">
            <Flex px="4" py="3" borderBottomWidth="1px" borderColor="gray.200" align="center" justify="space-between">
              <Flex align="center" gap="2"><Printer size={16} /><Text fontWeight="bold" fontSize="sm">Preview Comanda (DEV)</Text></Flex>
              <Button size="xs" variant="ghost" onClick={() => setDevPreviewLines(null)}><X size={14} /></Button>
            </Flex>
            <Box
              as="pre"
              fontFamily="monospace"
              fontSize="12px"
              lineHeight="1.6"
              p="4"
              bg="gray.50"
              overflowY="auto"
              maxH="60vh"
              whiteSpace="pre-wrap"
            >
              {devPreviewLines.join("\n")}
            </Box>
            <Flex px="4" py="3" justify="end" borderTopWidth="1px" borderColor="gray.200">
              <Button size="sm" onClick={() => setDevPreviewLines(null)}>Cerrar</Button>
            </Flex>
          </Box>
        </Flex>
      )}

      {/* Add products modal */}
      {checkout === "selector" && (
        <CheckoutModeModal
          table={table}
          clients={clients}
          itemsByClient={itemsByClient}
          deliveryTypes={deliveryTypes}
          orderTotal={orderTotal}
          onClose={() => setCheckout(null)}
          onCobrarTodo={() => setCheckout("todo")}
          onCobrarCliente={(clientId) => setCheckout(clientId)}
          onCuentasSeparadas={(scopeItems) => { setSplitState({ scopeItems, slots: [{ id: crypto.randomUUID(), items: [], deliveryType: null }, { id: crypto.randomUUID(), items: [], deliveryType: null }], slotIndex: 0 }); setCheckout("split"); }}
        />
      )}

      {(checkout === "todo" || (typeof checkout === "string" && checkout !== "selector" && checkout !== "split" && checkout !== "split-cobro")) && (
        <TableCheckoutModal
          table={table}
          order={order}
          cash={cash}
          clients={clients}
          targetClientId={checkout === "todo" ? null : checkout}
          allItems={allItems}
          deliveryTypes={deliveryTypes}
          orderTotal={orderTotal}
          onClose={() => setCheckout(null)}
          onConfirmed={(orderClosed) => {
            setCheckout(null);
            if (orderClosed) { onOrderClosed(); } else { void reload(); }
          }}
        />
      )}

      {checkout === "split" && splitState && (
        <SplitBillModal
          table={table}
          scopeItems={splitState.scopeItems}
          deliveryTypes={deliveryTypes}
          clients={clients}
          onClose={() => { setCheckout(null); setSplitState(null); }}
          onStartCobro={(slots) => { setSplitState((prev) => prev ? { ...prev, slots, slotIndex: 0 } : null); setCheckout("split-cobro"); }}
        />
      )}

      {checkout === "split-cobro" && splitState && splitState.slotIndex < splitState.slots.length && (() => {
        const slot = splitState.slots[splitState.slotIndex];
        const slotTotal = slot.items.filter((i) => !i.combo_table_order_item_id).reduce((s, i) => s + i.subtotal, 0) + (slot.deliveryType?.price ?? 0);
        return (
          <TableCheckoutModal
            table={table}
            order={order}
            cash={cash}
            clients={clients}
            targetClientId={null}
            allItems={slot.items}
            deliveryTypes={deliveryTypes}
            orderTotal={slotTotal}
            initialDeliveryOverride={slot.deliveryType}
            slotLabel={`Persona ${splitState.slotIndex + 1} de ${splitState.slots.length}`}
            hideCancelButton
            skipAutoClose
            onClose={() => {}}
            onConfirmed={(orderClosed) => {
              if (orderClosed) {
                setSplitState(null);
                setCheckout(null);
                onOrderClosed();
              } else {
                const nextIndex = splitState.slotIndex + 1;
                if (nextIndex >= splitState.slots.length) {
                  // Todos los slots cobrados, cerrar orden
                  void tableOrderService.closeOrder(order.id).then(() => {
                    setSplitState(null);
                    setCheckout(null);
                    onOrderClosed();
                  });
                } else {
                  setSplitState((prev) => prev ? { ...prev, slotIndex: nextIndex } : null);
                }
              }
            }}
          />
        );
      })()}

      {addProductsModal && (
        <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
          <Box w="full" maxW="900px" h="calc(100vh - 40px)" bg="white" borderRadius="md" boxShadow="2xl" overflow="hidden" display="flex" flexDirection="column">
            <Flex px="5" py="3" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.200" shrink="0">
              <Flex align="center" gap="3" flexWrap="wrap">
                <Text fontWeight="bold" fontSize="md">Agregar — {table.name}</Text>
                {clients.length > 0 && (
                  <Flex gap="1" align="center" flexWrap="wrap">
                    <Text fontSize="xs" color="gray.500">Para:</Text>
                    {clients.map((c) => (
                      <Button
                        key={c.id}
                        size="xs"
                        variant={addProductsClientId === c.id ? "solid" : "outline"}
                        colorPalette="purple"
                        onClick={() => setAddProductsClientId(c.id)}
                      >{c.client_name ?? `Cliente ${c.client_number}`}</Button>
                    ))}
                  </Flex>
                )}
              </Flex>
              <Button size="sm" variant="ghost" onClick={() => setAddProductsModal(false)}><X size={17} /></Button>
            </Flex>
            <Box flex="1" minH="0" overflow="hidden" p="5">
              <ProductCatalogPanel
                onConfirm={(result) => void handleCatalogConfirm(result)}
                onCancel={() => setAddProductsModal(false)}
              />
            </Box>
          </Box>
        </Flex>
      )}
    </Flex>
  );
}

// ---- ClientCard: un cliente completo con collapse, nombre editable, notas, items, delivery, tarjeta ----
function ClientCard({ client, allItems, itemsByClient, deliveryTypes, onClientChange, onItemsChange, onCancel, tableName }: {
  client: TableOrderClient;
  allItems: TableOrderItem[];
  itemsByClient: Map<string, TableOrderItem[]>;
  deliveryTypes: DeliveryType[];
  onClientChange: (c: TableOrderClient) => void;
  onItemsChange: () => void;
  onCancel: () => void;
  tableName?: string;
}) {
  const [open, setOpen] = useState(true);
  const [nameVal, setNameVal] = useState(client.client_name ?? "");
  const [notesVal, setNotesVal] = useState(client.notes ?? "");

  const clientItems = (itemsByClient.get(client.id) ?? []).filter((i) => !i.combo_table_order_item_id);
  const deliveryPrice = deliveryTypes.find((d) => d.id === client.delivery_type_id)?.price ?? 0;
  const clientTotal = clientItems.reduce((s, i) => s + i.subtotal, 0) + deliveryPrice;

  const label = nameVal.trim() || `Cliente ${client.client_number}`;

  return (
    <Box mb="2" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
      {/* Header collapse */}
      <Flex align="center" bg="gray.50" px="3" py="2" borderBottomWidth={open ? "1px" : "0"} borderColor="gray.200">
        <Box flex="1" cursor="pointer" onClick={() => setOpen((v) => !v)}>
          <Flex align="center" gap="2">
            <ChevronRight size={14} style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s ease", color: "#6b7280", flexShrink: 0 }} />
            <Badge colorPalette="purple" variant="subtle" size="sm">{label}</Badge>
            <Text fontSize="xs" color="gray.500">{fmtMoney(clientTotal)}</Text>
          </Flex>
        </Box>
        <Tip text="Cancelar cliente">
          <Button size="xs" variant="ghost" colorPalette="red" onClick={onCancel} ml="1">
            <X size={13} />
          </Button>
        </Tip>
      </Flex>

      {open && (
        <Box px="3" py="3">
          {/* Nombre editable */}
          <Input
            size="sm"
            placeholder={`Cliente ${client.client_number}`}
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={() => {
              void tableOrderService.updateClientName(client.id, nameVal || null);
              onClientChange({ ...client, client_name: nameVal.trim() || null });
            }}
            mb="2"
          />

          {/* Notas del cliente */}
          <Input
            size="sm"
            placeholder="Notas del pedido"
            value={notesVal}
            onChange={(e) => setNotesVal(e.target.value)}
            onBlur={() => { void tableOrderService.updateClientNotes(client.id, notesVal || null); onClientChange({ ...client, notes: notesVal.trim() || null }); }}
            mb="3"
          />

          {/* Items */}
          {clientItems.length === 0 ? (
            <Flex direction="column" align="center" justify="center" py="3" mb="3" bg="gray.50" borderRadius="md" gap="1">
              <Text fontSize="sm" color="gray.400">Sin productos aun</Text>
              <Text fontSize="xs" color="gray.300">Usa el boton "Agregar Productos" para tomar el pedido</Text>
            </Flex>
          ) : (
            <Box mb="3">
              <OrderItemList items={clientItems} allItems={allItems} onItemsChange={onItemsChange} tableName={tableName} />
            </Box>
          )}

          {/* Tipos de domicilio */}
          {deliveryTypes.length > 0 && (
            <Box mb="3">
              <Text fontSize="xs" color="gray.500" fontWeight="semibold" mb="1">Domicilio</Text>
              <Flex gap="2" wrap="wrap">
                {deliveryTypes.map((dt) => {
                  const active = client.delivery_type_id === dt.id;
                  return (
                    <Button
                      key={dt.id}
                      size="xs"
                      variant={active ? "solid" : "outline"}
                      colorPalette={active ? "purple" : "gray"}
                      onClick={async () => {
                        const next = active ? null : dt.id;
                        await tableOrderService.updateClientDeliveryType(client.id, next);
                        onClientChange({ ...client, delivery_type_id: next });
                      }}
                    >
                      {dt.name}{dt.price ? ` +${fmtMoney(dt.price)}` : ""}
                    </Button>
                  );
                })}
              </Flex>
            </Box>
          )}

          {/* Checkbox tarjeta */}
          <Flex
            align="center"
            gap="2"
            cursor="pointer"
            onClick={async () => {
              const next = !client.is_card;
              await tableOrderService.updateClientCard(client.id, next);
              onClientChange({ ...client, is_card: next ? 1 : 0 });
            }}
          >
            <Box
              w="16px" h="16px" borderRadius="3px"
              borderWidth="2px"
              borderColor={client.is_card ? "purple.500" : "gray.300"}
              bg={client.is_card ? "purple.500" : "white"}
              display="flex" alignItems="center" justifyContent="center"
              flexShrink="0"
            >
              {client.is_card ? <Check size={10} color="white" /> : null}
            </Box>
            <Text fontSize="xs" color="gray.600">Pago con tarjeta</Text>
          </Flex>
        </Box>
      )}
    </Box>
  );
}

function AddClientInline({ onAdd, clientCount }: { onAdd: (name: string | null) => void; clientCount: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  function confirm() {
    onAdd(name.trim() || null);
    setName("");
    setOpen(false);
  }

  if (!open) {
    return (
      <Button size="xs" variant="ghost" colorPalette="gray" onClick={() => setOpen(true)} mt="1">
        <Plus size={12} />Agregar Cliente
      </Button>
    );
  }
  return (
    <Flex gap="2" align="center" mt="2">
      <Input
        size="sm"
        autoFocus
        placeholder={`Cliente ${clientCount + 1}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") confirm(); if (e.key === "Escape") { setOpen(false); setName(""); } }}
        flex="1"
      />
      <Button size="sm" colorPalette="purple" onClick={confirm}><Check size={14} /></Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setName(""); }}><X size={14} /></Button>
    </Flex>
  );
}

function FloorCarousel({ floors, currentFloor, onSelect }: { floors: number[]; currentFloor: number; onSelect: (floor: number) => void }) {
  const idx = floors.indexOf(currentFloor);
  const prev = idx > 0 ? floors[idx - 1] : null;
  const next = idx < floors.length - 1 ? floors[idx + 1] : null;
  return (
    <Flex align="center" gap="1">
      <Button size="sm" variant="ghost" disabled={prev === null} onClick={() => prev !== null && onSelect(prev)} px="2">
        <ChevronLeft size={16} />
      </Button>
      <Box minW="80px" textAlign="center">
        <Button size="sm" variant="solid" colorPalette="purple" pointerEvents="none">
          Piso {currentFloor}
        </Button>
      </Box>
      <Button size="sm" variant="ghost" disabled={next === null} onClick={() => next !== null && onSelect(next)} px="2">
        <ChevronRight size={16} />
      </Button>
      <Text fontSize="xs" color="gray.400">{idx + 1} / {floors.length}</Text>
    </Flex>
  );
}

type OrderDetail = { order: TableOrder; items: TableOrderItem[]; total: number; deliveryTotal: number; invoiceNumbers: string[] };

const BOGOTA_ZONE = "America/Bogota";

function fmtDateBogota(iso: string) {
  return new Date(iso).toLocaleString("es-CO", {
    timeZone: BOGOTA_ZONE, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function CheckoutModeModal({ table, clients, itemsByClient, deliveryTypes, orderTotal, onClose, onCobrarTodo, onCobrarCliente, onCuentasSeparadas }: {
  table: RestaurantTable;
  clients: TableOrderClient[];
  itemsByClient: Map<string, TableOrderItem[]>;
  deliveryTypes: DeliveryType[];
  orderTotal: number;
  onClose: () => void;
  onCobrarTodo: () => void;
  onCobrarCliente: (clientId: string) => void;
  onCuentasSeparadas: (scopeItems: TableOrderItem[]) => void;
}) {
  const [mode, setMode] = useState<"select" | "por-cliente" | "cliente-modo">("select");
  const [selectedClient, setSelectedClient] = useState<TableOrderClient | null>(null);

  const clientsWithItems = clients.filter((c) => {
    const items = (itemsByClient.get(c.id) ?? []).filter((i) => !i.combo_table_order_item_id);
    return items.length > 0;
  });

  if (mode === "cliente-modo" && selectedClient) {
    const clientItems = (itemsByClient.get(selectedClient.id) ?? []).filter((i) => !i.combo_table_order_item_id);
    const clientDelivery = deliveryTypes.find((d) => d.id === selectedClient.delivery_type_id);
    const clientTotal = clientItems.reduce((s, i) => s + i.subtotal, 0) + (clientDelivery?.price ?? 0);
    const label = selectedClient.client_name?.trim() || `Cliente ${selectedClient.client_number}`;
    return (
      <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="4">
        <Box w="full" maxW="380px" bg="white" borderRadius="lg" boxShadow="2xl">
          <Flex px="6" pt="6" pb="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.100">
            <Box>
              <Heading size="md">{label}</Heading>
              <Text fontSize="2xl" fontWeight="bold" color="purple.700" mt="1">{fmtMoney(clientTotal)}</Text>
            </Box>
            <Button size="sm" variant="ghost" onClick={() => setMode("por-cliente")}><X size={18} /></Button>
          </Flex>
          <Box px="6" py="5">
            <Stack gap="3">
              <Button colorPalette="green" size="lg" onClick={() => onCobrarCliente(selectedClient.id)}>Cobrar Todo</Button>
              <Button colorPalette="purple" variant="outline" size="lg" onClick={() => {
                const items = (itemsByClient.get(selectedClient.id) ?? []);
                onCuentasSeparadas(items);
              }}>Cuentas Separadas</Button>
            </Stack>
          </Box>
        </Box>
      </Flex>
    );
  }

  if (mode === "por-cliente") {
    return (
      <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="4">
        <Box w="full" maxW="400px" bg="white" borderRadius="lg" boxShadow="2xl">
          <Flex px="6" pt="6" pb="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.100">
            <Heading size="md">Selecciona cliente</Heading>
            <Button size="sm" variant="ghost" onClick={() => setMode("select")}><X size={18} /></Button>
          </Flex>
          <Box px="6" py="4">
            <Stack gap="2">
              {clientsWithItems.map((c) => {
                const items = (itemsByClient.get(c.id) ?? []).filter((i) => !i.combo_table_order_item_id);
                const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
                const delivery = deliveryTypes.find((d) => d.id === c.delivery_type_id);
                const clientTotal = subtotal + (delivery?.price ?? 0);
                const label = c.client_name?.trim() || `Cliente ${c.client_number}`;
                return (
                  <Button key={c.id} variant="outline" colorPalette="gray" justifyContent="space-between" h="auto" py="3" px="4" onClick={() => {
                    if (items.length === 1) {
                      onCobrarCliente(c.id);
                    } else {
                      setSelectedClient(c);
                      setMode("cliente-modo");
                    }
                  }}>
                    <Flex align="center" gap="2">
                      <Text fontWeight="semibold">{label}</Text>
                      {c.is_card ? <Badge colorPalette="blue" size="sm">Tarjeta</Badge> : null}
                      {delivery ? <Badge colorPalette="orange" size="sm">+{fmtMoney(delivery.price)}</Badge> : null}
                    </Flex>
                    <Text fontWeight="bold" color="purple.700">{fmtMoney(clientTotal)}</Text>
                  </Button>
                );
              })}
            </Stack>
          </Box>
        </Box>
      </Flex>
    );
  }

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="4">
      <Box w="full" maxW="380px" bg="white" borderRadius="lg" boxShadow="2xl">
        <Flex px="6" pt="6" pb="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.100">
          <Box>
            <Heading size="md">Cobrar — {table.name}</Heading>
            <Text fontSize="2xl" fontWeight="bold" color="purple.700" mt="1">{fmtMoney(orderTotal)}</Text>
          </Box>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>
        <Box px="6" py="5">
          <Stack gap="3">
            <Button colorPalette="green" size="lg" onClick={onCobrarTodo}>Cobrar Todo</Button>
            {clientsWithItems.length >= 2 && (
              <Button colorPalette="purple" variant="outline" size="lg" onClick={() => setMode("por-cliente")}>Cobrar por Cliente</Button>
            )}
            <Button colorPalette="purple" variant="outline" size="lg" onClick={() => {
              const allScopeItems = Array.from(itemsByClient.values()).flat();
              onCuentasSeparadas(allScopeItems);
            }}>Cuentas Separadas</Button>
          </Stack>
        </Box>
      </Box>
    </Flex>
  );
}

function SplitBillModal({ table, scopeItems, deliveryTypes, clients, onClose, onStartCobro }: {
  table: RestaurantTable;
  scopeItems: TableOrderItem[];
  deliveryTypes: DeliveryType[];
  clients: TableOrderClient[];
  onClose: () => void;
  onStartCobro: (slots: SplitSlot[]) => void;
}) {
  const rootScope = scopeItems.filter((i) => !i.combo_table_order_item_id);

  // Un único domicilio por orden (primer cliente del scope con delivery_type_id)
  const scopeClientIds = new Set(scopeItems.map((i) => i.table_order_client_id).filter(Boolean));
  const deliveryClient = clients.find((c) => scopeClientIds.has(c.id) && c.delivery_type_id);
  const orderDeliveryType = deliveryClient ? (deliveryTypes.find((d) => d.id === deliveryClient.delivery_type_id) ?? null) : null;

  const [slots, setSlots] = useState<SplitSlot[]>([
    { id: crypto.randomUUID(), items: [], deliveryType: null },
    { id: crypto.randomUUID(), items: [], deliveryType: null },
  ]);

  const assignedItemIds = new Set(slots.flatMap((s) => s.items.map((i) => i.id)));
  const deliveryAssigned = slots.some((s) => s.deliveryType !== null);
  const unassignedItems = rootScope.filter((i) => !assignedItemIds.has(i.id));
  const showDeliveryUnassigned = orderDeliveryType && !deliveryAssigned;

  function addSlot() {
    setSlots((prev) => [...prev, { id: crypto.randomUUID(), items: [], deliveryType: null }]);
  }

  function removeSlot(slotId: string) {
    setSlots((prev) => prev.filter((s) => s.id !== slotId));
  }

  function assignItem(item: TableOrderItem, toSlotId: string) {
    setSlots((prev) => prev.map((s) => s.id === toSlotId ? { ...s, items: [...s.items, item] } : s));
  }

  function unassignItem(itemId: string, fromSlotId: string) {
    setSlots((prev) => prev.map((s) => s.id === fromSlotId ? { ...s, items: s.items.filter((i) => i.id !== itemId) } : s));
  }

  function moveItemToNext(item: TableOrderItem, currentSlotId: string) {
    const currentIdx = slots.findIndex((s) => s.id === currentSlotId);
    const nextIdx = (currentIdx + 1) % slots.length;
    setSlots((prev) => prev.map((s, idx) => {
      if (idx === currentIdx) return { ...s, items: s.items.filter((i) => i.id !== item.id) };
      if (idx === nextIdx) return { ...s, items: [...s.items, item] };
      return s;
    }));
  }

  function assignDelivery(toSlotId: string) {
    setSlots((prev) => prev.map((s) => ({ ...s, deliveryType: s.id === toSlotId ? orderDeliveryType : null })));
  }

  function moveDeliveryToNext(currentSlotId: string) {
    const currentIdx = slots.findIndex((s) => s.id === currentSlotId);
    const nextIdx = (currentIdx + 1) % slots.length;
    setSlots((prev) => prev.map((s, idx) => {
      if (idx === currentIdx) return { ...s, deliveryType: null };
      if (idx === nextIdx) return { ...s, deliveryType: orderDeliveryType };
      return s;
    }));
  }

  function unassignDelivery(fromSlotId: string) {
    setSlots((prev) => prev.map((s) => s.id === fromSlotId ? { ...s, deliveryType: null } : s));
  }

  const totalUnassigned = unassignedItems.length + (showDeliveryUnassigned ? 1 : 0);
  const allAssigned = totalUnassigned === 0;
  const noEmptySlots = slots.every((s) => s.items.length > 0 || s.deliveryType !== null);
  const canCobrar = allAssigned && noEmptySlots;

  const validationMsg = !allAssigned
    ? `${totalUnassigned} elemento(s) sin asignar`
    : !noEmptySlots
    ? "Hay personas sin productos asignados"
    : null;

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="4">
      <Box w="full" maxW="520px" maxH="calc(100vh - 32px)" bg="white" borderRadius="lg" boxShadow="2xl" display="flex" flexDirection="column" overflow="hidden">
        <Flex px="5" py="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.100" shrink="0">
          <Box>
            <Heading size="md">Cuentas Separadas — {table.name}</Heading>
            <Text fontSize="sm" color="gray.500" mt="0.5">Asigna cada producto a una persona</Text>
          </Box>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>

        <Box flex="1" overflowY="auto" px="5" py="4">
          {/* Sin asignar */}
          {totalUnassigned > 0 && (
            <Box mb="4">
              <Text fontSize="xs" fontWeight="bold" color="orange.600" mb="2">SIN ASIGNAR ({totalUnassigned})</Text>
              <Stack gap="1">
                {unassignedItems.map((item) => (
                  <Flex key={item.id} align="center" gap="2" px="3" py="2" bg="orange.50" borderRadius="md" borderWidth="1px" borderColor="orange.200">
                    <Text fontSize="xs" flex="1">{item.quantity > 1 ? `${item.quantity}x ` : ""}{item.product_name}</Text>
                    <Text fontSize="xs" color="gray.600" mr="2">{fmtMoney(item.subtotal)}</Text>
                    <Flex gap="1">
                      {slots.map((s, idx) => (
                        <Button key={s.id} size="xs" variant="outline" colorPalette="purple" onClick={() => assignItem(item, s.id)}>P{idx + 1}</Button>
                      ))}
                    </Flex>
                  </Flex>
                ))}
                {showDeliveryUnassigned && (
                  <Flex align="center" gap="2" px="3" py="2" bg="orange.50" borderRadius="md" borderWidth="1px" borderColor="orange.200">
                    <Text fontSize="xs" flex="1" color="orange.700">Domicilio ({orderDeliveryType!.name})</Text>
                    <Text fontSize="xs" color="gray.600" mr="2">{fmtMoney(orderDeliveryType!.price ?? 0)}</Text>
                    <Flex gap="1">
                      {slots.map((s, idx) => (
                        <Button key={s.id} size="xs" variant="outline" colorPalette="orange" onClick={() => assignDelivery(s.id)}>P{idx + 1}</Button>
                      ))}
                    </Flex>
                  </Flex>
                )}
              </Stack>
            </Box>
          )}

          {/* Slots */}
          <Stack gap="3">
            {slots.map((slot, idx) => {
              const slotTotal = slot.items.reduce((s, i) => s + i.subtotal, 0) + (slot.deliveryType?.price ?? 0);
              const isEmpty = slot.items.length === 0 && !slot.deliveryType;
              return (
                <Box key={slot.id} borderWidth="1px" borderColor={isEmpty ? "gray.200" : "purple.200"} borderRadius="md" overflow="hidden">
                  <Flex px="3" py="2" bg={isEmpty ? "gray.50" : "purple.50"} align="center" justify="space-between">
                    <Text fontSize="xs" fontWeight="bold" color={isEmpty ? "gray.500" : "purple.700"}>Persona {idx + 1}</Text>
                    <Flex align="center" gap="2">
                      {!isEmpty && <Text fontSize="xs" fontWeight="bold" color="purple.700">{fmtMoney(slotTotal)}</Text>}
                      {slots.length > 2 && (
                        <Button size="xs" variant="ghost" colorPalette="red" onClick={() => removeSlot(slot.id)}><X size={12} /></Button>
                      )}
                    </Flex>
                  </Flex>
                  {isEmpty ? (
                    <Box px="3" py="3">
                      <Text fontSize="xs" color="gray.400" textAlign="center">Sin productos asignados</Text>
                    </Box>
                  ) : (
                    <Stack gap="0" px="3" py="2">
                      {slot.items.map((item) => (
                        <Flex key={item.id} align="center" gap="2" py="1">
                          <Text fontSize="xs" flex="1">{item.quantity > 1 ? `${item.quantity}x ` : ""}{item.product_name}</Text>
                          <Text fontSize="xs" color="gray.500" mr="1">{fmtMoney(item.subtotal)}</Text>
                          <Tip text="Mover a siguiente persona">
                            <Button size="xs" variant="ghost" colorPalette="gray" onClick={() => moveItemToNext(item, slot.id)}><ChevronRight size={12} /></Button>
                          </Tip>
                          <Tip text="Quitar">
                            <Button size="xs" variant="ghost" colorPalette="red" onClick={() => unassignItem(item.id, slot.id)}><X size={12} /></Button>
                          </Tip>
                        </Flex>
                      ))}
                      {slot.deliveryType && (
                        <Flex align="center" gap="2" py="1">
                          <Text fontSize="xs" flex="1" color="orange.600">Domicilio ({slot.deliveryType.name})</Text>
                          <Text fontSize="xs" color="gray.500" mr="1">{fmtMoney(slot.deliveryType.price ?? 0)}</Text>
                          <Tip text="Mover a siguiente persona">
                            <Button size="xs" variant="ghost" colorPalette="gray" onClick={() => moveDeliveryToNext(slot.id)}><ChevronRight size={12} /></Button>
                          </Tip>
                          <Tip text="Quitar">
                            <Button size="xs" variant="ghost" colorPalette="red" onClick={() => unassignDelivery(slot.id)}><X size={12} /></Button>
                          </Tip>
                        </Flex>
                      )}
                    </Stack>
                  )}
                </Box>
              );
            })}
          </Stack>

          <Button mt="3" size="sm" variant="outline" colorPalette="gray" w="full" onClick={addSlot}>
            <Plus size={14} />Agregar persona
          </Button>
        </Box>

        <Box px="5" py="4" borderTopWidth="1px" borderColor="gray.100" flexShrink="0">
          {validationMsg && (
            <Flex align="center" gap="2" mb="3">
              <AlertCircle size={14} color="#d97706" />
              <Text fontSize="xs" color="orange.600">{validationMsg}</Text>
            </Flex>
          )}
          <Button w="full" colorPalette="green" size="lg" disabled={!canCobrar} onClick={() => onStartCobro(slots)}>
            Cobrar — Persona 1 de {slots.length}
          </Button>
        </Box>
      </Box>
    </Flex>
  );
}

function fmtMoney(v: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v);
}

function groupAuditItems(items: { product_name: string; unit_price: number; quantity: number; subtotal: number }[]) {
  const map = new Map<string, { label: string; quantity: number; unitPrice: number; subtotal: number }>();
  for (const i of items) {
    const key = `${i.product_name}__${i.unit_price}`;
    const existing = map.get(key);
    if (existing) {
      existing.quantity += i.quantity;
      existing.subtotal += i.subtotal;
    } else {
      map.set(key, { label: i.product_name, quantity: i.quantity, unitPrice: i.unit_price, subtotal: i.subtotal });
    }
  }
  return Array.from(map.values());
}

type TablePayMethod = "cash" | "card" | "split";

function TableCheckoutModal({ table, order, cash, clients, targetClientId, allItems, deliveryTypes, orderTotal, slotLabel, hideCancelButton, skipAutoClose, initialDeliveryOverride, onClose, onConfirmed }: {
  table: RestaurantTable;
  order: TableOrder;
  cash: CashSession;
  clients: TableOrderClient[];
  targetClientId: string | null;
  allItems: TableOrderItem[];
  deliveryTypes: DeliveryType[];
  orderTotal: number;
  slotLabel?: string;
  hideCancelButton?: boolean;
  skipAutoClose?: boolean;
  initialDeliveryOverride?: DeliveryType | null;
  onClose: () => void;
  onConfirmed: (orderClosed: boolean) => void;
}) {
  // Cliente de referencia: el target si lo hay, sino el primero
  const client = targetClientId ? (clients.find((c) => c.id === targetClientId) ?? null) : (clients[0] ?? null);

  // Items a cobrar: si hay targetClientId solo los de ese cliente, sino todos
  const itemsToCobrar = targetClientId
    ? allItems.filter((i) => i.table_order_client_id === targetClientId)
    : allItems;

  // Total a cobrar: si hay targetClientId, subtotal de ese cliente + su domicilio
  const clientDelivery = client ? (deliveryTypes.find((d) => d.id === client.delivery_type_id) ?? null) : null;
  const targetTotal = targetClientId
    ? itemsToCobrar.filter((i) => !i.combo_table_order_item_id).reduce((s, i) => s + i.subtotal, 0) + (clientDelivery?.price ?? 0)
    : orderTotal;

  // Pre-seleccionar delivery type y metodo de pago desde el cliente (o override para cuentas separadas)
  const initialDelivery = initialDeliveryOverride !== undefined ? initialDeliveryOverride : clientDelivery;
  const initialMethod: TablePayMethod = client?.is_card ? "card" : "cash";

  const [hasPrinter, setHasPrinter] = useState(false);
  const [bizSettings, setBizSettings] = useState<Awaited<ReturnType<typeof businessConfigService.load>> | null>(null);
  const [allAdditions, setAllAdditions] = useState<PosAddition[]>([]);
  const [allSauces, setAllSauces] = useState<PosSauce[]>([]);
  const [method, setMethod] = useState<TablePayMethod>(initialMethod);
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryType | null>(initialDelivery);
  const [cashGiven, setCashGiven] = useState("");
  const [cashGivenTouched, setCashGivenTouched] = useState(false);
  const [splitCash, setSplitCash] = useState("");
  const [splitMode, setSplitMode] = useState<"cash" | "card">("cash");
  const [splitCashGiven, setSplitCashGiven] = useState("");
  const [splitCashGivenTouched, setSplitCashGivenTouched] = useState(false);
  const [orderNote, setOrderNote] = useState(client?.notes ?? order.notes ?? "");
  const [printInvoice, setPrintInvoice] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([
      printerService.list(),
      businessConfigService.load(),
      posService.additions(),
      posService.sauces(),
    ]).then(([printers, settings, adds, { items: scs }]) => {
      setHasPrinter(Boolean(settings.printerReceipt && printers.includes(settings.printerReceipt)));
      setBizSettings(settings);
      setAllAdditions(adds);
      setAllSauces(scs);
    }).catch(() => {});
  }, []);

  const total = targetTotal + (selectedDelivery?.price ?? 0) - (initialDelivery?.price ?? 0);

  useEffect(() => {
    if (!cashGivenTouched) setCashGiven(String(total));
  }, [total, cashGivenTouched]);

  useEffect(() => {
    if (!splitCashGivenTouched) {
      const inputNum = Math.min(Number(splitCash) || 0, total);
      const cashPart = splitMode === "cash" ? inputNum : total - inputNum;
      setSplitCashGiven(cashPart > 0 ? String(cashPart) : "");
    }
  }, [total, splitCash, splitMode, splitCashGivenTouched]);

  function handleDeliveryToggle(dt: DeliveryType) {
    setSelectedDelivery((prev) => prev?.id === dt.id ? null : dt);
    if (!cashGivenTouched) setCashGiven("");
    if (!splitCashGivenTouched) setSplitCashGiven("");
  }

  function applyBill(bill: number) {
    if (method === "cash") {
      setCashGiven((prev) => { const base = cashGivenTouched ? (Number(prev) || 0) : 0; setCashGivenTouched(true); return String(base + bill); });
    } else {
      setSplitCashGiven((prev) => { const base = splitCashGivenTouched ? (Number(prev) || 0) : 0; setSplitCashGivenTouched(true); return String(base + bill); });
    }
  }

  const cashNum = Number(cashGiven) || 0;
  const splitInputNum = Math.min(Number(splitCash) || 0, total);
  const splitCashNum = splitMode === "cash" ? splitInputNum : total - splitInputNum;
  const splitCardNum = total - splitCashNum;
  const splitCashGivenNum = Number(splitCashGiven) || 0;
  const changeCash = method === "cash" ? cashNum - total : splitCashGivenNum - splitCashNum;
  const cashInsufficient = method === "cash" ? cashNum < total : splitCashGivenNum < splitCashNum;
  const splitInvalid = method === "split" && (splitCashNum <= 0 || splitCardNum <= 0);
  const bills = [10_000, 20_000, 50_000, 100_000];

  async function handleConfirm() {
    setSaving(true);
    try {
      const payMethod: import("../pos/SaleService").SalePaymentMethod =
        method === "cash" ? "CASH" : method === "card" ? "CARD" : "SPLIT";

      // Construir sale items desde los items a cobrar (solo root items)
      const rootItems = itemsToCobrar.filter((i) => !i.combo_table_order_item_id);
      const resolveAdditions = (adds: { name: string; quantity: number; price: number }[]) =>
        Object.fromEntries(adds.flatMap((a) => { const found = allAdditions.find((x) => x.name === a.name); return found ? [[found.id, a.quantity]] : []; }));
      const resolveSauces = (scs: { name: string }[]) =>
        scs.flatMap((s) => { const found = allSauces.find((x) => x.name === s.name); return found ? [found.id] : []; });

      const saleItems: import("../pos/SaleService").SaleItemRequest[] = rootItems.map((item) => {
        const isCombo = !!item.combo_id && !item.combo_table_order_item_id && item.product_id === null;
        const children = itemsToCobrar.filter((c) => c.combo_table_order_item_id === item.id);
        return {
          key: item.id,
          name: item.product_name,
          price: item.unit_price,
          originalPrice: item.original_unit_price ?? item.unit_price,
          quantity: item.quantity,
          kind: isCombo ? "combo" : "product",
          selectedOption: item.selected_option,
          note: item.notes ?? "",
          additions: resolveAdditions(item.additions),
          sauces: resolveSauces(item.sauces),
          productId: item.product_id ?? item.id,
          categoryName: null,
          children: children.map((child) => ({
            productId: child.product_id ?? child.id,
            name: child.product_name,
            quantity: child.quantity,
            additions: resolveAdditions(child.additions),
            sauces: resolveSauces(child.sauces),
            selectedOption: child.selected_option,
          })),
        };
      });

      const req: import("../pos/SaleService").SaleRequest = {
        cash,
        items: saleItems,
        paymentMethod: payMethod,
        total,
        cashGiven: method !== "card" ? (method === "cash" ? cashNum : splitCashGivenNum) : undefined,
        changeGiven: method !== "card" ? Math.max(0, changeCash) : undefined,
        cashAmount: method === "split" ? splitCashNum : undefined,
        cardAmount: method === "split" ? splitCardNum : undefined,
        notes: orderNote || undefined,
        clientName: client?.client_name ?? undefined,
        tableOrderId: order.id,
        delivery: selectedDelivery ? { type: selectedDelivery, paymentMethod: payMethod } : undefined,
      };

      const { saleService } = await import("../pos/SaleService");
      const result = await saleService.confirm(req, allAdditions, allSauces);

      let orderClosed = false;
      if (skipAutoClose) {
        // El cierre de orden lo maneja el caller (flujo split)
        orderClosed = false;
      } else if (targetClientId) {
        await tableOrderService.cancelClient(targetClientId);
        const [remainingClients, remainingByClient] = await Promise.all([
          tableOrderService.getClients(order.id),
          tableOrderService.getItemsByClient(order.id),
        ]);
        const anyWithItems = remainingClients.some((c) =>
          (remainingByClient.get(c.id) ?? []).some((i) => !i.combo_table_order_item_id),
        );
        if (!anyWithItems) {
          await tableOrderService.closeOrder(order.id);
          orderClosed = true;
        }
      } else {
        await tableOrderService.closeOrder(order.id);
        orderClosed = true;
      }

      const clientLabel = client?.client_name ? ` | Cliente: ${client.client_name}` : "";
      await auditService.log(
        "COBRAR_MESA",
        "MESA",
        `Mesa: ${table.name}${clientLabel} | Factura: #${result.invoiceNumber} | Total: ${fmtMoney(total)} | Pago: ${payMethod}`,
        order.id,
        groupAuditItems(rootItems),
      ).catch(() => {});

      notify.success(`Factura #${result.invoiceNumber}`, result.changeGiven > 0 ? `Cambio: ${fmtMoney(result.changeGiven)}` : undefined);

      if (bizSettings?.phone && saleService.normalizeWhatsAppPhone(bizSettings.phone)) {
        const shouldSend = bizSettings.deliveryWhatsapp === "TODAS" || (bizSettings.deliveryWhatsapp === "SOLO_DOMICILIOS" && !!selectedDelivery);
        if (shouldSend) {
          try { void invoke("open_help_url", { url: saleService.buildWhatsAppUrl(bizSettings.phone, bizSettings.name, result.invoiceNumber, req, allAdditions, allSauces) }); } catch { /* non-fatal */ }
        }
      }
      if (method !== "card" && bizSettings?.printerReceipt) {
        void saleService.openCashDrawer(bizSettings.printerReceipt);
      }
      if (bizSettings) {
        void saleService.generateAndSaveInvoice(result, req, cash.sessionNumber, bizSettings, allAdditions, allSauces, printInvoice);
      }

      onConfirmed(orderClosed);
    } catch (error) {
      const msg = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
      console.error("[TableCheckoutModal] Error al cobrar:", error);
      notify.error("Error al cobrar", msg || "Intenta de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="4">
      <Box w="full" maxW="520px" maxH="calc(100vh - 32px)" overflowY="auto" bg="white" borderRadius="lg" boxShadow="2xl">
        <Flex px="6" pt="6" pb="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.100">
          <Box>
            <Heading size="lg">Cobrar — {slotLabel ?? (targetClientId && client ? (client.client_name?.trim() || `Cliente ${client.client_number}`) : table.name)}</Heading>
            {slotLabel && <Text fontSize="sm" color="gray.500" mt="0.5">{table.name}</Text>}
          </Box>
          {!hideCancelButton && <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>}
        </Flex>

        <Box px="6" py="5">
          {/* Total */}
          <Flex direction="column" align="center" mb="6">
            <Text fontSize="sm" color="gray.500" fontWeight="medium">Total</Text>
            <Text fontSize="4xl" fontWeight="bold" color="purple.700" lineHeight="1.1">{fmtMoney(total)}</Text>
            {selectedDelivery && <Text fontSize="xs" color="gray.400" mt="1">Incluye domicilio {fmtMoney(selectedDelivery.price)}</Text>}
          </Flex>

          {/* Delivery */}
          {deliveryTypes.length > 0 && (
            <Box mb="5">
              <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="2">Domicilio</Text>
              <Flex gap="2" flexWrap="wrap">
                {deliveryTypes.map((dt) => {
                  const active = selectedDelivery?.id === dt.id;
                  return (
                    <Button key={dt.id} size="sm" variant={active ? "solid" : "outline"} colorPalette={active ? "blue" : "gray"} onClick={() => handleDeliveryToggle(dt)}>
                      {dt.name}{dt.price > 0 ? ` +${fmtMoney(dt.price)}` : ""}
                    </Button>
                  );
                })}
              </Flex>
            </Box>
          )}

          {/* Metodo de pago */}
          <Box mb="5">
            <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="2">Metodo de pago</Text>
            <Flex gap="2">
              {(["cash", "card", "split"] as TablePayMethod[]).map((m) => {
                const labels: Record<TablePayMethod, string> = { cash: "Efectivo", card: "Tarjeta", split: "Dividido" };
                return <Button key={m} size="sm" variant={method === m ? "solid" : "outline"} colorPalette={method === m ? "purple" : "gray"} onClick={() => setMethod(m)}>{labels[m]}</Button>;
              })}
            </Flex>
          </Box>

          {/* Efectivo */}
          {method === "cash" && (
            <Box mb="5">
              <Text fontSize="sm" color="gray.600" mb="1">Efectivo recibido</Text>
              <Input value={cashGiven} onChange={(e) => { setCashGiven(e.target.value); setCashGivenTouched(true); }} type="number" placeholder="0" />
              <Flex mt="2" gap="2" flexWrap="wrap">
                {bills.map((b) => <Button key={b} size="xs" variant="outline" colorPalette="gray" onClick={() => applyBill(b)}>${(b / 1000).toFixed(0)}k</Button>)}
                <Button size="xs" variant="outline" colorPalette="gray" onClick={() => { setCashGiven(String(total)); setCashGivenTouched(false); }}>Exacto</Button>
              </Flex>
              <Flex mt="3" align="center" justify="space-between">
                <Text fontSize="sm" color="gray.600">Cambio</Text>
                {cashInsufficient
                  ? <Text fontSize="sm" fontWeight="semibold" color="red.500">Monto insuficiente</Text>
                  : <Text fontSize="sm" fontWeight="bold" color="green.600">{fmtMoney(changeCash)}</Text>}
              </Flex>
            </Box>
          )}

          {/* Dividido */}
          {method === "split" && (
            <Box mb="5">
              <Flex mb="2" gap="1" p="1" bg="gray.100" borderRadius="md" w="fit-content">
                {(["cash", "card"] as const).map((m) => (
                  <Button key={m} size="xs" variant={splitMode === m ? "solid" : "ghost"} colorPalette={splitMode === m ? "purple" : "gray"}
                    onClick={() => { setSplitMode(m); setSplitCash(""); setSplitCashGivenTouched(false); }}>
                    {m === "cash" ? "Efectivo primero" : "Transferencia primero"}
                  </Button>
                ))}
              </Flex>
              <Text fontSize="sm" color="gray.600" mb="1">{splitMode === "cash" ? "Monto en efectivo" : "Monto en transferencia"}</Text>
              <Input value={splitCash} onChange={(e) => setSplitCash(e.target.value)} type="number" placeholder="0" />
              {splitCashNum > 0 && splitCardNum > 0 && (
                <Flex mt="2" gap="3">
                  <Flex align="center" gap="1"><Text fontSize="xs" color="gray.500">Efectivo:</Text><Text fontSize="xs" fontWeight="semibold">{fmtMoney(splitCashNum)}</Text></Flex>
                  <Flex align="center" gap="1"><Text fontSize="xs" color="gray.500">Tarjeta/Transfer.:</Text><Text fontSize="xs" fontWeight="semibold">{fmtMoney(splitCardNum)}</Text></Flex>
                </Flex>
              )}
              {splitInvalid && splitCash !== "" && <Text fontSize="xs" color="red.500" mt="1">Ambas partes deben ser mayores a 0</Text>}
              {splitCashNum > 0 && (
                <Box mt="4">
                  <Text fontSize="sm" color="gray.600" mb="1">Efectivo recibido</Text>
                  <Input value={splitCashGiven} onChange={(e) => { setSplitCashGiven(e.target.value); setSplitCashGivenTouched(true); }} type="number" placeholder="0" />
                  <Flex mt="2" gap="2" flexWrap="wrap">
                    {bills.map((b) => <Button key={b} size="xs" variant="outline" colorPalette="gray" onClick={() => applyBill(b)}>${(b / 1000).toFixed(0)}k</Button>)}
                    <Button size="xs" variant="outline" colorPalette="gray" onClick={() => { setSplitCashGiven(String(splitCashNum)); setSplitCashGivenTouched(false); }}>Exacto</Button>
                  </Flex>
                  <Flex mt="3" align="center" justify="space-between">
                    <Text fontSize="sm" color="gray.600">Cambio efectivo</Text>
                    {cashInsufficient
                      ? <Text fontSize="sm" fontWeight="semibold" color="red.500">Monto insuficiente</Text>
                      : <Text fontSize="sm" fontWeight="bold" color="green.600">{fmtMoney(changeCash)}</Text>}
                  </Flex>
                </Box>
              )}
            </Box>
          )}

          {/* Nota */}
          <Box mb="5">
            <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="1">Nota del pedido</Text>
            <Input value={orderNote} onChange={(e) => setOrderNote(e.target.value)} placeholder="Opcional..." />
          </Box>

          {/* Imprimir */}
          <Flex mb="6" align="center" justify="space-between">
            <Box>
              <Text fontSize="sm" fontWeight="semibold" color="gray.700">Imprimir factura</Text>
              {!hasPrinter && <Text fontSize="xs" color="gray.400">No hay impresora configurada o detectada</Text>}
            </Box>
            <Button size="sm" variant={printInvoice ? "solid" : "outline"} colorPalette={printInvoice ? "purple" : "gray"} disabled={!hasPrinter} onClick={() => setPrintInvoice((v) => !v)}>
              {printInvoice ? "Si" : "No"}
            </Button>
          </Flex>

          <Button w="full" colorPalette="purple" size="lg" loading={saving} disabled={cashInsufficient || splitInvalid || saving} onClick={() => void handleConfirm()}>
            Confirmar cobro
          </Button>
        </Box>
      </Box>
    </Flex>
  );
}

function HistorialTab({ table, cash, onNavigate }: { table: RestaurantTable; cash: CashSession | null | "loading"; onNavigate: (view: string, param?: string) => void }) {
  const [details, setDetails] = useState<OrderDetail[] | "loading">("loading");

  useEffect(() => {
    if (cash === "loading" || !cash) { setDetails(cash === "loading" ? "loading" : []); return; }
    let mounted = true;
    setDetails("loading");
    tableOrderService.getOrdersByTableAndSession(table.id, cash.id).then(async (orders) => {
      const result: OrderDetail[] = [];
      for (const order of orders) {
        const [items, sales] = await Promise.all([
          tableOrderService.getItemsForOrder(order.id, false),
          tableOrderService.getSalesByTableOrderId(order.id),
        ]);
        const total = order.status === "OPEN"
          ? items.filter((i) => !i.combo_table_order_item_id).reduce((s, i) => s + i.subtotal, 0)
          : sales.reduce((s, r) => s + r.total, 0);
        const deliveryTotal = sales.reduce((s, r) => s + (r.delivery_price ?? 0), 0);
        const invoiceNumbers = sales.map((s) => s.invoice_number).filter(Boolean);
        result.push({ order, items, total, deliveryTotal, invoiceNumbers });
      }
      if (mounted) setDetails(result.filter((d) => d.total > 0 || d.items.length > 0));
    }).catch(() => { if (mounted) setDetails([]); });
    return () => { mounted = false; };
  }, [table.id, cash]);

  if (details === "loading") {
    return <Flex h="full" align="center" justify="center"><Spinner /></Flex>;
  }

  if (!cash) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text color="gray.400" textAlign="center" fontSize="sm">Sin caja abierta. El historial muestra la caja actual.</Text>
      </Flex>
    );
  }

  if (!details.length) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text color="gray.400" textAlign="center" fontSize="sm">Sin cuentas en esta caja para esta mesa.</Text>
      </Flex>
    );
  }

  return (
    <Stack gap="3">
      {details.map(({ order, items, total, deliveryTotal, invoiceNumbers }) => {
        const roots = items.filter((i) => !i.combo_table_order_item_id);
        return (
          <Box key={order.id} borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
            {/* Card header */}
            <Flex px="3" py="2" bg="gray.50" borderBottomWidth="1px" borderColor="gray.200" align="center" justify="space-between">
              <Box>
                <Text fontWeight="semibold" fontSize="xs" color="gray.700">{fmtDateBogota(order.opened_at)}</Text>
                {order.client_name ? <Text fontSize="xs" color="gray.500">{order.client_name}</Text> : null}
              </Box>
              <Badge colorPalette={order.status === "OPEN" ? "orange" : "gray"} size="sm">
                {order.status === "OPEN" ? "Abierta" : "Cerrada"}
              </Badge>
            </Flex>

            {/* Items */}
            <Box px="3" py="2">
              <Stack gap="1">
                {roots.map((item) => {
                  const children = items.filter((c) => c.combo_table_order_item_id === item.id);
                  const isCombo = children.length > 0;
                  return (
                    <Box key={item.id}>
                      {/* Root item */}
                      <Flex justify="space-between" align="baseline">
                        <Text fontSize="xs" flex="1" mr="2">
                          {item.quantity}x {item.product_name}
                        </Text>
                        <Text fontSize="xs" color="gray.600" whiteSpace="nowrap">{fmtMoney(item.subtotal)}</Text>
                      </Flex>
                      {item.selected_option ? (
                        <Text fontSize="xs" color="purple.600" fontStyle="italic" pl="3">&gt;&gt; {item.selected_option}</Text>
                      ) : null}
                      {!isCombo && item.additions.map((a, i) => (
                        <Text key={i} fontSize="xs" color="gray.500" pl="3">+ {a.quantity > 1 ? `${a.quantity}x ` : ""}{a.name}</Text>
                      ))}
                      {!isCombo && item.sauces.length > 0 && (
                        <Text fontSize="xs" color="orange.600" pl="3">Salsas: {item.sauces.map((s) => s.name).join(", ")}</Text>
                      )}
                      {/* Combo children */}
                      {children.map((child) => (
                        <Box key={child.id} pl="4" mt="0.5">
                          <Text fontSize="xs" color="gray.600">- {child.quantity}x {child.product_name}</Text>
                          {child.selected_option ? (
                            <Text fontSize="xs" color="purple.600" fontStyle="italic" pl="3">&gt;&gt; {child.selected_option}</Text>
                          ) : null}
                          {child.additions.map((a, i) => (
                            <Text key={i} fontSize="xs" color="gray.500" pl="3">+ {a.quantity > 1 ? `${a.quantity}x ` : ""}{a.name}</Text>
                          ))}
                          {child.sauces.length > 0 && (
                            <Text fontSize="xs" color="orange.600" pl="3">Salsas: {child.sauces.map((s) => s.name).join(", ")}</Text>
                          )}
                        </Box>
                      ))}
                    </Box>
                  );
                })}
              </Stack>

              {/* Total */}
              <Flex justify="space-between" align="center" mt="2" pt="2" borderTopWidth="1px" borderColor="gray.100">
                <Text fontSize="xs" fontWeight="semibold" color="gray.700">Total</Text>
                <Box textAlign="right">
                  <Text fontSize="xs" fontWeight="bold">{fmtMoney(total)}</Text>
                  {deliveryTotal > 0 && (
                    <Text fontSize="xs" color="gray.400">incluye domicilio {fmtMoney(deliveryTotal)}</Text>
                  )}
                </Box>
              </Flex>

              {invoiceNumbers.length > 0 && (
                <Flex mt="2" gap="2" wrap="wrap">
                  {invoiceNumbers.map((inv) => (
                    <Button key={inv} size="xs" variant="outline" colorPalette="purple" onClick={() => onNavigate("history", inv)}>
                      Ver {inv}
                    </Button>
                  ))}
                </Flex>
              )}
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
}

function ClientSection({ label, total, colorPalette, defaultOpen, children }: {
  label: string;
  total: number;
  colorPalette: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <Box mb="2" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
      <Flex
        align="center"
        justify="space-between"
        px="3"
        py="2"
        bg="gray.50"
        cursor="pointer"
        onClick={() => setOpen((v) => !v)}
        _hover={{ bg: "gray.100" }}
      >
        <Flex align="center" gap="2">
          <ChevronRight
            size={14}
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s ease", color: "#6b7280" }}
          />
          <Badge colorPalette={colorPalette} variant="subtle" size="sm">{label}</Badge>
        </Flex>
        <Text fontSize="xs" color="gray.500" fontWeight="semibold">{fmtMoney(total)}</Text>
      </Flex>
      {open && <Box px="3" py="2">{children}</Box>}
    </Box>
  );
}

// Clave de agrupacion: misma config = mismo grupo
function groupKey(item: TableOrderItem, allItems: TableOrderItem[]): string {
  const addKey = [...item.additions].map((a) => a.name).sort().join(",");
  const sauceKey = [...item.sauces].map((s) => s.name).sort().join(",");
  const children = allItems.filter((c) => c.combo_table_order_item_id === item.id);
  const childKey = children.map((child) => {
    const ca = [...child.additions].map((a) => a.name).sort().join(",");
    const cs = [...child.sauces].map((s) => s.name).sort().join(",");
    return `${child.product_id ?? ""}:${child.selected_option ?? ""}:${ca}:${cs}`;
  }).join(";");
  return `${item.product_id ?? item.product_name}|${item.selected_option ?? ""}|${addKey}|${sauceKey}|${childKey}`;
}

function OrderItemList({ items, allItems, onItemsChange, tableName }: { items: TableOrderItem[]; allItems: TableOrderItem[]; onItemsChange?: () => void; tableName?: string }) {
  // Agrupar items por clave — preservando orden de insercion
  const groups = new Map<string, TableOrderItem[]>();
  for (const item of items) {
    const key = groupKey(item, allItems);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return (
    <Stack gap="2">
      {[...groups.values()].map((group) => (
        <OrderItemRow key={group[0].id} group={group} allItems={allItems} onItemsChange={onItemsChange} tableName={tableName} />
      ))}
    </Stack>
  );
}

function ComboChildRow({ child, onItemsChange }: { child: TableOrderItem; onItemsChange?: () => void }) {
  const [localAdditions, setLocalAdditions] = useState<{ name: string; quantity: number; price: number }[]>(child.additions);
  const [localSauces, setLocalSauces] = useState<{ name: string }[]>(child.sauces);
  const [localOption, setLocalOption] = useState<string | null>(child.selected_option);
  const [allAdditions, setAllAdditions] = useState<PosAddition[]>([]);
  const [allSauces, setAllSauces] = useState<PosSauce[]>([]);
  const [maxSauces, setMaxSauces] = useState(3);
  const [editMode, setEditMode] = useState<"additions" | "sauces" | "option" | null>(null);
  const [draftAdditions, setDraftAdditions] = useState<Record<string, number>>({});
  const [draftSauces, setDraftSauces] = useState<string[]>([]);
  const [showAdditions, setShowAdditions] = useState(false);
  const [showSauces, setShowSauces] = useState(false);
  const [productOptions, setProductOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!child.product_id) return;
    posService.products(null).then((prods) => {
      const prod = prods.find((p) => p.id === child.product_id);
      if (!prod) return;
      setShowAdditions(prod.showAdditions);
      setShowSauces(prod.showSauces);
      setProductOptions(prod.options);
    });
  }, [child.product_id]);

  async function openModal(mode: "additions" | "sauces" | "option") {
    if (mode !== "option") {
      const [adds, { items: scs, max }] = await Promise.all([posService.additions(), posService.sauces()]);
      setAllAdditions(adds);
      setAllSauces(scs);
      setMaxSauces(max);
      if (mode === "additions") {
        const qty: Record<string, number> = {};
        for (const a of localAdditions) {
          const found = adds.find((x) => x.name === a.name);
          if (found) qty[found.id] = a.quantity;
        }
        setDraftAdditions(qty);
      } else {
        setDraftSauces(scs.filter((s) => localSauces.some((ls) => ls.name === s.name)).map((s) => s.id));
      }
    }
    setEditMode(mode);
  }

  async function confirmAdditions() {
    const adds = allAdditions.filter((a) => (draftAdditions[a.id] ?? 0) > 0).map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: draftAdditions[a.id] }));
    await tableOrderService.replaceItemAdditions(child.id, adds);
    setLocalAdditions(adds.map((a) => ({ name: a.name, quantity: a.quantity, price: a.price })));
    setEditMode(null);
    onItemsChange?.();
  }

  async function confirmSauces() {
    const scs = allSauces.filter((s) => draftSauces.includes(s.id)).map((s) => ({ id: s.id, name: s.name }));
    await tableOrderService.replaceItemSauces(child.id, scs);
    setLocalSauces(scs.map((s) => ({ name: s.name })));
    setEditMode(null);
    onItemsChange?.();
  }

  async function confirmOption(option: string) {
    await tableOrderService.updateItemOption(child.id, option);
    setLocalOption(option);
    setEditMode(null);
    onItemsChange?.();
  }

  return (
    <Box pl="3" mt="1" borderLeftWidth="2px" borderColor="gray.200">
      <Flex align="center" gap="1">
        <Text fontSize="xs" color="gray.600" fontWeight="medium" flex="1">- {child.quantity > 1 ? `${child.quantity}x ` : ""}{child.product_name}</Text>
        {productOptions.length > 0 && (
          <Tip text="Opciones">
            <Button size="xs" variant="ghost" colorPalette="orange" px="1" onClick={() => void openModal("option")}><Settings2 size={12} /></Button>
          </Tip>
        )}
        {showAdditions && (
          <Tip text="Adiciones">
            <Button size="xs" variant="ghost" colorPalette="purple" px="1" onClick={() => void openModal("additions")}><Plus size={12} /></Button>
          </Tip>
        )}
        {showSauces && (
          <Tip text="Salsas">
            <Button size="xs" variant="ghost" colorPalette="green" px="1" onClick={() => void openModal("sauces")}><Flame size={12} /></Button>
          </Tip>
        )}
      </Flex>
      {localOption && <Text fontSize="xs" color="purple.600" fontStyle="italic" pl="2">&gt;&gt; {localOption}</Text>}
      {localAdditions.map((a, i) => <Text key={i} fontSize="xs" color="gray.500" pl="2">+ {a.quantity > 1 ? `${a.quantity}x ` : ""}{a.name}</Text>)}
      {localSauces.length > 0 && <Text fontSize="xs" color="orange.600" pl="2">Salsas: {localSauces.map((s) => s.name).join(", ")}</Text>}
      {editMode === "additions" && (
        <AdditionsModal name={child.product_name} additions={allAdditions} quantities={draftAdditions} onClose={() => setEditMode(null)} onChange={(id, delta) => setDraftAdditions((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] ?? 0) + delta) }))} onConfirm={() => void confirmAdditions()} confirmLabel="Guardar" />
      )}
      {editMode === "sauces" && (
        <SaucesModal name={child.product_name} sauces={allSauces} maxSauces={maxSauces} selected={draftSauces} onClose={() => setEditMode(null)} onToggle={(id) => setDraftSauces((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : prev.length < maxSauces ? [...prev, id] : prev)} onConfirm={() => void confirmSauces()} />
      )}
      {editMode === "option" && (
        <OptionModal name={child.product_name} options={productOptions} selected={localOption} onClose={() => setEditMode(null)} onConfirm={(opt) => void confirmOption(opt)} />
      )}
    </Box>
  );
}

function OrderItemRow({ group, allItems, onItemsChange, tableName }: { group: TableOrderItem[]; allItems: TableOrderItem[]; onItemsChange?: () => void; tableName?: string }) {
  const item = group[0];
  const totalQty = group.reduce((s, i) => s + i.quantity, 0);
  const totalSub = group.reduce((s, i) => s + i.subtotal, 0);
  const children = allItems.filter((c) => c.combo_table_order_item_id === item.id);

  const [noteOpen, setNoteOpen] = useState(!!item.notes);
  const [noteVal, setNoteVal] = useState(item.notes ?? "");

  // Estado local de adiciones/salsas/opcion para reflejar cambios sin recargar todo
  const [localAdditions, setLocalAdditions] = useState<{ name: string; quantity: number; price: number }[]>(item.additions);
  const [localSauces, setLocalSauces] = useState<{ name: string }[]>(item.sauces);
  const [localOption, setLocalOption] = useState<string | null>(item.selected_option);

  // Listas completas del tenant — se cargan lazy
  const [allAdditions, setAllAdditions] = useState<PosAddition[]>([]);
  const [allSauces, setAllSauces] = useState<PosSauce[]>([]);
  const [maxSauces, setMaxSauces] = useState(3);

  // Modal activo: null | "additions" | "sauces" | "option"
  type EditMode = "additions" | "sauces" | "option";
  const [editMode, setEditMode] = useState<EditMode | null>(null);
  // Drafts mientras el modal está abierto
  const [draftAdditions, setDraftAdditions] = useState<Record<string, number>>({});
  const [draftSauces, setDraftSauces] = useState<string[]>([]);

  // Capacidades del producto — cargadas al montar para mostrar iconos siempre que aplique
  const [productOptions, setProductOptions] = useState<string[]>([]);
  const [showAdditionsIcon, setShowAdditionsIcon] = useState(false);
  const [showSaucesIcon, setShowSaucesIcon] = useState(false);

  useEffect(() => {
    if (!item.product_id || children.length > 0) return;
    posService.products(null).then((prods) => {
      const prod = prods.find((p) => p.id === item.product_id);
      if (!prod) return;
      setProductOptions(prod.options);
      setShowAdditionsIcon(prod.showAdditions);
      setShowSaucesIcon(prod.showSauces);
    });
  }, [item.product_id]);

  async function openModal(mode: EditMode) {
    if (mode === "additions" || mode === "sauces") {
      const [adds, { items: scs, max }] = await Promise.all([posService.additions(), posService.sauces()]);
      setAllAdditions(adds);
      setAllSauces(scs);
      setMaxSauces(max);
      if (mode === "additions") {
        const qty: Record<string, number> = {};
        for (const a of localAdditions) {
          const found = adds.find((x) => x.name === a.name);
          if (found) qty[found.id] = a.quantity;
        }
        setDraftAdditions(qty);
      } else {
        setDraftSauces(scs.filter((s) => localSauces.some((ls) => ls.name === s.name)).map((s) => s.id));
      }
    }
    setEditMode(mode);
  }

  async function confirmAdditions() {
    const adds = allAdditions
      .filter((a) => (draftAdditions[a.id] ?? 0) > 0)
      .map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: draftAdditions[a.id] }));
    await Promise.all(group.map((gi) => tableOrderService.replaceItemAdditions(gi.id, adds)));
    setLocalAdditions(adds.map((a) => ({ name: a.name, quantity: a.quantity, price: a.price })));
    setEditMode(null);
    onItemsChange?.();
  }

  async function confirmSauces() {
    const scs = allSauces.filter((s) => draftSauces.includes(s.id)).map((s) => ({ id: s.id, name: s.name }));
    await Promise.all(group.map((gi) => tableOrderService.replaceItemSauces(gi.id, scs)));
    setLocalSauces(scs.map((s) => ({ name: s.name })));
    setEditMode(null);
    onItemsChange?.();
  }

  async function confirmOption(option: string) {
    await Promise.all(group.map((gi) => tableOrderService.updateItemOption(gi.id, option)));
    setLocalOption(option);
    setEditMode(null);
    onItemsChange?.();
  }

  async function decrement() {
    const result = await tableOrderService.decrementItem(item.id);
    if (result === "removed") {
      await auditService.log("ELIMINAR_ITEM_MESA", "MESA", `${item.product_name} eliminado de ${tableName ?? "mesa"}`, item.id).catch(() => {});
    }
    onItemsChange?.();
  }

  function saveNote(val: string) {
    const trimmed = val.trim() || null;
    void Promise.all(group.map((gi) => tableOrderService.updateItemNotes(gi.id, trimmed)));
  }

  return (
    <Box borderWidth="1px" borderColor="gray.100" borderRadius="md" px="2" py="2">
      {/* Fila principal */}
      <Flex align="center" gap="1">
        <Text fontSize="xs" fontWeight="bold" color="gray.700" minW="22px" textAlign="center">{totalQty}x</Text>
        <Text fontSize="xs" fontWeight="semibold" flex="1">{item.product_name}</Text>
        <Text fontSize="xs" color="gray.600" whiteSpace="nowrap" mr="1">{fmtMoney(totalSub)}</Text>
        <Tip text={noteOpen ? "Ocultar nota" : "Nota"}>
          <Button size="xs" variant="ghost" colorPalette="gray" onClick={() => setNoteOpen((v) => !v)} px="1">
            <MessageSquare size={13} />
          </Button>
        </Tip>
        {productOptions.length > 0 && (
          <Tip text="Opciones">
            <Button size="xs" variant="ghost" colorPalette="purple" px="1" onClick={() => void openModal("option")}>
              <Settings2 size={13} />
            </Button>
          </Tip>
        )}
        {children.length === 0 && showAdditionsIcon && (
          <Tip text="Adiciones">
            <Button size="xs" variant="ghost" colorPalette="purple" px="1" onClick={() => void openModal("additions")}>
              <Plus size={13} />
            </Button>
          </Tip>
        )}
        {children.length === 0 && showSaucesIcon && (
          <Tip text="Salsas">
            <Button size="xs" variant="ghost" colorPalette="green" px="1" onClick={() => void openModal("sauces")}>
              <Flame size={13} />
            </Button>
          </Tip>
        )}
        <Tip text="Quitar 1 unidad">
          <Button size="xs" variant="ghost" colorPalette="red" onClick={() => void decrement()} px="1">
            <Minus size={13} />
          </Button>
        </Tip>
      </Flex>

      {/* Nota */}
      {noteOpen && (
        <Input size="xs" mt="1" placeholder="Nota del producto" value={noteVal}
          onChange={(e) => { setNoteVal(e.target.value); saveNote(e.target.value); }} />
      )}

      {/* Detalles */}
      {localOption && <Text fontSize="xs" color="purple.600" fontStyle="italic" pl="2" mt="0.5">&gt;&gt; {localOption}</Text>}
      {children.length === 0 && localAdditions.map((a, i) => (
        <Text key={i} fontSize="xs" color="gray.500" pl="2">+ {a.quantity > 1 ? `${a.quantity}x ` : ""}{a.name}</Text>
      ))}
      {children.length === 0 && localSauces.length > 0 && (
        <Text fontSize="xs" color="orange.600" pl="2">Salsas: {localSauces.map((s) => s.name).join(", ")}</Text>
      )}

      {/* Hijos de combo */}
      {children.map((child) => (
        <ComboChildRow key={child.id} child={child} onItemsChange={onItemsChange} />
      ))}

      {/* Modales de edicion */}
      {editMode === "additions" && (
        <AdditionsModal
          name={item.product_name}
          additions={allAdditions}
          quantities={draftAdditions}
          onClose={() => setEditMode(null)}
          onChange={(id, delta) => setDraftAdditions((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] ?? 0) + delta) }))}
          onConfirm={() => void confirmAdditions()}
          confirmLabel="Guardar"
        />
      )}
      {editMode === "sauces" && (
        <SaucesModal
          name={item.product_name}
          sauces={allSauces}
          maxSauces={maxSauces}
          selected={draftSauces}
          onClose={() => setEditMode(null)}
          onToggle={(id) => setDraftSauces((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : prev.length < maxSauces ? [...prev, id] : prev)}
          onConfirm={() => void confirmSauces()}
          confirmLabel="Guardar"
        />
      )}
      {editMode === "option" && (
        <OptionModal
          name={item.product_name}
          options={productOptions}
          selected={localOption}
          onClose={() => setEditMode(null)}
          onConfirm={(opt) => void confirmOption(opt)}
        />
      )}
    </Box>
  );
}

function ContextMenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <Box
      px="4"
      py="2"
      fontSize="sm"
      cursor="pointer"
      color={danger ? "red.600" : "gray.800"}
      _hover={{ bg: danger ? "red.50" : "gray.50" }}
      onClick={onClick}
    >
      {label}
    </Box>
  );
}

function ModalOverlay({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
      <Box w="full" maxW="460px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
        <Flex justify="space-between" align="center" mb="5">
          <Heading size="md">{title}</Heading>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button>
        </Flex>
        {children}
      </Box>
    </Flex>
  );
}

function FieldBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text mb="2" fontWeight="semibold" fontSize="sm">{label}</Text>
      {children}
    </Box>
  );
}

type TransferStep =
  | { step: "select-client" }
  | { step: "select-items"; clientId: string | null; clientName: string | null }
  | { step: "select-table"; clientId: string | null; itemIds: string[] };

function TransferTableModal({ srcTable, srcOrder, cash, tenantId, session, onClose, onTransferred }: {
  srcTable: RestaurantTable;
  srcOrder: TableOrder | null;
  cash: CashSession;
  tenantId: string;
  session: { user: { id: string } } | null;
  onClose: () => void;
  onTransferred: (srcTableId: string, destOrder: TableOrder, srcFullyEmpty: boolean, destCanvasInfo: TableCanvasInfo, srcCanvasInfo: TableCanvasInfo | null) => void;
}) {
  const [transferStep, setTransferStep] = useState<TransferStep | null>(null);
  const [clients, setClients] = useState<TableOrderClient[]>([]);
  const [rootItems, setRootItems] = useState<TableOrderItem[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [allTables, setAllTables] = useState<RestaurantTable[]>([]);
  const [allOrders, setAllOrders] = useState<Map<string, TableOrder>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!srcOrder) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      tableOrderService.getClients(srcOrder.id),
      tableOrderService.getItemsForOrder(srcOrder.id),
      tablesService.listAllTables(tenantId),
    ]).then(async ([c, items, tables]) => {
      const rootOnly = items.filter((i) => !i.combo_table_order_item_id);
      const tableIds = tables.map((t) => t.id);
      const orders = await tableOrderService.getOpenOrdersByTableIds(tableIds);
      setClients(c);
      setRootItems(rootOnly);
      setAllTables(tables.filter((t) => t.id !== srcTable.id));
      const oMap = new Map<string, TableOrder>(orders.map((o) => [o.table_id, o]));
      setAllOrders(oMap);

      // Determinar paso inicial
      if (c.length > 1) {
        setTransferStep({ step: "select-client" });
      } else {
        const clientId = c[0]?.id ?? null;
        const clientName = c[0]?.client_name ?? null;
        const clientItems = clientId ? rootOnly.filter((i) => i.table_order_client_id === clientId) : rootOnly;
        if (clientItems.length <= 1) {
          const ids = new Set(clientItems.map((i) => i.id));
          setSelectedItemIds(ids);
          setTransferStep({ step: "select-table", clientId, itemIds: Array.from(ids) });
        } else {
          const ids = new Set(clientItems.map((i) => i.id));
          setSelectedItemIds(ids);
          setTransferStep({ step: "select-items", clientId, clientName });
        }
      }
    }).catch(() => notify.error("No fue posible cargar los datos de la mesa."))
      .finally(() => setLoading(false));
  }, [srcOrder?.id]);

  function handleSelectClient(client: TableOrderClient) {
    const clientItems = rootItems.filter((i) => i.table_order_client_id === client.id);
    const ids = new Set(clientItems.map((i) => i.id));
    setSelectedItemIds(ids);
    if (clientItems.length <= 1) {
      setTransferStep({ step: "select-table", clientId: client.id, itemIds: Array.from(ids) });
    } else {
      setTransferStep({ step: "select-items", clientId: client.id, clientName: client.client_name });
    }
  }

  function toggleItem(id: string) {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll(clientId: string | null) {
    const clientItems = rootItems.filter((i) => i.table_order_client_id === clientId);
    const allSelected = clientItems.every((i) => selectedItemIds.has(i.id));
    if (allSelected) {
      setSelectedItemIds(new Set());
    } else {
      setSelectedItemIds(new Set(clientItems.map((i) => i.id)));
    }
  }

  async function handleTransfer(destTable: RestaurantTable) {
    if (!srcOrder || !session) return;
    const step = transferStep;
    if (!step || step.step !== "select-table") return;
    setSaving(true);
    try {
      let destOrder = allOrders.get(destTable.id) ?? null;
      const destWasFree = !destOrder;
      if (!destOrder) {
        destOrder = await tableOrderService.openOrder(tenantId, destTable.id, cash.id, session.user.id, null);
      }

      // Si el destino ya tenia orden, crear un cliente nuevo para no mezclar con los existentes
      // Si estaba libre, usar el cliente que openOrder ya creo
      let destClientId: string | null;
      if (destWasFree) {
        const destClients = await tableOrderService.getClients(destOrder.id);
        destClientId = destClients[0]?.id ?? null;
      } else {
        const srcClientName = step.clientId ? clients.find((c) => c.id === step.clientId)?.client_name ?? null : null;
        const newClient = await tableOrderService.addClient(destOrder.id, srcClientName);
        destClientId = newClient.id;
      }
      if (!destClientId) throw new Error("Mesa destino sin cliente activo.");

      // Copiar metadata del cliente origen al cliente destino (siempre es un cliente nuevo o recien creado)
      if (step.clientId) {
        await tableOrderService.copyClientMeta(step.clientId, destClientId);
      }

      await tableOrderService.moveItems(step.itemIds, destOrder.id, destClientId);

      // Preservar el opened_at mas antiguo
      if (new Date(srcOrder.opened_at) < new Date(destOrder.opened_at)) {
        await tableOrderService.updateOpenedAt(destOrder.id, srcOrder.opened_at);
        destOrder = { ...destOrder, opened_at: srcOrder.opened_at };
      }

      // Calcular canvasInfo del destino con datos frescos de BD
      const [destClientsRefresh, destItemsRefresh, deliveryTypes] = await Promise.all([
        tableOrderService.getClients(destOrder.id),
        tableOrderService.getItemsForOrder(destOrder.id),
        businessConfigService.deliveryTypes().catch(() => [] as DeliveryType[]),
      ]);
      const destItemsTotal = destItemsRefresh.filter((i) => !i.combo_table_order_item_id).reduce((s, i) => s + i.subtotal, 0);
      const destDomTotal = destClientsRefresh.reduce((s, c) => s + (deliveryTypes.find((d) => d.id === c.delivery_type_id)?.price ?? 0), 0);
      const destCanvasInfo: TableCanvasInfo = {
        clientNames: resolveClientNames(destClientsRefresh, destTable.name),
        total: destItemsTotal + destDomTotal,
      };

      // Verificar si el cliente origen quedo sin items root
      const srcClientId = step.clientId;
      const remaining = await tableOrderService.getItemsForOrder(srcOrder.id);
      const remainingRoot = remaining.filter((i) => !i.combo_table_order_item_id && i.table_order_client_id === srcClientId);
      if (remainingRoot.length === 0 && srcClientId) {
        await tableOrderService.cancelClient(srcClientId);
      }

      // Verificar si la orden origen quedo completamente vacia (sin clientes activos)
      const remainingClients = await tableOrderService.getClients(srcOrder.id);
      const srcFullyEmpty = remainingClients.length === 0;
      if (srcFullyEmpty) {
        await tableOrderService.deleteOrder(srcOrder.id);
      }

      // Calcular canvasInfo del origen actualizado (si aun tiene clientes)
      let srcCanvasInfo: TableCanvasInfo | null = null;
      if (!srcFullyEmpty) {
        const srcItemsRefresh = await tableOrderService.getItemsForOrder(srcOrder.id);
        const srcItemsTotal = srcItemsRefresh.filter((i) => !i.combo_table_order_item_id).reduce((s, i) => s + i.subtotal, 0);
        const srcDomTotal = remainingClients.reduce((s, c) => s + (deliveryTypes.find((d) => d.id === c.delivery_type_id)?.price ?? 0), 0);
        srcCanvasInfo = {
          clientNames: resolveClientNames(remainingClients, srcTable.name),
          total: srcItemsTotal + srcDomTotal,
        };
      }

      notify.success(`Items transferidos a ${destTable.name}.`);
      onTransferred(srcTable.id, destOrder, srcFullyEmpty, destCanvasInfo, srcCanvasInfo);
    } catch (err) {
      notify.error(`Error al transferir: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!srcOrder) {
    return (
      <ModalOverlay title="Transferir mesa" onClose={onClose}>
        <Text color="gray.600">Esta mesa no tiene una orden activa.</Text>
        <Flex mt="6" justify="end"><Button colorPalette="purple" onClick={onClose}>Cerrar</Button></Flex>
      </ModalOverlay>
    );
  }

  if (loading || !transferStep) {
    return (
      <ModalOverlay title="Transferir mesa" onClose={onClose}>
        <Flex justify="center" py="8"><Spinner /></Flex>
      </ModalOverlay>
    );
  }

  // PASO 1: Seleccionar cliente
  if (transferStep.step === "select-client") {
    return (
      <ModalOverlay title={`Transferir - ${srcTable.name}`} onClose={onClose}>
        <Text fontSize="sm" color="gray.600" mb="4">Selecciona el cliente cuyos productos quieres transferir.</Text>
        <Stack gap="2">
          {clients.map((c) => {
            const count = rootItems.filter((i) => i.table_order_client_id === c.id).length;
            return (
              <Box
                key={c.id}
                as="button"
                w="full"
                textAlign="left"
                px="4"
                py="3"
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
                _hover={{ bg: "purple.50", borderColor: "purple.300" }}
                onClick={() => handleSelectClient(c)}
              >
                <Flex align="center" justify="space-between">
                  <Text fontWeight="semibold" fontSize="sm">{c.client_name ?? `Cliente ${c.client_number}`}</Text>
                  <Badge colorPalette="purple">{count} {count === 1 ? "producto" : "productos"}</Badge>
                </Flex>
              </Box>
            );
          })}
        </Stack>
        <Flex mt="5" justify="end"><Button variant="outline" onClick={onClose}>Cancelar</Button></Flex>
      </ModalOverlay>
    );
  }

  // PASO 2: Seleccionar items
  if (transferStep.step === "select-items") {
    const clientId = transferStep.clientId;
    const clientItems = rootItems.filter((i) => i.table_order_client_id === clientId);
    const allSel = clientItems.every((i) => selectedItemIds.has(i.id));
    return (
      <ModalOverlay title={`Transferir - ${srcTable.name}`} onClose={onClose}>
        <Text fontSize="sm" color="gray.600" mb="1">
          {transferStep.clientName ? `Cliente: ${transferStep.clientName}` : `Cliente ${clients.find((c) => c.id === clientId)?.client_number ?? ""}`}
        </Text>
        <Text fontSize="sm" color="gray.500" mb="4">Selecciona los productos a transferir.</Text>
        <Box mb="3">
          <Box
            as="button"
            fontSize="xs"
            color="purple.600"
            fontWeight="semibold"
            onClick={() => toggleAll(clientId)}
          >
            {allSel ? "Quitar todos" : "Seleccionar todos"}
          </Box>
        </Box>
        <Stack gap="2" mb="5" maxH="260px" overflowY="auto" className="content-scroll">
          {clientItems.map((item) => {
            const checked = selectedItemIds.has(item.id);
            return (
              <Flex
                key={item.id}
                as="button"
                align="center"
                gap="3"
                px="3"
                py="2"
                borderWidth="1px"
                borderColor={checked ? "purple.300" : "gray.200"}
                borderRadius="md"
                bg={checked ? "purple.50" : "white"}
                _hover={{ borderColor: "purple.300" }}
                onClick={() => toggleItem(item.id)}
                textAlign="left"
                w="full"
              >
                <Box w="16px" h="16px" borderRadius="3px" borderWidth="2px" borderColor={checked ? "purple.500" : "gray.300"} bg={checked ? "purple.500" : "white"} flexShrink="0" display="flex" alignItems="center" justifyContent="center">
                  {checked && <Check size={10} color="white" />}
                </Box>
                <Box flex="1">
                  <Text fontSize="sm" fontWeight="medium">{item.quantity}x {item.product_name}</Text>
                </Box>
                <Text fontSize="sm" color="gray.500">${item.subtotal.toLocaleString("es-CO")}</Text>
              </Flex>
            );
          })}
        </Stack>
        <Flex justify="space-between" align="center">
          <Button variant="outline" onClick={() => {
            if (clients.length > 1) setTransferStep({ step: "select-client" });
            else onClose();
          }}>Atras</Button>
          <Button
            colorPalette="purple"
            disabled={selectedItemIds.size === 0}
            onClick={() => setTransferStep({ step: "select-table", clientId, itemIds: Array.from(selectedItemIds) })}
          >
            Siguiente
          </Button>
        </Flex>
      </ModalOverlay>
    );
  }

  // PASO 3: Seleccionar mesa destino
  const clientId = transferStep.clientId;
  const itemIds = transferStep.itemIds;
  const itemCount = itemIds.length;
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
      <Box w="full" maxW="520px" bg="white" borderRadius="md" p="6" boxShadow="2xl" maxH="90vh" display="flex" flexDirection="column">
        <Flex justify="space-between" align="center" mb="2">
          <Heading size="md">Seleccionar mesa destino</Heading>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button>
        </Flex>
        <Text fontSize="sm" color="gray.500" mb="4">
          {srcTable.name} &rarr; {itemCount} {itemCount === 1 ? "producto" : "productos"}
        </Text>
        <Box flex="1" overflowY="auto" className="content-scroll">
          {(() => {
            const byFloor = new Map<number, RestaurantTable[]>();
            for (const t of allTables) {
              if (!byFloor.has(t.floor)) byFloor.set(t.floor, []);
              byFloor.get(t.floor)!.push(t);
            }
            return Array.from(byFloor.entries()).sort(([a], [b]) => a - b).map(([floor, floorTables]) => (
              <Box key={floor} mb="4">
                {byFloor.size > 1 && (
                  <Text fontSize="xs" fontWeight="bold" color="gray.400" mb="2" textTransform="uppercase">Piso {floor}</Text>
                )}
                <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(140px, 1fr))" gap="2">
                  {floorTables.map((t) => {
                    const order = allOrders.get(t.id);
                    const isMerged = order?.notes?.startsWith("MERGED:") ?? false;
                    const disabled = saving || isMerged;
                    const status = getTableStatus(order);
                    const color = STATUS_COLORS[status];
                    const label = STATUS_LABELS[status];
                    const card = (
                      <Box
                        key={t.id}
                        as={disabled ? "div" : "button"}
                        w="full"
                        borderWidth="2px"
                        borderColor="gray.200"
                        borderRadius="md"
                        p="3"
                        textAlign="left"
                        opacity={disabled ? 0.45 : 1}
                        cursor={disabled ? "not-allowed" : "pointer"}
                        _hover={!disabled ? { borderColor: "purple.400", bg: "purple.50" } : undefined}
                        onClick={() => !disabled && void handleTransfer(t)}
                      >
                        <Text fontSize="sm" fontWeight="semibold" mb="1" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">{t.name}</Text>
                        <Flex align="center" gap="1">
                          <Box w="9px" h="9px" borderRadius="full" bg={color} flexShrink="0" />
                          <Text fontSize="xs" color="gray.500">{label}</Text>
                        </Flex>
                      </Box>
                    );
                    return (
                      <Box key={t.id}>
                        {isMerged ? <Tip text="Esta mesa esta unida a otra. Desunela primero.">{card}</Tip> : card}
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            ));
          })()}
        </Box>
        <Flex mt="4" justify="start">
          <Button variant="outline" onClick={() => {
            const clientItems = rootItems.filter((i) => i.table_order_client_id === clientId);
            if (clientItems.length <= 1) {
              if (clients.length > 1) setTransferStep({ step: "select-client" });
              else onClose();
            } else {
              const clientName = clients.find((c) => c.id === clientId)?.client_name ?? null;
              setTransferStep({ step: "select-items", clientId, clientName });
            }
          }}>Atras</Button>
        </Flex>
      </Box>
    </Flex>
  );
}
