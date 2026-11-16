# Fase 3 -- Matriz de pruebas

## Pruebas automatizables ejecutadas

| Prueba | Resultado |
|---|---|
| `cargo check` (Rust) | PASS -- 0 errores, 3 warnings preexistentes |
| TypeScript typecheck (`tsc --noEmit`) | PASS -- 0 errores |
| Plugin registrado en lib.rs | PASS -- verificado en codigo |
| Permisos updater en capabilities | PASS -- verificado en codigo |
| Plugin process registrado | PASS -- verificado en codigo |
| `USE_TAURI_UPDATER = false` por defecto | PASS -- legacy activo, sin impacto en clientes |

## Pruebas manuales pendientes (NO ejecutar sin autorizacion)

Las siguientes pruebas requieren un ambiente de prueba aislado con datos SQLite de prueba.
Nunca ejecutar sobre la instalacion de produccion de un negocio real.

### Checklist de prueba de extremo a extremo

1. [ ] Instalar una version VIEJA de MadPost en maquina de prueba
2. [ ] Crear el `.env` con `TAURI_SIGNING_PRIVATE_KEY_PATH`
3. [ ] Publicar una version NUEVA firmada a un release de prueba con `publish-release.ps1 -DryRun` primero
4. [ ] Publicar real: `publish-release.ps1 -Version "X.Y.Z-test.1" -Channel stable -Notes "Prueba Fase 3"`
5. [ ] En la version antigua: cambiar `USE_TAURI_UPDATER = true` en `UpdateService.ts` y compilar
6. [ ] Abrir la app -- verificar que detecta la nueva version
7. [ ] Verificar que se muestran las notas de version correctas
8. [ ] Hacer clic en "Descargar e instalar"
9. [ ] Verificar que se ejecuta `backupService.createBackup` (revisar carpeta backups)
10. [ ] Verificar progreso de descarga en pantalla
11. [ ] Verificar que NSIS se ejecuta en modo passive (sin ventana de instalador)
12. [ ] Verificar que la app se relanza con la version nueva
13. [ ] Verificar que los datos SQLite persisten tras la actualizacion
14. [ ] Verificar que NO se invoco `cmd.exe`, PowerShell ni `.bat` en la ruta nueva
15. [ ] Repetir para canal beta con `prereleaseAccess = true`
16. [ ] Probar `minimumVersion` mayor a la version instalada -- verificar bloqueo
17. [ ] Probar con manifiesto inexistente (404) -- verificar mensaje de error claro
18. [ ] Probar con firma invalida -- verificar que el plugin rechaza la descarga
19. [ ] Probar downgrade: beta instalada > stable disponible -- verificar que NO instala

## Pruebas de error (sin instalacion real)

| Escenario | Comportamiento esperado | Verificado |
|---|---|---|
| Manifiesto 404 | Error en `checkV2`, mensaje "No pudimos conectarnos..." | Pendiente |
| JSON invalido en manifiesto | Error en `checkV2`, mismo mensaje | Pendiente |
| Firma invalida en .sig | Plugin rechaza en download, error en UI | Pendiente |
| `pendingUpdate = null` al instalar | Error "No hay actualizacion pendiente" | Pendiente |
| `debug_assertions` activo | `check_for_update_v2` retorna `available: false` | PASS (codigo) |
| Repo privado sin token | `check_for_update_v2` falla con mensaje claro | Pendiente |
