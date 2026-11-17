# MadPost Desktop — Fase 5: retirada definitiva del actualizador legacy

## Rol
Actúa como arquitecto senior de Tauri 2, Rust, React/TypeScript, NSIS y distribución de software Windows. Trabaja **sobre el repositorio real** de MadPost, identifica los nombres efectivos de archivos y funciones y no supongas que coinciden con este documento. Prioriza cambios pequeños, seguros y verificables. Esta fase ocurre **después de superar la prueba real** de actualización entre dos pre-releases utilizando `tauri-plugin-updater`.

## Contexto confirmado
- MadPost Desktop utiliza React + Tauri 2 + Rust + SQLite local.
- La implementación previa usa `update_installer.rs`, `reqwest`, GitHub Releases, generación de `.bat`, `cmd /c`, lanzamiento de instalador NSIS con `/S`, cierre manual mediante `app.exit(0)` y relanzamiento del `.exe`.
- La implementación nueva emplea `tauri-plugin-updater` y manifiestos independientes `stable-latest.json` y `beta-latest.json` en la rama `releases-manifest`.
- Se compila **localmente en Windows** y se publica con GitHub CLI mediante un script PowerShell. **No introducir GitHub Actions para compilar ni publicar.**
- El usuario verificó una actualización real de beta a beta, incluyendo el cierre y reapertura de la aplicación.
- `update-config.json` contiene `latestVersion` y `minimumVersion`; `minimumVersion` determina cuándo la actualización es obligatoria. Comprobar la lógica vigente antes de cambiarla.
- El backup SQLite se realiza desde la UI/servicio; el respaldo del instalador anterior sirve **solo para recuperación manual**, no existe rollback automático.
- Hay instalaciones antiguas en negocios que podrían seguir usando el actualizador legacy. **La compatibilidad de esas instalaciones con el nuevo release es un requisito obligatorio.**

## Meta de la fase
Consolidar la aplicación en **un solo mecanismo de actualización** (`tauri-plugin-updater`), retirando el camino legacy de las **nuevas compilaciones**, sin romper actualizaciones existentes, datos SQLite, políticas de versiones, canales ni publicación local.

## Reglas estrictas
1. Antes de editar, inspecciona el código real, el historial relevante y las notas de las fases 1 a 4, incluidos los scripts de publicación.
2. No borres datos del usuario, SQLite, credenciales, logs útiles, backups existentes, ni directorios persistentes de AppData.
3. No elimines `update-config.json` ni cambies su semántica de forma silenciosa; podría seguir siendo consultado por clientes legacy ya instalados.
4. No elimines releases históricos, assets antiguos, tags ni formatos de distribución necesarios para migrar.
5. No elimines o renombres las rutas de `stable-latest.json` y `beta-latest.json`.
6. No elimines el mecanismo de respaldo manual del instalador sin comprobar que sigue obteniendo un ejecutable útil y que el fallo del backup no bloquea injustificadamente la actualización.
7. No uses CMD, `.bat` ni PowerShell invocado desde la aplicación **para actualizar o reiniciar**. El PowerShell **local de desarrollo/publicación**, usado manualmente por el operador, sí está permitido.
8. No cambies el instalador NSIS, su alcance `currentUser`, el identificador de la aplicación o rutas AppData sin justificar explícitamente el impacto de migración.
9. No publiques releases, no hagas `git push`, no generes tags remotos, no instales sobre el equipo ni ejecutes scripts de publicación sin aprobación explícita.
10. No imprimas ni leas para logs la clave privada o contraseña de firma del updater; no las incluyas en el repositorio.
11. No introduzcas GitHub Actions.
12. Conserva la funcionalidad y el diseño de `UpdateView.tsx` salvo cambios necesarios para simplificar el código y corregir estados.

## Paso 1 — Auditoría del legado (obligatorio antes de modificar)
Localiza y documenta:
- Todos los comandos Tauri registrados, handlers Rust, módulos, imports y llamadas React que intervienen en detección, descarga, instalación y reinicio.
- Referencias a `update_installer.rs`, `install_and_exit`, `backup_current_version`, `download_asset`, `check_update`, `cmd /c`, `.bat`, `/S`, `app.exit`, esperas de 150 ms, uso de `reqwest` **para updates** y cualquier helper de relanzamiento.
- Las funciones o dependencias que otros módulos siguen consumiendo (no eliminar código compartido de red/HTTP o backup sin comprobar su uso).
- El `UpdateService` nuevo, plugin Rust/JS, capabilities, `tauri.conf.json`, estado de UI, callbacks y manejo de fallos.
- La estructura actual de `update-config.json`, los manifiestos, la rama `releases-manifest` y el script `publish-release.ps1` (o su nombre real).

Entrega una tabla **mantener / migrar / eliminar** con todas las piezas afectadas y sus dependencias antes de proceder.

## Paso 2 — Verificar la ruta de migración de clientes legacy
Este es el punto más crítico.

Un cliente viejo **no usa** `tauri-plugin-updater`: continuará consultando su código compilado para buscar versiones en GitHub. Aunque lo retiremos del código nuevo, el viejo continuará ejecutándose hasta ser actualizado.

- Reconstruye exactamente qué endpoint, asset, convención de nombre, formato de versión y condición de pre-release espera ese cliente viejo. En particular, verifica que pueda descargar el `.exe` publicado por el script nuevo.
- Si el script actual solo publica artefactos reconocibles por el nuevo plugin, añade una opción de publicación compatible (por ejemplo, mantener el `.exe` NSIS con el nombre que esperan los clientes antiguos), **sin** cambiar el flujo nuevo ni alterar releases anteriores.
- Confirma que se mantendrán accesibles los metadatos de GitHub Releases y `update-config.json` en la rama/ruta que esperan los clientes anteriores; una vez retiremos el código, estos servicios no desaparecen.
- Revisa la política `minimumVersion`: evita exigir a un cliente viejo una versión que no podría descargar por su propio mecanismo. No fuerces actualizaciones incompatibles sin un camino de recuperación.
- Verifica si `backup_current_version` de los clientes antiguos depende de que exista el instalador de su versión actual en Releases. Documenta cómo se manejarán versiones antiguas sin asset histórico.
- Verifica la coexistencia temporal de clientes antiguos y nuevos, canales stable/beta y acceso a pre-releases. Un beta que cambie a estable no debe sufrir downgrade involuntario.
- Si hay una incompatibilidad imposible de corregir desde nuevas publicaciones (por ejemplo, código legacy que solo acepta un nombre de asset irreversible), **detén la eliminación completa** de ese punto y presenta una estrategia de transición con una versión puente o actualización manual. No afirmes que los clientes viejos están cubiertos sin evidencia.

## Paso 3 — Retirar solo el código de instalación legacy de las nuevas versiones
Una vez documentada la compatibilidad:
- Elimina `install_and_exit()` legacy y sus funciones exclusivas de descarga temporal, creación/ejecución de `.bat`, `cmd /c`, `/S`, espera arbitraria y relanzamiento manual.
- Elimina `check_update()` legacy si el nuevo servicio ya resuelve completamente la detección, canal y política de actualización, evitando búsquedas duplicadas; conserva/adapta la lógica de negocio necesaria para `minimumVersion` y pre-releases.
- Retira comandos del `invoke_handler`, exports, imports y permisos que ya no sean necesarios.
- Limpia dependencias y features **solo si ningún otro módulo las utiliza**. `reqwest` puede seguir siendo necesario para otros servicios de MadPost.
- Si `update_installer.rs` contiene lógica legítima reutilizable, extrae esa lógica a módulos apropiados antes de eliminar el archivo; no borres el archivo por su nombre de manera ciega.
- Revisa que desde la aplicación no quede ninguna ruta de actualización que inicie CMD/BAT/PowerShell.

## Paso 4 — Consolidar el flujo del updater oficial
Comprueba que haya **un único flujo** de actualización con estos pasos:
1. Obtener canal y política de actualización del usuario.
2. Leer `minimumVersion` mediante la lógica existente y decidir obligatoriedad, con comparación SemVer correcta para prereleases.
3. Consultar el manifiesto del canal correspondiente con `tauri-plugin-updater`.
4. Mostrar versiones, notas y obligatoriedad de forma coherente.
5. Mantener backup SQLite **antes de instalar**, respetando estados de error y restaurabilidad.
6. Preservar respaldo manual del instalador previo: comprobar fuente correcta, integridad básica, ruta AppData y manejo de fallo; **no introducir rollback automático**.
7. Descargar con el plugin y mostrar progreso, sin duplicar descarga manual en Rust.
8. Preparar cierre de servicios/operaciones pendientes de forma segura si el proyecto ya dispone de esa coordinación; no bloquear ni perder pedidos/mesas.
9. Instalar con `tauri-plugin-updater`, usando comportamiento de cierre/reapertura de Windows. Verificar la configuración vigente de `restartAfterInstall` y `plugins.updater.windows.installMode`; no reimplementar relanzamiento propio.
10. Al iniciar la versión nueva, verificar que los datos y el estado de la aplicación se conservan y no se vuelve a ofrecer la misma versión.

No solicites permisos nuevos innecesarios ni cambies semántica de actualización obligatoria. Asegura que las fallas de red/JSON/firma/instalación se presentan claramente y no bloquean permanentemente al usuario por fallos transitorios salvo política explícita y ya probada.

## Paso 5 — Depurar el script de publicación local (mantenerlo)
- Mantener compilación local, firma Tauri, `gh release create` y manejo de canal stable/beta; nada de workflows remotos.
- Asegurar coherencia de número de versión en `tauri.conf.json`, Cargo/package según aplique, release/tag, instalador, `.sig` y JSON.
- Mantener publicación de un `.exe` NSIS que los clientes legacy puedan reconocer cuando sea necesario, además del asset actualizado y firma para Tauri v2 (pueden ser el mismo `.exe` si procede).
- Asegurar que se carga exactamente la firma del build en el JSON, y que no se cambia el manifiesto del otro canal.
- Antes de actualizar el manifiesto, comprobar que release y assets estén publicados y accesibles.
- Si falla un paso, evitar anunciar un manifiesto roto; diseñar reintentos/recuperación y reportar un estado claro.
- Evitar construir rutas de descarga mediante supuestos de nombres; utilizar los assets reales generados.
- No publicar ni ejecutar efectos remotos en esta fase sin confirmación.

## Paso 6 — Validaciones automáticas sin efectos peligrosos
Ejecuta las comprobaciones locales disponibles (adaptándolas al proyecto):
- `cargo check` incluyendo el feature/plugin del updater cuando corresponda.
- TypeScript typecheck y build de frontend.
- Pruebas unitarias/regresión de SemVer, `minimumVersion`, stable/beta, igualdad de versión y beta→stable sin downgrade.
- Pruebas del parsing de manifiestos, selección de assets, generación de URLs y contenido de firma, con mocks/fixtures.
- Comprobación de ausencia de usos de `cmd /c`, `.bat` y helpers legacy **en el camino de actualización**. No reportar falsos positivos por scripts de desarrollo u otros módulos legítimos.
- Verificación estática de que SQLite/AppData, los backups y el flujo visual siguen intactos.
- Validación estática de la capacidad de migración legacy→nuevo en base a nombre de asset/endpoint/configuración (sin fingir que equivale a una instalación real).

No ejecutes una actualización real ni alteres la instalación local como parte de una prueba automatizada.

## Paso 7 — Documentación y entrega
Crear o actualizar `UpdatePlan/FASE5_RETIRADA_LEGACY.md` con:
- Arquitectura definitiva y diagrama del flujo.
- Lista precisa de funciones/archivos/comandos eliminados y conservados.
- Política `minimumVersion` y stable/beta.
- Método de publicación local y requisitos de firmas.
- Procedimiento de recuperación **manual** desde el backup del instalador anterior.
- Plan de transición para instalaciones antiguas (qué release aceptan y hasta cuándo se preservarán las convenciones de compatibilidad).
- Evidencia de pruebas y riesgos pendientes.
- Checklist de validación manual posterior: versión nueva, actualización desde legacy, actualización del plugin, reapertura, SQLite, backup e inexistencia de BAT/CMD.

## Criterios de aceptación
- Un solo motor de descarga/instalación en las compilaciones nuevas: `tauri-plugin-updater`.
- No existe creación ni ejecución de BAT/CMD para updates desde MadPost nuevo.
- El updater mantiene stable/beta, obligatoriedad, progreso, notas, firma y reapertura.
- Backup SQLite y respaldo manual del instalador preservados.
- Script local y GitHub CLI preservados; ningún workflow de GitHub Actions agregado.
- Hay evidencia razonada y comprobable de compatibilidad con clientes legacy, o un bloqueo de migración claramente identificado **antes** de hacer una eliminación peligrosa.
- `cargo check`, comprobaciones de frontend y tests disponibles pasan; cualquier fallo previo se distingue de las regresiones.
- No se han subido secretos ni realizado publicaciones/cambios remotos sin autorización.

## Forma de trabajo solicitada
1. Presenta primero auditoría y matriz de impacto.
2. Implementa la limpieza segura y mínima.
3. Corre las validaciones locales.
4. Entrega resumen conciso con archivos modificados, elementos eliminados, pendientes, riesgos y pasos de prueba manual.
5. No hagas commits, push, tags, releases ni instalaciones reales sin mi orden explícita.

**Nota:** Si la auditoría demuestra que la actualización de clientes legacy requiere conservar contratos de publicación anteriores, conserva dichos contratos remotos aunque el código legacy ya no exista en las nuevas compilaciones. Retirar código nuevo y retirar compatibilidad para instalaciones viejas son decisiones diferentes.
