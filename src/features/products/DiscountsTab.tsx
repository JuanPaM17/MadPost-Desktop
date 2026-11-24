import { Badge, Box, Button, Checkbox, Flex, Grid, Heading, Input, Stack, Table, Text } from "@chakra-ui/react";
import { Check, Layers, Pencil, Plus, Power, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { notify } from "../../components/ui/AppToaster";
import { PaginationControls } from "../../components/ui/PaginationControls";
import { ScrollableSelect } from "../../components/ui/ScrollableSelect";
import { applyDiscount, discountService, displayValue, isEffective, type Discount, type DiscountProductOption, type DiscountType } from "./DiscountService";
import { categoryService, type Category } from "./CategoryService";
import { appCache } from "../../infrastructure/AppCache";

export function DiscountsTab({ canEdit }: { canEdit: boolean }) {
  const [discounts, setDiscounts] = useState<Discount[]>([]); const [search, setSearch] = useState(""); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(10); const [loading, setLoading] = useState(true); const [editing, setEditing] = useState<Discount | null | undefined>(undefined); const [deleting, setDeleting] = useState<Discount | null>(null); const [bulkOpen, setBulkOpen] = useState(false);
  const filtered = useMemo(() => discounts.filter((discount) => discount.productName?.toLowerCase().includes(search.trim().toLowerCase())), [discounts, search]); const pageItems = pageSize ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;
  useEffect(() => { void load(); }, []);
  async function load() { appCache.invalidate("products"); setLoading(true); try { setDiscounts(await discountService.list()); } catch { notify.error("No fue posible cargar los descuentos."); } finally { setLoading(false); } }
  async function toggle(discount: Discount) { try { await discountService.setActive(discount, discount.active !== 1); await load(); notify.success(`Descuento ${discount.active === 1 ? "desactivado" : "activado"}.`); } catch (error) { notify.error(error instanceof Error ? error.message : "No fue posible actualizar el descuento."); } }
  async function remove() { if (!deleting) return; try { await discountService.remove(deleting); setDeleting(null); await load(); notify.success("Descuento eliminado."); } catch { notify.error("No fue posible eliminar el descuento."); } }
  return <Box w="full" maxW="1280px" mx="auto"><Flex gap="3" wrap="wrap" mb="5"><Box flex="1" minW={{ base: "full", md: "240px" }} position="relative"><Search size={17} color="#6b7280" style={{ position: "absolute", left: 12, top: 11, zIndex: 1 }} /><Input pl="10" placeholder="Buscar por producto..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></Box>{canEdit ? <><Button variant="outline" colorPalette="purple" onClick={() => setBulkOpen(true)}><Layers size={18} />Descuento masivo</Button><Button colorPalette="purple" onClick={() => setEditing(null)}><Plus size={18} />Nuevo descuento</Button></> : null}</Flex><Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden"><Box overflowX="auto"><Table.Root size="sm" minW="840px"><Table.Header><Table.Row><Table.ColumnHeader>Producto</Table.ColumnHeader><Table.ColumnHeader w="130px">Precio original</Table.ColumnHeader><Table.ColumnHeader w="110px">Valor</Table.ColumnHeader><Table.ColumnHeader w="140px">Precio final</Table.ColumnHeader><Table.ColumnHeader w="130px">Estado</Table.ColumnHeader>{canEdit ? <Table.ColumnHeader w="280px" textAlign="right">Acciones</Table.ColumnHeader> : null}</Table.Row></Table.Header><Table.Body>{pageItems.map((discount) => <Table.Row key={discount.id}><Table.Cell fontWeight="semibold">{discount.productName ?? "Producto eliminado"}</Table.Cell><Table.Cell color="gray.600">${formatPrice(discount.productPrice ?? 0)}</Table.Cell><Table.Cell>{displayValue(discount)}</Table.Cell><Table.Cell color="green.600" fontWeight="bold">${formatPrice(applyDiscount(discount, discount.productPrice ?? 0))}</Table.Cell><Table.Cell><Status discount={discount} /></Table.Cell>{canEdit ? <Table.Cell textAlign="right"><Flex justify="end" gap="2"><Button size="sm" variant="outline" onClick={() => setEditing(discount)}><Pencil size={16} />Editar</Button><Button size="sm" colorPalette={discount.active === 1 ? "red" : "gray"} variant={discount.active === 1 ? "outline" : "solid"} onClick={() => void toggle(discount)}><Power size={16} />{discount.active === 1 ? "Desactivar" : "Activar"}</Button><Button size="sm" variant="outline" colorPalette="red" onClick={() => setDeleting(discount)}><Trash2 size={16} />Eliminar</Button></Flex></Table.Cell> : null}</Table.Row>)}{loading ? <EmptyRow message="Cargando descuentos..." cols={canEdit ? 6 : 5} /> : null}{!loading && !pageItems.length ? <EmptyRow message="No hay descuentos para mostrar." cols={canEdit ? 6 : 5} /> : null}</Table.Body></Table.Root></Box><PaginationControls total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} /></Box>{canEdit && editing !== undefined ? <DiscountDialog discount={editing} onClose={() => setEditing(undefined)} onSaved={async (discount) => { setEditing(undefined); await load(); notify.success(`${editing ? "Descuento guardado" : "Descuento creado"}: ${discount.productName}`); }} /> : null}{deleting ? <ConfirmDelete discount={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} /> : null}{canEdit && bulkOpen ? <BulkDiscountDialog onClose={() => setBulkOpen(false)} onSaved={async (count) => { setBulkOpen(false); await load(); notify.success(`${count} descuento${count !== 1 ? "s" : ""} creado${count !== 1 ? "s" : ""}.`); }} /> : null}</Box>;
}

function DiscountDialog({ discount, onClose, onSaved }: { discount: Discount | null; onClose: () => void; onSaved: (discount: Discount) => Promise<void> }) {
  const [products, setProducts] = useState<DiscountProductOption[]>([]); const [productId, setProductId] = useState(discount?.productId ?? ""); const [discountType, setDiscountType] = useState<DiscountType>(discount?.discountType ?? "PERCENT"); const [value, setValue] = useState(discount ? String(discount.discountValue) : ""); const [startDate, setStartDate] = useState(toDateInput(discount?.startDate)); const [endDate, setEndDate] = useState(toDateInput(discount?.endDate)); const [active, setActive] = useState(discount?.active !== 0); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  useEffect(() => { void discountService.activeProducts().then((items) => { setProducts(discount && !items.some((item) => item.id === discount.productId) && discount.productName ? [{ id: discount.productId, name: discount.productName, price: discount.productPrice ?? 0 }, ...items] : items); }).catch(() => setError("No fue posible cargar los productos activos.")); }, [discount]);
  const product = products.find((item) => item.id === productId); const numericValue = Number(discountType === "FIXED_PRICE" ? value.replace(/[.,]/g, "") : value); const preview = product && Number.isFinite(numericValue) && numericValue > 0 ? discountType === "PERCENT" ? product.price * (1 - numericValue / 100) : numericValue : null;
  async function save() { if (!productId) { setError("Selecciona un producto."); return; } if (!value.trim()) { setError("Ingresa el valor del descuento."); return; } setSaving(true); setError(""); try { await onSaved(await discountService.save(discount, { productId, productName: product?.name ?? "Producto", productPrice: product?.price ?? 0, discountType, discountValue: numericValue, active, startDate: startDate ? `${startDate}T00:00:00.000Z` : null, endDate: endDate ? `${endDate}T23:59:59.999Z` : null })); } catch (reason) { const message = reason instanceof Error ? reason.message : "No fue posible guardar el descuento."; setError(message); notify.error(message); setSaving(false); } }
  return <Modal><Heading size="md">{discount ? "Editar descuento" : "Nuevo descuento"}</Heading><Stack mt="5" gap="4"><Field label="Producto *"><ScrollableSelect placement="bottom" value={productId} placeholder="Selecciona un producto" options={products.map((product) => ({ value: product.id, label: product.name }))} onValueChange={setProductId} /></Field>{product ? <Text fontSize="sm" color="gray.500">Precio actual: ${formatPrice(product.price)}</Text> : null}<Field label="Tipo de descuento"><Flex gap="2"><Button flex="1" variant={discountType === "PERCENT" ? "solid" : "outline"} colorPalette={discountType === "PERCENT" ? "purple" : "gray"} onClick={() => setDiscountType("PERCENT")}>Porcentaje (%)</Button><Button flex="1" variant={discountType === "FIXED_PRICE" ? "solid" : "outline"} colorPalette={discountType === "FIXED_PRICE" ? "purple" : "gray"} onClick={() => setDiscountType("FIXED_PRICE")}>Precio directo ($)</Button></Flex></Field><Field label="Valor *"><Input inputMode="decimal" placeholder={discountType === "PERCENT" ? "Ej: 20 (para 20% de descuento)" : "Ej: 12000 (nuevo precio)"} value={value} onChange={(event) => setValue(event.target.value)} /></Field>{preview !== null && preview >= 0 ? <Text color="green.600" fontWeight="bold">Precio final: ${formatPrice(preview)}</Text> : null}<Box><Text mb="2" fontSize="sm" fontWeight="semibold">Vigencia (opcional)</Text><Flex gap="3" direction={{ base: "column", sm: "row" }}><Field label="Desde"><Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></Field><Field label="Hasta"><Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field></Flex></Box><Checkbox.Root checked={active} onCheckedChange={(details) => setActive(details.checked === true)}><Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>Activo</Checkbox.Label></Checkbox.Root></Stack>{error ? <Text mt="3" color="red.600" fontSize="sm">{error}</Text> : null}<Flex justify="end" gap="3" mt="6"><Button variant="outline" disabled={saving} onClick={onClose}><X size={17} />Cancelar</Button><Button colorPalette="purple" disabled={saving} onClick={() => void save()}><Check size={17} />{saving ? "Guardando..." : "Guardar"}</Button></Flex></Modal>;
}
function Status({ discount }: { discount: Discount }) { if (discount.active !== 1) return <Badge colorPalette="gray">Inactivo</Badge>; if (!isEffective(discount)) return <Badge colorPalette="orange">Fuera de fecha</Badge>; return <Badge colorPalette="green">Activo</Badge>; }
function ConfirmDelete({ discount, onCancel, onConfirm }: { discount: Discount; onCancel: () => void; onConfirm: () => void }) { return <Modal compact><Heading size="md">Eliminar descuento</Heading><Text mt="3" color="gray.600">Eliminar descuento de '{discount.productName ?? "este producto"}'? Esta accion no se puede deshacer.</Text><Flex justify="end" gap="3" mt="6"><Button variant="outline" onClick={onCancel}>Cancelar</Button><Button colorPalette="red" onClick={onConfirm}><Trash2 size={17} />Eliminar</Button></Flex></Modal>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <Box flex="1"><Text mb="2" fontSize="sm" fontWeight="semibold">{label}</Text>{children}</Box>; }
function EmptyRow({ message, cols = 5 }: { message: string; cols?: number }) { return <Table.Row><Table.Cell colSpan={cols}><Text py="10" textAlign="center" color="gray.500">{message}</Text></Table.Cell></Table.Row>; }
function Modal({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) { return <Flex position="fixed" zIndex="modal" inset="0" bg="blackAlpha.500" align="center" justify="center" p="4"><Box w="full" maxW={compact ? "460px" : "520px"} maxH="calc(100vh - 48px)" overflowY="auto" bg="white" borderRadius="md" boxShadow="2xl" p={{ base: "5", md: "7" }}>{children}</Box></Flex>; }
function formatPrice(value: number) { return new Intl.NumberFormat("es-CO", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value); }
function toDateInput(value: string | null | undefined) { return value?.slice(0, 10) ?? ""; }

function BulkDiscountDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (count: number) => Promise<void> }) {
  const [products, setProducts] = useState<DiscountProductOption[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [discountType, setDiscountType] = useState<DiscountType>("PERCENT");
  const [value, setValue] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [active, setActive] = useState(true);
  const [categoryId, setCategoryId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([discountService.activeProducts(), categoryService.list(), discountService.list()])
      .then(([prods, cats, discs]) => { setProducts(prods); setCategories(cats); setDiscounts(discs); })
      .catch(() => setError("No fue posible cargar los productos."));
  }, []);

  const activeDiscountProductIds = useMemo(() => new Set(discounts.filter(isEffective).map((d) => d.productId)), [discounts]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => p.name.toLowerCase().includes(q) && !selectedIds.has(p.id)).slice(0, 8);
  }, [searchQuery, products, selectedIds]);

  function addProduct(id: string) { setSelectedIds((prev) => new Set([...prev, id])); setSearchQuery(""); }
  function removeProduct(id: string) { setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; }); }

  function addCategory(catId: string) {
    if (!catId) return;
    const catProducts = products.filter((p) => p.categoryId === catId);
    setSelectedIds((prev) => new Set([...prev, ...catProducts.map((p) => p.id)]));
    setCategoryId("");
  }

  const selectedProducts = useMemo(() => products.filter((p) => selectedIds.has(p.id)), [products, selectedIds]);
  const numericValue = Number(discountType === "FIXED_PRICE" ? value.replace(/[.,]/g, "") : value);

  function computePreview(price: number) {
    if (!Number.isFinite(numericValue) || numericValue <= 0) return null;
    return discountType === "PERCENT" ? price * (1 - numericValue / 100) : numericValue;
  }

  function validate(): string | null {
    if (selectedIds.size === 0) return "Selecciona al menos un producto.";
    if (!value.trim() || !Number.isFinite(numericValue) || numericValue <= 0) return "El valor debe ser mayor a 0.";
    if (discountType === "PERCENT" && numericValue >= 100) return "El porcentaje debe ser menor a 100.";
    if (discountType === "FIXED_PRICE") {
      const invalid = selectedProducts.filter((p) => numericValue >= p.price);
      if (invalid.length > 0) return `El precio fijo debe ser menor al precio original. Productos con conflicto: ${invalid.map((p) => `${p.name} ($${formatPrice(p.price)})`).join(", ")}.`;
    }
    return null;
  }

  async function save() {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true); setError("");
    try {
      const results = await discountService.saveBulk(
        [...selectedIds],
        { discountType, discountValue: numericValue, active, startDate: startDate ? `${startDate}T00:00:00.000Z` : null, endDate: endDate ? `${endDate}T23:59:59.999Z` : null },
        products,
      );
      await onSaved(results.length);
    } catch (reason) {
      const msg = reason instanceof Error ? reason.message : "No fue posible guardar los descuentos.";
      setError(msg);
      setSaving(false);
    }
  }

  const withActiveDiscount = selectedProducts.filter((p) => activeDiscountProductIds.has(p.id));
  const invalidPriceIds = useMemo(() => discountType === "FIXED_PRICE" && numericValue > 0 ? new Set(selectedProducts.filter((p) => numericValue >= p.price).map((p) => p.id)) : new Set<string>(), [discountType, numericValue, selectedProducts]);

  return (
    <Flex position="fixed" zIndex="modal" inset="0" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="900px" maxH="calc(100vh - 48px)" overflowY="auto" bg="white" borderRadius="md" boxShadow="2xl" p={{ base: "5", md: "7" }}>
        <Heading size="md" mb="5">Descuento masivo</Heading>
        <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="6">
          {/* Columna izquierda: configuracion */}
          <Stack gap="4">
            <Heading size="sm" color="gray.600">Configuracion del descuento</Heading>
            <Field label="Tipo de descuento">
              <Flex gap="2">
                <Button flex="1" variant={discountType === "PERCENT" ? "solid" : "outline"} colorPalette={discountType === "PERCENT" ? "purple" : "gray"} onClick={() => setDiscountType("PERCENT")}>Porcentaje (%)</Button>
                <Button flex="1" variant={discountType === "FIXED_PRICE" ? "solid" : "outline"} colorPalette={discountType === "FIXED_PRICE" ? "purple" : "gray"} onClick={() => setDiscountType("FIXED_PRICE")}>Precio directo ($)</Button>
              </Flex>
            </Field>
            <Field label="Valor *">
              <Input inputMode="decimal" placeholder={discountType === "PERCENT" ? "Ej: 20 (para 20%)" : "Ej: 12000 (nuevo precio)"} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Box>
              <Text mb="2" fontSize="sm" fontWeight="semibold">Vigencia (opcional)</Text>
              <Flex gap="3" direction={{ base: "column", sm: "row" }}>
                <Field label="Desde"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
                <Field label="Hasta"><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
              </Flex>
            </Box>
            <Checkbox.Root checked={active} onCheckedChange={(details) => setActive(details.checked === true)}>
              <Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>Activo</Checkbox.Label>
            </Checkbox.Root>
            <Box bg="purple.50" borderRadius="md" px="3" py="2">
              <Text fontSize="sm" color="purple.700" fontWeight="semibold">
                Se aplicara a {selectedIds.size} producto{selectedIds.size !== 1 ? "s" : ""} seleccionado{selectedIds.size !== 1 ? "s" : ""}
              </Text>
              {withActiveDiscount.length > 0 ? (
                <Text fontSize="xs" color="orange.600" mt="1">
                  {withActiveDiscount.length} ya tiene{withActiveDiscount.length !== 1 ? "n" : ""} descuento activo (se desactivara el anterior)
                </Text>
              ) : null}
            </Box>
            {error ? <Text color="red.600" fontSize="sm">{error}</Text> : null}
          </Stack>

          {/* Columna derecha: selector */}
          <Stack gap="4">
            <Heading size="sm" color="gray.600">Seleccion de productos</Heading>
            <Field label="Agregar por categoria">
              <ScrollableSelect
                placement="bottom"
                value={categoryId}
                placeholder="Selecciona una categoria"
                options={categories.map((c) => ({ value: c.id, label: c.name }))}
                onValueChange={(id) => { setCategoryId(id); addCategory(id); }}
              />
            </Field>
            <Field label="Buscar producto">
              <Box position="relative">
                <Search size={16} color="#6b7280" style={{ position: "absolute", left: 10, top: 10, zIndex: 1 }} />
                <Input pl="9" placeholder="Nombre del producto..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
              </Box>
              {searchResults.length > 0 ? (
                <Box mt="1" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" boxShadow="md" overflow="hidden">
                  {searchResults.map((p) => (
                    <Box key={p.id} px="3" py="2" cursor="pointer" _hover={{ bg: "gray.50" }} onClick={() => addProduct(p.id)}>
                      <Text fontSize="sm" fontWeight="semibold">{p.name}</Text>
                      <Text fontSize="xs" color="gray.500">${formatPrice(p.price)}</Text>
                    </Box>
                  ))}
                </Box>
              ) : null}
            </Field>
            <Box>
              <Text fontSize="sm" fontWeight="semibold" mb="2">Productos seleccionados ({selectedIds.size})</Text>
              {selectedProducts.length === 0 ? (
                <Text fontSize="sm" color="gray.400">Ninguno todavia. Agrega por categoria o busqueda.</Text>
              ) : (
                <Stack gap="1" maxH="260px" overflowY="auto" pr="1">
                  {selectedProducts.map((p) => {
                    const finalPrice = computePreview(p.price);
                    const hasActive = activeDiscountProductIds.has(p.id);
                    const invalidPrice = invalidPriceIds.has(p.id);
                    return (
                      <Flex key={p.id} align="center" gap="2" bg={invalidPrice ? "red.50" : "gray.50"} borderRadius="md" px="3" py="2">
                        <Box flex="1" minW="0">
                          <Flex align="center" gap="2" wrap="wrap">
                            <Text fontSize="sm" fontWeight="semibold" noOfLines={1}>{p.name}</Text>
                            {hasActive ? <Badge colorPalette="orange" size="sm">Ya tiene descuento</Badge> : null}
                          </Flex>
                          <Flex gap="2" align="center">
                            <Text fontSize="xs" color="gray.500">${formatPrice(p.price)}</Text>
                            {finalPrice !== null && finalPrice >= 0 ? (
                              <><Text fontSize="xs" color="gray.400">-&gt;</Text><Text fontSize="xs" color="green.600" fontWeight="bold">${formatPrice(finalPrice)}</Text></>
                            ) : null}
                          </Flex>
                        </Box>
                        <Button size="xs" variant="ghost" colorPalette="red" onClick={() => removeProduct(p.id)}><X size={14} /></Button>
                      </Flex>
                    );
                  })}
                </Stack>
              )}
            </Box>
          </Stack>
        </Grid>

        <Flex justify="end" gap="3" mt="6">
          <Button variant="outline" disabled={saving} onClick={onClose}><X size={17} />Cancelar</Button>
          <Button colorPalette="purple" disabled={saving || selectedIds.size === 0} onClick={() => void save()}>
            <Check size={17} />{saving ? "Guardando..." : `Guardar ${selectedIds.size > 0 ? selectedIds.size : ""} descuento${selectedIds.size !== 1 ? "s" : ""}`}
          </Button>
        </Flex>
      </Box>
    </Flex>
  );
}
