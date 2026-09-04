# Desarrollo

## Ejecutar en modo desarrollo

Para iniciar la aplicacion de escritorio:

```bash
npm run tauri dev
```

Durante el desarrollo, Tauri levanta Vite en:

```text
http://127.0.0.1:1420/
```

Esto es normal. La URL local sirve la interfaz React, pero Tauri la carga dentro de una ventana nativa usando WebView2.

Cuando la terminal muestra:

```text
Finished `dev` profile
Running `target\debug\madpost-desktop.exe`
```

significa que la aplicacion nativa ya esta corriendo.

## Si no encuentra Cargo

Si aparece un error como:

```text
program not found
failed to run 'cargo metadata'
```

verifica que Rust/Cargo este disponible:

```powershell
rustc --version
cargo --version
```

En Windows, Cargo normalmente esta en:

```text
C:\Users\juanm\.cargo\bin
```

Si acabas de instalar Rust, cierra PowerShell y abre una terminal nueva para que se actualice el `PATH`.

## Compilar para produccion

Para generar la version final de escritorio:

```bash
npm run tauri build
```

En modo produccion la app ya no depende del servidor local de Vite.

## Ubicaciones importantes

Codigo del proyecto:

```text
C:\Users\juanm\git\MadPast-Workpace\MadPost-React
```

Build web:

```text
C:\Users\juanm\git\MadPast-Workpace\MadPost-React\dist
```

Build nativo de Tauri:

```text
C:\Users\juanm\git\MadPast-Workpace\MadPost-React\src-tauri\target
```

Base SQLite de la aplicacion:

```text
C:\Users\juanm\AppData\Roaming\com.madpost.desktop\madpost.db
```

Tambien puede estar bajo:

```text
C:\Users\juanm\AppData\Local\com.madpost.desktop\madpost.db
```

Para buscar la base de datos:

```powershell
Get-ChildItem "$env:APPDATA","$env:LOCALAPPDATA" -Recurse -Filter "madpost.db" -ErrorAction SilentlyContinue
```
