import { Badge, Box, Button, Flex, Grid, Heading, Input, Spinner, Text } from "@chakra-ui/react";
import { CircleAlert, Flame, LockKeyhole, MessageSquare, Minus, Plus, Search, ShoppingCart, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cashRegisterService, type CashSession } from "../cashregister/CashRegisterService";
import { businessConfigService, printerService, type DeliveryType } from "../config/BusinessConfigService";
import { notify } from "../../components/ui/AppToaster";
import { Tip } from "../../components/ui/Tip";
import { posService, type PosAddition, type PosCategory, type PosCombo, type PosProduct, type PosSauce } from "./PosService";

type PosStatus = "loading" | "open" | "closed" | "error";
type SelectedCategory = "all" | "combos" | string;
type PosGridItem = ({ kind: "product" } & PosProduct) | ({ kind: "combo" } & PosCombo);
type CartChild = { productId: string; name: string; quantity: number; showAdditions: boolean; showSauces: boolean; additions: Record<string, number>; sauces: string[]; options: string[]; selectedOption: string | null };
type CartItem = { key: string; name: string; price: number; quantity: number; kind: "product" | "combo"; note: string; showAdditions: boolean; showSauces: boolean; additions: Record<string, number>; sauces: string[]; options: string[]; selectedOption: string | null; children: CartChild[] };

export function PosView() {
  const [status, setStatus] = useState<PosStatus>("loading");
  const [cash, setCash] = useState<CashSession | null>(null);
  useEffect(() => {
    let active = true;
    void cashRegisterService.getOpenSession().then((session) => {
      if (!active) return;
      setCash(session);
      setStatus(session ? "open" : "closed");
    }).catch(() => active && setStatus("error"));
    return () => { active = false; };
  }, []);
  if (status === "loading") return <LoadingState />;
  if (status !== "open" || !cash) return <ClosedState unavailable={status === "error"} />;
  return <PosWorkspace cash={cash} />;
}

export function PosHeaderBar({ userName }: { userName: string }) {
  const [cash, setCash] = useState<CashSession | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    void cashRegisterService.getOpenSession().then(setCash).catch(() => setCash(null));
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <Flex w="full" align="center" justify="space-between" gap="5"><Heading size="lg">{cash ? `Caja #${cash.sessionNumber}` : "Caja"}</Heading><Text flex="1" textAlign="center" color="gray.600" fontSize="sm">{formatClock(now)}</Text><Text textAlign="right" fontWeight="medium">{userName}</Text></Flex>;
}

function PosWorkspace({ cash }: { cash: CashSession }) {
  const [categories, setCategories] = useState<PosCategory[]>([]);
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [combos, setCombos] = useState<PosCombo[]>([]);
  const [selected, setSelected] = useState<SelectedCategory>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [additions, setAdditions] = useState<PosAddition[]>([]);
  const [sauces, setSauces] = useState<PosSauce[]>([]);
  const [maxSauces, setMaxSauces] = useState(3);
  const loadItems = useCallback(async (selection: SelectedCategory) => {
    setLoading(true);
    try {
      if (selection === "combos") { setProducts([]); setCombos(await posService.combos()); }
      else { setCombos([]); setProducts(await posService.products(selection === "all" ? null : selection)); }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void posService.categories().then(setCategories).catch(() => setCategories([])); }, []);
  useEffect(() => { void posService.additions().then(setAdditions).catch(() => setAdditions([])); }, []);
  useEffect(() => { void posService.sauces().then(({ items, max }) => { setSauces(items); setMaxSauces(max); }).catch(() => {}); }, []);
  useEffect(() => { void loadItems(selected); }, [loadItems, selected]);
  const productItems = useMemo(() => filterItems(products, search), [products, search]);
  const comboItems = useMemo(() => filterItems(combos, search), [combos, search]);
  const cartTotal = cart.reduce((total, item) => total + (item.price + itemExtras(item, additions)) * item.quantity, 0);
  function add(item: PosGridItem) { const key = `${item.kind}:${item.id}`; setCart((current) => { const found = current.find((entry) => entry.key === key); return found ? current.map((entry) => entry.key === key ? { ...entry, quantity: entry.quantity + 1 } : entry) : [...current, { key, name: item.name, price: item.price, quantity: 1, kind: item.kind, note: "", showAdditions: item.kind === "product" && item.showAdditions, showSauces: item.kind === "product" && item.showSauces, additions: {}, sauces: [], options: item.kind === "product" ? item.options : [], selectedOption: item.kind === "product" && item.options.length > 0 ? item.options[0] : null, children: item.kind === "combo" ? item.items.map((child) => ({ ...child, additions: {}, sauces: [], selectedOption: child.options.length > 0 ? child.options[0] : null })) : [] }]; }); }
  function changeOption(key: string, option: string) { setCart((current) => current.map((item) => item.key !== key ? item : { ...item, selectedOption: option })); }
  function changeChildOption(key: string, productId: string, option: string) { setCart((current) => current.map((item) => item.key !== key ? item : { ...item, children: item.children.map((child) => child.productId !== productId ? child : { ...child, selectedOption: option }) })); }
  function changeQuantity(key: string, delta: number) { setCart((current) => current.flatMap((item) => item.key !== key ? [item] : item.quantity + delta <= 0 ? [] : [{ ...item, quantity: item.quantity + delta }])); }
  function updateNote(key: string, note: string) { setCart((current) => current.map((item) => item.key === key ? { ...item, note } : item)); }
  function changeAddition(key: string, additionId: string, delta: number) { setCart((current) => current.map((item) => { if (item.key !== key) return item; const quantity = Math.max(0, (item.additions[additionId] ?? 0) + delta); return { ...item, additions: { ...item.additions, [additionId]: quantity } }; })); }
  function changeChildAddition(key: string, productId: string, additionId: string, delta: number) { setCart((current) => current.map((item) => item.key !== key ? item : { ...item, children: item.children.map((child) => child.productId !== productId ? child : { ...child, additions: { ...child.additions, [additionId]: Math.max(0, (child.additions[additionId] ?? 0) + delta) } }) })); }
  function toggleSauce(key: string, sauceId: string) { setCart((current) => current.map((item) => { if (item.key !== key) return item; const has = item.sauces.includes(sauceId); if (!has && item.sauces.length >= maxSauces) return item; return { ...item, sauces: has ? item.sauces.filter((s) => s !== sauceId) : [...item.sauces, sauceId] }; })); }
  function toggleChildSauce(key: string, productId: string, sauceId: string) { setCart((current) => current.map((item) => item.key !== key ? item : { ...item, children: item.children.map((child) => { if (child.productId !== productId) return child; const has = child.sauces.includes(sauceId); if (!has && child.sauces.length >= maxSauces) return child; return { ...child, sauces: has ? child.sauces.filter((s) => s !== sauceId) : [...child.sauces, sauceId] }; }) })); }
  return <Flex h="full" minH="0" align="stretch"><Flex flex="1" minW="0" minH="0" p="10" pr="5" direction="column"><CategoryBar categories={categories} selected={selected} onSelect={setSelected} /><Box mt="5" maxW="500px" position="relative"><Search size={18} color="#64748b" style={{ position: "absolute", left: 13, top: 12, zIndex: 1 }} /><Input pl="11" placeholder="Buscar producto..." value={search} onChange={(event) => setSearch(event.target.value)} /></Box><ProductGrid products={productItems} combos={comboItems} loading={loading} onAdd={add} /></Flex><CartPanel cash={cash} items={cart} additions={additions} sauces={sauces} maxSauces={maxSauces} total={cartTotal} onChangeQuantity={changeQuantity} onAdditionChange={changeAddition} onChildAdditionChange={changeChildAddition} onSauceToggle={toggleSauce} onChildSauceToggle={toggleChildSauce} onNoteChange={updateNote} onOptionChange={changeOption} onChildOptionChange={changeChildOption} onClear={() => setCart([])} /></Flex>;
}

function CategoryBar({ categories, selected, onSelect }: { categories: PosCategory[]; selected: SelectedCategory; onSelect: (value: SelectedCategory) => void }) {
  const [hasCombos, setHasCombos] = useState(false);
  useEffect(() => { void posService.combos().then((items) => setHasCombos(items.length > 0)).catch(() => setHasCombos(false)); }, []);
  return <Box mt="4" overflowX="auto" className="pos-category-scroll"><Flex w="max-content" gap="2" pb="2"><CategoryButton active={selected === "all"} onClick={() => onSelect("all")}>Todos</CategoryButton>{categories.map((category) => <CategoryButton key={category.id} active={selected === category.id} onClick={() => onSelect(category.id)}>{category.name}</CategoryButton>)}{hasCombos ? <CategoryButton active={selected === "combos"} onClick={() => onSelect("combos")}>Combos</CategoryButton> : null}</Flex></Box>;
}

function CategoryButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <Button size="sm" borderRadius="sm" variant={active ? "solid" : "outline"} colorPalette={active ? "purple" : "gray"} onClick={onClick}>{children}</Button>; }

function ProductGrid({ products, combos, loading, onAdd }: { products: PosProduct[]; combos: PosCombo[]; loading: boolean; onAdd: (item: PosGridItem) => void }) {
  const items: PosGridItem[] = [...products.map((item) => ({ ...item, kind: "product" as const })), ...combos.map((item) => ({ ...item, kind: "combo" as const }))];
  if (loading) return <Flex flex="1" minH="0" py="16" justify="center"><Spinner color="#6366f1" /></Flex>;
  if (!items.length) return <Text flex="1" py="16" textAlign="center" color="gray.500">No hay productos para mostrar.</Text>;
  return <Box mt="5" flex="1" minH="0" overflowY="auto" pr="2"><Grid templateColumns="repeat(auto-fill, 158px)" gap="3">{items.map((item) => { const product = item.kind === "product" ? item : null; const low = product?.stock !== null && product?.stock !== undefined && product.stock <= 5; const empty = product?.stock !== null && product?.stock !== undefined && product.stock <= 0; const discounted = Boolean(product && product.price !== product.originalPrice); return <Button key={`${item.kind}-${item.id}`} w="158px" h="100px" p="3" alignItems="stretch" justifyContent="space-between" flexDirection="column" bg={empty ? "red.50" : low ? "orange.50" : "white"} borderWidth="1px" borderColor={empty ? "red.300" : low ? "orange.300" : "gray.200"} color="gray.800" _hover={{ bg: "purple.50", borderColor: "purple.300" }} onClick={() => onAdd(item)}><Box minW="0"><Text textAlign="left" truncate fontSize="sm" fontWeight="semibold">{item.name}</Text>{item.kind === "combo" ? <Text mt="1" lineClamp="1" color="gray.500" fontSize="xs">{item.items.map((part) => `${part.quantity > 1 ? `${part.quantity}x ` : ""}${part.name}`).join(" + ")}</Text> : <Tip text={product?.description || "Sin descripcion"}><Text mt="1" w="full" truncate color="gray.500" fontSize="xs">{product?.description || "Sin descripcion"}</Text></Tip>}</Box><Flex w="full" justify="space-between" align="end" gap="1">{discounted && product ? <><Text color="gray.400" fontSize="xs" textDecoration="line-through">{money(product.originalPrice)}</Text><Text color="green.600" fontSize="sm" fontWeight="bold">{money(product.price)}</Text></> : <Text color="purple.700" fontSize="sm" fontWeight="bold">{money(item.price)}</Text>}{product?.stock !== null && product?.stock !== undefined ? <Text color={empty ? "red.600" : low ? "orange.700" : "gray.500"} fontSize="xs">{product.stock}</Text> : null}</Flex></Button>; })}</Grid></Box>;
}

function CartPanel({ cash, items, additions, sauces, maxSauces, total, onChangeQuantity, onAdditionChange, onChildAdditionChange, onSauceToggle, onChildSauceToggle, onNoteChange, onOptionChange, onChildOptionChange, onClear }: { cash: CashSession; items: CartItem[]; additions: PosAddition[]; sauces: PosSauce[]; maxSauces: number; total: number; onChangeQuantity: (key: string, delta: number) => void; onAdditionChange: (key: string, additionId: string, delta: number) => void; onChildAdditionChange: (key: string, productId: string, additionId: string, delta: number) => void; onSauceToggle: (key: string, sauceId: string) => void; onChildSauceToggle: (key: string, productId: string, sauceId: string) => void; onNoteChange: (key: string, note: string) => void; onOptionChange: (key: string, option: string) => void; onChildOptionChange: (key: string, productId: string, option: string) => void; onClear: () => void }) {
  const [noteKey, setNoteKey] = useState<string | null>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (noteKey) setTimeout(() => noteInputRef.current?.focus(), 0); }, [noteKey]);
  const [additionTarget, setAdditionTarget] = useState<{ key: string; childId?: string } | null>(null);
  const [sauceTarget, setSauceTarget] = useState<{ key: string; childId?: string } | null>(null);
  const [checkout, setCheckout] = useState(false);
  const targetItem = items.find((item) => item.key === additionTarget?.key);
  const targetChild = targetItem?.children.find((child) => child.productId === additionTarget?.childId);
  const targetAdditions = targetChild?.additions ?? targetItem?.additions ?? {};
  const targetName = targetChild?.name ?? targetItem?.name ?? "";
  const sauceItem = items.find((item) => item.key === sauceTarget?.key);
  const sauceChild = sauceItem?.children.find((child) => child.productId === sauceTarget?.childId);
  const selectedSauces = sauceChild?.sauces ?? sauceItem?.sauces ?? [];
  const sauceName = sauceChild?.name ?? sauceItem?.name ?? "";
  return <Flex w="440px" minW="380px" h="full" minH="0" shrink="0" overflow="hidden" direction="column" borderLeftWidth="1px" borderColor="gray.200" bg="white">
    <Flex px="5" py="4" borderBottomWidth="1px" borderColor="gray.200" align="center" justify="space-between"><Flex align="center" gap="2"><ShoppingCart size={19} color="#4f46e5" /><Heading size="sm">Pedido</Heading>{items.length ? <Badge colorPalette="purple">{items.length}</Badge> : null}</Flex>{items.length ? <Button size="xs" variant="ghost" colorPalette="red" onClick={onClear}><Trash2 size={15} />Limpiar</Button> : null}</Flex>
    {!items.length ? <Flex flex="1" minH="0" align="center" justify="center" direction="column" px="6" color="gray.500" textAlign="center"><ShoppingCart size={32} strokeWidth={1.5} /><Text mt="4">Agrega productos para iniciar la venta.</Text></Flex> : <Box flex="1" minH="0" overflowY="auto" p="4">{items.map((item) => <Box key={item.key} pb="4" mb="4" borderBottomWidth="1px" borderColor="gray.100">
      <Flex justify="space-between" gap="2">
        <Text fontWeight="semibold">{item.name}</Text>
        <Flex gap="1">
          <Tip text="Nota"><Button size="xs" variant="ghost" onClick={() => setNoteKey(noteKey === item.key ? null : item.key)}><MessageSquare size={15} /></Button></Tip>
          {item.showSauces || item.children.some((child) => child.showSauces) ? <Tip text="Salsas"><Button size="xs" variant="ghost" colorPalette="green" onClick={() => setSauceTarget({ key: item.key })}><Flame size={15} /></Button></Tip> : null}
          {item.showAdditions || item.children.some((child) => child.showAdditions) ? <Tip text="Adiciones"><Button size="xs" variant="ghost" colorPalette="purple" onClick={() => setAdditionTarget({ key: item.key })}><Plus size={15} /></Button></Tip> : null}
          <Tip text="Eliminar"><Button size="xs" variant="ghost" colorPalette="red" onClick={() => onChangeQuantity(item.key, -item.quantity)}><X size={15} /></Button></Tip>
        </Flex>
      </Flex>
      {item.options.length > 0 ? <Flex mt="2" gap="1" flexWrap="wrap">{item.options.map((opt) => <Button key={opt} size="xs" variant={item.selectedOption === opt ? "solid" : "outline"} colorPalette={item.selectedOption === opt ? "orange" : "gray"} onClick={() => onOptionChange(item.key, opt)}>{opt}</Button>)}</Flex> : null}
      {item.sauces.length > 0 ? <Flex mt="1" align="center" gap="1" flexWrap="wrap"><Flame size={12} color="#16a34a" />{item.sauces.map((id) => { const s = sauces.find((x) => x.id === id); return s ? <Badge key={id} colorPalette="green" size="sm" variant="subtle">{s.name}</Badge> : null; })}</Flex> : null}
      {Object.keys(item.additions).some((id) => (item.additions[id] ?? 0) > 0) ? <Flex mt="1" align="center" gap="1" flexWrap="wrap"><Plus size={12} color="#7c3aed" />{additions.filter((a) => (item.additions[a.id] ?? 0) > 0).map((a) => <Badge key={a.id} colorPalette="purple" size="sm" variant="subtle">{item.additions[a.id]}x {a.name}</Badge>)}</Flex> : null}
      {item.children.map((child) => <Flex key={child.productId} mt="2" pl="2" direction="column" borderLeftWidth="2px" borderColor="gray.200"><Flex justify="space-between"><Text fontSize="xs" color="gray.600">- {child.quantity > 1 ? `${child.quantity}x ` : ""}{child.name}</Text><Flex gap="1">{child.showSauces ? <Tip text="Salsas"><Button size="xs" variant="ghost" colorPalette="green" onClick={() => setSauceTarget({ key: item.key, childId: child.productId })}><Flame size={13} /></Button></Tip> : null}{child.showAdditions ? <Tip text="Adiciones"><Button size="xs" variant="ghost" colorPalette="purple" onClick={() => setAdditionTarget({ key: item.key, childId: child.productId })}><Plus size={14} /></Button></Tip> : null}</Flex></Flex>{child.options.length > 0 ? <Flex mt="1" gap="1" flexWrap="wrap">{child.options.map((opt) => <Button key={opt} size="xs" variant={child.selectedOption === opt ? "solid" : "outline"} colorPalette={child.selectedOption === opt ? "orange" : "gray"} onClick={() => onChildOptionChange(item.key, child.productId, opt)}>{opt}</Button>)}</Flex> : null}
{child.sauces.length > 0 ? <Flex mt="1" align="center" gap="1" flexWrap="wrap"><Flame size={11} color="#16a34a" />{child.sauces.map((id) => { const s = sauces.find((x) => x.id === id); return s ? <Badge key={id} colorPalette="green" size="sm" variant="subtle">{s.name}</Badge> : null; })}</Flex> : null}{Object.keys(child.additions).some((id) => (child.additions[id] ?? 0) > 0) ? <Flex mt="1" align="center" gap="1" flexWrap="wrap"><Plus size={11} color="#7c3aed" />{additions.filter((a) => (child.additions[a.id] ?? 0) > 0).map((a) => <Badge key={a.id} colorPalette="purple" size="sm" variant="subtle">{child.additions[a.id]}x {a.name}</Badge>)}</Flex> : null}</Flex>)}
      {(noteKey === item.key || item.note) ? <Input ref={noteKey === item.key ? noteInputRef : undefined} mt="2" size="sm" placeholder="Nota para el pedido" value={item.note} onChange={(event) => onNoteChange(item.key, event.target.value)} /> : null}
      <Flex mt="3" align="center" justify="space-between"><Flex align="center" gap="2"><Button size="xs" variant="outline" onClick={() => onChangeQuantity(item.key, -1)}><Minus size={14} /></Button><Text minW="20px" textAlign="center">{item.quantity}</Text><Button size="xs" variant="outline" onClick={() => onChangeQuantity(item.key, 1)}><Plus size={14} /></Button></Flex><Text fontWeight="bold">{money(item.price * item.quantity)}</Text></Flex>
    </Box>)}</Box>}
    <Box p="5" borderTopWidth="1px" borderColor="gray.200"><Flex justify="space-between"><Text fontWeight="bold">Total</Text><Text color="purple.700" fontSize="xl" fontWeight="bold">{money(total)}</Text></Flex>{(() => { const missing = items.find((item) => (item.options.length > 0 && !item.selectedOption) || item.children.some((child) => child.options.length > 0 && !child.selectedOption)); return <Tip text={missing ? `Selecciona una opcion para "${missing.name}"` : ""}><Button mt="4" w="full" colorPalette="purple" disabled={!items.length || !!missing} onClick={() => setCheckout(true)}>Cobrar</Button></Tip>; })()}</Box>
    {additionTarget ? <AdditionsModal name={targetName} additions={additions} quantities={targetAdditions} onClose={() => setAdditionTarget(null)} onChange={(additionId, delta) => additionTarget.childId ? onChildAdditionChange(additionTarget.key, additionTarget.childId, additionId, delta) : onAdditionChange(additionTarget.key, additionId, delta)} /> : null}
    {checkout ? <CheckoutModal cash={cash} items={items} additions={additions} sauces={sauces} subtotal={total} onClose={() => setCheckout(false)} onConfirmed={onClear} /> : null}
    {sauceTarget ? <SaucesModal name={sauceName} sauces={sauces} maxSauces={maxSauces} selected={selectedSauces} onClose={() => setSauceTarget(null)} onToggle={(sauceId) => sauceTarget.childId ? onChildSauceToggle(sauceTarget.key, sauceTarget.childId, sauceId) : onSauceToggle(sauceTarget.key, sauceId)} /> : null}
  </Flex>;
}
type PayMethod = "cash" | "card" | "split";

function CheckoutModal({ cash, items, additions, sauces, subtotal, onClose, onConfirmed }: { cash: CashSession; items: CartItem[]; additions: PosAddition[]; sauces: PosSauce[]; subtotal: number; onClose: () => void; onConfirmed: () => void }) {
  const [deliveryTypes, setDeliveryTypes] = useState<DeliveryType[]>([]);
  const [hasPrinter, setHasPrinter] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryType | null>(null);
  const [method, setMethod] = useState<PayMethod>("cash");
  const [cashGiven, setCashGiven] = useState("");
  const [cashGivenTouched, setCashGivenTouched] = useState(false);
  const [splitCash, setSplitCash] = useState("");
  const [splitCashGiven, setSplitCashGiven] = useState("");
  const [splitCashGivenTouched, setSplitCashGivenTouched] = useState(false);
  const [orderNote, setOrderNote] = useState("");
  const [printInvoice, setPrintInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bizSettings, setBizSettings] = useState<Awaited<ReturnType<typeof businessConfigService.load>> | null>(null);

  useEffect(() => {
    void businessConfigService.deliveryTypes().then(setDeliveryTypes).catch(() => {});
    void Promise.all([printerService.list(), businessConfigService.load()]).then(([printers, settings]) => {
      setHasPrinter(Boolean(settings.printerReceipt && printers.includes(settings.printerReceipt)));
      setBizSettings(settings);
    }).catch(() => {});
  }, []);

  const total = subtotal + (selectedDelivery?.price ?? 0);

  // cash given sync when total changes and not manually edited
  useEffect(() => {
    if (!cashGivenTouched) setCashGiven(String(total));
  }, [total, cashGivenTouched]);
  useEffect(() => {
    if (!splitCashGivenTouched) { const rest = total - Math.max(0, Number(splitCash) || 0); setSplitCashGiven(String(Math.max(0, rest))); }
  }, [total, splitCash, splitCashGivenTouched]);

  function handleDeliveryToggle(dt: DeliveryType) {
    setSelectedDelivery((prev) => prev?.id === dt.id ? null : dt);
    if (!cashGivenTouched) setCashGiven("");
    if (!splitCashGivenTouched) setSplitCashGiven("");
  }

  function applyBill(bill: number) {
    if (method === "cash") {
      setCashGiven((prev) => { const base = cashGivenTouched ? (Number(prev) || 0) : 0; const next = base + bill; setCashGivenTouched(true); return String(next); });
    } else {
      setSplitCashGiven((prev) => { const base = splitCashGivenTouched ? (Number(prev) || 0) : 0; const next = base + bill; setSplitCashGivenTouched(true); return String(next); });
    }
  }

  const cashNum = Number(cashGiven) || 0;
  const splitCashNum = Math.min(Number(splitCash) || 0, total);
  const splitCardNum = total - splitCashNum;
  const splitCashGivenNum = Number(splitCashGiven) || 0;
  const changeCash = method === "cash" ? cashNum - total : splitCashGivenNum - splitCashNum;
  const cashInsufficient = method === "cash" ? cashNum < total : splitCashGivenNum < splitCashNum;
  const splitInvalid = method === "split" && (splitCashNum <= 0 || splitCardNum <= 0);

  const bills = [10_000, 20_000, 50_000, 100_000];

  return <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="4">
    <Box w="full" maxW="520px" maxH="calc(100vh - 32px)" overflowY="auto" bg="white" borderRadius="lg" boxShadow="2xl">
      {/* header */}
      <Flex px="6" pt="6" pb="4" align="center" justify="space-between" borderBottomWidth="1px" borderColor="gray.100">
        <Heading size="lg">Cobrar</Heading>
        <Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button>
      </Flex>

      <Box px="6" py="5">
        {/* total */}
        <Flex direction="column" align="center" mb="6">
          <Text fontSize="sm" color="gray.500" fontWeight="medium">Total</Text>
          <Text fontSize="4xl" fontWeight="bold" color="purple.700" lineHeight="1.1">{money(total)}</Text>
          {selectedDelivery ? <Text fontSize="xs" color="gray.400" mt="1">Incluye domicilio {money(selectedDelivery.price)}</Text> : null}
        </Flex>

        {/* delivery */}
        {deliveryTypes.length > 0 ? <Box mb="5">
          <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="2">Domicilio</Text>
          <Flex gap="2" flexWrap="wrap">{deliveryTypes.map((dt) => {
            const active = selectedDelivery?.id === dt.id;
            return <Button key={dt.id} size="sm" variant={active ? "solid" : "outline"} colorPalette={active ? "blue" : "gray"} onClick={() => handleDeliveryToggle(dt)}>{dt.name}{dt.price > 0 ? ` +${money(dt.price)}` : ""}</Button>;
          })}</Flex>
        </Box> : null}

        {/* payment method */}
        <Box mb="5">
          <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="2">Metodo de pago</Text>
          <Flex gap="2">
            {(["cash", "card", "split"] as PayMethod[]).map((m) => {
              const labels: Record<PayMethod, string> = { cash: "Efectivo", card: "Tarjeta", split: "Dividido" };
              return <Button key={m} size="sm" variant={method === m ? "solid" : "outline"} colorPalette={method === m ? "purple" : "gray"} onClick={() => setMethod(m)}>{labels[m]}</Button>;
            })}
          </Flex>
        </Box>

        {/* cash fields */}
        {method === "cash" ? <Box mb="5">
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
              : <Text fontSize="sm" fontWeight="bold" color="green.600">{money(changeCash)}</Text>}
          </Flex>
        </Box> : null}

        {/* split fields */}
        {method === "split" ? <Box mb="5">
          <Text fontSize="sm" color="gray.600" mb="1">Monto en efectivo</Text>
          <Input value={splitCash} onChange={(e) => setSplitCash(e.target.value)} type="number" placeholder="0" />
          {splitCashNum > 0 && splitCardNum > 0 ? <Flex mt="2" gap="3">
            <Flex align="center" gap="1"><Text fontSize="xs" color="gray.500">Efectivo:</Text><Text fontSize="xs" fontWeight="semibold">{money(splitCashNum)}</Text></Flex>
            <Flex align="center" gap="1"><Text fontSize="xs" color="gray.500">Tarjeta:</Text><Text fontSize="xs" fontWeight="semibold">{money(splitCardNum)}</Text></Flex>
          </Flex> : null}
          {splitInvalid && splitCash !== "" ? <Text fontSize="xs" color="red.500" mt="1">Ambas partes deben ser mayores a 0</Text> : null}
          {splitCashNum > 0 ? <Box mt="4">
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
                : <Text fontSize="sm" fontWeight="bold" color="green.600">{money(changeCash)}</Text>}
            </Flex>
          </Box> : null}
        </Box> : null}

        {/* order note */}
        <Box mb="5">
          <Text fontSize="sm" fontWeight="semibold" color="gray.700" mb="1">Nota del pedido</Text>
          <Input value={orderNote} onChange={(e) => setOrderNote(e.target.value)} placeholder="Opcional..." />
        </Box>

        {/* print invoice */}
        <Flex mb="6" align="center" justify="space-between">
          <Box>
            <Text fontSize="sm" fontWeight="semibold" color="gray.700">Imprimir factura</Text>
            {!hasPrinter ? <Text fontSize="xs" color="gray.400">No hay impresora configurada o detectada</Text> : null}
          </Box>
          <Button
            size="sm"
            variant={printInvoice ? "solid" : "outline"}
            colorPalette={printInvoice ? "purple" : "gray"}
            disabled={!hasPrinter}
            onClick={() => setPrintInvoice((v) => !v)}
          >{printInvoice ? "Si" : "No"}</Button>
        </Flex>

        {/* confirm */}
        <Button
          w="full"
          colorPalette="purple"
          size="lg"
          loading={saving}
          disabled={cashInsufficient || splitInvalid || saving}
          onClick={async () => {
            setSaving(true);
            try {
              const payMethod: import("./SaleService").SalePaymentMethod =
                method === "cash" ? "CASH" : method === "card" ? "CARD" : "SPLIT";
              const saleItems: import("./SaleService").SaleItemRequest[] = items.map((item) => ({
                key: item.key,
                name: item.name,
                price: item.price,
                originalPrice: item.price,
                quantity: item.quantity,
                kind: item.kind,
                selectedOption: item.selectedOption,
                note: item.note,
                additions: item.additions,
                sauces: item.sauces,
                productId: item.key.replace(/^product:/, ""),
                categoryName: null,
                children: item.children.map((child) => ({
                  productId: child.productId,
                  name: child.name,
                  quantity: child.quantity,
                  additions: child.additions,
                  sauces: child.sauces,
                  selectedOption: child.selectedOption,
                })),
              }));
              const req: import("./SaleService").SaleRequest = {
                cash,
                items: saleItems,
                paymentMethod: payMethod,
                total,
                cashGiven: method !== "card" ? (method === "cash" ? cashNum : splitCashGivenNum) : undefined,
                changeGiven: method !== "card" ? Math.max(0, changeCash) : undefined,
                cashAmount: method === "split" ? splitCashNum : undefined,
                cardAmount: method === "split" ? splitCardNum : undefined,
                notes: orderNote || undefined,
                delivery: selectedDelivery ? { type: selectedDelivery, paymentMethod: payMethod } : undefined,
              };
              const { saleService } = await import("./SaleService");
              const result = await saleService.confirm(req, additions, sauces);
              // Venta guardada — a partir de aqui todo es best-effort, no debe bloquear ni mostrar error
              notify.success(`Factura #${result.invoiceNumber}`, result.changeGiven > 0 ? `Cambio: ${money(result.changeGiven)}` : undefined);
              onConfirmed();
              onClose();
              // WhatsApp si domicilio
              if (selectedDelivery && bizSettings?.phone) {
                const shouldSend = bizSettings.deliveryWhatsapp === "SOLO_DOMICILIOS" || bizSettings.deliveryWhatsapp === "TODAS";
                if (shouldSend) {
                  try { window.open(saleService.buildWhatsAppUrl(bizSettings.phone, bizSettings.name, result.invoiceNumber, req, additions, sauces), "_blank"); } catch { /* non-fatal */ }
                }
              }
              // Cajon (efectivo o dividido)
              if (method !== "card" && bizSettings?.printerReceipt) {
                void saleService.openCashDrawer(bizSettings.printerReceipt);
              }
              // PDF de factura
              if (bizSettings) {
                void saleService.generateAndSaveInvoice(result, req, cash.sessionNumber, bizSettings, additions, sauces, printInvoice);
              }
            } catch (error) {
              console.error("[Checkout] Error capturado:", error);
              notify.error("Error al cobrar", error instanceof Error ? error.message : "Intenta de nuevo.");
            } finally {
              setSaving(false);
            }
          }}
        >Confirmar cobro</Button>
      </Box>
    </Box>
  </Flex>;
}

function SaucesModal({ name, sauces, maxSauces, selected, onClose, onToggle }: { name: string; sauces: PosSauce[]; maxSauces: number; selected: string[]; onClose: () => void; onToggle: (id: string) => void }) {
  return <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4">
    <Box w="full" maxW="480px" maxH="calc(100vh - 48px)" overflowY="auto" bg="white" p="6" boxShadow="2xl" borderRadius="md">
      <Flex justify="space-between" align="center"><Heading size="md">Salsas</Heading><Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button></Flex>
      <Text mt="1" color="gray.500" fontSize="sm">{name}</Text>
      <Flex mt="1" align="center" gap="1"><Flame size={13} color={selected.length > 0 ? "#16a34a" : "#94a3b8"} /><Text fontSize="xs" color={selected.length >= maxSauces ? "green.600" : "gray.400"}>{selected.length} / {maxSauces} seleccionadas</Text></Flex>
      <Flex mt="4" gap="2" wrap="wrap">{sauces.map((sauce) => { const active = selected.includes(sauce.id); const maxed = !active && selected.length >= maxSauces; return <Button key={sauce.id} size="sm" variant={active ? "solid" : "outline"} colorPalette="green" opacity={maxed ? 0.4 : 1} disabled={maxed} onClick={() => onToggle(sauce.id)}>{sauce.name}</Button>; })}</Flex>
      <Flex mt="6" justify="end"><Button variant="outline" onClick={onClose}>Listo</Button></Flex>
    </Box>
  </Flex>;
}
function AdditionsModal({ name, additions, quantities, onClose, onChange }: { name: string; additions: PosAddition[]; quantities: Record<string, number>; onClose: () => void; onChange: (id: string, delta: number) => void }) { return <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.500" align="center" justify="center" p="4"><Box w="full" maxW="520px" maxH="calc(100vh - 48px)" overflowY="auto" bg="white" p="6" boxShadow="2xl"><Flex justify="space-between" align="center"><Heading size="md">Adiciones</Heading><Button size="sm" variant="ghost" onClick={onClose}><X size={18} /></Button></Flex><Text mt="2" color="gray.500" fontSize="sm">{name}</Text><Flex mt="5" gap="2" wrap="wrap">{additions.map((addition) => { const quantity = quantities[addition.id] ?? 0; const disabled = addition.stock !== null && addition.stock <= 0; return <Flex key={addition.id} borderWidth="1px" borderColor={quantity ? "purple.300" : "gray.200"} bg={quantity ? "purple.50" : "white"} p="2" align="center" gap="2"><Text fontSize="sm">{addition.name} {addition.price ? `+${money(addition.price)}` : ""}</Text><Button size="xs" variant="outline" disabled={!quantity} onClick={() => onChange(addition.id, -1)}><Minus size={13} /></Button><Text minW="18px" textAlign="center" fontSize="sm">{quantity}</Text><Button size="xs" colorPalette="purple" disabled={disabled} onClick={() => onChange(addition.id, 1)}><Plus size={13} /></Button></Flex>; })}</Flex><Flex mt="6" justify="end"><Button variant="outline" onClick={onClose}>Listo</Button></Flex></Box></Flex>; }
function LoadingState() { return <Flex h="full" align="center" justify="center" direction="column" gap="4"><Spinner size="lg" color="#6366f1" /><Text color="gray.500">Verificando la caja...</Text></Flex>; }
function ClosedState({ unavailable }: { unavailable: boolean }) { return <Flex h="full" align="center" justify="center" px="4"><Box w="full" maxW="500px" borderWidth="1px" borderColor={unavailable ? "red.200" : "orange.200"} bg={unavailable ? "red.50" : "orange.50"} p={{ base: "6", md: "8" }} textAlign="center"><Flex mx="auto" w="54px" h="54px" align="center" justify="center" borderRadius="full" bg={unavailable ? "red.100" : "orange.100"} color={unavailable ? "red.600" : "orange.600"}>{unavailable ? <CircleAlert size={28} /> : <LockKeyhole size={26} />}</Flex><Heading mt="5" size="md">{unavailable ? "No fue posible verificar la caja" : "Caja cerrada"}</Heading><Text mt="3" color="gray.600">{unavailable ? "Intenta ingresar nuevamente al modulo." : "Debes abrir una caja antes de realizar ventas."}</Text></Box></Flex>; }
function filterItems<T extends { name: string; description?: string | null }>(items: T[], search: string) { const query = search.trim().toLocaleLowerCase(); return items.filter((item) => !query || item.name.toLocaleLowerCase().includes(query) || (item.description ?? "").toLocaleLowerCase().includes(query)); }
function itemExtras(item: CartItem, additions: PosAddition[]) { const amount = (quantities: Record<string, number>, multiplier = 1) => additions.reduce((total, addition) => total + (quantities[addition.id] ?? 0) * addition.price * multiplier, 0); return amount(item.additions) + item.children.reduce((total, child) => total + amount(child.additions, child.quantity), 0); }
function money(value: number) { return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value); }
function formatClock(value: Date) { return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", weekday: "long", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(value); }
