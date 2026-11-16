# Fase 3 -- Integracion Tauri Updater

## Estado: INTEGRADO -- pendiente prueba de extremo a extremo en instalacion real

---

## Arquitectura

Dos mecanismos de actualizacion coexisten. El activo se controla con una variable en `.env`:

```
# .env en la raiz del proyecto
USE_TAURI_UPDATER=true   # activa el nuevo mecanismo
USE_TAURI_UPDATER=false  # (o ausente) usa el legacy
```

El valor se inyecta en el bundle en tiempo de build via `vite.config.ts` como `__USE_TAURI_UPDATER__`.
No es configurable en runtime -- requiere recompilar para cambiar.

| Mecanismo | Activo cuando | Ruta |
|---|---|---|
| Legacy (`update_installer.rs`) | `USE_TAURI_UPDATER = false` | `check_for_update` -> `install_update` -> `.bat` -> `cmd /c` |
| Nuevo (`tauri-plugin-updater`) | `USE_TAURI_UPDATER = true` | `check_for_update_v2` -> `downloadAndInstall` -> NSIS passive -> `relaunch()` |

---

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `src-tauri/Cargo.toml` | `tauri-plugin-updater` pasa de optional a obligatorio; se agrega `tauri-plugin-process`; se elimina el feature flag `updater` |
| `src-tauri/src/lib.rs` | Plugin updater y process registrados; nuevo comando `check_for_update_v2` |
| `src-tauri/tauri.conf.json` | `endpoints` con URL de stable-latest.json (rama releases-manifest) |
| `src-tauri/capabilities/default.json` | Permisos `updater:*` y `process:allow-restart` |
| `src/features/update/UpdateService.ts` | Flag `USE_TAURI_UPDATER` exportado |
| `src/features/update/TauriUpdaterService.ts` | Nuevo servicio con check/download/install y progreso |
| `src/features/update/UpdateView.tsx` | Integracion dual: renderiza segun el flag activo |

---

## Comando Rust: check_for_update_v2

```rust
async fn check_for_update_v2(app: AppHandle, channel: String) -> Result<UpdateV2Result, String>
```

- Recibe `channel`: `"stable"` o `"beta"`
- Construye el endpoint: `raw.githubusercontent.com/{repo}/releases-manifest/{channel}-latest.json`
- Inyecta `Authorization: Bearer {MADPOST_GITHUB_TOKEN}` si esta definido (repo privado)
- Retorna: `{ available, version, currentVersion, releaseNotes, pubDate }`
- En `debug_assertions` siempre retorna `available: false` (no instala en dev)

---

## Seleccion de canal

La seleccion de canal sigue la regla de autorizacion existente:

```typescript
const prereleaseAccess = await licenseService.hasPrereleaseAccess();
const channel = prereleaseAccess ? "beta" : "stable";
```

- `prerelease_access = true` en la licencia -> canal beta -> `beta-latest.json`
- `prerelease_access = false/null` -> canal stable -> `stable-latest.json`

No existe cambio manual de canal en la UI. La regla es de negocio, no de preferencia.

---

## Flujo de instalacion nuevo

1. `checkV2(channel)` -> `invoke("check_for_update_v2")` en Rust
2. Si `available = true`, el servicio JS ejecuta `check()` del plugin para obtener el objeto `Update`
3. El usuario hace clic en "Descargar e instalar"
4. `backupService.createBackup(tenantId)` -- backup SQLite antes del punto irreversible
5. `downloadAndInstall(onProgress)` -- descarga con eventos Started/Progress/Finished
6. NSIS se ejecuta en modo `passive` (sin ventana del instalador, progreso visible en la barra de Windows)
7. `relaunch()` -- el plugin de process relanza la app con la nueva version

No se usa `.bat`, `cmd /c` ni `app.exit(0)` en esta ruta.

---

## Repo privado

`raw.githubusercontent.com` no es publicamente accesible en repos privados.
El comando Rust inyecta el token `MADPOST_GITHUB_TOKEN` (compilado en el binario via `option_env!`)
como header `Authorization` al construir el `Updater`.

Cuando el plugin JS ejecuta `check()` directamente (segunda llamada en `TauriUpdaterService`),
puede fallar si el repo es privado y el plugin JS no tiene acceso al token. En ese caso
`pendingUpdate` queda `null` y el `downloadAndInstall` falla con un mensaje claro.

**Resolucion definitiva para Fase 4**: mover toda la logica de download/install al lado Rust
donde el token esta disponible, o hacer publico el repo.

---

## Endpoints configurados

`tauri.conf.json`:
```json
"endpoints": [
  "https://raw.githubusercontent.com/JuanPaM17/MadPost-Desktop/releases-manifest/stable-latest.json"
]
```

El endpoint de `tauri.conf.json` es el fallback que usa el plugin si no se sobreescribe via
`updater_builder().endpoints(...)`. El comando `check_for_update_v2` siempre lo sobreescribe
dinamicamente segun el canal solicitado.

---

## Progreso de descarga

El componente muestra progreso porcentual si el servidor retorna `Content-Length`.
Si `totalBytes = null` (servidor no retorna longitud), muestra spinner sin porcentaje.
No hay division por cero: se guarda el acumulado en bytes en lugar de calcular ratio.
