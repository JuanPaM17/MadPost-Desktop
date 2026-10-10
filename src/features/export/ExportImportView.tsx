import { invoke } from "@tauri-apps/api/core";
import { Box, Button, Flex, Grid, Heading, Spinner, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Database, Download, FileSpreadsheet, Upload, Users } from "lucide-react";
import { useState } from "react";
import { notify } from "../../components/ui/AppToaster";
import { sessionContext } from "../../core/session/SessionContext";
import {
  exportBackupDb,
  exportCajas,
  exportHistorial,
  exportProductos,
  exportUsuarios,
  importBackupDb,
  importProductos,
  importUsuarios,
  type ImportResult,
} from "./ExportImportService";

// ---------------------------------------------------------------------------
// Panel wrapper
// ---------------------------------------------------------------------------
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5">
      {children}
    </Box>
  );
}

function SectionHeading({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <Flex align="center" gap="3" mb="4">
      <Flex w="32px" h="32px" align="center" justify="center" bg="purple.50" color="purple.600" borderRadius="md" shrink="0">
        {icon}
      </Flex>
      <Box>
        <Heading size="sm">{title}</Heading>
        {sub && <Text fontSize="xs" color="gray.500" mt="0.5">{sub}</Text>}
      </Box>
    </Flex>
  );
}

function ImportResultAlert({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const hasErrors = result.errors.length > 0;
  return (
    <Box mt="4" p="4" borderWidth="1px" borderRadius="md"
      borderColor={hasErrors ? "orange.300" : "green.300"}
      bg={hasErrors ? "orange.50" : "green.50"}>
      <Flex justify="space-between" align="start">
        <Box>
          <Text fontWeight="semibold" color={hasErrors ? "orange.700" : "green.700"} fontSize="sm">
            Importacion completada
          </Text>
          <Text fontSize="sm" mt="1" color="gray.700">
            {result.created} creados · {result.updated} actualizados
            {hasErrors ? ` · ${result.errors.length} errores` : ""}
          </Text>
          {hasErrors && (
            <Box mt="2" maxH="120px" overflowY="auto">
              {result.errors.map((e, i) => (
                <Text key={i} fontSize="xs" color="orange.700">{e}</Text>
              ))}
            </Box>
          )}
        </Box>
        <Button size="xs" variant="ghost" onClick={onClose}>Cerrar</Button>
      </Flex>
    </Box>
  );
}

function ExportCard({ title, sub, id, label, icon, busy, onExport }: {
  title: string; sub: string; id: string; label: string; icon: React.ReactNode;
  busy: string | null; onExport: () => void;
}) {
  const loading = busy === id;
  return (
    <Box p="4" borderWidth="1px" borderColor="gray.200" borderRadius="md">
      <Text fontSize="sm" fontWeight="semibold" mb="1">{title}</Text>
      <Text fontSize="xs" color="gray.500" mb="3">{sub}</Text>
      <Button variant="outline" disabled={!!busy} onClick={onExport}>
        {loading ? <Spinner size="xs" /> : icon}
        {loading ? "Exportando..." : label}
      </Button>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// ExportImportView
// ---------------------------------------------------------------------------
export function ExportImportView() {
  const canSeeUsers = sessionContext.hasPermission("users.view");
  const session = sessionContext.current();
  const isAdmin = session?.user.role === "ADMIN" || session?.user.role === "SUPERADMIN";

  const [busy, setBusy] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ key: string; result: ImportResult } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  async function run(key: string, fn: () => Promise<boolean | ImportResult | null>) {
    setBusy(key);
    try {
      const result = await fn();
      if (result === false) return; // usuario canceló dialogo
      if (result === true || result === null) return;
      if (typeof result === "object" && "created" in result) {
        if (result === null) return;
        setImportResult({ key, result: result as ImportResult });
      }
    } catch (e) {
      notify.error("Ocurrio un error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(key: string, fn: () => Promise<boolean>) {
    await run(key, async () => {
      const ok = await fn();
      if (ok) notify.success("Archivo exportado correctamente.");
      return ok;
    });
  }

  async function handleImport(key: string, fn: () => Promise<ImportResult | null>) {
    await run(key, fn);
  }

  async function handleRestoreDb() {
    setBusy("restore-db");
    try {
      const ok = await importBackupDb();
      if (!ok) return;
      notify.success("Base de datos restaurada. La aplicacion se reiniciara en 3 segundos para aplicar los cambios.");
      setTimeout(() => { void invoke("exit_app"); }, 3000);
    } catch (e) {
      notify.error("No fue posible restaurar la base de datos.", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirmRestore(false);
    }
  }

  function ActionButton({ id, label, icon, onClick, variant = "outline", colorPalette = "gray" }: {
    id: string; label: string; icon: React.ReactNode;
    onClick: () => void; variant?: string; colorPalette?: string;
  }) {
    const loading = busy === id;
    return (
      <Button variant={variant as "outline"} colorPalette={colorPalette} disabled={!!busy} onClick={onClick} minW="220px">
        {loading ? <Spinner size="xs" /> : icon}
        {loading ? "Procesando..." : label}
      </Button>
    );
  }

  return (
    <Box maxW="900px" mx="auto">
      <Stack gap="5">

        {/* Seccion 1: Exportar a Excel */}
        <Panel>
          <SectionHeading
            icon={<FileSpreadsheet size={18} />}
            title="Exportar a Excel"
            sub="Genera archivos .xlsx con los datos del negocio."
          />
          <Grid templateColumns="repeat(2, 1fr)" gap="4">
            <ExportCard
              title="Catalogo del negocio"
              sub="12 hojas: Categorias, Productos, Adiciones, Insumos, Insumos_Productos, Combos, Combos_Items, Opciones_Productos, Salsas, Tipos_Domicilio, Descuentos, Mesas."
              id="export-productos"
              label="Exportar catalogo"
              icon={<Download size={16} />}
              busy={busy}
              onExport={() => void handleExport("export-productos", exportProductos)}
            />
            <ExportCard
              title="Historial de Pedidos"
              sub="2 hojas: Pedidos (una fila por venta) y Detalle_Pedidos (una fila por item vendido)."
              id="export-historial"
              label="Exportar historial"
              icon={<Download size={16} />}
              busy={busy}
              onExport={() => void handleExport("export-historial", exportHistorial)}
            />
            <ExportCard
              title="Cajas Registradoras"
              sub="1 hoja: numero, estado, fechas, vendedor, montos iniciales, esperados, reales y totales."
              id="export-cajas"
              label="Exportar cajas"
              icon={<Download size={16} />}
              busy={busy}
              onExport={() => void handleExport("export-cajas", exportCajas)}
            />
            {canSeeUsers && (
              <ExportCard
                title="Usuarios"
                sub="1 hoja: ID, usuario, nombre display, rol y estado activo. Solo administradores."
                id="export-usuarios"
                label="Exportar usuarios"
                icon={<Users size={16} />}
                busy={busy}
                onExport={() => void handleExport("export-usuarios", exportUsuarios)}
              />
            )}
          </Grid>
        </Panel>

        {/* Seccion 2: Importar desde Excel */}
        <Panel>
            <SectionHeading
              icon={<Upload size={18} />}
              title="Importar desde Excel"
              sub="Usa el mismo formato de los archivos exportados. Busca por nombre: actualiza si existe, crea si no."
            />
            <Grid templateColumns="repeat(2, 1fr)" gap="4">
              <Box p="4" borderWidth="1px" borderColor="gray.200" borderRadius="md">
                <Text fontSize="sm" fontWeight="semibold" mb="1">Catalogo del negocio</Text>
                <Text fontSize="xs" color="gray.500" mb="3">
                  Orden de procesamiento: Categorias → Productos → Adiciones → Insumos → Insumos_Productos → Salsas → Opciones_Productos → Combos → Tipos_Domicilio → Descuentos → Mesas.
                </Text>
                <ActionButton
                  id="import-productos"
                  label="Importar catalogo"
                  icon={<Upload size={16} />}
                  colorPalette="purple"
                  onClick={() => void handleImport("import-productos", importProductos)}
                />
                {importResult?.key === "import-productos" && (
                  <ImportResultAlert result={importResult.result} onClose={() => setImportResult(null)} />
                )}
              </Box>

              <Box p="4" borderWidth="1px" borderColor="gray.200" borderRadius="md">
                <Text fontSize="sm" fontWeight="semibold" mb="1">Usuarios</Text>
                <Box mb="3" p="3" bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md">
                  <Flex align="center" gap="2">
                    <AlertTriangle size={14} color="#92400e" />
                    <Text fontSize="xs" color="yellow.800">
                      Nuevos usuarios se crean con contrasena temporal <strong>madpost123</strong>.
                    </Text>
                  </Flex>
                </Box>
                <ActionButton
                  id="import-usuarios"
                  label="Importar usuarios"
                  icon={<Users size={16} />}
                  colorPalette="purple"
                  onClick={() => void handleImport("import-usuarios", importUsuarios)}
                />
                {importResult?.key === "import-usuarios" && (
                  <ImportResultAlert result={importResult.result} onClose={() => setImportResult(null)} />
                )}
              </Box>
            </Grid>
        </Panel>

        {/* Seccion 3: Copia de seguridad local (solo admin) */}
        {isAdmin && <Panel>
            <SectionHeading
              icon={<Database size={18} />}
              title="Copia de seguridad local"
              sub="Copia binaria directa del archivo SQLite (.db)."
            />
            <Stack gap="3">
              <Box>
                <Text fontSize="sm" fontWeight="semibold" mb="1">Exportar backup</Text>
                <Text fontSize="xs" color="gray.500" mb="2">
                  Guarda una copia del archivo de base de datos. El nombre propuesto incluye la fecha de hoy.
                </Text>
                <ActionButton
                  id="export-db"
                  label="Exportar base de datos (.db)"
                  icon={<Download size={16} />}
                  onClick={() => void handleExport("export-db", exportBackupDb)}
                />
              </Box>

              <Box>
                <Text fontSize="sm" fontWeight="semibold" mb="1">Restaurar backup</Text>
                <Box mb="3" p="3" bg="red.50" borderWidth="1px" borderColor="red.200" borderRadius="md">
                  <Flex align="center" gap="2">
                    <AlertTriangle size={15} color="#991b1b" />
                    <Text fontSize="xs" color="red.800" fontWeight="semibold">
                      Accion destructiva: reemplaza toda la base de datos actual con el archivo seleccionado. La aplicacion se reiniciara automaticamente para aplicar los cambios.
                    </Text>
                  </Flex>
                </Box>
                {!confirmRestore ? (
                  <Button variant="outline" colorPalette="red" disabled={!!busy} onClick={() => setConfirmRestore(true)}>
                    <Upload size={16} />Restaurar base de datos (.db)
                  </Button>
                ) : (
                  <Flex gap="2" align="center">
                    <Text fontSize="sm" color="red.700" fontWeight="semibold">¿Confirmas? Se perderan todos los datos actuales.</Text>
                    <Button colorPalette="red" size="sm" disabled={busy === "restore-db"} onClick={() => void handleRestoreDb()}>
                      {busy === "restore-db" ? <Spinner size="xs" /> : null}
                      Si, restaurar
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setConfirmRestore(false)}>Cancelar</Button>
                  </Flex>
                )}
              </Box>
            </Stack>
        </Panel>}

      </Stack>
    </Box>
  );
}
