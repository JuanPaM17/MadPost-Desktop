import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { appConfig } from "../../config/AppConfig";

class SupabaseConnection {
  private client: SupabaseClient | null = null;

  getClient(): SupabaseClient {
    if (!appConfig.supabaseUrl() || !appConfig.supabaseServiceRoleKey()) {
      throw new Error("Falta configurar supabase.url o supabase.service_role_key en .env.");
    }
    if (!this.client) {
      this.client = createClient(appConfig.supabaseUrl(), appConfig.supabaseServiceRoleKey(), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return this.client;
  }
}

export const supabaseConnection = new SupabaseConnection();
