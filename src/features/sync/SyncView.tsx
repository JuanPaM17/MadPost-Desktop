import { Box, Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, CheckCircle, ChevronDown, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { notify } from "../../components/ui/AppToaster";
import { sessionContext } from "../../core/session/SessionContext";
import { connectivityMonitor } from "./ConnectivityMonitor";
import { fullSyncService, type TableSyncProgress } from "./FullSyncService";
import { migrationService } from "../migration/MigrationService";

// ---------------------------------------------------------------------------
// Store singleton — survives component unmount/remount
// ---------------------------------------------------------------------------

type RowState = {
  tableName: string;
  totalRecords: number;
  status: TableSyncProgress["status"] | "PENDING";
  logLines: string[];
};

type Phase = "idle" | "running" | "done";

type SyncState = {
  phase: Phase;
  rows: RowState[];
  elapsed: number;
  totalElapsed: number | null;
  lastSync: string | undefined;
  doneCount: number;
  totalCount: number;
};

const initialState = (): SyncState => ({
  phase: "idle", rows: [], elapsed: 0, totalElapsed: null,
  lastSync: undefined, doneCount: 0, totalCount: 0,
});

let store: SyncState = initialState();
let timerInterval: ReturnType<typeof setInterval> | null = null;
let startTime = 0;
const listeners = new Set<() => void>();

function notify_listeners() { listeners.forEach((fn) => fn()); }

function setStore(patch: Partial<SyncState>) {
  store = { ...store, ...patch };
  notify_listeners();
}

function startTimer() {
  startTime = Date.now();
  setStore({ elapsed: 0 });
  timerInterval = setInterval(() => {
    setStore({ elapsed: Math.floor((Date.now() - startTime) / 1000) });
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  return Math.floor((Date.now() - startTime) / 1000);
}

function useSyncStore(): SyncState {
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return store;
}

async function runSync() {
  if (store.phase === "running") return;
  if (!connectivityMonitor.isOnline()) {
    notify.error("Sin conexion a internet. Verifica tu red e intenta de nuevo.");
    return;
  }
  const tenantId = sessionContext.current()?.tenantId;
  if (!tenantId) { notify.error("No hay sesion activa."); return; }

  fullSyncService.reset();
  const tables = fullSyncService.tables;
  const initialRows: RowState[] = [
    { tableName: "__reset_nube__", totalRecords: 0, status: "PENDING", logLines: [] },
    ...tables.map((t) => ({ tableName: t, totalRecords: 0, status: "PENDING" as const, logLines: [] })),
  ];
  setStore({ phase: "running", rows: initialRows, doneCount: 0, totalCount: tables.length, totalElapsed: null });
  startTimer();

  const result = await fullSyncService.resetAndSync(tenantId, (progress) => {
    const current = store.rows;
    const index = current.findIndex((r) => r.tableName === progress.tableName);
    const updated = [...current];
    if (index === -1) updated.push({ ...progress });
    else updated[index] = { ...progress };
    const doneCount = updated.filter((r) => r.status === "DONE").length;
    setStore({ rows: updated, doneCount });
  });

  const secs = stopTimer();
  const dateStr = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date());
  setStore({
    phase: "done",
    totalElapsed: secs,
    lastSync: `${dateStr}  --  Duracion: ${formatElapsed(secs)}`,
    doneCount: result.completedTables,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE_NAMES: Record<string, string> = {
  __reset_nube__: "Borrar nube",
  tenants: "Negocio",
  users: "Usuarios",
  categories: "Categorias",
  products: "Productos",
  product_options: "Opciones de producto",
  discounts: "Descuentos",
  additions: "Adiciones",
  sauces: "Salsas",
  supplies: "Insumos",
  product_supplies: "Insumos por producto",
  combos: "Combos",
  combo_items: "Items de combo",
  cash_sessions: "Cajas",
  delivery_types: "Tipos de domicilio",
  sales: "Ventas",
  sale_items: "Items de venta",
  sale_item_additions: "Adiciones de venta",
  sale_item_sauces: "Salsas de venta",
  stock_logs: "Historial de stock",
};

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function JavaSyncCard() {
  const tenantId = sessionContext.current()?.tenantId;
  const [visible, setVisible] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    void Promise.all([migrationService.javaDbExists(), migrationService.isReactMigrated(tenantId)])
      .then(([javaExists, alreadyMigrated]) => setVisible(javaExists && !alreadyMigrated));
  }, [tenantId]);

  if (!visible) return null;

  async function handleSync() {
    if (!tenantId || countdown !== null) return;
    try {
      await migrationService.markMigratedAndReload(tenantId);
    } catch {
      notify.error("No fue posible sincronizar con Java. Intenta de nuevo.");
      return;
    }
    // markMigratedAndReload llama window.location.reload() -- este codigo no corre
  }

  function startCountdown() {
    if (countdown !== null) return;
    setCountdown(5);
    let secs = 5;
    const interval = setInterval(() => {
      secs--;
      setCountdown(secs);
      if (secs <= 0) { clearInterval(interval); void handleSync(); }
    }, 1000);
  }

  return (
    <Panel mb="4">
      <Flex align="start" gap="3">
        <AlertTriangle size={18} color="#d97706" style={{ flexShrink: 0, marginTop: 2 }} />
        <Box flex="1">
          <Heading size="sm">Sincronizar version anterior</Heading>
          <Text mt="1" fontSize="sm" color="gray.600">
            Se detecto una base de datos de una version anterior de MadPost que aun no ha sido sincronizada.
            Al confirmar se marcara la migracion y la app se recargara automaticamente.
          </Text>
          <Button mt="3" colorPalette="orange" disabled={countdown !== null} onClick={startCountdown}>
            <RotateCcw size={15} />
            {countdown !== null ? `Recargando en ${countdown}s...` : "Sincronizar version anterior"}
          </Button>
        </Box>
      </Flex>
    </Panel>
  );
}

export function SyncView({ pendingLastSync }: { pendingLastSync?: string }) {
  const state = useSyncStore();
  const [logOpen, setLogOpen] = useState<string | null>(null);

  // Seed lastSync from prop only if store hasn't run yet
  useEffect(() => {
    if (pendingLastSync && !store.lastSync) setStore({ lastSync: pendingLastSync });
  }, [pendingLastSync]);

  useEffect(() => {
    if (sessionStorage.getItem("auto_full_sync") === "1") {
      sessionStorage.removeItem("auto_full_sync");
      void runSync();
    }
  }, []);

  const isRunning = state.phase === "running";
  const isDone = state.phase === "done";

  return (
    <Box maxW="980px" mx="auto">
      <JavaSyncCard />
      <Panel>
        <Heading size="sm">Sincronizacion completa</Heading>
        <Text mt="2" fontSize="sm" color="gray.600">
          Sube todos los datos locales a la nube. Los datos existentes en la nube se eliminan y se vuelven a subir desde este equipo.
        </Text>

        <Flex mt="4" align="center" gap="3" wrap="wrap">
          <Button colorPalette="purple" disabled={isRunning} onClick={() => void runSync()}>
            <RefreshCw size={16} />
            Sincronizar todo
          </Button>

          {isRunning && (
            <Text fontFamily="mono" fontWeight="bold" color="#6366f1" minW="60px">
              {formatElapsed(state.elapsed)}
            </Text>
          )}

          {isDone && state.totalElapsed !== null && (
            <Text fontFamily="mono" fontWeight="bold" color="gray.500" minW="60px">
              {formatElapsed(state.totalElapsed)}
            </Text>
          )}

          {state.lastSync && (
            <Text fontSize="sm" color="gray.500">
              Ultima sync: {state.lastSync}
            </Text>
          )}
        </Flex>

        {isDone && state.totalElapsed !== null && (
          <Flex
            mt="4" align="center" gap="2" p="3" borderRadius="md"
            bg={state.doneCount === state.totalCount ? "green.50" : "orange.50"}
            borderWidth="1px"
            borderColor={state.doneCount === state.totalCount ? "green.200" : "orange.200"}
          >
            {state.doneCount === state.totalCount
              ? <CheckCircle size={16} color="#10b981" />
              : <AlertTriangle size={16} color="#f59e0b" />}
            <Text
              fontSize="sm" fontWeight="semibold"
              color={state.doneCount === state.totalCount ? "green.700" : "orange.700"}
            >
              {`Completado en ${formatElapsed(state.totalElapsed)}: ${state.doneCount} de ${state.totalCount} tablas sincronizadas.`}
            </Text>
          </Flex>
        )}
      </Panel>

      {state.rows.length > 0 && (
        <Panel mt="4">
          <Stack gap="0" divideY="1px">
            {state.rows.map((row) => (
              <SyncRow
                key={row.tableName}
                row={row}
                logOpen={logOpen === row.tableName}
                onToggleLog={() => setLogOpen(logOpen === row.tableName ? null : row.tableName)}
              />
            ))}
          </Stack>
        </Panel>
      )}

      {state.rows.length === 0 && state.phase === "idle" && (
        <Panel mt="4">
          <Text fontSize="sm" color="gray.400" textAlign="center" py="6">
            Las filas de progreso apareceran aqui al iniciar la sincronizacion.
          </Text>
        </Panel>
      )}
    </Box>
  );
}

function SyncRow({ row, logOpen, onToggleLog }: { row: RowState; logOpen: boolean; onToggleLog: () => void }) {
  const isReset = row.tableName === "__reset_nube__";
  const label = TABLE_NAMES[row.tableName] ?? row.tableName;

  const statusColor =
    row.status === "SYNCING" ? "#6366f1"
    : row.status === "DONE" ? "#10b981"
    : row.status === "ERROR" ? "#ef4444"
    : "#94a3b8";

  const statusLabel =
    row.status === "SYNCING" ? "Procesando..."
    : row.status === "DONE" ? "Listo"
    : row.status === "ERROR" ? "Error"
    : "Pendiente";

  const countLabel =
    row.status === "PENDING" ? "-"
    : row.status === "SYNCING" && row.totalRecords === 0 ? "..."
    : `${row.totalRecords} reg.`;

  return (
    <Box py="2">
      <Flex align="center" gap="2">
        <Text w="210px" flexShrink="0" fontSize="sm" fontWeight={isReset ? "bold" : "normal"} color={isReset ? "#ef4444" : "gray.700"} truncate>
          {label}
        </Text>
        <Text w="110px" flexShrink="0" fontSize="sm" color="gray.400">{countLabel}</Text>
        <Text w="120px" flexShrink="0" fontSize="sm" fontWeight={row.status === "DONE" || row.status === "ERROR" ? "bold" : "normal"} color={statusColor}>
          {statusLabel}
        </Text>
        <Box flex="1" />
        <Button size="xs" variant="ghost" onClick={onToggleLog}>
          <ChevronDown size={14} style={{ transform: logOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
          Ver detalle
        </Button>
      </Flex>
      {logOpen && row.logLines.length > 0 && (
        <Box mt="2" p="3" bg="gray.50" borderRadius="sm" fontFamily="mono" fontSize="xs" color="gray.600" maxH="180px" overflowY="auto" whiteSpace="pre-wrap">
          {row.logLines.join("\n")}
        </Box>
      )}
      {logOpen && row.logLines.length === 0 && (
        <Box mt="2" p="3" bg="gray.50" borderRadius="sm">
          <Text fontSize="xs" color="gray.400">Sin registros de log.</Text>
        </Box>
      )}
    </Box>
  );
}

function Panel({ children, ...props }: React.ComponentProps<typeof Box>) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5" {...props}>
      {children}
    </Box>
  );
}
