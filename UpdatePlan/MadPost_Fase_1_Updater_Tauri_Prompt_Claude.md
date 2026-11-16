# MadPost — Fase 1: preparar Tauri Updater sin romper el actualizador existente

## Rol
Actúa como arquitecto de software e ingeniero senior especializado en Tauri 2, Rust, React/TypeScript, instaladores NSIS para Windows y distribución mediante GitHub Releases. Trabaja **sobre el repositorio real**, no sobre supuestos. Antes de editar, inspecciona el código y explica brevemente qué existe, qué vas a cambiar y por qué.

## Contexto actual (validar en el repositorio)
MadPost es una aplicación de escritorio React + Tauri 2 para restaurantes, con SQLite local. Hoy tiene un actualizador propio en Rust (`update_installer.rs`) que:

1. Consulta `update-config.json` desde la rama `main` del repositorio GitHub; contiene `latestVersion` y `minimumVersion`.
2. Consulta GitHub Releases: `/releases/latest` para estable o `/releases?per_page=10` para usuarios con acceso a pre-release.
3. Compara versiones con `CARGO_PKG_VERSION` y decide si una actualización es obligatoria según `minimumVersion`.
4. Antes de instalar, `UpdateView.tsx` solicita `backupService.createBackup(tenantId)` para respaldar SQLite.
5. Descarga a `%APPDATA%\com.madpost.desktop\backups\MadPost-v{version}.exe` el instalador de la versión actualmente instalada. **Este respaldo se conserva para recuperación manual**: si MadPost deja de abrirse después de una actualización, el operador puede buscar el instalador anterior y ejecutarlo manualmente. No se necesita una función de rollback dentro de la interfaz.
6. Descarga el nuevo instalador con `reqwest`, genera un `.bat` temporal y ejecuta `cmd /c` para instalar mediante NSIS (`/S`), reabrir MadPost y borrar el script. Finalmente sale con `app.exit(0)` después de 150 ms.

**Motivo de la migración:** eliminar en una fase posterior los `.bat`, `cmd /c` y relanzamientos manuales porque este comportamiento puede activar alertas antivirus. No se promete que desaparezcan todas las alertas: la reputación del archivo y la firma de código de Windows son cuestiones distintas de la firma obligatoria del updater de Tauri.

## Arquitectura objetivo (implementar por fases)

- Conservar GitHub Releases como distribución y no incorporar un servidor nuevo.
- Mantener `update-config.json` con `latestVersion` y `minimumVersion` **por compatibilidad durante la migración**, hasta definir expresamente su relación con los manifiestos nuevos.
- Separar dos canales en el sistema de publicación:

```text
GitHub Releases / publicación de manifiestos
    |
    +-- stable/latest.json
    |       -> última versión estable (ejemplo: 1.5.0)
    |
    +-- beta/latest.json
            -> última versión beta autorizada (ejemplo: 1.6.0-beta.2)
```

- La estructura anterior representa **rutas lógicas**, no URLs ya existentes. No asumir que GitHub Releases hospeda carpetas `stable/` y `beta/` como directorios reales ni que `/releases/latest/download/...` sirve para pre-releases. En fases posteriores, proponer una forma REAL y verificable de publicar ambos manifiestos (por ejemplo: archivos distintos `stable-latest.json` y `beta-latest.json` como assets con URLs estables, o manifiestos en rutas separadas de una rama de publicación consumidos mediante `raw.githubusercontent.com`). Evaluar especialmente que GitHub `releases/latest` ignora pre-releases. No cambiar ahora la publicación.
- Usar `tauri-plugin-updater` oficial para comprobación, descarga, validación obligatoria de firma, instalación y cierre en Windows; conservar lógica de autorización de canal, `minimumVersion`, backup SQLite y backup del instalador previo.
- Preferir NSIS para Windows y `installMode: passive`, sujeto a confirmar configuración real.
- Los canales deberán resolverse según autorización existente, idealmente desde Rust o una capa que no permita saltarse las reglas del negocio mediante un simple cambio visual. No asumir un modelo de autorización distinto sin inspección.
- El plugin oficial no incorpora rollback del negocio; conservar el backup manual del instalador anterior mientras sea útil y comprobar qué pasa si el release previo no está disponible.

## Alcance ESTRICTO de esta Fase 1
**Objetivo:** dejar preparado e integrado el plugin oficial y la estrategia de firma/configuración, **sin activar una nueva instalación real, sin cambiar el flujo que usan los clientes y sin eliminar código anterior**.

### 1. Inspección e inventario (obligatorio antes de cambios)
Localiza y lee, según existan:
- `package.json` y gestor de paquetes; versiones de Tauri, CLI y React.
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` y posibles archivos de configuración por ambiente.
- `src-tauri/src/lib.rs` o `main.rs`, inicialización de plugins.
- `src-tauri/capabilities/*.json`.
- `update_installer.rs`, comandos Tauri expuestos, `UpdateView.tsx`, `backupService`, configuración de GitHub Releases y scripts de build.
- `.github/workflows/*`, si existen.
- Dónde se guarda SQLite y las configuraciones locales, para confirmar que no estén dentro de la carpeta del instalador.
- Política de versiones, identidad de bundle, nombre de ejecutable y configuración NSIS.

Presenta una tabla breve con estado actual, riesgos y archivos a modificar. No inventes archivos ni versiones.

### 2. Dependencias e inicialización del plugin
- Añade `tauri-plugin-updater` en Rust y, solo si se necesita para fases siguientes, `@tauri-apps/plugin-updater` en TypeScript. Usa versiones compatibles con el Tauri y Rust efectivamente instalados; verifica los requisitos actuales del plugin (la documentación puede exigir una versión mínima de Rust).
- Registra el plugin siguiendo el patrón ya usado por el proyecto, evitando duplicados.
- Configura permisos de capacidades **mínimos y explícitos** de acuerdo con el plan. Si autorizas comandos de actualización en esta fase, no los invoques desde la UI aún.
- Activa generación de artefactos firmados para Tauri 2 en builds de release: `bundle.createUpdaterArtifacts: true`, siempre que sea compatible con el pipeline existente.
- Conserva el instalador NSIS que ya se construye. No cambies `identifier`, nombre del producto, ruta de datos, target ni modo de instalación sin justificación y aprobación.
- Documenta cómo se incorporará `windows.installMode: passive` y si resulta viable configurarlo ya sin cambiar el comportamiento del actualizador anterior.

### 3. Firma de actualizaciones
La firma del updater es **obligatoria** y no equivale a Authenticode.
- Comprueba cómo se generan o almacenan hoy las claves, si existen.
- Si no existen, indica un procedimiento reproducible para crear el par con `tauri signer generate` y conservar el archivo privado **fuera del repositorio**. Si la fase requiere interacción del operador para generar/guardar secretos, no la suplantes: entrega instrucciones y deja el paso como pendiente explícito.
- La clave pública puede ir en `tauri.conf.json` cuando sea real. **No agregues claves ficticias, ni una cadena de ejemplo que haga parecer funcional el updater, ni incluyas claves privadas en el código, registros o documentación.**
- Explica las variables del build `TAURI_SIGNING_PRIVATE_KEY` y, si corresponde, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; no las imprimas ni las confirmes en logs.
- Si activar `createUpdaterArtifacts` impide compilar sin claves de firma en el entorno actual, deja preparado un camino seguro para builds locales y documenta claramente el pendiente, sin desactivar la verificación de firmas.

### 4. Preparar la especificación de canales (SOLO diseño, sin publicar todavía)
Define un contrato y una estrategia práctica para ambos manifiestos:

```text
stable/latest.json -> última versión estable
beta/latest.json   -> última versión preliminar permitida
```

- Explica cómo mapear esas rutas lógicas a URLs **realmente accesibles** en GitHub, sin backend adicional; distingue claramente propuesta de implementación ya existente.
- Define la estructura válida del JSON estático del updater, con campos `version`, `notes`, `pub_date`, `platforms`, `url` y `signature` según corresponda, con `windows-x86_64` o el target detectado; la propiedad `signature` debe contener el **contenido del `.sig`**, no su ruta.
- Aclara qué ocurre si el canal beta tiene una versión menor o igual que la estable, o un usuario pasa de beta a estable; el plugin compara versiones por defecto y no realiza downgrades automáticamente. Proponer política, no implementarla todavía.
- Aclara cómo se seguirá leyendo `minimumVersion` y cómo se separa la política de actualización obligatoria del manifiesto para descargar e instalar.
- No mover, borrar ni editar `update-config.json` en esta fase salvo que sea estrictamente necesario y esté razonado.
- No alterar los workflows ni crear releases todavía; eso corresponde a la fase 2.

### 5. Respaldo manual de instalador
- **No eliminar `backup_current_version()` ni su carpeta** `%APPDATA%\com.madpost.desktop\backups\`.
- El propósito es permitir que el operador ejecute manualmente el instalador anterior si la versión nueva no inicia. No implementar rollback automático ni agregar botón de rollback.
- Dejar documentado si la versión respaldada coincide con la efectivamente instalada y qué hacer cuando el instalador antiguo ya no se encuentra en Releases.
- No modificar ni romper el backup SQLite de `UpdateView.tsx`.

### 6. Comprobaciones y pruebas
- Ejecuta validaciones disponibles (`cargo check`, `npm run ...`, TypeScript, tests pertinentes) si el entorno permite hacerlo, sin lanzar instalaciones reales ni generar releases públicos.
- Evita cambios de funcionalidad en la interfaz y confirma que el flujo antiguo permanece intacto.
- Confirma que ningún dato SQLite se mueve, borra o sobrescribe.
- Reporta exactamente qué verificaste y qué no pudiste comprobar.

## Prohibiciones de esta fase
- NO sustituir todavía `check_update()` o `install_and_exit()`.
- NO eliminar `reqwest`, `.bat`, CMD o código de instalación propio todavía. Se eliminarán solo tras validar el nuevo sistema en fases posteriores.
- NO hacer una actualización real del equipo ni relanzar MadPost.
- NO crear ni publicar releases/tags en GitHub.
- NO eliminar el backup manual de la versión anterior.
- NO introducir un servidor externo, nuevos servicios de pago o dependencias no justificadas.
- NO exponer claves privadas, contraseñas, tokens o datos de negocios.
- NO hacer refactorizaciones ajenas al updater.

## Entregables al terminar
1. Resumen del diagnóstico del proyecto real.
2. Lista precisa de archivos modificados y finalidad de cada cambio.
3. Dependencias y plugin registrado, o explicación verificable de qué bloquea su integración.
4. Firma preparada o instrucciones/pending del operador si se necesitan secretos.
5. Propuesta concreta y **viable** para publicar `stable/latest.json` y `beta/latest.json` usando GitHub, con URLs de ejemplo claramente identificadas como ejemplos.
6. Validaciones ejecutadas y resultados.
7. Confirmación explícita de que el actualizador antiguo, los respaldos y la interfaz siguen operativos.
8. Lista de pendientes para fase 2 (automatización de GitHub Releases y manifiestos) y de pasos que **NO** se ejecutaron.

## Criterios de aceptación
- La aplicación conserva su actual mecanismo de actualización sin cambios de comportamiento.
- No se ejecuta CMD/BAT nuevo en el flujo migrado porque todavía no se habilita el flujo migrado; el existente permanece temporalmente intacto.
- Hay preparación real del plugin oficial sin secretos filtrados ni claves ficticias.
- Existe una propuesta técnica implementable para canales estable/beta, no solo un diagrama.
- La copia del instalador anterior sigue disponible para recuperación manual.
- No existe riesgo introducido para los datos SQLite ni para instalaciones actualmente desplegadas.

## Documentación oficial
- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/distribute/windows-installer/

**Forma de trabajar:** realiza la inspección inicial, aplica únicamente los cambios seguros de esta fase y reporta el resultado con evidencias. Si hay un bloqueo objetivo de firma o de compatibilidad, no lo disimules: identifica el bloqueo, conserva el funcionamiento actual y entrega pasos concretos para resolverlo. No avances a fase 2.
