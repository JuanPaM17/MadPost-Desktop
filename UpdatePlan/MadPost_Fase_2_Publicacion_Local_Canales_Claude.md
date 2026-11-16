# PROMPT PARA CLAUDE CODE — MADPOST DESKTOP
## Fase 2: publicación local reproducible y manifiestos Stable/Beta (sin GitHub Actions)

### Contexto confirmado

Proyecto: **MadPost Desktop**, React + TypeScript + Tauri 2 + Rust, con builds Windows **NSIS** realizados **localmente** por el desarrollador. Repositorio de publicación: `JuanPaM17/MadPost-Desktop` (confirmar el remoto real antes de operar).

El mecanismo de actualizaciones actual es propio en Rust (`update_installer.rs`) y utiliza `reqwest`, la API de GitHub, `update-config.json`, descarga de instaladores, respaldo manual de instalador anterior, respaldo SQLite desde `UpdateView.tsx`, creación de BAT, ejecución por CMD e inicio posterior del programa. **Sigue activo y no debe romperse en esta fase**.

La Fase 1 dejó preparado `tauri-plugin-updater` como dependencia opcional y `@tauri-apps/plugin-updater` como dependencia JS; se configuró `bundle.createUpdaterArtifacts: true`, NSIS `currentUser` y una clave pública para verificar actualizaciones. El operador generó sus claves localmente en:

- Pública: `C:\Users\juanm\.tauri\madpost-updater.key.pub`
- Privada: `C:\Users\juanm\.tauri\madpost-updater.key`

**No leer, imprimir, copiar, adjuntar, commitear ni registrar la clave privada ni la contraseña.** Para el build, utiliza las variables de entorno provistas por el operador; no guardes secretos en archivos versionados. La clave pública ya debería encontrarse en `tauri.conf.json`: compruébalo sin reescribirla innecesariamente.

En la fase anterior se acordó conservar:

- Detección de versiones estables y beta y política de versiones mínimas.
- `update-config.json` existente y flujo de actualización viejo.
- Backup SQLite y backup del instalador anterior para recuperación **manual**, sin interfaz de rollback.
- Los instaladores descargables desde GitHub Releases.

### Decisión arquitectónica irrevocable para esta fase

**NO utilizar GitHub Actions, runners, CI de GitHub, workflows ni compilaciones remotas.**

El operador hace el build en **Windows local** y actualmente publica con:

```powershell
gh release create vX.Y.Z "src-tauri/target/release/bundle/nsis/MadPost_X.Y.Z_x64-setup.exe" --title "vX.Y.Z" --notes "Descripción de cambios para usuarios, no demasiado técnica"
```

Se busca mejorar ese flujo con **un script PowerShell local** que pueda compilar / validar artefactos, subir el instalador NSIS y la firma, y publicar manifiestos por canal sin cambiar la lógica de actualización de la aplicación todavía.

Propuesta de URLs estables para los manifiestos, si el repositorio y su rama son públicos:

```text
https://raw.githubusercontent.com/JuanPaM17/MadPost-Desktop/releases-manifest/stable-latest.json
https://raw.githubusercontent.com/JuanPaM17/MadPost-Desktop/releases-manifest/beta-latest.json
```

Rama de publicación aislada `releases-manifest` con ambos JSON. No asumir que los pre-releases cuentan como `/releases/latest`: **ese endpoint ignora pre-releases**.

---

## 0. Antes de modificar: auditoría obligatoria

1. Examina `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, capacidades, `lib.rs`, `update_installer.rs`, `UpdateView.tsx`, `update-config.json`, los documentos `UpdatePlan/FASE1_*`, scripts preexistentes y la estructura real de assets NSIS.
2. Comprueba el `git remote`, las versiones de Tauri/CLI, `gh --version`, disponibilidad de Git/PowerShell y si el repositorio de publicación es público o privado. **Si es privado, las URLs raw y los assets no son adecuados para clientes sin autenticación; documenta el bloqueo y diseña alternativa, sin fingir que es funcional**.
3. Detecta cómo están sincronizadas hoy las versiones en `package.json`, `src-tauri/tauri.conf.json`, `Cargo.toml` y el release. No cambies el esquema si no es necesario; nunca publiques un instalador cuya versión compilada no coincide con el tag.
4. Comprueba qué artefactos produce el CLI real tras `createUpdaterArtifacts: true`. Según la documentación oficial de Tauri 2, **NSIS en Windows genera `.exe` y `.exe.sig`**: no inventes `.nsis.zip`, salvo si la configuración instalada usa expresamente `"v1Compatible"`. Descubre los nombres **reales** de los archivos; no asumas `MadPost_X.Y.Z...` sin verificarlos.
5. Comprueba si `releases-manifest` ya existe, cómo se gestionan los tags y si hay releases estables o beta. No sobrescribas historia remota ni crees publicaciones reales sin autorización.
6. Anota hallazgos, limitaciones y decisiones concretas antes de cambios invasivos. Evita dependencias innecesarias.

## 1. Alcance: implementar herramienta de publicación local

Crear, si no existe ya una solución equivalente, `scripts/publish-release.ps1` (PowerShell compatible con el entorno real de Windows), con interfaz sugerida:

```powershell
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "Mejoras y correcciones para el negocio"
.\scripts\publish-release.ps1 -Version "1.10.0-beta.1" -Channel beta -Notes "Vista previa de nuevas funciones"
```

Opcional y recomendable: `-NotesFile`, `-SkipBuild` para usar artefactos ya compilados, `-DryRun` sin escrituras remotas, `-Repo`, y ayuda explicativa. **No convertir la publicación en un proceso engorroso**. El modo predeterminado de build debe acordarse con los scripts existentes: preferible soportar ambos flujos (build local seguido de publicación, o publicación de build ya existente).

### Comportamiento necesario

1. Preflight: validación de dependencias `git`, `gh`, herramientas de build cuando corresponda y autenticación de `gh`; directorio/repositorio correcto, estado de git apropiado, permisos para publicar y política de versiones.
2. Validar `Version` conforme a SemVer, incluidos pre-releases. `stable` exige versión sin sufijo prerelease; `beta` exige una versión prerelease (por ejemplo `1.10.0-beta.1`). Rechazar entradas inconsistentes sin publicar nada.
3. Verificar coincidencia exacta entre la versión del proyecto **compilada** y el tag `v{Version}`. No asumir que cambiar un JSON actualiza la versión de Rust. Detectar build obsoleto y evitar que se publique.
4. En modo build: usar el mecanismo local existente (`npm run tauri build` o equivalente real), con las variables de firma definidas en la sesión de PowerShell o de forma segura por el operador. **Nunca escribir la contraseña en el script, argumentos visibles de procesos, salida o logs**. Si no están disponibles, detenerse con instrucciones precisas, sin solicitar secretos dentro de Claude.
5. Localizar el instalador `.exe` y su archivo `.exe.sig` generado en la misma compilación. Deben corresponder inequívocamente a esa versión y arquitectura. En `-SkipBuild`, exigir verificación especial de que el instalador no es un artefacto viejo. Evitar coincidencias ambiguas por glob.
6. Validar el contenido `.sig` (no vacío) y generar el JSON Tauri v2 usando **el texto real del archivo `.sig`**, no la ruta ni la URL. Usar `ConvertTo-Json` u otra serialización correcta; NO construir JSON mediante concatenaciones vulnerables a comillas / saltos de línea.
7. Determinar `windows-x86_64` de la arquitectura real compilada y utilizar únicamente plataformas realmente publicadas. Si se compila otra arquitectura, ajustar la clave y el asset.
8. Publicar el release mediante **GitHub CLI**, con tag `v{Version}`, notas comprensibles, instalador `.exe` y `.exe.sig`, y `--prerelease` para beta. Para estable, no usar `--prerelease`; no marcar beta como latest estable. Detectar releases/tags existentes y **nunca sobrescribir silenciosamente assets o un tag publicado**. El operador debe poder reintentar de forma explícita y controlada si hubo un error parcial.
9. Obtener/confirmar las URLs reales de los assets que quedaron publicados (preferiblemente mediante `gh release view --json assets`, no mediante adivinación). Comprobar que la descarga es accesible para el público objetivo y que el tamaño del archivo es consistente. La URL del JSON debe apuntar al `.exe` adecuado.
10. Generar un JSON por canal con formato del updater estático, por ejemplo:

```json
{
  "version": "1.9.0",
  "notes": "Mejoras y correcciones para el negocio",
  "pub_date": "2026-11-16T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/JuanPaM17/MadPost-Desktop/releases/download/v1.9.0/ARCHIVO_REAL.exe",
      "signature": "TEXTO_REAL_DEL_ARCHIVO_SIG"
    }
  }
}
```

El valor de `pub_date` debe ser la **fecha UTC real de la publicación**, con formato RFC 3339; lo anterior es solamente un ejemplo.

11. Actualizar **solamente** `stable-latest.json` si `-Channel stable` o **solamente** `beta-latest.json` si `-Channel beta`. Conservar intacto el otro, salvo inicialización explícita y fundamentada. Impedir regresiones accidentales de versiones mediante comparación SemVer válida: no reemplazar un manifiesto más reciente con uno más viejo, ni tratar `1.10.0-beta.2` como mayor que `1.10.0`.
12. **Atención a bootstrap del canal**: si el archivo del otro canal todavía no tiene un release válido, no inventar versiones, URLs ni firmas. Documentar cómo inicializar canales por separado y distinguir `canal aún no publicado` de `error`.
13. Publicar la actualización del manifiesto en la rama `releases-manifest` usando Git, **sin cambiar de rama destructivamente en el workspace actual**. Preferir `git worktree` temporal o aislamiento equivalente, comprobar estado del remoto, y evitar commits en `main` por accidente. Crear la rama huérfana solo si no existe y con cuidado de no mezclar contenidos del proyecto; sin `push --force`.
14. Implementar estrategia de publicación **segura frente a fallos**: primero verificar artefactos; crear/subir y comprobar el Release; **solo después** actualizar el manifiesto. Si el manifiesto falla, informar que el Release existe pero **no está anunciado**; permitir reintento idempotente y documentado de sincronización. Nunca apuntar el manifiesto a un release incompleto.
15. Considerar caché y consistencia temporal de `raw.githubusercontent.com`; comprobar lectura del manifiesto publicado con reintentos limitados. No interpretar una respuesta cacheada como éxito definitivo inmediato. Evitar anunciar compatibilidad o disponibilidad sin comprobación.
16. Soportar correctamente UTF-8 y notas con tildes/comillas/saltos de línea en Windows. Mantener salida legible en PowerShell y no volcar secretos.
17. Finalizar con resumen de URLs, versión, canal, assets y estado del manifiesto; devolver código de salida no cero si el proceso es incompleto.

### Notas de versión

La descripción para clientes es sencilla, no demasiado técnica, como en el comando `gh release create` del operador. Usar exactamente las notas indicadas por el operador; no inventarlas. Evitar exposición accidental de secretos o datos de clientes.

## 2. `update-config.json` y política de versiones

- **No eliminar ni modificar** `update-config.json` si no hace falta para la publicación. El actualizador antiguo continúa consultándolo.
- **No sincronizar automáticamente** `minimumVersion` ni modificar la obligación de actualizar en esta fase sin análisis explícito: hay impacto sobre instalaciones existentes.
- Aclarar en la documentación que la publicación en los nuevos manifiestos y el anuncio al actualizador viejo son **dos mecanismos distintos** mientras convivan, y detallar cuál detecta cada release.
- Proponer, sin introducir cambios disruptivos, cómo el operador realizará la transición inicial: versiones viejas usan el actualizador antiguo para instalar la primera versión que incorpore updater oficial; las siguientes usan los nuevos manifiestos.
- Política beta → estable: no se fuerza downgrade. Si la versión estable es menor que la beta instalada, el programa no debe instalar una versión inferior. Ese comportamiento se implementará/validará cuando se migre la detección en fase posterior.
- **No convertir los canales en control de acceso de seguridad**: si los manifest y releases son públicos, cualquier persona puede descargar betas. Mantener la selección de canal por permiso/licencia como regla de negocio, no como secreto.

## 3. Configuración de updater preparada, NO migración funcional todavía

- Inspecciona si `tauri.conf.json` ya tiene clave pública y endpoints correctos o vacíos.
- Documenta los endpoints definitivos de `stable-latest.json` y `beta-latest.json`.
- Si añadir endpoints o registrar `tauri-plugin-updater` modifica el funcionamiento del actualizador, **no lo hagas en esta fase**; esa activación corresponde a la fase de integración posterior.
- `bundle.windows.nsis.installMode = "currentUser"` y `plugins.updater.windows.installMode = "passive"` son opciones **diferentes**. No reemplazar una por otra. El segundo aplica cuando se active el plugin.
- Mantén dependencia optional/feature si forma parte del enfoque de coexistencia escogido.

## 4. Integridad y comprobaciones

Implementar validaciones automatizables (tests/scripts o dry-run, según convenga) para:

- JSON con versión SemVer y esquema Tauri v2 (`version`, `platforms.windows-x86_64.url`, `platforms.windows-x86_64.signature`).
- Firma leída del `.sig`, no la URL del mismo.
- `stable` no sobrescribe `beta`; `beta` no sobrescribe `stable`.
- Publicar una versión más vieja no cambia el manifiesto.
- Build obsoleto, archivo faltante, firma vacía, tag duplicado y release parcial fallan con mensajes claros.
- Escenario de reintento después de subir assets pero antes de actualizar la rama.
- Dry-run no crea tags, releases, commits ni modifica la rama remota.
- `cargo check` y comprobaciones JS pertinentes, si las modificaciones lo justifican.

Para pruebas no destructivas, usar manifiestos locales simulados y mocks donde corresponda. **No crear un release real, ni crear la rama remota, ni ejecutar push sin una orden explícita del operador**. Primero entregar el script probado localmente. No usar GitHub Actions en ningún caso.

## 5. Entregables esperados

1. `scripts/publish-release.ps1` implementado (o adaptado a la estructura existente) y archivos auxiliares mínimos si se justifican.
2. Documentación `UpdatePlan/FASE2_PUBLICACION_LOCAL.md` con: prerequisitos, firma local, comandos `stable` y `beta`, `-DryRun`, recuperación tras error parcial, inicialización de la rama `releases-manifest`, gestión de cache, limitaciones conocidas y publicación de la primera versión con updater oficial.
3. Validaciones automatizadas cuando proceda.
4. Tabla de archivos modificados y razón de cada cambio.
5. Evidencia de validaciones realizadas, resultados y pendientes precisos para fase siguiente.
6. Ejemplos finales de uso adaptados a **nombres de archivos reales** en el proyecto.

### Restricciones duras

- NO crear workflows GitHub Actions.
- NO modificar la lógica antigua de actualización (`update_installer.rs`, comandos BAT/CMD, ni el flujo de `UpdateView.tsx`).
- NO quitar respaldos de SQLite ni instaladores anteriores.
- NO habilitar instalación automática con plugin todavía; se hará en fase posterior.
- NO introducir servicio backend propio, VPS, GitHub Actions ni dependencias de pago.
- NO tocar claves privadas, contraseñas, secretos ni imprimirlos en logs.
- NO hacer publicaciones reales, push, borrar ni sobrescribir tags/releases sin autorización explícita.
- NO atribuir funciones no verificadas al CLI, especialmente el nombre del archivo generado por Tauri.
- Si el repositorio es privado y los clientes no están autenticados contra GitHub, señalarlo como requisito bloqueante para esas URLs.

### Criterios de aceptación de Fase 2

- [ ] Script PowerShell local con parámetros de versión, canal y notas.
- [ ] Modo dry-run confiable, sin efectos secundarios remotos.
- [ ] Validación de versiones y artefactos firmados NSIS.
- [ ] Comandos GitHub CLI correctos para estables y pre-releases.
- [ ] Manifiesto Tauri v2 generado a partir del `.exe.sig` real.
- [ ] Flujo de rama `releases-manifest` que respete el otro canal.
- [ ] Fallos parciales recuperables sin anunciar releases incompletos.
- [ ] Documentación de transición desde el actualizador viejo.
- [ ] Actualizador antiguo intacto y compilación existente funcional.
- [ ] Sin Actions, sin secretos expuestos y sin publicaciones reales no autorizadas.

**Comienza inspeccionando el repositorio real, contrasta las convenciones con la documentación oficial de Tauri 2 y GitHub CLI, y luego implementa exclusivamente esta Fase 2.**

Fuentes para contrastar:
- https://v2.tauri.app/plugin/updater/
- https://cli.github.com/manual/gh_release_create
- https://cli.github.com/manual/gh_release_upload
