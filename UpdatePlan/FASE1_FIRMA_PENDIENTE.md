# Fase 1 — Claves de firma del updater

## Estado: COMPLETADO

Las claves fueron generadas por el operador y la clave pública quedó configurada en `tauri.conf.json`.

| Item | Estado |
|---|---|
| Clave privada generada | HECHO — `C:\Users\juanm\.tauri\madpost-updater.key` (fuera del repo) |
| Clave pública configurada en `tauri.conf.json` | HECHO — `plugins.updater.pubkey` |
| Secret `TAURI_SIGNING_PRIVATE_KEY` en GitHub Actions | PENDIENTE — verificar por separado |
| Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` en GitHub Actions | PENDIENTE — verificar por separado |

## Por qué son obligatorias
`tauri-plugin-updater` verifica la firma criptográfica de cada actualización antes de instalarla.
Sin la clave pública en `tauri.conf.json`, el plugin rechazará cualquier artefacto.
Esta firma es **distinta** de Authenticode (firma de código de Windows para el antivirus).

## Dónde están las claves
- Clave privada: `C:\Users\juanm\.tauri\madpost-updater.key` — **nunca subir al repo**
- Clave pública: incorporada en `src-tauri/tauri.conf.json` bajo `plugins.updater.pubkey`

## Secretos de CI pendientes (Fase 2)
Para que GitHub Actions pueda generar artefactos firmados al hacer release:

1. Ir a `Settings > Secrets and variables > Actions` del repo en GitHub
2. Crear secret `TAURI_SIGNING_PRIVATE_KEY` con el contenido completo del archivo `.key`
3. Si se usó contraseña al generar: crear `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
4. El workflow de release debe exponer estas variables al paso `tauri build`

Con estas variables presentes, `createUpdaterArtifacts: true` (ya configurado en `tauri.conf.json`)
generará automáticamente `.nsis.zip` y `.nsis.zip.sig` junto al instalador NSIS en cada release.

## Confirmacion de seguridad
- La clave privada NO fue leida, impresa, copiada al repositorio ni registrada en logs
- Solo se leyó y usó el archivo `.pub`
- El repositorio no contiene ningún secreto

## Nota sobre installMode
Hay dos `installMode` con significados distintos e independientes:

| Propiedad | Ubicacion | Proposito |
|---|---|---|
| `bundle.windows.nsis.installMode: "currentUser"` | Tauri bundler | Define si NSIS instala para el usuario actual o para todos los usuarios al hacer `tauri build` |
| `plugins.updater.windows.installMode: "passive"` | Plugin updater | Define el modo de UI del instalador NSIS cuando el plugin ejecuta la actualización silenciosa en Fase 2 |

Ambas coexisten sin conflicto. `passive` en el contexto del updater es un valor válido del plugin (no del bundler).
