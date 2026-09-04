# MadPost Desktop

Aplicacion base de escritorio creada con React, TypeScript, Tauri 2 y SQLite.

## Requisitos

- Node.js 20 o superior
- Rust estable con Cargo
- WebView2 Runtime en Windows

## Comandos

```bash
npm install
npm run tauri dev
```

Para probar solo la interfaz web:

```bash
npm run dev
```

SQLite se usa dentro de Tauri mediante `@tauri-apps/plugin-sql`. En navegador se usa un fallback con `localStorage` para facilitar el desarrollo visual.
