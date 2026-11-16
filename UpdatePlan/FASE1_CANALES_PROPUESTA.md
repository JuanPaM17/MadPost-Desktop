# Fase 1 — Propuesta de canales stable / beta

## Restricción real de GitHub Releases
`GET /releases/latest` de GitHub **ignora pre-releases**.
Los assets de un pre-release no tienen una URL estable tipo `/releases/latest/download/...`.
Por eso no se pueden usar dos llamadas a `/releases/latest` para resolver ambos canales.

## Propuesta: manifiestos JSON como assets en cada release

Cada release (estable o beta) incluirá dos archivos JSON adicionales como assets:

| Asset | Canal | Quién lo consume |
|---|---|---|
| `stable-latest.json` | Estable | Usuarios sin acceso pre-release |
| `beta-latest.json` | Beta | Usuarios con acceso pre-release |

Estos archivos se suben manualmente (Fase 2: via GitHub Actions) junto al `.exe` y `.sig`.

### URLs de acceso (ejemplo con repo real)
```
https://github.com/JuanPaM17/MadPost-Desktop/releases/latest/download/stable-latest.json
https://github.com/JuanPaM17/MadPost-Desktop/releases/download/v1.9.0-beta.1/beta-latest.json
```

**Problema:** `releases/latest/download/` ignora pre-releases, así que `beta-latest.json`
no tiene URL estable por ese mecanismo.

### Solución recomendada: rama de publicación (`releases-manifest`)

Mantener una rama `releases-manifest` en el repo que solo contiene:
```
stable-latest.json
beta-latest.json
```

URLs via `raw.githubusercontent.com` (siempre estables, sin importar pre-release):
```
https://raw.githubusercontent.com/JuanPaM17/MadPost-Desktop/releases-manifest/stable-latest.json
https://raw.githubusercontent.com/JuanPaM17/MadPost-Desktop/releases-manifest/beta-latest.json
```

GitHub Actions actualiza estos archivos en la rama al publicar cada release.
No requiere servidor externo. El contenido es público y cacheable por CDN de GitHub.

## Estructura del manifiesto (formato Tauri Updater v2)

```json
{
  "version": "1.9.0",
  "notes": "Novedades de esta version",
  "pub_date": "2026-11-16T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/JuanPaM17/MadPost-Desktop/releases/download/v1.9.0/MadPost-Desktop_1.9.0_x64-setup.nsis.zip",
      "signature": "<contenido del archivo .sig, NO la ruta>"
    }
  }
}
```

Notas:
- `url` apunta al `.nsis.zip` generado por `createUpdaterArtifacts: true`
- `signature` es el texto del archivo `.sig` generado al compilar con la clave privada
- `version` debe ser SemVer; el plugin no hace downgrade automático

## Política de canales y minimumVersion

`minimumVersion` en `update-config.json` seguirá siendo leída por `check_update()` (Rust propio)
mientras el actualizador antiguo esté activo.

En Fase 2, cuando se active `tauri-plugin-updater`:
- El plugin compara `version` del manifiesto con `CARGO_PKG_VERSION`
- `minimumVersion` se implementará como lógica propia antes de llamar al plugin:
  si `current < minimumVersion` → forzar instalación sin opción de cancelar
- Si un usuario beta pasa a stable y la versión estable es menor: el plugin NO hará downgrade.
  Se debe mostrar mensaje explicativo. Política: si `stable >= current`, actualizar; si no, mantener.

## Qué NO se hace en Fase 1
- No se crea la rama `releases-manifest`
- No se suben manifiestos
- No se modifican workflows (no existen)
- Los endpoints en `tauri.conf.json` quedan vacíos hasta Fase 2
