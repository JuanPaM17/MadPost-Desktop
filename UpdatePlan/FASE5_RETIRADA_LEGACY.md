# MadPost Desktop — Fase 5: Retirada definitiva del actualizador legacy

## Estado: COMPLETADO

---

## Arquitectura definitiva

### Flujo unico de actualizacion

```
Login exitoso
    └─> checkForUpdateV2() [App.tsx, silencioso]
            └─> invoke("check_for_update_v2", { channel })  [lib.rs]
                    └─> tauri-plugin-updater → raw.githubusercontent.com/{repo}/releases-manifest/{canal}-latest.json
                            └─> Si available=true → UpdateBanner (esquina inferior derecha)
                                    └─> "Actualizar ahora" → installUpdateV2() [App.tsx]
                                            ├─ Paso 0: BackupService.createBackup()
                                            ├─ Paso 1: invoke("download_update") → proxy madpost.bizzify.lat/api/download
                                            ├─ Paso 2: invoke("install_update_v2") → NSIS passive → cierra proceso
                                            └─ Paso 3: relaunch() [si NSIS no cerro el proceso]

Pantalla de actualizaciones (UpdateView)
    └─> Mismo flujo de pasos via tauriUpdaterService
    └─> listReleases() → invoke("list_releases") → api.github.com [historial]
```

### Canales

| Canal | Manifiesto | Acceso |
|---|---|---|
| `stable` | `releases-manifest/stable-latest.json` | Todos los usuarios |
| `beta` | `releases-manifest/beta-latest.json` | Usuarios con `hasPrereleaseAccess()` |

### URL de descarga

Los manifiestos apuntan al proxy `https://madpost.bizzify.lat/api/download?asset_id={id}&repo={repo}&name={nombre}` en lugar de `github.com/releases/download` directamente, evitando bloqueos de red en instalaciones de produccion.

---

## Archivos eliminados

### Rust
| Archivo | Razon |
|---|---|
| `src-tauri/src/update_installer.rs` | Contenia todo el mecanismo legacy: `.bat`, `cmd /c`, `app.exit(0)`, descarga manual con `reqwest`, `backup_current_version`, `install_and_exit`, `check_update`, `list_releases`, `is_newer`, `get_bytes` |

### Comandos Tauri eliminados del invoke_handler
| Comando | Reemplazado por |
|---|---|
| `check_for_update` | `check_for_update_v2` |
| `install_update` | `download_update` + `install_update_v2` |

### TypeScript / React
| Archivo / Simbolo | Razon |
|---|---|
| `src/features/update/UpdateDialog.tsx` | Reemplazado por `UpdateBanner` + `UpdateStepsModal` |
| `UpdateService.checkForUpdate()` | Reemplazado por `tauriUpdaterService.checkV2()` |
| `UpdateService.check()` | Eliminado |
| `UpdateService.install()` | Eliminado |
| `UpdateService.USE_TAURI_UPDATER` | Eliminado (siempre true, sin uso) |
| `UpdateInfo`, `UpdateCheckResult` (tipos) | Eliminados |
| `__USE_TAURI_UPDATER__` en vite.config.ts | Eliminado |

---

## Archivos conservados / modificados

### Rust
| Archivo | Cambio |
|---|---|
| `src-tauri/src/lib.rs` | `list_releases` reimplementado inline; eliminados `check_for_update`, `install_update`, `mod update_installer` |
| `src-tauri/src/update_installer.rs` | ELIMINADO |

### TypeScript
| Archivo | Cambio |
|---|---|
| `src/features/update/UpdateService.ts` | Reducido a `APP_VERSION`, `ReleaseEntry`, `listReleases()` |
| `src/features/update/TauriUpdaterService.ts` | Sin cambios — es el nuevo servicio |
| `src/features/update/UpdateView.tsx` | Usa `tauriUpdaterService` y `UpdateStepsModal` compartido |
| `src/features/update/UpdateStepsModal.tsx` | Nuevo — componentes compartidos entre UpdateView y App.tsx |
| `src/App.tsx` | `checkForUpdateV2()` + `installUpdateV2()` + `UpdateBanner` |
| `vite.config.ts` | Eliminado `__USE_TAURI_UPDATER__` |

### Conservados intactos (contrato con clientes legacy)
| Archivo / Recurso | Razon |
|---|---|
| `update-config.json` (rama `main`) | Clientes ≤ 1.8.x lo consultan para saber si hay update. Mientras `latestVersion` sea `1.8.0` no se fuerza ninguna actualizacion sobre ellos. |
| Nombre de asset `MadPost.Desktop_x.x.x_x64-setup.exe` | El legacy busca cualquier `.exe` en los assets — el nombre actual es compatible |
| Rama `releases-manifest` y archivos `stable/beta-latest.json` | Contrato del nuevo sistema |
| `reqwest` en Cargo.toml | Usado por `r2_native.rs` (Cloudflare R2) — no es exclusivo del updater |

---

## Politica minimumVersion y canales

- `update-config.json` tiene `minimumVersion: 1.8.0`. Mientras no se modifique, ningun cliente legacy recibe actualizacion forzada.
- Para forzar migracion de clientes legacy a v1.9.x: subir `latestVersion` y `minimumVersion` a `1.9.0` en `update-config.json` y hacer commit en `main`. El cliente legacy descargara el `.exe` del release v1.9.0 via `api.github.com` (mismo mecanismo que siempre uso).
- Beta→stable: un usuario beta que cambia a stable no sufre downgrade porque `check_for_update_v2` consulta el manifiesto del canal correcto segun `hasPrereleaseAccess()`.

---

## Metodo de publicacion local

```powershell
# Publicar release nuevo
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "..."

# Publicar pre-release beta
.\scripts\publish-release.ps1 -Version "1.9.0-beta.4" -Channel beta -Notes "..."

# Solo compilar (sin GitHub)
.\scripts\publish-release.ps1 -Version "1.9.0-beta.2" -Channel beta -BuildOnly

# Resubir assets sin crear release nuevo
.\scripts\publish-release.ps1 -Version "1.9.0-beta.2" -Channel beta -UpdateOnly -SkipBuild

# Editar solo notas
.\scripts\publish-release.ps1 -Version "1.9.0-beta.2" -Channel beta -Notes "Nuevas notas" -NotesOnly
```

Requisitos: `TAURI_SIGNING_PRIVATE_KEY_PATH` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` en `.env`.

---

## Procedimiento de recuperacion manual

Si una actualizacion falla antes de completarse:

1. Abrir la app -- el banner rojo de `localStorage("update_crash_log")` indicara el punto de falla.
2. Si la app no abre (NSIS incompleto): ir a `%APPDATA%\com.madpost.desktop\backups\` y ejecutar el backup del instalador anterior (`MadPost-vX.X.X.exe`) manualmente.
3. Si no hay backup local: descargar el instalador de la version anterior desde `https://madpost.bizzify.lat/descargas` o directamente desde GitHub Releases.

**No existe rollback automatico.** El backup es unicamente para recuperacion manual.

---

## Plan de transicion para instalaciones antiguas

| Version instalada | Mecanismo de update | Estado |
|---|---|---|
| ≤ 1.8.x | Legacy (`update_installer.rs` compilado en esa version) | Mientras `update-config.json` tenga `latestVersion: 1.8.0`, no detectan update. Cuando se suba a `1.9.0`, se les ofrecera el instalador NSIS del release v1.9.0 via `api.github.com`. |
| 1.9.0-beta.1 | `tauri-plugin-updater` (nuevo) | Ya migrados al nuevo sistema. |
| ≥ 1.9.0-beta.2 | `tauri-plugin-updater` (nuevo) | Sistema consolidado. |

**Incompatibilidades conocidas:** Ninguna. El nombre del asset `.exe` es compatible con el buscador legacy. La URL de descarga via proxy `madpost.bizzify.lat` es transparente para ambos sistemas.

---

## Evidencia de validaciones

| Validacion | Resultado |
|---|---|
| `cargo check` | PASS — 3 warnings preexistentes, 0 errores |
| `tsc --noEmit` | PASS — 0 errores |
| Busqueda de `cmd /c`, `.bat`, `app.exit`, `install_and_exit` en codigo nuevo | 0 resultados |
| Busqueda de `update_installer`, `check_for_update`, `install_update` legacy | 0 resultados |
| Busqueda de `UpdateDialog`, `USE_TAURI_UPDATER` en src | 0 resultados |
| Prueba real beta.1 → beta.2 (descarga + install + relaunch) | PASS |
| Prueba real beta.2 → beta.3 (flujo desde login) | PASS |

---

## Checklist de validacion manual posterior

- [ ] Instalar beta.2, iniciar sesion, verificar que aparece banner de beta.3
- [ ] Dar "Actualizar ahora", verificar los 4 pasos con logs accesibles
- [ ] Verificar que la app relanza en beta.3
- [ ] Abrir pantalla de Actualizaciones, verificar "Todo al dia"
- [ ] Verificar historial de versiones en UpdateView
- [ ] Verificar que SQLite y datos se conservan tras la actualizacion
- [ ] Verificar que no existe ningun `.bat` ni proceso `cmd` durante el flujo
- [ ] En una instalacion legacy (≤ 1.8.x): verificar que no se ofrece update involuntario

---

## Riesgos residuales

| Riesgo | Mitigacion |
|---|---|
| NSIS `passive` mata el proceso antes de que React muestre paso 3 | `localStorage("update_crash_log")` persiste el punto de falla. `showSteps` state independiente evita que la UI desaparezca si el proceso sobrevive. |
| Cache de `raw.githubusercontent.com` (TTL 5 min) puede servir manifiesto viejo | Esperar 5 min tras publicar antes de probar desde la app. |
| Clave privada Ed25519 en SQLite sin DPAPI | Mejora futura, no bloqueante para esta fase. |
