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

## Pre-releases: cuando usarlos y como publicarlos

Un pre-release es una version real del instalador que se publica en GitHub pero **no se ofrece al publico general**. Solo los clientes que tengan activado el flag `prerelease_access` en su licencia la reciben.

### Cuando usar un pre-release (no un release normal)

- Funcionalidad nueva grande que quieres probar con uno o dos clientes antes de darsela a todos
- Cambio de riesgo medio-alto: nueva pantalla, refactor de flujo de caja, nuevo modulo
- Version que necesita validacion en produccion real antes de ser la "oficial"
- Nunca uses pre-release para un bug fix urgente -- eso va directo como release normal

### Cuando NO usar un pre-release

- Bug fix o correccion pequeña -- va directo como release normal (patch)
- Una funcion ya probada que quieres darle a todos de una vez

### Reglas importantes de pre-releases

1. **Un pre-release NUNCA va en `update-config.json`** -- ni como `latestVersion` ni como `minimumVersion`. El `update-config.json` solo refleja releases oficiales.
2. **Un pre-release no puede ser version minima obligatoria** -- no puedes forzar a clientes sin acceso a instalar algo que no ven.
3. El numero de version del pre-release debe ser mayor al `latestVersion` actual en `update-config.json`. Ejemplo: si `latestVersion` es `1.8.0`, el pre-release puede ser `1.9.0`.
4. Cuando el pre-release se aprueba y pasa a release oficial, se actualiza `update-config.json` con ese numero y se crea un nuevo release normal (o se edita el existente quitando el flag `--prerelease`).

### Como publicar un pre-release

#### Paso 1 — Actualizar version en los cuatro archivos (igual que un release normal)

`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` con el nuevo numero.

**NO tocar `update-config.json`** -- ese archivo queda apuntando al ultimo release oficial.

#### Paso 2 — Commit, tag y push

```bash
git add -A
git commit -m "feat: vX.Y.Z - descripcion breve (pre-release)"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

#### Paso 3 — Build

```bash
npm run tauri build
```

#### Paso 4 — Crear el release en GitHub con flag `--prerelease`

```bash
gh release create vX.Y.Z "src-tauri/target/release/bundle/nsis/MadPost_X.Y.Z_x64-setup.exe" \
  --title "vX.Y.Z — Nombre descriptivo" \
  --notes "Descripcion de cambios" \
  --prerelease
```

El flag `--prerelease` es lo que hace que GitHub marque el release como pre-release. La app desktop lo detecta por el campo `prerelease: true` que devuelve la API de GitHub.

#### Paso 5 — Activar acceso en el cliente de prueba

En el panel de administracion de licencias (`/admin/licenses`), haz clic en el icono de cohete de la licencia del cliente que va a probar. El cohete se pone naranja cuando el acceso esta activo.

Desde ese momento, cuando ese cliente abra la pantalla de Actualizaciones vera la nueva version disponible con la etiqueta `(Pre-release)`.

### Promover un pre-release a release oficial

Dos opciones:

**Opcion A** (recomendada si no hubo cambios): edita el release en GitHub, desmarca "Pre-release" y marca "Latest release". Luego actualiza `update-config.json` con ese numero.

**Opcion B**: crea un release oficial nuevo con el mismo numero de version:
```bash
gh release create vX.Y.Z "src-tauri/target/release/bundle/nsis/MadPost_X.Y.Z_x64-setup.exe" \
  --title "vX.Y.Z — Nombre descriptivo" \
  --notes "Descripcion de cambios"
```
(sin `--prerelease`). Luego actualiza `update-config.json`.

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

### 1. Actualizar la version en cuatro archivos

`package.json`:
```json
{
  "version": "X.Y.Z"
}
```

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

`update-config.json` (en la raiz del repo):
```json
{
  "latestVersion": "X.Y.Z",
  "minimumVersion": "???"
}
```

> Este archivo es el que consulta la app instalada para saber si hay una version nueva disponible. Si no se actualiza, los clientes no recibiran la notificacion de actualizacion aunque el release ya este publicado en GitHub.

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

---

## Deshabilitar una version publicada

Si ya publicaste una version oficial y necesitas que nadie mas la reciba como actualizacion (bug critico, build incorrecto) sin eliminarla de GitHub:

### Paso 1 — Bajar `update-config.json` a la version anterior buena

```json
{
  "latestVersion": "1.4.0",
  "minimumVersion": "1.3.0"
}
```

Esto hace que la app ya no ofrezca `1.5.0` como actualizacion. Los clientes que ya la instalaron no se ven afectados.

### Paso 2 — Publicar la version corregida

Publica la correccion con un nuevo numero (ej. `1.5.1`) y actualiza `update-config.json` normalmente. No re-uses el numero anterior.

> Si el problema es en un pre-release, simplemente no actives el acceso en mas clientes y corrige en la siguiente version. Los pre-releases no tocan `update-config.json` asi que no hay nada que revertir.

---

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

### v1.8.0 — Copias de seguridad automaticas mientras trabajas

**Corregido:**
- Los tickets, comandas de cocina y pre-tickets ya no muestran caracteres extraños al imprimir productos con tildes, ñ u otros caracteres especiales. La correccion iniciada en v1.7.1 ahora queda completamente resuelta.

**Nuevo:**
- Mientras la caja este abierta, MadPost guarda una copia de seguridad de tus datos cada hora de forma automatica, sin que tengas que hacer nada.
- Antes de instalar una actualizacion, MadPost guarda automaticamente una copia del instalador de la version actual, para que siempre puedas volver a ella si lo necesitas.

---

### v1.7.1 — Correccion de caracteres en impresion

**Corregido:**
- Los tickets, comandas de cocina y pre-tickets ya no muestran caracteres extraños al imprimir productos con tildes, ñ u otros caracteres especiales. Antes aparecian simbolos como ├ón o caracteres ilegibles; ahora el texto se imprime correctamente en la impresora termica.

---

### v1.7.0 — Control de insumos por venta, ajustes de inventario y mejoras en mesas

**Nuevo:**
- Control de descuento de insumos por venta: puedes configurar insumo por insumo si el descuento de stock se hace automatico al vender o si el cajero puede decidirlo en cada venta. Cuando un insumo esta en modo "preguntar", aparece un modal antes de confirmar la venta para que el cajero marque que insumos incluir o no. Util para preparaciones que a veces se hacen sin un ingrediente segun el pedido del cliente.
- Boton de insumos opcionales en el carrito del punto de venta y en mesas: si un producto tiene insumos en modo "preguntar", aparece un boton de edicion en el item del carrito para revisar o cambiar la seleccion en cualquier momento antes de cobrar.
- Ajuste de inventario con operaciones rapidas: el formulario de ajuste de stock ahora tiene botones de Sumar, Restar y Reemplazar para hacer cambios sin tener que calcular manualmente el nuevo valor.
- Decimales en inventario: el formulario de ajuste de insumos ya acepta cantidades con decimales, importante para insumos que se miden por peso o volumen.
- Filtros en la pantalla de Inventario: puedes filtrar el listado de insumos y productos por nombre y estado de stock directamente desde la pantalla.
- Insumos vinculados visibles primero al editar un producto: los insumos que ya estan asociados al producto aparecen al inicio de la lista para facilitar la revision.

**Mejorado:**
- El editor de mesas ya no pregunta confirmacion al clonar una pared decorativa, la duplica directamente.
- Se corrigieron comportamientos inesperados al arrastrar en el modo de seleccion multiple del editor de mesas.
- Los combos ahora descuentan correctamente el stock de los productos hijos, sus insumos y sus adiciones, igual que si cada hijo se vendiera por separado.

---

### v1.6.0 — Mesas mejoradas, busqueda sin tildes y pre-ticket por impresora

**Nuevo:**
- El editor de mesas ahora permite agregar paredes y elementos decorativos para que el plano se vea igual que tu salon real. Puedes darle el color que quieras a cada pared.
- Seleccion multiple en el editor: arrastra el cursor sobre el plano para encuadrar varias mesas o paredes al mismo tiempo, moverlas juntas o eliminarlas de un solo clic derecho.
- Los vendedores con acceso al modulo de mesas ahora pueden editar el plano, ya no es exclusivo del administrador.

**Mejorado:**
- El buscador de productos y combos ahora encuentra resultados aunque escribas sin tildes o con letras diferentes. Por ejemplo, escribir "cafe" encuentra "Cafe" sin problema.
- Los combos ahora aparecen al inicio de la lista de categorias, igual en el punto de venta que en las mesas.
- Compartir por WhatsApp ya no requiere tener un numero registrado en la app. Abre directamente WhatsApp para que tu elijas a quien enviarselo.
- El pre-ticket ahora se imprime directamente en la impresora termica. Ya no genera un archivo PDF.
- El pre-ticket ahora muestra el precio por unidad de cada producto y el valor del domicilio cuando aplica.
- Las notas que escribes en el detalle de una mesa ahora llegan correctamente a la comanda de cocina y al cobro. Antes se podian perder en algunos casos.
- Ahora puedes ajustar la cantidad de un producto desde el detalle de la mesa tanto para subir como para bajar sin tener que eliminarlo.
- Cambiar el tipo de entrega de una mesa (domicilio o para llevar) ahora actualiza la comanda de cocina automaticamente.

---

### v1.5.0 — Modo prueba, ayuda por pantalla y auditorias completas

**Nuevo:**
- Modo prueba: opera la caja, las mesas y el punto de venta sin riesgo. Todo lo que hagas en este modo desaparece al cerrar sesion y no toca los datos reales del negocio.
- Centro de ayuda contextual: cada pantalla tiene un boton que muestra videos y guias relacionados con esa seccion, sin tener que salir de lo que estas haciendo.
- Pre-ticket desde mesas: genera una cuenta preliminar para entregarle al cliente antes de cobrar.
- Actualizaciones y Mi Perfil ahora se pueden habilitar o restringir por rol desde Roles y Permisos.

**Mejorado:**
- El detalle de ventas y cobros en la auditoria ahora se ve completo: muestra cada adicion con cantidad y precio, las salsas, la opcion del producto y las notas del cliente.

---

### v1.4.0 — Auditoria completa y mejoras de usuarios

**Nuevo:**
- Registro de auditoria ampliado: inicio y cierre de sesion, cambio de usuario, cobros y cancelaciones de mesa, ventas del punto de venta y cambios en configuracion del negocio.
- Las cancelaciones y cobros de mesa ahora muestran en el detalle de auditoria una tabla con cada producto, cantidad, precio unitario y subtotal.
- El boton de cambiar usuario solo aparece cuando hay otros usuarios disponibles y se actualiza en tiempo real al crear o eliminar usuarios.

**Mejorado:**
- La pantalla de auditoria tiene buscador, filtros por fecha, usuario, accion y tipo, y un modal de detalle completo por registro.

---

### v1.3.0 — Roles y permisos, cambio rapido de usuario y exportacion ampliada

**Nuevo:**
- Sistema de roles y permisos personalizados: asigna permisos individuales a cada usuario desde la pantalla Roles y Permisos.
- Cambiar de usuario rapidamente desde el menu lateral sin cerrar la sesion actual.

**Mejorado:**
- Exportacion del catalogo ampliada: ahora incluye tipos de domicilio, descuentos y mesas.
- Importacion del catalogo actualizada con el mismo formato ampliado.
- Al importar, los cambios son visibles de inmediato sin necesidad de reiniciar la app.
- Separador visual entre secciones del menu lateral.

---

### v1.2.0 — Sincronizacion automatica con datos anteriores

**Mejorado:**
- Si se detecta una base de datos de una instalacion anterior al iniciar la app, los datos se importan automaticamente sin pasos adicionales por parte del usuario.
- Se elimino la pantalla de confirmacion en Configuracion > Sincronizacion para este proceso.

---

### v1.1.0 — Mesas, pago dividido y mejoras generales

**Corregido:**
- El cobro con pago dividido (efectivo + tarjeta) fallaba silenciosamente sin guardar la venta
- Ventana negra que aparecia brevemente al abrir la app en Windows
- Productos y categorias recien creados no aparecian en el punto de venta hasta reiniciar la app

**Mejorado:**
- El historial ahora muestra correctamente los pagos divididos con el desglose de cuanto fue en efectivo y cuanto en tarjeta
- Al cobrar en modo dividido, puedes elegir si el monto que ingresas es el efectivo o la transferencia
- Las pantallas cargan mas rapido -- los datos se guardan en memoria y no se vuelven a consultar innecesariamente
- Las adiciones tienen buscador en el punto de venta cuando hay muchas
- El catalogo oculta automaticamente las categorias y combos que no tienen productos activos
- Horario de copias de seguridad automaticas: 5:30 PM y 11:00 PM

**Nuevo:**
- Mesas: unir dos mesas en una sola para cobrar juntas
- Mesas: transferir productos o clientes de una mesa a otra
- Al cobrar una mesa que tenia otras unidas, las mesas origen se limpian automaticamente

---

### v1.0.0 — Lanzamiento inicial

Primera version oficial de MadPost Desktop para Windows. Todo lo que necesitas para gestionar tu negocio desde un solo lugar.

**Pantalla de inicio**
- Resumen en tiempo real del estado de la caja, ventas de la sesion activa, productos disponibles y alertas de stock
- Accesos rapidos fijos a las secciones principales y accesos personalizables por cada usuario
- Vista diferenciada segun rol: vendedor ve lo esencial, administrador ve estadisticas y alertas adicionales

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
