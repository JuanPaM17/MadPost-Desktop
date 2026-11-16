# Fase 3 -- Migracion legacy

## Como activar la ruta nueva (para pruebas internas)

Agregar en el `.env` de la raiz del proyecto:

```
USE_TAURI_UPDATER=true
```

Recompilar (`npm run tauri build`). El valor se inyecta en el bundle en tiempo de build
via `vite.config.ts` -- no es una variable de entorno en runtime, es una constante de compilacion.

## Como regresar a la ruta legacy

Cambiar en `.env`:

```
USE_TAURI_UPDATER=false
```

O eliminar la linea -- el default es `false` si la variable no existe.

El mecanismo legacy (`update_installer.rs`, `.bat`, `cmd /c`) sigue intacto y sin cambios.
Cualquier compilacion con `USE_TAURI_UPDATER = false` usa exactamente el mismo flujo
que las versiones anteriores a Fase 3.

## Condiciones para eliminar el legacy (Fase 4)

No eliminar `update_installer.rs` ni los comandos legacy hasta que se cumplan TODAS:

- [ ] Prueba de extremo a extremo completada en maquina de prueba (ver FASE3_PRUEBAS.md)
- [ ] Al menos una version de produccion instalada con `USE_TAURI_UPDATER = true` y sin incidentes
- [ ] Confirmacion de que `relaunch()` funciona correctamente en Windows con NSIS currentUser
- [ ] Confirmacion de que el backup SQLite se ejecuta correctamente antes de la instalacion
- [ ] Confirmacion de que los datos persisten tras la actualizacion via plugin
- [ ] Resolucion del acceso al repo privado (token en Rust o repo publico)

## Riesgo residual conocido: repo privado

El plugin JS (`check()` en `TauriUpdaterService`) no tiene acceso al token de GitHub.
Si el repo es privado y `pendingUpdate` queda null, la descarga falla.

Opciones para Fase 4:
1. Hacer publico el repositorio `JuanPaM17/MadPost-Desktop` (mas simple)
2. Mover `download` e `install` al lado Rust con un comando Tauri que use el token
3. Exponer el token al plugin JS via configuracion de Tauri (menos seguro)

La opcion 1 es la mas simple y el actualizador antiguo ya funciona con el repo privado
via token compilado. Para el plugin oficial, publico es lo mas directo.

## Que NO cambia en Fase 3

- `update_installer.rs` -- sin modificaciones
- `.bat` / `cmd /c` -- sin modificaciones
- `BackupService.ts` -- sin modificaciones
- `update-config.json` -- sin modificaciones
- Flujo de acceso beta via `prerelease_access` en licencia -- sin modificaciones
- `minimumVersion` consultado por el actualizador legacy -- sin modificaciones
