# MadPost Desktop — Fase 3: Integración controlada de Tauri Updater 2

> **Prompt para Claude Code.** Trabaja sobre el repositorio real, inspecciona primero y no presupongas nombres de funciones que no existan.
>
> **Alcance:** integrar detección, descarga, instalación y reapertura mediante el plugin oficial de Tauri 2, manteniendo durante esta fase el actualizador antiguo como ruta de contingencia. No eliminar CMD/BAT todavía. **No publicar releases, modificar ramas remotas ni instalar sobre una instalación de producción sin autorización explícita.**

## 0. Contexto y decisiones ya tomadas

Aplicación **MadPost Desktop**, React + TypeScript + Tauri 2 + Rust, Windows, instalador NSIS y SQLite local.

Sistema existente: `update_installer.rs` usa `reqwest`, lee `update-config.json` (`latestVersion`, `minimumVersion`), consulta GitHub Releases, admite stable y pre-releases, compara la versión compilada, descarga el instalador antiguo a `%APPDATA%/.../backups/`, descarga el nuevo `.exe` y crea `.bat` ejecutado mediante `cmd /c`; `UpdateView.tsx` hace previamente `backupService.createBackup(tenantId)`. Todo esto **debe seguir disponible temporalmente** hasta completar pruebas de extremo a extremo.

En la Fase 1 se agregaron dependencias opcionales de `tauri-plugin-updater` y `@tauri-apps/plugin-updater`, se habilitó `createUpdaterArtifacts: true`, se definió NSIS `currentUser`, se generaron claves de firma y se configuró la **clave pública** en `tauri.conf.json`. La clave privada está fuera del repositorio; nunca leerla ni imprimirla salvo en el proceso de compilación autorizado.

En la Fase 2 se implementó —según el reporte del operador— la **publicación local** por PowerShell + GitHub CLI, sin GitHub Actions: compilar localmente, generar `.exe` y `.exe.sig`, publicar release y escribir manifiestos en rama `releases-manifest`. Comprueba su implementación real y sus formatos antes de conectar el cliente.

Canales:

- Stable: `https://raw.githubusercontent.com/JuanPaM17/MadPost-Desktop/releases-manifest/stable-latest.json`
- Beta: `https://raw.githubusercontent.com/JuanPaM17/MadPost-Desktop/releases-manifest/beta-latest.json`

La selección de canal debe **conservar la regla actual de autorización beta**. Los usuarios sin acceso beta no pueden habilitarlo por un simple cambio de estado visual. No crear servidor adicional ni pipelines de Actions.

## 1. Objetivo y alcance exacto

Conectar el sistema de actualizaciones de MadPost con **`tauri-plugin-updater`** para que la consulta y la verificación/descarga/instalación de artefactos firmados funcionen en un camino nuevo. Integrar `UpdateView.tsx` sin perder notas de versión, progreso, manejo de errores, respaldo de SQLite, respaldo recuperable del instalador anterior ni política de actualización obligatoria.

**Importante:** preservar el flujo viejo detrás de una opción de migración controlada mientras se validan versiones instaladas reales. Esta fase prepara y permite probar el flujo nuevo; la retirada de `update_installer.rs`, `.bat`, `cmd /c`, esperas artificiales y `app.exit(0)` será la fase de limpieza **después** de validación funcional, no antes.

## 2. Auditoría inicial obligatoria (sin modificar todavía)

1. Leer `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (o entrypoint equivalente), `src-tauri/tauri.conf.json`, `src-tauri/capabilities/*.json`, `package.json`, `UpdateView.tsx`, `update_installer.rs`, servicios de backup y cualquier estado de acceso a beta.
2. Leer los archivos de `UpdatePlan/` creados en Fase 1/2; inspeccionar el script real de publicación, los nombres de `.exe`/`.sig`, el contenido y la ruta de los manifiestos generados.
3. Determinar dónde se calcula la versión actual y quién aplica `minimumVersion`, el bloqueo de interfaz, las notas, el canal de usuario y las notificaciones.
4. Identificar si se usa una característica `updater` opcional de Cargo, por qué, y en qué comandos/builds se activa. Evitar una configuración donde JavaScript intente usar un plugin que no se registró en Rust.
5. Entregar un resumen corto de los hallazgos antes de cambios mayores; ante discrepancias entre este prompt y el repositorio, seguir la realidad del código y explicar las diferencias.

## 3. Integración Rust / Tauri

1. Registrar el plugin oficial en el arranque de Tauri de forma **coherente con `Cargo.toml` y la estrategia de activación**. Si se mantiene feature flag o mecanismo de prueba, asegurar que sea explícito y que no genere binarios sin updater por accidente.
2. Agregar permisos mínimos del updater en `capabilities`; si se llama desde React, incluir los permisos necesarios para `check`, `download`, `install` (o el conjunto `updater:default` si así se justifica). No añadir permisos amplios no relacionados.
3. Configurar correctamente `plugins.updater.windows.installMode: "passive"` para la actualización. **No confundir** con `bundle.windows.nsis.installMode: "currentUser"`, que controla el ámbito del instalador. Confirmar opciones exactas con la versión instalada.
4. La elección **dinámica** de endpoint stable/beta debe quedar bien resuelta: verificar si la API instalada permite pasar endpoints al construir `Updater` en Rust (`updater_builder().endpoints(...)`) y exponer un comando Tauri estrecho si es necesario. La API `check()` de JavaScript no debe suponerse capaz de cambiar endpoints arbitrariamente.
5. **No** configurar simultáneamente stable y beta como una lista de fallback: el segundo endpoint se usa por errores HTTP y no representa selección de canal. Seleccionar exactamente un canal según los permisos existentes.
6. Mantener TLS, clave pública y verificación criptográfica obligatoria. No desactivar la validación de firmas por comodidad; no exponer la clave privada.
7. Si una decisión de implementación requiere controlar el ciclo de vida de `Update` entre `check`, `download` e `install`, evaluar un servicio Rust que conserve el `Update` en memoria o usar JS si mantiene selección de canal verificada. Priorizar arquitectura simple y comprobable.

## 4. Detección de versiones y reglas de negocio

1. Reusar `update-config.json` como fuente actual de `minimumVersion` y, si aún corresponde, de `latestVersion` para información funcional. No duplicar dos fuentes de verdad para decidir el artefacto descargable: **el manifiesto del canal elegido es la fuente de la versión instalable y su URL/firma**.
2. Comparar con `semver` real, incluidos sufijos `-beta.1`; no usar comparación de tres números que ignore pre-releases.
3. Aplicar `minimumVersion` como regla de negocio: si versión actual es menor que mínima, marcar obligatoria la actualización y bloquear el acceso normal según comportamiento actual. Si falla la red o el manifiesto, mostrar error y ruta de recuperación; no crear un bloqueo irreversible sin estrategia.
4. Actualizaciones normales: opcionales, conservando la presentación y acción de `UpdateView.tsx`.
5. Evitar downgrade automático, incluso si el usuario cambia de beta a stable y su beta instalada es mayor que el último stable. Mostrar explicación clara y mantener versión actual hasta que exista una estable superior.
6. Validar tratamiento de `v` en tags de GitHub, SemVer, canal publicado y arquitectura `windows-x86_64`. Contemplar que exista un manifiesto sin entrada para la plataforma: informar, no descargar otro paquete.
7. Verificar qué sucede cuando el manifiesto aún no existe, está mal formado, la URL está rota, la firma no coincide o la versión publicada no es más nueva.

## 5. Descarga, respaldo e instalación

1. Conservar `backupService.createBackup(tenantId)` **antes de iniciar instalación**, preferiblemente antes de un punto irreversible; no perder errores o confirmación de backup.
2. Conservar el **respaldo manual del instalador previo** para visitas/remoto: decidir si la función `backup_current_version()` permanece como acción previa al update nuevo o si se adopta una solución equivalente y documentada. No confundir con backup SQLite. Evitar bloquear silenciosamente toda actualización si el asset antiguo dejó de estar disponible; definir una política explícita y comunicarla.
3. Descarga mediante plugin oficial, no `reqwest` propio en el camino nuevo. Permitir que React muestre progreso real con eventos `Started`, `Progress` y `Finished`; manejar total desconocido sin dividir por cero.
4. Separar descargar de instalar para que el usuario vea progreso y pueda preparar cierre. Manejar doble clic, descarga simultánea y posibles errores, sin estado inconsistente.
5. Antes de instalar, coordinar cierre de recursos: operaciones SQLite, escrituras pendientes, procesos y comunicaciones activas, sin destruir pedidos ni datos. Revisar si un hook `on_before_exit` es necesario; no asumir que un callback JS terminará después de que Windows cierre el proceso.
6. En Windows, `update.install()` debe lanzar el instalador y cerrar la app mediante mecanismo Tauri. Configurar o verificar la **reapertura** con las opciones de instalación de la versión efectiva de plugin, sin un `.bat` adicional ni relanzamiento manual en la ruta nueva.
7. No realizar una instalación real automáticamente durante pruebas unitarias, `cargo check` o al iniciar la app de desarrollo.

## 6. Integración React y compatibilidad

1. Reusar la vista actual y sus textos, estados, permisos de beta, notas de versión y política de obligatoriedad. Evitar rediseños fuera del alcance.
2. Encapsular la nueva ruta en un servicio con interfaz tipada (`check`, `download`, `install`, progreso, errores) y separar políticas de dominio de transporte/instalación.
3. Implementar selección **controlada** del mecanismo de actualización (legacy/new) para pruebas internas sin cambiar la experiencia de clientes actuales. Documentar dónde se activa y cómo regresar de manera segura durante la transición.
4. Conservar comandos/IPC legacy hasta contar con comprobación real de actualización e instalación. No exponer públicamente un botón de cambiar motor a usuarios finales salvo que ya exista autorización administrativa.
5. No registrar claves privadas, tokens, contraseñas o datos sensibles en logs.

## 7. Pruebas y aceptación

### Pruebas sin instalaciones reales

- `cargo check`, TypeScript typecheck y build frontend (usar comandos existentes).
- Validar esquema de `tauri.conf.json` y permisos activos.
- Probar análisis de versiones: stable, beta, misma versión, versión inferior, `minimumVersion` forzada y beta->stable sin downgrade.
- Probar errores: 404 del manifiesto, JSON inválido, 404 del asset, firma inválida, desconexión, descarga interrumpida, progreso con longitud desconocida.
- Verificar que el antiguo mecanismo sigue intacto, que la compilación de release genera el artefacto esperado y que el canal elegido es único.

### Pruebas manuales que debe proponer, NO ejecutar sin permiso

1. Instalar una versión **de prueba** vieja de MadPost en un ambiente controlado, usando datos SQLite de prueba (nunca sobrescribir el negocio real).
2. Publicar una versión nueva firmada a un release de prueba autorizado; verificar que el manifiesto apunte al `.exe` y su firma real.
3. Abrir la versión antigua y confirmar: detección correcta → notas → backup SQLite → backup instalador → descarga con progreso → instalación NSIS → cierre → reapertura con versión nueva → datos persistentes.
4. Repetir para canal beta y escenario `minimumVersion`.
5. Confirmar que en el **camino nuevo** no se invoca `cmd.exe`, PowerShell ni `.bat`. La ruta antigua seguirá existiendo, pero no debe usarse durante esta prueba.
6. Verificar que el instalador no dispara elevación de privilegios inesperada para un `currentUser` estándar y que reinstalar manualmente un instalador respaldado continúa siendo posible.

## 8. Documentación y entregables

Crear o actualizar en `UpdatePlan/`:

- `FASE3_INTEGRACION_UPDATER.md`: arquitectura real, archivos modificados, decisiones stable/beta, comandos y estados UI.
- `FASE3_PRUEBAS.md`: matriz de pruebas automáticas/manuales y resultados (no marcar como realizado lo no ejecutado).
- `FASE3_MIGRACION_LEGACY.md`: cómo activar la ruta nueva para pruebas, cómo regresar a la anterior y condiciones para eliminar legacy en la fase posterior.

### Criterios de cierre

- Plugin registrado y habilitado coherentemente con los permisos y la configuración.
- Canal stable/beta seleccionable por las reglas de autorización existentes, con manifiestos Fase 2.
- Detección, progreso, respaldo, instalación y reapertura integrados en la ruta nueva.
- Política `minimumVersion` y ausencia de downgrade preservadas.
- Código anterior **conservado** y sin regresiones confirmadas por validaciones ejecutadas.
- Diferenciar con claridad **integración de código completada** versus **instalación real comprobada**. Si no se ha probado una actualización instalada de extremo a extremo, no declarar la migración validada para producción.
- Sin creación de release, pushes, cambios remotos ni publicación automática sin autorización.

## 9. Fuentes oficiales que debes verificar antes de cambiar APIs

- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/reference/javascript/updater/
- https://v2.tauri.app/plugin/process/

**Salida final de Claude:** resumen concreto de cambios, tabla de comprobaciones con resultado real, limitaciones y pendientes para Fase 4 (pruebas reales y eventual retiro de CMD/BAT). No responder únicamente con propuesta: implementar en el repositorio en el alcance acordado, sin realizar operaciones remotas o instalaciones reales no autorizadas.
