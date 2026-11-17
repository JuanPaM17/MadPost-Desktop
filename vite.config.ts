import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import packageJson from "./package.json";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");

  return {
    define: {
      __MADPOST_ENV__: JSON.stringify({
        supabaseUrl: environment["supabase.url"] ?? environment.VITE_SUPABASE_URL ?? "",
        supabaseAnonKey:
          environment["supabase.anon_key"] ?? environment.VITE_SUPABASE_ANON_KEY ?? "",
        supabaseServiceRoleKey:
          environment["supabase.service_role_key"] ??
          environment.VITE_SUPABASE_SERVICE_ROLE_KEY ??
          "",
        // R2 is consumed exclusively by the native Rust backend. Never expose its credentials to the webview bundle.
        r2Endpoint: "",
        r2AccessKeyId: "",
        r2SecretAccessKey: "",
        r2Bucket: "",
        r2Region: "auto",
        githubRepo: environment["github.repo"] ?? "",
        githubToken: environment["github.token"] ?? "",
        madpostBaseUrl: environment["madpost.base_url"] ?? "https://madpost.bizzify.lat",
      }),
      __MADPOST_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: [react()],
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
