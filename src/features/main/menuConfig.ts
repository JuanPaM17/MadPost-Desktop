import { BarChart3, Boxes, Code2, Download, History, LayoutDashboard, Package, Settings, ShoppingCart, Table2, Users, WalletCards } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type MenuItemDef = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Only shown/available to ADMIN or SUPERADMIN */
  adminOnly?: boolean;
  /** Only shown/available to SUPERADMIN or DEV mode */
  superAdminOrDev?: boolean;
  /** Not shown in sidebar (hardcoded as quick link in HomeView) */
  homeOnly?: boolean;
};

export const MENU_ITEMS: MenuItemDef[] = [
  { id: "home",       label: "Inicio",          icon: LayoutDashboard },
  { id: "pos",        label: "Punto de Venta",   icon: ShoppingCart,  homeOnly: true },
  { id: "tables",     label: "Mesas",            icon: Table2,        homeOnly: true },
  { id: "cash",       label: "Caja",             icon: WalletCards,   homeOnly: true },
  { id: "history",    label: "Historial",        icon: History },
  { id: "products",   label: "Productos",        icon: Package,       homeOnly: true },
  { id: "inventory",  label: "Inventario",       icon: Boxes,         homeOnly: true },
  { id: "statistics", label: "Estadisticas",     icon: BarChart3 },
  { id: "audit",      label: "Auditoria",        icon: History },
  { id: "users",      label: "Usuarios",         icon: Users,         adminOnly: true },
  { id: "settings",   label: "Configuracion",    icon: Settings },
  { id: "updates",    label: "Actualizaciones",  icon: Download },
  { id: "sql-editor", label: "SQL Editor",       icon: Code2,         superAdminOrDev: true },
];
