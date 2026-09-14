import { Badge, Box, Button, Flex, Grid, Input, Spinner, Text } from "@chakra-ui/react";
import { Flame, Minus, Plus, Search, ShoppingCart, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tip } from "../../components/ui/Tip";
import { businessConfigService } from "../config/BusinessConfigService";
import { posService, type PosAddition, type PosCategory, type PosCombo, type PosComboItem, type PosProduct, type PosSauce } from "./PosService";

// ---------------------------------------------------------------------------
// Tipos exportados
// ---------------------------------------------------------------------------
export type SelectedCategory = "all" | "combos" | string;
export type PosGridItem = ({ kind: "product" } & PosProduct) | ({ kind: "combo" } & PosCombo);

export type CartChild = {
  productId: string;
  name: string;
  quantity: number;
  showAdditions: boolean;
  showSauces: boolean;
  additions: Record<string, number>;   // additionId → qty
  sauces: string[];                    // sauceId[]
  options: string[];
  selectedOption: string | null;
};
export type CartItem = {
  key: string;
  name: string;
  price: number;
  quantity: number;
  kind: "product" | "combo";
  note: string;
  showAdditions: boolean;
  showSauces: boolean;
  additions: Record<string, number>;
  sauces: string[];
  options: string[];
  selectedOption: string | null;
  categoryName: string | null;
  children: CartChild[];
};

// Resultado que emite ProductCatalogPanel al confirmar
export type CatalogConfirmResult = {
  items: CartItem[];
  additions: PosAddition[];
  sauces: PosSauce[];
  maxSauces: number;
};

// ---------------------------------------------------------------------------
// Helpers exportados
// ---------------------------------------------------------------------------
export function itemExtras(item: CartItem, additions: PosAddition[]) {
  const amount = (quantities: Record<string, number>, multiplier = 1) =>
    additions.reduce((total, a) => total + (quantities[a.id] ?? 0) * a.price * multiplier, 0);
  return amount(item.additions) + item.children.reduce((total, child) => total + amount(child.additions, child.quantity), 0);
}

export function filterItems<T extends { name: string; description?: string | null }>(items: T[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  return items.filter((item) => !query || item.name.toLocaleLowerCase().includes(query) || (item.description ?? "").toLocaleLowerCase().includes(query));
}

export function money(value: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

// ---------------------------------------------------------------------------
// CategoryBar / CategoryButton
// ---------------------------------------------------------------------------
export function CategoryBar({ categories, selected, hasCombos, onSelect }: { categories: PosCategory[]; selected: SelectedCategory; hasCombos: boolean; onSelect: (value: SelectedCategory) => void }) {
  return (
    <Box overflowX="auto" className="pos-category-scroll">
      <Flex w="max-content" gap="2" pb="2">
        <CategoryButton active={selected === "all"} onClick={() => onSelect("all")}>Todos</CategoryButton>
        {categories.map((c) => (
          <CategoryButton key={c.id} active={selected === c.id} onClick={() => onSelect(c.id)}>{c.name}</CategoryButton>
        ))}
        {hasCombos ? <CategoryButton active={selected === "combos"} onClick={() => onSelect("combos")}>Combos</CategoryButton> : null}
      </Flex>
    </Box>
  );
}

export function CategoryButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button size="sm" borderRadius="sm" variant={active ? "solid" : "outline"} colorPalette={active ? "purple" : "gray"} onClick={onClick}>{children}</Button>;
}

// ---------------------------------------------------------------------------
// ProductGrid — con stock local
// ---------------------------------------------------------------------------
export function ProductGrid({
  products, combos, loading, stockMap = new Map(), threshold = 5, onAdd,
}: {
  products: PosProduct[];
  combos: PosCombo[];
  loading: boolean;
  stockMap?: Map<string, number>;
  threshold?: number;
  onAdd: (item: PosGridItem) => void;
}) {
  const items: PosGridItem[] = [
    ...products.map((p) => ({ ...p, kind: "product" as const })),
    ...combos.map((c) => ({ ...c, kind: "combo" as const })),
  ];
  if (loading) return <Flex flex="1" minH="0" py="16" justify="center"><Spinner color="#6366f1" /></Flex>;
  if (!items.length) return <Text flex="1" py="16" textAlign="center" color="gray.500">No hay productos para mostrar.</Text>;
  return (
    <Box mt="5" flex="1" minH="0" overflowY="auto" pr="2">
      <Grid templateColumns="repeat(auto-fill, 158px)" gap="3">
        {items.map((item) => {
          // Para combos, el stock efectivo es el mínimo de sus hijos
          let curStock: number | null = null;
          if (item.kind === "product") {
            curStock = stockMap.has(item.id) ? stockMap.get(item.id)! : (item.stock ?? null);
          } else {
            const childStocks = item.items.map((child) => stockMap.has(child.productId) ? stockMap.get(child.productId)! : null).filter((s): s is number => s !== null);
            curStock = childStocks.length > 0 ? Math.min(...childStocks) : null;
          }
          const empty = curStock !== null && curStock <= 0;
          const low = !empty && curStock !== null && curStock <= threshold;
          const product = item.kind === "product" ? item : null;
          const discounted = Boolean(product && product.price !== product.originalPrice);

          const comboTooltip = item.kind === "combo"
            ? item.items.map((part) => `${part.quantity > 1 ? `${part.quantity}x ` : ""}${part.name}`).join(" + ")
            : null;

          return (
            <Button
              key={`${item.kind}-${item.id}`}
              w="158px" h="100px" p="3"
              alignItems="stretch" justifyContent="space-between" flexDirection="column"
              bg={empty ? "red.50" : low ? "orange.50" : "white"}
              borderWidth="1px"
              borderColor={empty ? "red.300" : low ? "orange.300" : "gray.200"}
              color="gray.800"
              _hover={{ bg: "purple.50", borderColor: "purple.300" }}
              onClick={() => onAdd(item)}
            >
              <Box minW="0">
                <Text textAlign="left" truncate fontSize="sm" fontWeight="semibold">{item.name}</Text>
                {item.kind === "combo" ? (
                  <Tip text={comboTooltip ?? ""}>
                    <Text mt="1" lineClamp="1" color="gray.500" fontSize="xs">{comboTooltip}</Text>
                  </Tip>
                ) : (
                  <Tip text={product?.description || "Sin descripcion"}>
                    <Text mt="1" w="full" truncate color="gray.500" fontSize="xs">{product?.description || "Sin descripcion"}</Text>
                  </Tip>
                )}
              </Box>
              <Flex w="full" justify="space-between" align="end" gap="1">
                {discounted && product
                  ? <><Text color="gray.400" fontSize="xs" textDecoration="line-through">{money(product.originalPrice)}</Text><Text color="green.600" fontSize="sm" fontWeight="bold">{money(product.price)}</Text></>
                  : <Text color="purple.700" fontSize="sm" fontWeight="bold">{money(item.price)}</Text>}
                {curStock !== null
                  ? <Text color={empty ? "red.600" : low ? "orange.700" : "gray.500"} fontSize="xs">{curStock}</Text>
                  : null}
              </Flex>
            </Button>
          );
        })}
      </Grid>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// AdditionsGrid — grid reutilizable de adiciones (3 columnas)
// ---------------------------------------------------------------------------
export function AdditionsGrid({ additions, quantities, onChange }: {
  additions: PosAddition[];
  quantities: Record<string, number>;
  onChange: (id: string, delta: number) => void;
}) {
  return (
    <Grid templateColumns="repeat(3, 1fr)" gap="3">
      {additions.map((addition) => {
        const quantity = quantities[addition.id] ?? 0;
        const disabled = addition.stock !== null && addition.stock <= 0;
        return (
          <Flex
            key={addition.id}
            direction="column"
            align="center"
            justify="space-between"
            borderWidth="2px"
            borderColor={quantity ? "purple.400" : "gray.200"}
            bg={quantity ? "purple.50" : "white"}
            borderRadius="md"
            p="3"
            gap="2"
            minH="100px"
          >
            <Box textAlign="center">
              <Text fontSize="sm" fontWeight={quantity ? "semibold" : "normal"} lineClamp={2} lineHeight="1.3">{addition.name}</Text>
              {addition.price ? <Text fontSize="xs" color="purple.600" mt="0.5">+{money(addition.price)}</Text> : <Text fontSize="xs" color="gray.400" mt="0.5">gratis</Text>}
            </Box>
            <Flex align="center" gap="2">
              <Button size="xs" variant="outline" disabled={!quantity} onClick={() => onChange(addition.id, -1)}><Minus size={12} /></Button>
              <Text minW="16px" textAlign="center" fontSize="sm" fontWeight="semibold">{quantity}</Text>
              <Button size="xs" colorPalette="purple" disabled={disabled} onClick={() => onChange(addition.id, 1)}><Plus size={12} /></Button>
            </Flex>
          </Flex>
        );
      })}
    </Grid>
  );
}

// AdditionsModal
// ---------------------------------------------------------------------------
export function AdditionsModal({ name, additions, quantities, onClose, onChange, onConfirm, confirmLabel = "Listo" }: {
  name: string;
  additions: PosAddition[];
  quantities: Record<string, number>;
  onClose: () => void;
  onChange: (id: string, delta: number) => void;
  onConfirm?: () => void;
  confirmLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const filtered = search.trim()
    ? additions.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : additions;
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="560px" bg="white" boxShadow="2xl" borderRadius="md" display="flex" flexDirection="column" maxH="calc(100vh - 48px)">
        <Box p="6" pb="3">
          <Flex justify="space-between" align="center">
            <Text fontWeight="bold" fontSize="lg">Adiciones</Text>
            <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
          </Flex>
          <Text mt="1" color="gray.500" fontSize="sm">{name}</Text>
          {additions.length > 6 && (
            <Box mt="3" position="relative">
              <Search size={16} color="#64748b" style={{ position: "absolute", left: 11, top: 11, zIndex: 1 }} />
              <Input pl="9" size="sm" placeholder="Buscar adicion..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </Box>
          )}
        </Box>
        <Box overflowY="auto" px="6" flex="1">
          <AdditionsGrid additions={filtered} quantities={quantities} onChange={onChange} />
        </Box>
        <Box p="6" pt="4">
          <Flex justify="end" gap="2">
            {onConfirm
              ? <><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button colorPalette="purple" onClick={onConfirm}>{confirmLabel}</Button></>
              : <Button variant="outline" onClick={onClose}>Listo</Button>}
          </Flex>
        </Box>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// SaucesModal
// ---------------------------------------------------------------------------
export function SaucesModal({ name, sauces, maxSauces, selected, onClose, onToggle, onConfirm, confirmLabel = "Listo" }: {
  name: string;
  sauces: PosSauce[];
  maxSauces: number;
  selected: string[];
  onClose: () => void;
  onToggle: (id: string) => void;
  onConfirm?: () => void;
  confirmLabel?: string;
}) {
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="480px" maxH="calc(100vh - 48px)" overflowY="auto" bg="white" p="6" boxShadow="2xl" borderRadius="md">
        <Flex justify="space-between" align="center">
          <Text fontWeight="bold" fontSize="lg">Salsas</Text>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>
        <Text mt="1" color="gray.500" fontSize="sm">{name}</Text>
        <Flex mt="1" align="center" gap="1">
          <Flame size={13} color={selected.length > 0 ? "#16a34a" : "#94a3b8"} />
          <Text fontSize="xs" color={selected.length >= maxSauces ? "green.600" : "gray.400"}>{selected.length} / {maxSauces} seleccionadas</Text>
        </Flex>
        <Flex mt="4" gap="2" wrap="wrap">
          {sauces.map((sauce) => {
            const active = selected.includes(sauce.id);
            const maxed = !active && selected.length >= maxSauces;
            return <Button key={sauce.id} size="sm" variant={active ? "solid" : "outline"} colorPalette="green" opacity={maxed ? 0.4 : 1} disabled={maxed} onClick={() => onToggle(sauce.id)}>{sauce.name}</Button>;
          })}
        </Flex>
        <Flex mt="6" justify="end" gap="2">
          {onConfirm
            ? <><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button colorPalette="green" onClick={onConfirm}>{confirmLabel}</Button></>
            : <Button variant="outline" onClick={onClose}>Listo</Button>}
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// OptionModal — picker de opciones
// ---------------------------------------------------------------------------
export function OptionModal({ name, options, selected, onClose, onConfirm }: {
  name: string;
  options: string[];
  selected: string | null;
  onClose: () => void;
  onConfirm: (option: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(selected ?? options[0] ?? null);
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="400px" bg="white" p="6" boxShadow="2xl" borderRadius="md">
        <Flex justify="space-between" align="center" mb="1">
          <Text fontWeight="bold" fontSize="lg">Opciones</Text>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>
        <Text color="gray.500" fontSize="sm" mb="4">{name}</Text>
        <Flex gap="2" wrap="wrap">
          {options.map((opt) => (
            <Button key={opt} size="sm" variant={picked === opt ? "solid" : "outline"} colorPalette={picked === opt ? "orange" : "gray"} onClick={() => setPicked(opt)}>{opt}</Button>
          ))}
        </Flex>
        <Flex mt="6" justify="end" gap="2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button colorPalette="purple" disabled={!picked} onClick={() => picked && onConfirm(picked)}>Continuar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDialog — stock agotado
// ---------------------------------------------------------------------------
function ConfirmDialog({ message, onCancel, onConfirm }: { message: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="4">
      <Box w="full" maxW="380px" bg="white" p="6" boxShadow="2xl" borderRadius="md">
        <Text fontWeight="bold" mb="3">Sin stock</Text>
        <Text color="gray.600" fontSize="sm" mb="6">{message}</Text>
        <Flex justify="end" gap="3">
          <Button variant="outline" onClick={onCancel}>Cancelar</Button>
          <Button colorPalette="orange" onClick={onConfirm}>Agregar igual</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// ComboAdditionsModal — adiciones de varios hijos agrupadas
// ---------------------------------------------------------------------------
function ComboAdditionsModal({ comboChildren, additions, additionsByChild, onClose, onChange, onConfirm, confirmLabel }: {
  comboChildren: PosComboItem[];
  additions: PosAddition[];
  additionsByChild: Map<string, Record<string, number>>;
  onClose: () => void;
  onChange: (productId: string, additionId: string, delta: number) => void;
  onConfirm: () => void;
  confirmLabel: string;
}) {
  const childrenWithAdditions = comboChildren.filter((c) => c.showAdditions);
  if (!childrenWithAdditions.length) { onConfirm(); return null; }
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
      <Box w="full" maxW="560px" maxH="calc(100vh - 48px)" overflowY="auto" bg="white" p="6" boxShadow="2xl" borderRadius="md">
        <Flex justify="space-between" align="center" mb="1">
          <Text fontWeight="bold" fontSize="lg">Adiciones del combo</Text>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
        </Flex>
        {childrenWithAdditions.map((child) => {
          const quantities = additionsByChild.get(child.productId) ?? {};
          const label = child.quantity > 1 ? `${child.quantity}x ${child.name}${child.selectedOption ? ` [${child.selectedOption}]` : ""}` : `${child.name}${child.selectedOption ? ` [${child.selectedOption}]` : ""}`;
          return (
            <Box key={child.productId} mt="4">
              <Text fontSize="sm" fontWeight="semibold" color="gray.600" mb="2">{label}:</Text>
              <AdditionsGrid
                additions={additions}
                quantities={quantities}
                onChange={(additionId, delta) => onChange(child.productId, additionId, delta)}
              />
            </Box>
          );
        })}
        <Flex mt="6" justify="end" gap="2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button colorPalette="purple" onClick={onConfirm}>{confirmLabel}</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// MiniCart — carrito temporal derecho
// ---------------------------------------------------------------------------
function MiniCart({ items, additions, sauces, onRemove, onEditAdditions, onEditSauces, onEditOption, onConfirm, onCancel }: {
  items: CartItem[];
  additions: PosAddition[];
  sauces: PosSauce[];
  onRemove: (key: string) => void;
  onEditAdditions: (key: string, childId?: string) => void;
  onEditSauces: (key: string, childId?: string) => void;
  onEditOption: (key: string, childId?: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const total = items.reduce((s, item) => s + (item.price + itemExtras(item, additions)) * item.quantity, 0);
  return (
    <Flex direction="column" w="280px" shrink="0" borderLeftWidth="1px" borderColor="gray.200" bg="gray.50" h="full" minH="0">
      <Flex px="4" py="3" align="center" gap="2" borderBottomWidth="1px" borderColor="gray.200" bg="white">
        <ShoppingCart size={16} color="#4f46e5" />
        <Text fontWeight="semibold" fontSize="sm">Pedido actual</Text>
        {items.length > 0 ? <Badge colorPalette="purple" ml="auto">{items.length}</Badge> : null}
      </Flex>
      {items.length === 0
        ? <Flex flex="1" align="center" justify="center" p="4"><Text color="gray.400" fontSize="xs" textAlign="center">Agrega productos para verlos aqui.</Text></Flex>
        : (
          <Box flex="1" minH="0" overflowY="auto" p="3">
            {items.map((item) => (
              <Box key={item.key} mb="3" pb="3" borderBottomWidth="1px" borderColor="gray.200">
                <Flex justify="space-between" align="start" gap="1">
                  <Box minW="0">
                    <Text fontSize="sm" fontWeight="semibold" truncate>{item.quantity > 1 ? `${item.quantity}x ` : ""}{item.name}</Text>
                    {item.kind === "combo" ? <Badge size="xs" colorPalette="blue" variant="subtle" mt="0.5">Combo</Badge> : null}
                  </Box>
                  <Button size="xs" variant="ghost" colorPalette="red" flexShrink="0" onClick={() => onRemove(item.key)}><Trash2 size={13} /></Button>
                </Flex>
                {item.options.length > 0
                  ? <Button size="xs" variant="ghost" colorPalette="orange" mt="0.5" onClick={() => onEditOption(item.key)}>Opcion: {item.selectedOption ?? "—"}</Button>
                  : null}
                {item.showAdditions
                  ? <Button size="xs" variant="ghost" colorPalette="purple" onClick={() => onEditAdditions(item.key)}>
                    {Object.values(item.additions).some((q) => q > 0)
                      ? additions.filter((a) => (item.additions[a.id] ?? 0) > 0).map((a) => `${item.additions[a.id]}x ${a.name}`).join(", ")
                      : "+ Adiciones"}
                  </Button>
                  : null}
                {item.showSauces && sauces.length > 0
                  ? <Button size="xs" variant="ghost" colorPalette="green" onClick={() => onEditSauces(item.key)}>
                    {item.sauces.length > 0 ? sauces.filter((s) => item.sauces.includes(s.id)).map((s) => s.name).join(", ") : "+ Salsas"}
                  </Button>
                  : null}
                {item.children.map((child) => (
                  <Box key={child.productId} pl="2" mt="1" borderLeftWidth="2px" borderColor="gray.300">
                    <Text fontSize="xs" color="gray.600">- {child.quantity > 1 ? `${child.quantity}x ` : ""}{child.name}{child.selectedOption ? ` [${child.selectedOption}]` : ""}</Text>
                    {child.showAdditions
                      ? <Button size="xs" variant="ghost" colorPalette="purple" onClick={() => onEditAdditions(item.key, child.productId)}>
                        {Object.values(child.additions).some((q) => q > 0)
                          ? additions.filter((a) => (child.additions[a.id] ?? 0) > 0).map((a) => `${child.additions[a.id]}x ${a.name}`).join(", ")
                          : "+ Adiciones"}
                      </Button>
                      : null}
                    {child.showSauces && sauces.length > 0
                      ? <Button size="xs" variant="ghost" colorPalette="green" onClick={() => onEditSauces(item.key, child.productId)}>
                        {child.sauces.length > 0 ? sauces.filter((s) => child.sauces.includes(s.id)).map((s) => s.name).join(", ") : "+ Salsas"}
                      </Button>
                      : null}
                    {child.options.length > 0
                      ? <Button size="xs" variant="ghost" colorPalette="orange" onClick={() => onEditOption(item.key, child.productId)}>
                        Opcion: {child.selectedOption ?? "—"}
                      </Button>
                      : null}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )}
      <Box px="4" py="3" borderTopWidth="1px" borderColor="gray.200" bg="white">
        <Flex justify="space-between" align="center" mb="3">
          <Text fontSize="sm" fontWeight="semibold" color="gray.600">Subtotal</Text>
          <Text fontSize="sm" fontWeight="bold" color="purple.700">{money(total)}</Text>
        </Flex>
        <Flex gap="2">
          <Button size="sm" variant="outline" flex="1" onClick={onCancel}>Cancelar</Button>
          <Button size="sm" colorPalette="purple" flex="1" disabled={items.length === 0} onClick={onConfirm}>Confirmar</Button>
        </Flex>
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Tipo para los pasos pendientes del flujo de un item
// ---------------------------------------------------------------------------
type PendingStep =
  | { type: "stockConfirm"; item: PosGridItem }
  | { type: "option"; item: PosGridItem; childId?: string; options: string[] }
  | { type: "additions"; item: PosGridItem }
  | { type: "comboAdditions"; item: PosGridItem & { kind: "combo" }; additionsByChild: Map<string, Record<string, number>> }
  | { type: "sauces"; item: PosGridItem; childId?: string }
  | { type: "comboSauces"; item: PosGridItem & { kind: "combo" }; childIdx: number };

// ---------------------------------------------------------------------------
// ProductCatalogPanel
// Panel completo: categorías + buscador + grid + mini-carrito derecho.
// onConfirm se llama cuando el usuario presiona "Confirmar" con el carrito.
// onCancel se llama si presiona Cancelar.
// ---------------------------------------------------------------------------
export function ProductCatalogPanel({ onConfirm, onCancel }: {
  onConfirm: (result: CatalogConfirmResult) => void;
  onCancel: () => void;
}) {
  const [categories, setCategories] = useState<PosCategory[]>([]);
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [combos, setCombos] = useState<PosCombo[]>([]);
  const [selected, setSelected] = useState<SelectedCategory>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [additions, setAdditions] = useState<PosAddition[]>([]);
  const [sauces, setSauces] = useState<PosSauce[]>([]);
  const [maxSauces, setMaxSauces] = useState(3);
  const [threshold, setThreshold] = useState(5);
  const [stockMap, setStockMap] = useState<Map<string, number>>(new Map());
  const [cart, setCart] = useState<CartItem[]>([]);

  // Flujo pendiente: step actual + item en proceso
  const [pending, setPending] = useState<PendingStep | null>(null);
  // Item en construccion durante el flujo
  const pendingCartItem = useRef<CartItem | null>(null);
  // Para edicion desde mini-carrito
  const [editTarget, setEditTarget] = useState<{ key: string; childId?: string; mode: "additions" | "sauces" | "option" } | null>(null);

  const loadItems = useCallback(async (selection: SelectedCategory) => {
    setLoading(true);
    try {
      if (selection === "combos") { setProducts([]); setCombos(await posService.combos()); }
      else { setCombos([]); setProducts(await posService.products(selection === "all" ? null : selection)); }
    } finally { setLoading(false); }
  }, []);

  const [hasCombos, setHasCombos] = useState(false);
  useEffect(() => {
    void Promise.all([posService.categories(), posService.combos()]).then(([cats, cms]) => { setCategories(cats); setHasCombos(cms.length > 0); }).catch(() => setCategories([]));
  }, []);
  useEffect(() => { void posService.additions().then(setAdditions).catch(() => setAdditions([])); }, []);
  useEffect(() => { void posService.sauces().then(({ items, max }) => { setSauces(items); setMaxSauces(max); }).catch(() => {}); }, []);
  useEffect(() => { void businessConfigService.load().then((s) => setThreshold(s.stockAlertThreshold)).catch(() => {}); }, []);
  useEffect(() => { void loadItems(selected); }, [loadItems, selected]);

  // Cargar stock inicial de productos cuando cambia la lista
  useEffect(() => {
    const ids = [...products.map((p) => p.id), ...combos.flatMap((c) => c.items.map((ci) => ci.productId))];
    if (!ids.length) return;
    setStockMap((prev) => {
      const next = new Map(prev);
      // Solo inicializa los que no tengamos ya en el mapa local
      for (const p of products) {
        if (!next.has(p.id) && p.stock !== null) next.set(p.id, p.stock);
      }
      return next;
    });
  }, [products, combos]);

  const productItems = useMemo(() => filterItems(products, search), [products, search]);
  const comboItems = useMemo(() => filterItems(combos, search), [combos, search]);

  // ---------- helpers de flujo ----------

  function startFlow(item: PosGridItem) {
    // Verificar stock
    let empty = false;
    if (item.kind === "product") {
      const s = stockMap.has(item.id) ? stockMap.get(item.id)! : item.stock;
      empty = s !== null && s <= 0;
    } else {
      empty = item.items.some((child) => {
        const s = stockMap.has(child.productId) ? stockMap.get(child.productId)! : null;
        return s !== null && s <= 0;
      });
    }
    if (empty) { setPending({ type: "stockConfirm", item }); return; }
    beginItem(item);
  }

  function beginItem(item: PosGridItem) {
    if (item.kind === "product") {
      const ci: CartItem = {
        key: `product:${item.id}:${Date.now()}`,
        name: item.name,
        price: item.price,
        quantity: 1,
        kind: "product",
        note: "",
        showAdditions: item.showAdditions,
        showSauces: item.showSauces,
        additions: {},
        sauces: [],
        options: item.options,
        selectedOption: item.options.length > 0 ? item.options[0] : null,
        categoryName: item.categoryName,
        children: [],
      };
      pendingCartItem.current = ci;
      if (item.options.length > 0) {
        setPending({ type: "option", item, options: item.options });
      } else if (item.showAdditions && additions.length > 0) {
        setPending({ type: "additions", item });
      } else if (item.showSauces && sauces.length > 0) {
        setPending({ type: "sauces", item });
      } else {
        commitItem(ci, item);
      }
    } else {
      // combo
      const children: CartChild[] = item.items.map((child) => ({
        productId: child.productId,
        name: child.name,
        quantity: child.quantity,
        showAdditions: child.showAdditions,
        showSauces: child.showSauces,
        additions: {},
        sauces: [],
        options: child.options,
        selectedOption: child.options.length > 0 ? child.options[0] : null,
      }));
      const ci: CartItem = {
        key: `combo:${item.id}:${Date.now()}`,
        name: item.name,
        price: item.price,
        quantity: 1,
        kind: "combo",
        note: "",
        showAdditions: false,
        showSauces: false,
        additions: {},
        sauces: [],
        options: [],
        selectedOption: null,
        categoryName: null,
        children,
      };
      pendingCartItem.current = ci;
      // Paso 1 de combo: opciones del primer hijo que las tenga
      const firstWithOptions = children.findIndex((c) => c.options.length > 0);
      if (firstWithOptions >= 0) {
        const child = children[firstWithOptions];
        setPending({ type: "option", item, childId: child.productId, options: child.options });
      } else {
        continueComboAfterOptions(item as PosGridItem & { kind: "combo" }, ci);
      }
    }
  }

  function continueComboAfterOptions(item: PosGridItem & { kind: "combo" }, ci: CartItem) {
    // Adiciones agrupadas
    const childrenWithAdditions = ci.children.filter((c) => c.showAdditions);
    if (childrenWithAdditions.length > 0 && additions.length > 0) {
      const addByChild = new Map<string, Record<string, number>>();
      for (const c of childrenWithAdditions) addByChild.set(c.productId, {});
      setPending({ type: "comboAdditions", item, additionsByChild: addByChild });
    } else {
      continueComboAfterAdditions(item, ci, new Map());
    }
  }

  function continueComboAfterAdditions(item: PosGridItem & { kind: "combo" }, ci: CartItem, addByChild: Map<string, Record<string, number>>) {
    // Aplicar adiciones al ci
    if (pendingCartItem.current) {
      pendingCartItem.current = {
        ...pendingCartItem.current,
        children: pendingCartItem.current.children.map((c) => ({
          ...c,
          additions: addByChild.get(c.productId) ?? {},
        })),
      };
    }
    // Salsas: por cada hijo que las tenga
    const firstWithSauces = ci.children.findIndex((c) => c.showSauces);
    if (firstWithSauces >= 0 && sauces.length > 0) {
      setPending({ type: "comboSauces", item, childIdx: firstWithSauces });
    } else {
      commitItem(pendingCartItem.current!, item);
    }
  }

  function commitItem(ci: CartItem, item: PosGridItem) {
    // Decrementar stock local
    setStockMap((prev) => {
      const next = new Map(prev);
      if (item.kind === "product" && next.has(item.id)) {
        next.set(item.id, Math.max(0, next.get(item.id)! - 1));
      } else if (item.kind === "combo") {
        for (const child of item.items) {
          if (next.has(child.productId)) {
            next.set(child.productId, Math.max(0, next.get(child.productId)! - child.quantity));
          }
        }
      }
      return next;
    });
    setCart((prev) => [...prev, ci]);
    setPending(null);
    pendingCartItem.current = null;
  }

  function cancelFlow() {
    setPending(null);
    pendingCartItem.current = null;
  }

  // ---------- handlers de pasos ----------

  function handleStockConfirm() {
    const item = (pending as { type: "stockConfirm"; item: PosGridItem }).item;
    setPending(null);
    beginItem(item);
  }

  function handleOptionConfirm(option: string) {
    if (!pendingCartItem.current || !pending) return;
    const p = pending as { type: "option"; item: PosGridItem; childId?: string };
    if (p.childId) {
      // opcion de hijo de combo
      pendingCartItem.current = {
        ...pendingCartItem.current,
        children: pendingCartItem.current.children.map((c) =>
          c.productId === p.childId ? { ...c, selectedOption: option } : c,
        ),
      };
      // siguiente hijo con opciones
      const currentIdx = pendingCartItem.current.children.findIndex((c) => c.productId === p.childId);
      const nextWithOptions = pendingCartItem.current.children.findIndex((c, i) => i > currentIdx && c.options.length > 0);
      if (nextWithOptions >= 0) {
        const nextChild = pendingCartItem.current.children[nextWithOptions];
        setPending({ type: "option", item: p.item, childId: nextChild.productId, options: nextChild.options });
      } else {
        continueComboAfterOptions(p.item as PosGridItem & { kind: "combo" }, pendingCartItem.current);
      }
    } else {
      // opcion de producto simple
      pendingCartItem.current = { ...pendingCartItem.current, selectedOption: option };
      if (p.item.kind === "product" && p.item.showAdditions && additions.length > 0) {
        setPending({ type: "additions", item: p.item });
      } else if (p.item.kind === "product" && p.item.showSauces && sauces.length > 0) {
        setPending({ type: "sauces", item: p.item });
      } else {
        commitItem(pendingCartItem.current, p.item);
      }
    }
  }

  function handleAdditionsDone() {
    if (!pendingCartItem.current || !pending) return;
    const p = pending as { type: "additions"; item: PosGridItem };
    if (p.item.kind === "product" && p.item.showSauces && sauces.length > 0) {
      setPending({ type: "sauces", item: p.item });
    } else {
      commitItem(pendingCartItem.current, p.item);
    }
  }

  function handleComboAdditionsDone(addByChild: Map<string, Record<string, number>>) {
    if (!pendingCartItem.current || !pending) return;
    const p = pending as { type: "comboAdditions"; item: PosGridItem & { kind: "combo" } };
    continueComboAfterAdditions(p.item, pendingCartItem.current, addByChild);
  }

  function handleSaucesDone() {
    if (!pendingCartItem.current || !pending) return;
    const p = pending as { type: "sauces"; item: PosGridItem };
    commitItem(pendingCartItem.current, p.item);
  }

  function handleComboSaucesDone() {
    if (!pendingCartItem.current || !pending) return;
    const p = pending as { type: "comboSauces"; item: PosGridItem & { kind: "combo" }; childIdx: number };
    // siguiente hijo con salsas
    const nextIdx = pendingCartItem.current.children.findIndex((c, i) => i > p.childIdx && c.showSauces);
    if (nextIdx >= 0 && sauces.length > 0) {
      setPending({ type: "comboSauces", item: p.item, childIdx: nextIdx });
    } else {
      commitItem(pendingCartItem.current, p.item);
    }
  }

  // ---------- edicion desde mini-carrito ----------

  function handleEditAdditions(key: string, childId?: string) {
    setEditTarget({ key, childId, mode: "additions" });
  }
  function handleEditSauces(key: string, childId?: string) {
    setEditTarget({ key, childId, mode: "sauces" });
  }
  function handleEditOption(key: string, childId?: string) {
    setEditTarget({ key, childId, mode: "option" });
  }

  function applyEditAddition(id: string, delta: number) {
    if (!editTarget) return;
    setCart((prev) => prev.map((item) => {
      if (item.key !== editTarget.key) return item;
      if (editTarget.childId) {
        return { ...item, children: item.children.map((c) => c.productId !== editTarget.childId ? c : { ...c, additions: { ...c.additions, [id]: Math.max(0, (c.additions[id] ?? 0) + delta) } }) };
      }
      return { ...item, additions: { ...item.additions, [id]: Math.max(0, (item.additions[id] ?? 0) + delta) } };
    }));
  }

  function applyEditSauce(id: string) {
    if (!editTarget) return;
    setCart((prev) => prev.map((item) => {
      if (item.key !== editTarget.key) return item;
      if (editTarget.childId) {
        return { ...item, children: item.children.map((c) => {
          if (c.productId !== editTarget.childId) return c;
          const has = c.sauces.includes(id);
          if (!has && c.sauces.length >= maxSauces) return c;
          return { ...c, sauces: has ? c.sauces.filter((s) => s !== id) : [...c.sauces, id] };
        }) };
      }
      const has = item.sauces.includes(id);
      if (!has && item.sauces.length >= maxSauces) return item;
      return { ...item, sauces: has ? item.sauces.filter((s) => s !== id) : [...item.sauces, id] };
    }));
  }

  function applyEditOption(option: string) {
    if (!editTarget) return;
    setCart((prev) => prev.map((item) => {
      if (item.key !== editTarget.key) return item;
      if (editTarget.childId) {
        return { ...item, children: item.children.map((c) => c.productId !== editTarget.childId ? c : { ...c, selectedOption: option }) };
      }
      return { ...item, selectedOption: option };
    }));
  }

  // edit target item/child
  const editItem = editTarget ? cart.find((i) => i.key === editTarget.key) : null;
  const editChild = editItem && editTarget?.childId ? editItem.children.find((c) => c.productId === editTarget.childId) : null;
  const editAdditions = editChild?.additions ?? editItem?.additions ?? {};
  const editSauces = editChild?.sauces ?? editItem?.sauces ?? [];
  const editOptions = editChild?.options ?? editItem?.options ?? [];
  const editSelectedOption = editChild?.selectedOption ?? editItem?.selectedOption ?? null;
  const editName = editChild ? editChild.name : (editItem?.name ?? "");

  return (
    <Flex h="full" minH="0">
      {/* Izquierda: catálogo */}
      <Flex direction="column" flex="1" minW="0" minH="0" pr="3">
        <CategoryBar categories={categories} selected={selected} hasCombos={hasCombos} onSelect={setSelected} />
        <Box mt="4" position="relative">
          <Search size={18} color="#64748b" style={{ position: "absolute", left: 13, top: 12, zIndex: 1 }} />
          <Input pl="11" placeholder="Buscar producto..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </Box>
        <ProductGrid products={productItems} combos={comboItems} loading={loading} stockMap={stockMap} threshold={threshold} onAdd={startFlow} />
      </Flex>

      {/* Derecha: mini-carrito */}
      <MiniCart
        items={cart}
        additions={additions}
        sauces={sauces}
        onRemove={(key) => setCart((prev) => prev.filter((i) => i.key !== key))}
        onEditAdditions={handleEditAdditions}
        onEditSauces={handleEditSauces}
        onEditOption={handleEditOption}
        onConfirm={() => onConfirm({ items: cart, additions, sauces, maxSauces })}
        onCancel={onCancel}
      />

      {/* Flujo de agregar */}
      {pending?.type === "stockConfirm" ? (
        <ConfirmDialog
          message={`${pending.item.name} no tiene stock disponible. ¿Deseas agregarlo igualmente?`}
          onCancel={cancelFlow}
          onConfirm={handleStockConfirm}
        />
      ) : null}

      {pending?.type === "option" ? (
        <OptionModal
          name={`${pending.item.name}${pending.childId ? ` — ${pendingCartItem.current?.children.find((c) => c.productId === pending.childId)?.name ?? ""}` : ""}`}
          options={pending.options}
          selected={
            pending.childId
              ? (pendingCartItem.current?.children.find((c) => c.productId === pending.childId)?.selectedOption ?? null)
              : (pendingCartItem.current?.selectedOption ?? null)
          }
          onClose={cancelFlow}
          onConfirm={handleOptionConfirm}
        />
      ) : null}

      {pending?.type === "additions" && pendingCartItem.current ? (
        <AdditionsModal
          name={pending.item.name}
          additions={additions}
          quantities={pendingCartItem.current.additions}
          onClose={cancelFlow}
          onChange={(id, delta) => {
            if (!pendingCartItem.current) return;
            pendingCartItem.current = { ...pendingCartItem.current, additions: { ...pendingCartItem.current.additions, [id]: Math.max(0, (pendingCartItem.current.additions[id] ?? 0) + delta) } };
            // fuerza re-render pasando por un state auxiliar
            setPending({ ...pending });
          }}
          onConfirm={handleAdditionsDone}
          confirmLabel={pending.item.kind === "product" && pending.item.showSauces && sauces.length > 0 ? "Siguiente: Salsas" : "Agregar"}
        />
      ) : null}

      {pending?.type === "comboAdditions" ? (
        <ComboAdditionsModal
          comboChildren={pending.item.items}
          additions={additions}
          additionsByChild={pending.additionsByChild}
          onClose={cancelFlow}
          onChange={(productId, additionId, delta) => {
            setPending((prev) => {
              if (!prev || prev.type !== "comboAdditions") return prev;
              const next = new Map(prev.additionsByChild);
              const cur = next.get(productId) ?? {};
              next.set(productId, { ...cur, [additionId]: Math.max(0, (cur[additionId] ?? 0) + delta) });
              return { ...prev, additionsByChild: next };
            });
          }}
          onConfirm={() => {
            if (pending.type === "comboAdditions") handleComboAdditionsDone(pending.additionsByChild);
          }}
          confirmLabel={pendingCartItem.current?.children.some((c) => c.showSauces) && sauces.length > 0 ? "Siguiente: Salsas" : "Agregar"}
        />
      ) : null}

      {pending?.type === "sauces" && pendingCartItem.current ? (
        <SaucesModal
          name={pending.item.name}
          sauces={sauces}
          maxSauces={maxSauces}
          selected={pendingCartItem.current.sauces}
          onClose={cancelFlow}
          onToggle={(id) => {
            if (!pendingCartItem.current) return;
            const has = pendingCartItem.current.sauces.includes(id);
            if (!has && pendingCartItem.current.sauces.length >= maxSauces) return;
            pendingCartItem.current = { ...pendingCartItem.current, sauces: has ? pendingCartItem.current.sauces.filter((s) => s !== id) : [...pendingCartItem.current.sauces, id] };
            setPending({ ...pending });
          }}
          onConfirm={handleSaucesDone}
          confirmLabel="Agregar"
        />
      ) : null}

      {pending?.type === "comboSauces" && pendingCartItem.current ? (() => {
        const child = pendingCartItem.current.children[pending.childIdx];
        return (
          <SaucesModal
            name={`${pending.item.name} — ${child.name}`}
            sauces={sauces}
            maxSauces={maxSauces}
            selected={child.sauces}
            onClose={cancelFlow}
            onToggle={(id) => {
              if (!pendingCartItem.current) return;
              const ci = pendingCartItem.current;
              const ch = ci.children[pending.childIdx];
              const has = ch.sauces.includes(id);
              if (!has && ch.sauces.length >= maxSauces) return;
              const newSauces = has ? ch.sauces.filter((s) => s !== id) : [...ch.sauces, id];
              pendingCartItem.current = { ...ci, children: ci.children.map((c, i) => i === pending.childIdx ? { ...c, sauces: newSauces } : c) };
              setPending({ ...pending });
            }}
            onConfirm={handleComboSaucesDone}
            confirmLabel={(() => {
              const nextIdx = pendingCartItem.current?.children.findIndex((c, i) => i > pending.childIdx && c.showSauces) ?? -1;
              return nextIdx >= 0 ? "Siguiente" : "Agregar";
            })()}
          />
        );
      })() : null}

      {/* Edicion desde mini-carrito */}
      {editTarget?.mode === "additions" && editItem ? (
        <AdditionsModal
          name={editName}
          additions={additions}
          quantities={editAdditions}
          onClose={() => setEditTarget(null)}
          onChange={applyEditAddition}
        />
      ) : null}
      {editTarget?.mode === "sauces" && editItem ? (
        <SaucesModal
          name={editName}
          sauces={sauces}
          maxSauces={maxSauces}
          selected={editSauces}
          onClose={() => setEditTarget(null)}
          onToggle={applyEditSauce}
        />
      ) : null}
      {editTarget?.mode === "option" && editItem ? (
        <OptionModal
          name={editName}
          options={editOptions}
          selected={editSelectedOption}
          onClose={() => setEditTarget(null)}
          onConfirm={(opt) => { applyEditOption(opt); setEditTarget(null); }}
        />
      ) : null}
    </Flex>
  );
}
