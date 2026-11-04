// Catalogo completo de permisos del sistema.
// Cada permiso de "view" es la llave que abre el acceso al menu Y a la pantalla.
// Los permisos de accion controlan botones/tabs dentro de esa pantalla.

export type PermissionCode =
  | "pos.use"
  | "tables.use"
  | "cash.view"
  | "history.view"
  | "products.view"
  | "products.edit_products"
  | "products.edit_additions"
  | "products.edit_combos"
  | "products.edit_discounts"
  | "inventory.view"
  | "inventory.adjust"
  | "inventory.supplies_manage"
  | "statistics.view"
  | "audit.view"
  | "settings.view"
  | "settings.export_import"
  | "settings.edit"
  | "users.view"
  | "users.manage"
  | "updates.view"
  | "profile.view";

export type PermissionDef = {
  code: PermissionCode;
  module: string;
  label: string;
};

export const PERMISSION_DEFS: PermissionDef[] = [
  // Punto de Venta
  { code: "pos.use",                  module: "pos",        label: "Acceder al Punto de Venta" },
  // Mesas
  { code: "tables.use",               module: "tables",     label: "Acceder a Mesas" },
  // Caja
  { code: "cash.view",                module: "cash",       label: "Acceder a Caja" },
  // Historial
  { code: "history.view",             module: "history",    label: "Acceder al Historial" },
  // Productos
  { code: "products.view",            module: "products",   label: "Acceder a Productos" },
  { code: "products.edit_products",   module: "products",   label: "Gestionar productos y categorias" },
  { code: "products.edit_additions",  module: "products",   label: "Gestionar adiciones y salsas" },
  { code: "products.edit_combos",     module: "products",   label: "Gestionar combos" },
  { code: "products.edit_discounts",  module: "products",   label: "Gestionar descuentos" },
  // Inventario
  { code: "inventory.view",           module: "inventory",  label: "Acceder a Inventario" },
  { code: "inventory.adjust",         module: "inventory",  label: "Ajustar stock" },
  { code: "inventory.supplies_manage",module: "inventory",  label: "Gestionar insumos" },
  // Estadisticas
  { code: "statistics.view",          module: "statistics", label: "Acceder a Estadisticas" },
  // Auditoria
  { code: "audit.view",               module: "audit",      label: "Acceder a Auditoria" },
  // Configuracion
  { code: "settings.view",            module: "settings",   label: "Acceder a Configuracion" },
  { code: "settings.edit",            module: "settings",   label: "Guardar cambios en Configuracion" },
  { code: "settings.export_import",   module: "settings",   label: "Acceder a Exportar e Importar" },
  // Usuarios
  { code: "users.view",               module: "users",      label: "Acceder a Usuarios" },
  { code: "users.manage",             module: "users",      label: "Gestionar usuarios" },
  // Actualizaciones
  { code: "updates.view",             module: "updates",    label: "Acceder a Actualizaciones" },
  // Perfil
  { code: "profile.view",             module: "profile",    label: "Acceder a Mi Perfil" },
];

// Permisos por modulo: el item del menu aparece si el usuario tiene al menos uno de estos
export const MENU_PERMISSION_MAP: Record<string, PermissionCode[]> = {
  pos:        ["pos.use"],
  tables:     ["tables.use"],
  cash:       ["cash.view"],
  history:    ["history.view"],
  products:   ["products.view"],
  inventory:  ["inventory.view"],
  statistics: ["statistics.view"],
  audit:      ["audit.view"],
  settings:   ["settings.view"],
  users:      ["users.view"],
  updates:    ["updates.view"],
  profile:    ["profile.view"],
};

// Permisos por defecto para ADMIN (todo excepto superadmin)
export const ADMIN_DEFAULT_PERMISSIONS: PermissionCode[] = [
  "pos.use", "tables.use",
  "cash.view",
  "history.view",
  "products.view", "products.edit_products", "products.edit_additions", "products.edit_combos", "products.edit_discounts",
  "inventory.view", "inventory.adjust", "inventory.supplies_manage",
  "statistics.view",
  "audit.view",
  "settings.view", "settings.edit", "settings.export_import",
  "users.view", "users.manage",
  "updates.view",
  "profile.view",
];

// Permisos para el usuario DEMO (solo operacion de caja, sin administracion)
export const DEMO_PERMISSIONS: PermissionCode[] = [
  "pos.use",
  "tables.use",
  "cash.view",
  "history.view",
  "statistics.view",
  "audit.view",
  "inventory.view",
];

// Permisos por defecto para SELLER (vendedor basico)
export const SELLER_DEFAULT_PERMISSIONS: PermissionCode[] = [
  "pos.use",
  "tables.use",
  "cash.view",
  "history.view",
  "products.view", "products.edit_products", "products.edit_additions", "products.edit_combos", "products.edit_discounts",
  "inventory.view",
  "statistics.view",
  "audit.view",
  "settings.view",
  "settings.edit",
  "profile.view",
];

// Etiquetas legibles para los modulos
export const MODULE_LABELS: Record<string, string> = {
  pos:        "Punto de Venta",
  tables:     "Mesas",
  cash:       "Caja",
  history:    "Historial",
  products:   "Productos",
  inventory:  "Inventario",
  statistics: "Estadisticas",
  audit:      "Auditoria",
  settings:   "Configuracion",
  users:      "Usuarios",
  updates:    "Actualizaciones",
  profile:    "Mi Perfil",
};

// Orden en que se muestran los modulos en la pantalla de permisos
export const MODULE_ORDER = ["pos", "tables", "cash", "history", "products", "inventory", "statistics", "audit", "settings", "users", "updates", "profile"];
