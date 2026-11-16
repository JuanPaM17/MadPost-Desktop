# Fase 2 — Publicacion local reproducible y manifiestos Stable/Beta

## Prerequisitos

| Herramienta | Verificar con | Requerido |
|---|---|---|
| Git | `git --version` | Si |
| GitHub CLI | `gh --version` | Si |
| Node.js / npm | `npm --version` | Si (para build) |
| Rust / Cargo | `cargo --version` | Si (para build) |
| `.env` en raiz del proyecto | (ver abajo) | Si (para build con firma) |

### Preparar la clave de firma

La clave privada esta en `C:\Users\juanm\.tauri\madpost-updater.key` y **nunca va en el repositorio**.

Crea el archivo `.env` en la raiz del proyecto (ya esta en `.gitignore`):

```
TAURI_SIGNING_PRIVATE_KEY_PATH=C:\Users\juanm\.tauri\madpost-updater.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
```

El script lee el archivo `.key` desde esa ruta y carga su contenido como variable de entorno
antes del build. Si la variable ya esta definida en la sesion de PowerShell, el `.env` se ignora.

No pegues el contenido de la clave directamente en el `.env` — usa la ruta al archivo.

---

## Nombre real de los artefactos NSIS

Tras `npm run tauri build`, el archivo queda en:

```
src-tauri/target/release/bundle/nsis/MadPost Desktop_{version}_x64-setup.exe
src-tauri/target/release/bundle/nsis/MadPost Desktop_{version}_x64-setup.exe.sig
```

El script renombra automaticamente a `MadPost.Desktop_{version}_x64-setup.exe` (punto en lugar de espacio)
al subir a GitHub, para mantener consistencia con los releases anteriores.

**El archivo `.sig` solo se genera si `TAURI_SIGNING_PRIVATE_KEY` esta definida y `createUpdaterArtifacts: true`
esta en `tauri.conf.json`** (ya configurado desde Fase 1).

---

## Comandos de publicacion

### Release estable

```powershell
# La clave de firma se carga automaticamente desde .env
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "Mejoras y correcciones"
```

### Release beta (pre-release)

```powershell
.\scripts\publish-release.ps1 -Version "1.10.0-beta.1" -Channel beta -Notes "Vista previa de nuevas funciones"
```

### Usar notas desde un archivo

```powershell
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -NotesFile ".\CHANGELOG_1.9.0.md"
```

### Publicar build ya compilado (sin recompilar)

```powershell
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "Mejoras" -SkipBuild
```

El script verifica que el `.exe` y `.sig` existan en la carpeta bundle y que no sean muy antiguos.

### Dry-run (simular sin efectos remotos)

```powershell
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "Prueba" -DryRun
```

Genera el JSON del manifiesto en `scripts/stable-latest.json.dryrun` sin crear tag, release ni push.
Util para validar que la firma y el formato son correctos antes de publicar.

---

## Dos mecanismos de actualizacion durante la convivencia

| Mecanismo | Archivo que consulta | Quien lo actualiza |
|---|---|---|
| Actualizador actual (Rust propio) | `update-config.json` en rama `main` + API GitHub Releases | El operador manualmente |
| Futuro plugin Tauri (Fase 3) | `stable-latest.json` / `beta-latest.json` | El script automaticamente |

**Mientras convivan ambos:**
- Para que los clientes actuales reciban la notificacion, sigue actualizando `update-config.json` manualmente.
- El script de Fase 2 NO toca `update-config.json`.
- Los manifiestos nuevos son preparacion para cuando se active el plugin oficial.

### Flujo completo de publicacion de una version estable (con ambos mecanismos)

```powershell
# 1. Actualizar version en los tres archivos de codigo
#    - package.json
#    - src-tauri/tauri.conf.json
#    - src-tauri/Cargo.toml
#    (NO tocar update-config.json todavia)

# 2. Commit y tag
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "feat: v1.9.0 - descripcion breve"
git tag v1.9.0
git push origin main
git push origin v1.9.0

# 3. Publicar con el script (carga .env, compila, sube assets, actualiza manifiesto)
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "Descripcion para los clientes"

# 4. Actualizar update-config.json para el actualizador actual
#    Editar manualmente y hacer commit
git add update-config.json
git commit -m "chore: bump update-config to 1.9.0"
git push origin main
```

---

## Repositorio privado — como funcionan las URLs

El repositorio `JuanPaM17/Madpost-Desktop` es **privado**. Esto implica:

- `raw.githubusercontent.com` NO es accesible sin autenticacion para los manifiestos de la rama `releases-manifest`.
- Los assets de los releases tampoco son publicos.

**Solucion actual (compatible):**
El actualizador propio (`update_installer.rs`) ya tiene `MADPOST_GITHUB_TOKEN` compilado y lo usa para
todas las llamadas a la API de GitHub. Los manifiestos se suben como assets del release y el token
permite su descarga.

**Para cuando se active el plugin Tauri (Fase 3):**
Los endpoints en `tauri.conf.json` deberan usar las URLs de asset API de GitHub con autenticacion,
o hacer el repositorio publico. Esto se decide en Fase 3.

---

## Manifiestos generados

### Ubicaciones

| Manifiesto | Asset del release | Rama `releases-manifest` |
|---|---|---|
| `stable-latest.json` | `github.com/{repo}/releases/download/v{ver}/stable-latest.json` | `releases-manifest/stable-latest.json` |
| `beta-latest.json` | `github.com/{repo}/releases/download/v{ver}/beta-latest.json` | `releases-manifest/beta-latest.json` |

### Estructura del manifiesto (formato Tauri Updater v2)

```json
{
  "version": "1.9.0",
  "notes": "Descripcion de cambios para los clientes",
  "pub_date": "2026-11-16T14:30:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/JuanPaM17/Madpost-Desktop/releases/download/v1.9.0/MadPost.Desktop_1.9.0_x64-setup.exe",
      "signature": "<contenido real del archivo .sig — texto base64, NO la ruta>"
    }
  }
}
```

### Como actualizar un manifiesto manualmente (si el script falla en el paso de rama)

Si el release ya existe y los assets estan subidos pero el manifiesto en `releases-manifest` no se actualizo:

```powershell
# Reintento solo del manifiesto con -SkipBuild
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "..." -SkipBuild
```

El script detecta que el release ya existe y falla antes de intentar recrearlo, luego
puedes editar la logica o hacer el push manual:

```powershell
# Manual si el script sigue fallando:
git fetch origin releases-manifest
git worktree add C:\Temp\manifest-fix releases-manifest
# Editar el archivo JSON en C:\Temp\manifest-fix\stable-latest.json
git -C C:\Temp\manifest-fix add stable-latest.json
git -C C:\Temp\manifest-fix commit -m "release(stable): v1.9.0 (reintento)"
git -C C:\Temp\manifest-fix push origin releases-manifest
git worktree remove C:\Temp\manifest-fix
```

---

## Inicializacion de canales

### Primera vez que publicas con el nuevo sistema

La rama `releases-manifest` no existe al inicio. El script la crea automaticamente como
rama huerfana (sin historia compartida con `main`) en el primer uso.

Si quieres crear los manifiestos iniciales sin publicar un release real:

```powershell
# Dry-run para validar que todo funciona
.\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "Primera version" -DryRun
# Revisa scripts/stable-latest.json.dryrun
```

**Canal sin version publicada todavia:**
Si solo publicas canal `stable` y un cliente busca `beta-latest.json`, el archivo no existe
o tiene la version `0.0.0`. El script nunca inventa versiones: si `beta-latest.json` no existe
en la rama, simplemente no esta publicado — el actualizador no ofrece nada al usuario beta.

---

## Politica de versiones y regresiones

- El script **rechaza** publicar una version mas vieja que la actual en el manifiesto del canal.
- `stable` y `beta` son manifiestos independientes: publicar en uno no toca el otro.
- Un usuario con `1.10.0-beta.1` instalado NO recibira una actualizacion a `1.9.0` stable
  porque el plugin no hace downgrades (version numerica menor). Esto se gestiona en Fase 3.
- `minimumVersion` en `update-config.json` sigue controlando actualizaciones obligatorias
  para el actualizador actual. No se sincroniza automaticamente con el script.

---

## Primera version que lleva el nuevo updater incorporado

Cuando se lance la primera version estable que incluya `tauri-plugin-updater` activado (Fase 3),
los clientes con el actualizador viejo la instalaran normalmente via `update-config.json`.
A partir de esa instalacion, el mecanismo nuevo toma el control para versiones futuras.

**Transicion:**
1. El cliente tiene v1.X con actualizador viejo.
2. `update-config.json` anuncia la version que incluye el plugin (ej. v1.9.0).
3. El cliente instala v1.9.0 con el actualizador viejo (BAT/cmd).
4. Desde v1.9.0 en adelante, el plugin Tauri maneja las actualizaciones via manifiestos.

---

## Cache de raw.githubusercontent.com

GitHub CDN puede cachear los manifiestos varios minutos. El script hace un reintento
de lectura tras el push pero no garantiza consistencia inmediata. Si un cliente verifica
actualizaciones justo despues de publicar y no ve la nueva version, es normal — en 5-10
minutos el cache se invalida.

---

## Limitaciones conocidas

| Limitacion | Impacto | Mitigacion |
|---|---|---|
| Repo privado | URLs de asset no publicas | Token GitHub en actualizador actual (ya funciona) |
| Sin `.sig` en builds sin firma | Script falla antes de publicar | Cargar `TAURI_SIGNING_PRIVATE_KEY` en la sesion |
| Cache de raw.githubusercontent | Delay de hasta 10 min tras push | Esperar antes de anunciar la version a clientes |
| Tag duplicado | Script falla con mensaje claro | Usar `-SkipBuild` para reintento de manifiesto |
| Worktree en disco con ruta larga | Posible error en Windows con rutas > 260 chars | Habilitar rutas largas en Windows o mover el repo a ruta mas corta |
