# Estrategia de Versionado - MadPost

MadPost sigue el estandar **SemVer (Versionado Semantico)**: `MAJOR.MINOR.PATCH`

---

## Como funciona cada numero

### PATCH — Correccion de errores `1.0.0 -> 1.0.1`
Se incrementa cuando se corrige un bug sin agregar funciones ni romper nada existente.

**Ejemplos en MadPost:**
- Arreglar que el logo no aparecia al primer inicio de sesion
- Corregir el formato de precios sin separador de miles
- Fix de columnas con espacio vacio en tablas

### MINOR — Nueva funcion compatible `1.0.1 -> 1.1.0`
Se incrementa cuando se agrega funcionalidad nueva sin romper lo que ya existia.

**Ejemplos en MadPost:**
- Agregar pantalla de Exportar / Importar Excel
- Agregar pantalla de Mi Perfil
- Agregar pantalla de Actualizaciones
- Agregar informacion de licencia en Configuracion

### MAJOR — Cambio incompatible `1.1.0 -> 2.0.0`
Se incrementa cuando hay cambios que rompen compatibilidad hacia atras.

**Ejemplos en MadPost (hipoteticos):**
- Cambiar el esquema de la base de datos de forma que una instalacion vieja no pueda leer los datos nuevos
- Eliminar el sistema de licencias y reemplazarlo por otro completamente distinto
- Cambiar el formato de exportacion de forma incompatible

---

## Etiquetas de pre-lanzamiento

Para pruebas antes de un release oficial:

```
2.0.0-alpha.1   -> pruebas internas, puede tener bugs graves
2.0.0-beta.1    -> pruebas mas amplias, mas estable
2.0.0           -> release oficial
```

En MadPost esto se usaria si se hace un cambio MAJOR y se quiere probar antes de darlo a clientes.

---

## Reglas para el proyecto de aqui en adelante

1. **Bug fix** (algo que no funcionaba bien) -> incrementar PATCH: `1.0.0 -> 1.0.1`
2. **Nueva pantalla o funcion** -> incrementar MINOR: `1.0.0 -> 1.1.0`
3. **Cambio en DB o flujo principal que rompe instalaciones viejas** -> incrementar MAJOR: `1.0.0 -> 2.0.0`
4. Siempre actualizar `src-tauri/tauri.conf.json` (version) y `src-tauri/Cargo.toml` (version) con el mismo numero
5. El tag de git debe ser `vX.Y.Z` (con la v minuscula adelante)
6. Siempre actualizar `update-config.json` en la raiz del repo como parte del release (ver abajo)

---

## Como publicar una nueva version

### 1. Actualizar la version en dos archivos

`src-tauri/tauri.conf.json`:
```json
{
  "version": "X.Y.Z"
}
```

`src-tauri/Cargo.toml`:
```toml
[package]
version = "X.Y.Z"
```

### 2. Decidir si la actualizacion es obligatoria

Actualiza `update-config.json` en la raiz del repo:

```json
{
  "latestVersion": "X.Y.Z",
  "minimumVersion": "???"
}
```

**Pregunta clave:** los clientes que tienen versiones anteriores, ¿pueden seguir usando la app sin actualizar?

- **Si**: deja `minimumVersion` en la version anterior mas reciente con la que aun es compatible.
  ```json
  { "latestVersion": "1.5.0", "minimumVersion": "1.3.0" }
  ```
  Los clientes con 1.3.0 o superior pueden continuar pero veran el aviso de actualizacion opcional.

- **No** (cambio de BD, flujo critico roto, seguridad): pon `minimumVersion` igual a la nueva version.
  ```json
  { "latestVersion": "1.5.0", "minimumVersion": "1.5.0" }
  ```
  Cualquier cliente con version inferior vera un bloqueo obligatorio y no puede usar la app hasta instalar.

Regla de oro: si subes una migracion de BD que rompe instalaciones viejas -> `minimumVersion = latestVersion`.

### 3. Agregar la entrada al historial de este archivo

### 4. Commit, tag y push

```bash
git add -A
git commit -m "feat: vX.Y.Z - descripcion breve para el publico, no ser tan tecnico"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

### 5. Construir el instalador local

```bash
npm run tauri build
```

El archivo queda en: `src-tauri/target/release/bundle/nsis/MadPost_X.Y.Z_x64-setup.exe`

### 6. Crear el release en GitHub y subir el instalador

```bash
gh release create vX.Y.Z "src-tauri/target/release/bundle/nsis/MadPost_X.Y.Z_x64-setup.exe" --title "vX.Y.Z" --notes "Descripcion de cambios, no ser tan tecnico"
```

> Nota: entre el paso 4 y el 6 existe una ventana donde el tag esta en GitHub pero el release aun no.
> Durante ese tiempo, clientes que abran la app veran la version en `update-config.json` pero sin instalador disponible.
> Ejecuta el paso 5 y 6 lo mas rapido posible despues del push del tag.

---

## Historial de versiones

### v1.0.0 — Lanzamiento inicial

MadPost llega a Windows como aplicacion nativa construida con React + Tauri, reemplazando la version anterior basada en Java + JavaFX. Misma funcionalidad central, arquitectura completamente nueva.

**Punto de venta**
- Venta directa con buscador de productos por categoria y subcategoria
- Combos con adiciones independientes por item del combo
- Adiciones y toppings configurables con control de stock y alertas visuales
- Notas por pedido y por item; salsas seleccionables por producto
- Modo domicilio con tipos de domicilio configurables (nombre y precio por tipo)
- Pago en efectivo, tarjeta o dividido (efectivo + tarjeta)
- Apertura automatica del cajon de dinero via impresora termica

**Mesas**
- Plano visual del salon con estados por color: libre / con pedido / comanda enviada / tiempo excedido
- Cuentas separadas por cliente; cobro independiente por cliente o por mesa completa
- Transferencia de items o clientes entre mesas
- Comandas diferenciales: solo se imprimen los productos nuevos desde la ultima comanda enviada
- Domicilio configurable por cliente dentro de una misma mesa

**Caja y administracion**
- Apertura y cierre de turnos con reporte en PDF generado automaticamente
- Historial de pedidos con reimpresion de tickets, factura PDF y envio por WhatsApp
- Historial de cajas con reporte de cierre por turno
- Edicion de ventas ya registradas (metodo de pago, notas, nombre del cliente)
- Eliminacion de ventas con restauracion automatica de stock (solo SUPERADMIN)

**Inventario**
- Stock directo por producto e insumos compartidos vinculados a productos
- Control de stock para adiciones con descuento automatico al vender
- Restauracion de stock al quitar items de mesa o cancelar clientes
- Historial de movimientos de stock con filtro por fechas y resumen de consumo por periodo

**Estadisticas**
- Resumen por rango de fechas: ventas, ticket promedio, efectivo vs tarjeta, domicilios
- Grafica de ventas diarias y horas pico
- Top de productos y ventas por categoria
- Desglose por vendedor; comparativa con periodo anterior

**Catalogo**
- Productos con opciones (variantes como tamano), descripcion, imagen y precio
- Combos, categorias, adiciones y salsas
- Descuentos por porcentaje o monto fijo con fecha de inicio y fin
- Desactivar productos y combos sin perder historial

**Configuracion**
- Impresoras independientes por funcion (caja y cocina) con copias de comanda configurables
- Tipos de domicilio multiples con nombre y precio
- WhatsApp configurable: ninguna, solo domicilios o todas las ventas
- Umbral de alerta de stock
- Logo del negocio en recibos y facturas PDF

**Sincronizacion y nube**
- Sincronizacion automatica en background con Supabase (funcion premium)
- Sincronizacion completa con progreso visual por tabla, cancelacion y log de detalle
- Copias de seguridad automaticas en la nube dos veces al dia
- Funcionamiento offline total; las ventas se guardan localmente aunque no haya internet

**Usuarios y auditoria**
- Roles: Vendedor, Administrador, Super Admin
- Recuperacion de acceso por codigo generado desde la app
- Registro de auditoria de acciones criticas con filtros por tipo y periodo

**Exportar e importar**
- Exportacion a Excel de productos, historial de pedidos, cajas y usuarios
- Importacion de productos y usuarios desde Excel
- Copia de seguridad del archivo SQLite local

**Actualizaciones**
- Auto-actualizacion desde GitHub Releases con notificacion al iniciar si hay version nueva
- Actualizaciones obligatorias configurables por version minima

**Pantalla de inicio**
- Accesos directos configurables por usuario a las secciones mas usadas
- Estadisticas rapidas: estado de caja, ventas de la sesion activa, productos activos y alertas de stock bajo
