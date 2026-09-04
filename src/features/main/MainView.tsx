import { Badge, Box, Button, Flex, Heading, Separator, Stack, Text } from "@chakra-ui/react";
import type { LucideIcon } from "lucide-react";
import { BarChart3, Boxes, CircleHelp, Code2, Download, History, LogOut, Package, Settings, ShoppingCart, Table2, UserRound, Users, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LocalUser } from "../../core/types";
import { licenseService } from "../license/LicenseService";
import { ProfileView } from "../auth/ProfileView";
import { UpdateView } from "../update/UpdateView";
import { SqlEditorView } from "../developer/SqlEditorView";
import { AuditView } from "../audit/AuditView";
import { ProductView } from "../products/ProductView";
import { invoke } from "@tauri-apps/api/core";
import { appConfig } from "../../config/AppConfig";
import { runtimeLogger } from "../runtime/RuntimeLogger";

type MenuItem = { id: string; label: string; icon: LucideIcon };

const operations: MenuItem[] = [
  { id: "pos", label: "Punto de Venta", icon: ShoppingCart }, { id: "tables", label: "Mesas", icon: Table2 },
  { id: "cash", label: "Caja", icon: WalletCards }, { id: "history", label: "Historial", icon: History },
];
const catalog: MenuItem[] = [{ id: "products", label: "Productos", icon: Package }, { id: "inventory", label: "Inventario", icon: Boxes }];
const administration: MenuItem[] = [{ id: "statistics", label: "Estadisticas", icon: BarChart3 }, { id: "audit", label: "Auditoria", icon: History }, { id: "users", label: "Usuarios", icon: Users }];

export function MainView({ user, tenantName, onLogout, onUserUpdated }: { user: LocalUser; tenantName: string; onLogout: () => void; onUserUpdated: (user: LocalUser) => void }) {
  const [activeView, setActiveView] = useState("pos");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const admin = user.role === "ADMIN" || user.role === "SUPERADMIN";
  const developer = user.role === "SUPERADMIN" || import.meta.env.DEV;
  const selectedTitle = useMemo(() => allItems(admin, developer).find((item) => item.id === activeView)?.label ?? "Punto de Venta", [activeView, admin, developer]);

  useEffect(() => { void licenseService.hasValidCachedLicense().then((license) => setExpiresAt(license?.expires_at ?? null)); }, []);
  function openHelp() { void invoke("open_help_url", { url: appConfig.helpUrl() }).catch((error) => runtimeLogger.error("CentroDeAyuda", "No fue posible abrir el navegador.", error)); }

  return <Flex h="100vh" minW="900px" overflow="hidden" bg="gray.50">
    <Flex w="270px" shrink="0" direction="column" color="white" background="linear-gradient(to bottom, #4f46e5, #6366f1)">
      <Box px="6" pt="7" pb="5"><Heading size="lg">{tenantName || "MadPost"}</Heading><Text mt="1" color="whiteAlpha.800" fontSize="sm">Sistema de punto de venta</Text></Box>
      <Box px="6" pb="5"><Text fontWeight="semibold" fontSize="sm">{user.display_name || user.username}</Text><Badge mt="1" bg="whiteAlpha.300" color="white" borderRadius="sm">{roleLabel(user.role)}</Badge></Box>
      <LicenseBanner expiresAt={expiresAt} />
      <Box className="sidebar-scroll" flex="1" overflowY="auto" px="3" pb="4"><Separator borderColor="whiteAlpha.300" mb="4" />
        <MenuSection title="OPERACIONES" items={operations} activeView={activeView} onSelect={setActiveView} />
        <Separator borderColor="whiteAlpha.300" my="4" />
        <MenuSection title="CATALOGO" items={catalog} activeView={activeView} onSelect={setActiveView} />
        {admin ? <><Separator borderColor="whiteAlpha.300" my="4" /><MenuSection title="ADMINISTRACION" items={administration} activeView={activeView} onSelect={setActiveView} /></> : null}
        {developer ? <><Separator borderColor="whiteAlpha.300" my="4" /><MenuSection title="DEVELOPER" items={[{ id: "sql-editor", label: "SQL Editor", icon: Code2 }]} activeView={activeView} onSelect={setActiveView} /></> : null}
        <Separator borderColor="whiteAlpha.300" my="4" />
        <MenuButton item={{ id: "settings", label: "Configuracion", icon: Settings }} active={activeView === "settings"} onClick={() => setActiveView("settings")} />
        <MenuButton item={{ id: "updates", label: "Actualizaciones", icon: Download }} active={activeView === "updates"} onClick={() => setActiveView("updates")} />
      </Box>
      <Box px="3" pb="4"><Separator borderColor="whiteAlpha.300" mb="3" />
        <MenuButton item={{ id: "help", label: "Centro de Ayuda", icon: CircleHelp }} active={false} onClick={openHelp} />
        <MenuButton item={{ id: "profile", label: "Mi Perfil", icon: UserRound }} active={activeView === "profile"} onClick={() => setActiveView("profile")} />
        <Button w="full" justifyContent="start" variant="ghost" color="white" _hover={{ bg: "whiteAlpha.200" }} onClick={onLogout}><LogOut size={18} />Cerrar Sesion</Button>
      </Box>
    </Flex>
    <Flex flex="1" minW="0" direction="column"><Flex h="72px" px="8" align="center" bg="white" borderBottomWidth="1px" borderColor="gray.200"><Heading size="lg">{selectedTitle}</Heading></Flex><Box className="content-scroll" flex="1" overflowY="auto" p="10">{activeView === "profile" ? <ProfileView user={user} onUpdated={onUserUpdated} /> : activeView === "updates" ? <UpdateView /> : activeView === "sql-editor" ? <SqlEditorView /> : activeView === "audit" ? <AuditView /> : activeView === "products" ? <ProductView /> : <Flex h="full" align="center" justify="center"><Text color="gray.500" fontSize="lg">{selectedTitle}</Text></Flex>}</Box></Flex>
  </Flex>;
}

function MenuSection({ title, items, activeView, onSelect }: { title: string; items: MenuItem[]; activeView: string; onSelect: (id: string) => void }) {
  return <Stack gap="1"><Text px="3" pb="1" color="whiteAlpha.700" fontWeight="bold" fontSize="xs">{title}</Text>{items.map((item) => <MenuButton key={item.id} item={item} active={activeView === item.id} onClick={() => onSelect(item.id)} />)}</Stack>;
}

function MenuButton({ item, active, onClick }: { item: MenuItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return <Button w="full" justifyContent="start" variant="ghost" color="white" bg={active ? "whiteAlpha.300" : "transparent"} _hover={{ bg: "whiteAlpha.200" }} onClick={onClick}><Icon size={18} />{item.label}</Button>;
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
function allItems(admin: boolean, developer: boolean) { return [...operations, ...catalog, ...(admin ? administration : []), ...(developer ? [{ id: "sql-editor", label: "SQL Editor", icon: Code2 }] : []), { id: "settings", label: "Configuracion", icon: Settings }, { id: "updates", label: "Actualizaciones", icon: Download }, { id: "help", label: "Centro de Ayuda", icon: CircleHelp }, { id: "profile", label: "Mi Perfil", icon: UserRound }]; }
