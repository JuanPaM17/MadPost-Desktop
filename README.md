# MadPost Desktop

Sistema de punto de venta para Windows, construido con React, TypeScript y Tauri 2. Reemplaza la version anterior basada en Java + JavaFX con la misma funcionalidad central sobre una arquitectura completamente nueva.

## Caracteristicas principales

- Punto de venta con combos, adiciones, salsas y domicilios
- Mesas con cuentas separadas por cliente y comandas diferenciales a cocina
- Caja con apertura/cierre de turno, historial de ventas y reportes PDF
- Inventario con stock directo, insumos y movimientos
- Estadisticas por rango de fechas con graficas y comparativa de periodos
- Sincronizacion automatica en background con Supabase
- Exportacion e importacion Excel; copia de seguridad SQLite
- Roles: Vendedor, Administrador, Super Admin
- Auto-actualizacion desde GitHub Releases

## Requisitos

- Windows 10 / 11 (64-bit)
- WebView2 Runtime (incluido en Windows 11; en Windows 10 se instala automaticamente con el instalador)
- Para desarrollo: Node.js 20+, Rust estable con Cargo

## Instalacion

Descarga el instalador desde [Releases](../../releases) y ejecutalo. No requiere configuracion adicional.

## Desarrollo

```bash
npm install
npm run tauri dev
```

Para probar solo la interfaz web (sin Tauri):

```bash
npm run dev
```

## Construccion

```bash
npm run tauri build
```

El instalador queda en `src-tauri/target/release/bundle/nsis/`.

## Versionado

El proyecto sigue SemVer. Ver [VERSIONING.md](VERSIONING.md) para la estrategia completa y el historial de versiones.
