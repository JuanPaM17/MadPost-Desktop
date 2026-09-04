import { Badge, Box, Button, Flex, Heading, Input, Stack, Table, Tabs, Text } from "@chakra-ui/react";
import { Check, Pencil, Plus, Power, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { notify } from "../../components/ui/AppToaster";
import { sauceService, type Sauce } from "./SauceService";
import { PaginationControls } from "../../components/ui/PaginationControls";
import { CategoriesTab } from "./CategoriesTab";
import { AdditionsTab } from "./AdditionsTab";
import { ProductsTab } from "./ProductsTab";
import { CombosTab } from "./CombosTab";
import { DiscountsTab } from "./DiscountsTab";

const tabs = ["Productos", "Categorias", "Adiciones", "Salsas", "Combos", "Descuentos"];

export function ProductView() {
  return <Tabs.Root defaultValue="Productos" variant="line" fitted={false}><Tabs.List className="tabs-scroll" overflowX="auto" mb="7">{tabs.map((tab) => <Tabs.Trigger key={tab} value={tab}>{tab}</Tabs.Trigger>)}</Tabs.List>{tabs.map((tab) => <Tabs.Content key={tab} value={tab}>{tab === "Productos" ? <ProductsTab /> : tab === "Salsas" ? <SaucesTab /> : tab === "Categorias" ? <CategoriesTab /> : tab === "Adiciones" ? <AdditionsTab /> : tab === "Combos" ? <CombosTab /> : tab === "Descuentos" ? <DiscountsTab /> : <Flex h="360px" align="center" justify="center"><Text color="gray.500" fontSize="lg">{tab}</Text></Flex>}</Tabs.Content>)}</Tabs.Root>;
}

function SaucesTab() {
  const [sauces, setSauces] = useState<Sauce[]>([]); const [maxSauces, setMaxSauces] = useState(3); const [maxSaucesInput, setMaxSaucesInput] = useState("3"); const [search, setSearch] = useState(""); const [name, setName] = useState(""); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<Sauce | null>(null); const [deleting, setDeleting] = useState<Sauce | null>(null); const [loading, setLoading] = useState(true);
  const filtered = useMemo(() => sauces.filter((sauce) => sauce.name.toLowerCase().includes(search.trim().toLowerCase())), [sauces, search]);
  const pageCount = Math.max(1, pageSize ? Math.ceil(filtered.length / pageSize) : 1);
  const pageItems = pageSize ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;
  useEffect(() => { void load(); }, []);
  async function load() { setLoading(true); try { const [items, maximum] = await Promise.all([sauceService.list(), sauceService.maxSauces()]); setSauces(items); setMaxSauces(maximum); setMaxSaucesInput(String(maximum)); } catch (error) { notify.error("No fue posible cargar las salsas."); } finally { setLoading(false); } }
  async function add() { try { const sauce = await sauceService.save(null, name); setSauces((current) => [...current, sauce].sort(sortSauces)); setName(""); notify.success(`Salsa guardada: ${sauce.name}`); } catch (error) { notify.error(error instanceof Error ? error.message : "No fue posible guardar la salsa."); } }
  async function updateMax(value: string) { setMaxSaucesInput(value); if (!/^\d+$/.test(value)) return; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) return; try { await sauceService.setMaxSauces(parsed); setMaxSauces(parsed); } catch (error) { notify.error(error instanceof Error ? error.message : "No fue posible guardar la configuracion."); } }
  function normalizeMaxInput() { setMaxSaucesInput(String(maxSauces)); }
  async function toggle(sauce: Sauce) { try { await sauceService.setActive(sauce, sauce.active !== 1); setSauces((current) => current.map((item) => item.id === sauce.id ? { ...item, active: item.active === 1 ? 0 : 1 } : item)); notify.success(`Salsa ${sauce.active === 1 ? "desactivada" : "activada"}: ${sauce.name}`); } catch { notify.error("No fue posible actualizar la salsa."); } }
  async function remove() { if (!deleting) return; try { await sauceService.remove(deleting); setSauces((current) => current.filter((item) => item.id !== deleting.id)); notify.success(`Salsa eliminada: ${deleting.name}`); setDeleting(null); } catch { notify.error("No fue posible eliminar la salsa."); } }

  return <Box w="full" maxW="1180px" mx="auto"><Flex align={{ base: "start", md: "center" }} gap="3" wrap="wrap" mb="6"><Text fontWeight="semibold">Maximo de salsas por producto:</Text><Input w="86px" inputMode="numeric" pattern="[0-9]*" value={maxSaucesInput} onChange={(event) => void updateMax(event.target.value)} onBlur={normalizeMaxInput} onKeyDown={(event) => { if (event.key === "Enter") { event.currentTarget.blur(); } }} /><Text color="gray.500" fontSize="sm">Entre 1 y 20</Text></Flex>
    <Flex gap="3" wrap="wrap" mb="5"><Box flex="1" minW={{ base: "full", md: "240px" }} position="relative"><Search size={17} color="#6b7280" style={{ position: "absolute", left: 12, top: 11, zIndex: 1 }} /><Input pl="10" placeholder="Buscar salsa..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></Box><form onSubmit={(event) => { event.preventDefault(); void add(); }}><Flex gap="2" wrap="wrap"><Input w={{ base: "full", md: "280px" }} placeholder="Nombre de la salsa (ej: Ketchup)" value={name} onChange={(event) => setName(event.target.value)} /><Button type="submit" colorPalette="purple" disabled={!name.trim()}><Plus size={18} />Agregar</Button></Flex></form></Flex>
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden"><Box overflowX="auto"><Table.Root size="sm" minW="650px"><Table.Header><Table.Row><Table.ColumnHeader>Nombre</Table.ColumnHeader><Table.ColumnHeader w="120px">Estado</Table.ColumnHeader><Table.ColumnHeader w="270px" textAlign="right">Acciones</Table.ColumnHeader></Table.Row></Table.Header><Table.Body>{pageItems.map((sauce) => <Table.Row key={sauce.id}><Table.Cell fontWeight="semibold">{sauce.name}</Table.Cell><Table.Cell><Badge colorPalette={sauce.active === 1 ? "green" : "gray"}>{sauce.active === 1 ? "Activa" : "Inactiva"}</Badge></Table.Cell><Table.Cell textAlign="right"><Flex justify="end" gap="2"><Button size="sm" variant="outline" onClick={() => setEditing(sauce)}><Pencil size={16} />Editar</Button><Button size="sm" colorPalette={sauce.active === 1 ? "red" : "gray"} variant={sauce.active === 1 ? "outline" : "solid"} onClick={() => void toggle(sauce)}><Power size={16} />{sauce.active === 1 ? "Desactivar" : "Activar"}</Button><Button size="sm" variant="outline" colorPalette="red" onClick={() => setDeleting(sauce)}><Trash2 size={16} />Eliminar</Button></Flex></Table.Cell></Table.Row>)}{!loading && !pageItems.length ? <Table.Row><Table.Cell colSpan={3}><Text py="10" textAlign="center" color="gray.500">No hay salsas para mostrar.</Text></Table.Cell></Table.Row> : null}{loading ? <Table.Row><Table.Cell colSpan={3}><Text py="10" textAlign="center" color="gray.500">Cargando salsas...</Text></Table.Cell></Table.Row> : null}</Table.Body></Table.Root></Box><PaginationControls total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} /></Box>
    {editing ? <SauceDialog sauce={editing} onClose={() => setEditing(null)} onSaved={(sauce) => { setSauces((current) => current.map((item) => item.id === sauce.id ? sauce : item)); setEditing(null); notify.success(`Salsa guardada: ${sauce.name}`); }} /> : null}
    {deleting ? <ConfirmDelete sauce={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} /> : null}
  </Box>;
}

function SauceDialog({ sauce, onClose, onSaved }: { sauce: Sauce; onClose: () => void; onSaved: (sauce: Sauce) => void }) {
  const [name, setName] = useState(sauce.name); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  async function save() { setSaving(true); setError(""); try { onSaved(await sauceService.save(sauce, name)); } catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible guardar la salsa."); setSaving(false); } }
  return <Modal><Heading size="md">Editar salsa</Heading><Text mt="2" color="gray.500">Actualiza el nombre que se mostrara en el punto de venta.</Text><Text mt="5" mb="2" fontSize="sm" fontWeight="semibold">Nombre</Text><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); }} />{error ? <Text mt="3" color="red.600" fontSize="sm">{error}</Text> : null}<Flex justify="end" gap="3" mt="6"><Button variant="outline" onClick={onClose} disabled={saving}><X size={17} />Cancelar</Button><Button colorPalette="purple" onClick={() => void save()} disabled={saving || !name.trim()}><Check size={17} />{saving ? "Guardando..." : "Guardar"}</Button></Flex></Modal>;
}

function ConfirmDelete({ sauce, onCancel, onConfirm }: { sauce: Sauce; onCancel: () => void; onConfirm: () => void }) { return <Modal><Heading size="md">Eliminar salsa</Heading><Text mt="3" color="gray.600">Eliminar salsa '{sauce.name}'? Esta accion no se puede deshacer.</Text><Flex justify="end" gap="3" mt="6"><Button variant="outline" onClick={onCancel}>Cancelar</Button><Button colorPalette="red" onClick={onConfirm}><Trash2 size={17} />Eliminar</Button></Flex></Modal>; }
function Modal({ children }: { children: React.ReactNode }) { return <Flex position="fixed" zIndex="modal" inset="0" bg="blackAlpha.500" align="center" justify="center" p="6"><Box w="full" maxW="460px" bg="white" borderRadius="md" boxShadow="2xl" p="7">{children}</Box></Flex>; }
function sortSauces(left: Sauce, right: Sauce) { return right.active - left.active || left.name.localeCompare(right.name); }
