import { BarChart3, Boxes, Code2, Download, History, LayoutDashboard, Package, Settings, Shield, ShoppingCart, Table2, Users, WalletCards } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PermissionCode } from "../roles/permissions";

export type MenuItemDef = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Permission required to see this item. If absent, visible to all authenticated users. */
  permission?: PermissionCode;
  /** Only shown/available to ADMIN or SUPERADMIN (role check, not permission) */
  adminOnly?: boolean;
  /** Only shown/available to SUPERADMIN or DEV mode */
  superAdminOrDev?: boolean;
  /** Not shown in sidebar (hardcoded as quick link in HomeView) */
  homeOnly?: boolean;
};

export const MENU_ITEMS: MenuItemDef[] = [
  { id: "home",       label: "Inicio",             icon: LayoutDashboard },
  { id: "pos",        label: "Punto de Venta",      icon: ShoppingCart,  homeOnly: true,  permission: "pos.use" },
  { id: "tables",     label: "Mesas",               icon: Table2,        homeOnly: true,  permission: "tables.use" },
  { id: "cash",       label: "Caja",                icon: WalletCards,   homeOnly: true,  permission: "cash.view" },
  { id: "history",    label: "Historial",           icon: History,                        permission: "history.view" },
  { id: "products",   label: "Productos",           icon: Package,       homeOnly: true,  permission: "products.view" },
  { id: "inventory",  label: "Inventario",          icon: Boxes,         homeOnly: true,  permission: "inventory.view" },
  { id: "statistics", label: "Estadisticas",        icon: BarChart3,                      permission: "statistics.view" },
  { id: "audit",      label: "Auditoria",           icon: History,                        permission: "audit.view" },
  { id: "users",      label: "Usuarios",            icon: Users,                          permission: "users.view" },
  { id: "roles",      label: "Roles y Permisos",    icon: Shield,        adminOnly: true },
  { id: "settings",   label: "Configuracion",       icon: Settings,                       permission: "settings.view" },
  { id: "updates",    label: "Actualizaciones",     icon: Download },
  { id: "sql-editor", label: "SQL Editor",          icon: Code2,         superAdminOrDev: true },
];
