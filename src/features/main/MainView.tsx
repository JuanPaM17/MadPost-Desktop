import { Badge, Box, Button, Flex, Heading, Separator, Stack, Text } from "@chakra-ui/react";
import { Tip } from "../../components/ui/Tip";
import type { LucideIcon } from "lucide-react";
import { CircleHelp, Download, LogOut, PanelLeftClose, PanelLeftOpen, Settings, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LocalUser } from "../../core/types";
import { licenseService } from "../license/LicenseService";
import { ProfileView } from "../auth/ProfileView";
import { UpdateView } from "../update/UpdateView";
import { SqlEditorView } from "../developer/SqlEditorView";
import { AuditView } from "../audit/AuditView";
import { ProductView } from "../products/ProductView";
import { InventoryView } from "../inventory/InventoryView";
import { ConfigView } from "../config/ConfigView";
import { UsersView } from "../auth/UsersView";
import { CashRegisterView } from "../cashregister/CashRegisterView";
import { HistoryView } from "../history/HistoryView";
import { PosHeaderBar, PosView } from "../pos/PosView";
import { TablesHeaderBar, TablesView } from "../tables/TablesView";
import { HomeView } from "../home/HomeView";
import { invoke } from "@tauri-apps/api/core";
import { appConfig } from "../../config/AppConfig";
import { runtimeLogger } from "../runtime/RuntimeLogger";
import { MENU_ITEMS } from "./menuConfig";

type MenuItem = { id: string; label: string; icon: LucideIcon };

const operations: MenuItem[] = MENU_ITEMS.filter((m) => ["home", "pos", "tables", "cash", "history"].includes(m.id));
const catalog: MenuItem[] = MENU_ITEMS.filter((m) => ["products", "inventory"].includes(m.id));
const administration: MenuItem[] = MENU_ITEMS.filter((m) => ["statistics", "audit", "users"].includes(m.id));

export function MainView({ user, tenantName, onLogout, onUserUpdated }: { user: LocalUser; tenantName: string; onLogout: () => void; onUserUpdated: (user: LocalUser) => void }) {
  const [activeView, setActiveView] = useState("home");
  const [historyInvoice, setHistoryInvoice] = useState<string | undefined>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const admin = user.role === "ADMIN" || user.role === "SUPERADMIN";
  const developer = user.role === "SUPERADMIN" || import.meta.env.DEV;
  const selectedTitle = useMemo(() => allItems(admin, developer).find((item) => item.id === activeView)?.label ?? "Punto de Venta", [activeView, admin, developer]);

  useEffect(() => { void licenseService.hasValidCachedLicense().then((license) => setExpiresAt(license?.expires_at ?? null)); }, []);
  function openHelp() { void invoke("open_help_url", { url: appConfig.helpUrl() }).catch((error) => runtimeLogger.error("CentroDeAyuda", "No fue posible abrir el navegador.", error)); }

  return <Flex h="100vh" minW="900px" overflow="hidden" bg="gray.50">
    <Flex w={sidebarCollapsed ? "72px" : "270px"} shrink="0" direction="column" color="white" background="linear-gradient(to bottom, #4f46e5, #6366f1)" transition="width 0.18s ease" overflow="hidden">
      <Flex px={sidebarCollapsed ? "3" : "6"} pt="5" pb="5" align="center" justify={sidebarCollapsed ? "center" : "space-between"}><Box display={sidebarCollapsed ? "none" : "block"}><Heading size="lg">{tenantName || "MadPost"}</Heading><Text mt="1" color="whiteAlpha.800" fontSize="sm">Sistema de punto de venta</Text></Box><Button aria-label="Ocultar menu" title="Ocultar menu" size="sm" variant="ghost" color="white" _hover={{ bg: "whiteAlpha.200" }} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</Button></Flex>
      <Box px={sidebarCollapsed ? "3" : "6"} pb="5" display={sidebarCollapsed ? "none" : "block"}><Text fontWeight="semibold" fontSize="sm">{user.display_name || user.username}</Text><Badge mt="1" bg="whiteAlpha.300" color="white" borderRadius="sm">{roleLabel(user.role)}</Badge></Box>
      <LicenseBanner expiresAt={expiresAt} />
      <Box className="sidebar-scroll" flex="1" overflowY="auto" px="3" pb="4"><Separator borderColor="whiteAlpha.300" mb="4" />
        <MenuSection title="OPERACIONES" items={operations} activeView={activeView} onSelect={setActiveView} collapsed={sidebarCollapsed} />
        <Separator borderColor="whiteAlpha.300" my="4" />
        <MenuSection title="CATALOGO" items={catalog} activeView={activeView} onSelect={setActiveView} collapsed={sidebarCollapsed} />
        {admin ? <><Separator borderColor="whiteAlpha.300" my="4" /><MenuSection title="ADMINISTRACION" items={administration} activeView={activeView} onSelect={setActiveView} collapsed={sidebarCollapsed} /></> : null}
        {developer ? <><Separator borderColor="whiteAlpha.300" my="4" /><MenuSection title="DEVELOPER" items={MENU_ITEMS.filter((m) => m.id === "sql-editor")} activeView={activeView} onSelect={setActiveView} collapsed={sidebarCollapsed} /></> : null}
        <Separator borderColor="whiteAlpha.300" my="4" />
        <MenuButton item={{ id: "settings", label: "Configuracion", icon: Settings }} active={activeView === "settings"} onClick={() => setActiveView("settings")} collapsed={sidebarCollapsed} />
        <MenuButton item={{ id: "updates", label: "Actualizaciones", icon: Download }} active={activeView === "updates"} onClick={() => setActiveView("updates")} collapsed={sidebarCollapsed} />
      </Box>
      <Box px="3" pb="4"><Separator borderColor="whiteAlpha.300" mb="3" />
        <MenuButton item={{ id: "help", label: "Centro de Ayuda", icon: CircleHelp }} active={false} onClick={openHelp} collapsed={sidebarCollapsed} />
        <MenuButton item={{ id: "profile", label: "Mi Perfil", icon: UserRound }} active={activeView === "profile"} onClick={() => setActiveView("profile")} collapsed={sidebarCollapsed} />
        {sidebarCollapsed ? <Tip text="Cerrar Sesion"><Button w="full" justifyContent="center" variant="ghost" color="white" _hover={{ bg: "whiteAlpha.200" }} onClick={onLogout}><LogOut size={18} /></Button></Tip> : <Button w="full" justifyContent="start" variant="ghost" color="white" _hover={{ bg: "whiteAlpha.200" }} onClick={onLogout}><LogOut size={18} />Cerrar Sesion</Button>}
      </Box>
    </Flex>
    <Flex flex="1" minW="0" direction="column"><Flex h="72px" px="8" align="center" bg="white" borderBottomWidth="1px" borderColor="gray.200">{activeView === "pos" ? <PosHeaderBar userName={user.display_name || user.username} active={activeView === "pos"} /> : activeView === "tables" ? <TablesHeaderBar userName={user.display_name || user.username} /> : <Heading size="lg">{selectedTitle}</Heading>}</Flex><Box className="content-scroll" flex="1" minH="0" overflowY={activeView === "pos" || activeView === "tables" ? "hidden" : "auto"} p={activeView === "pos" || activeView === "tables" ? "0" : "10"}><Box display={activeView === "pos" ? "block" : "none"} h="full"><PosView active={activeView === "pos"} /></Box>{activeView === "home" ? <HomeView onNavigate={setActiveView} /> : activeView === "profile" ? <ProfileView user={user} onUpdated={onUserUpdated} /> : activeView === "updates" ? <UpdateView /> : activeView === "sql-editor" ? <SqlEditorView /> : activeView === "audit" ? <AuditView /> : activeView === "users" ? <UsersView onCurrentUserUpdated={onUserUpdated} /> : activeView === "tables" ? <TablesView onNavigate={(view, param) => { setHistoryInvoice(param); setActiveView(view); }} /> : activeView === "history" ? <HistoryView initialInvoice={historyInvoice} /> : activeView === "cash" ? <CashRegisterView /> : activeView === "products" ? <ProductView /> : activeView === "inventory" ? <InventoryView /> : activeView === "settings" ? <ConfigView /> : activeView === "pos" ? null : <Flex h="full" align="center" justify="center"><Text color="gray.500" fontSize="lg">{selectedTitle}</Text></Flex>}</Box></Flex>
  </Flex>;
}

function MenuSection({ title, items, activeView, onSelect, collapsed }: { title: string; items: MenuItem[]; activeView: string; onSelect: (id: string) => void; collapsed: boolean }) {
  return <Stack gap="1"><Text display={collapsed ? "none" : "block"} px="3" pb="1" color="whiteAlpha.700" fontWeight="bold" fontSize="xs">{title}</Text>{items.map((item) => <MenuButton key={item.id} item={item} active={activeView === item.id} onClick={() => onSelect(item.id)} collapsed={collapsed} />)}</Stack>;
}

function MenuButton({ item, active, onClick, collapsed = false }: { item: MenuItem; active: boolean; onClick: () => void; collapsed?: boolean }) {
  const Icon = item.icon;
  const btn = <Button w="full" justifyContent={collapsed ? "center" : "start"} variant="ghost" color="white" bg={active ? "whiteAlpha.300" : "transparent"} _hover={{ bg: "whiteAlpha.200" }} onClick={onClick}><Icon size={18} />{collapsed ? null : item.label}</Button>;
  return collapsed ? <Tip text={item.label}>{btn}</Tip> : btn;
}

function LicenseBanner({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days > 15) return null;
  const date = new Intl.DateTimeFormat("es-CO").format(new Date(expiresAt));
  const color = days <= 0 ? "#dc2626" : days <= 5 ? "#ea580c" : "#d97706";
  const text = days <= 0 ? "Tu licencia ha expirado. Contacta a soporte." : `Tu licencia vence el ${date} (${days} dias restantes).`;
  return <Box mx="3" mb="3" p="3" bg={color} borderRadius="sm"><Text fontSize="xs" lineHeight="short">{text}</Text></Box>;
}

function roleLabel(role: LocalUser["role"]) { return role === "SUPERADMIN" ? "Super Admin" : role === "ADMIN" ? "Administrador" : "Vendedor"; }
function allItems(admin: boolean, developer: boolean) { return [...operations, ...catalog, ...(admin ? administration : []), ...(developer ? MENU_ITEMS.filter((m) => m.id === "sql-editor") : []), { id: "settings", label: "Configuracion", icon: Settings }, { id: "updates", label: "Actualizaciones", icon: Download }, { id: "help", label: "Centro de Ayuda", icon: CircleHelp }, { id: "profile", label: "Mi Perfil", icon: UserRound }]; }
