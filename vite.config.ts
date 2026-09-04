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
        r2Endpoint: environment["r2.endpoint"] ?? "",
        r2AccessKeyId: environment["r2.access_key_id"] ?? "",
        r2SecretAccessKey: environment["r2.secret_access_key"] ?? "",
        r2Bucket: environment["r2.bucket"] ?? "",
        r2Region: environment["r2.region"] ?? "auto",
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
