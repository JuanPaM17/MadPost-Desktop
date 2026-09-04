import { supabaseConnection } from "../../infrastructure/supabase/SupabaseClient";
import { authService } from "./AuthService";

export type RecoveryMode = "local" | "remote";
export type RecoveryRequest = { tenantId: string; username: string; code: string; password: string; mode: RecoveryMode };

class RecoveryService {
  async recover(request: RecoveryRequest) {
    const userId = request.mode === "local"
      ? await authService.verifyRecoveryCode(request.tenantId, request.username, request.code)
      : await this.verifyRemoteOverride(request.tenantId, request.username, request.code);
    await authService.resetPassword(userId, request.password);
  }

  private async verifyRemoteOverride(tenantId: string, username: string, rawCode: string) {
    const user = await authService.findRecoverableUser(tenantId, username);
    const code = rawCode.trim();
    if (!code) throw new Error("Ingresa el codigo de soporte.");
    const client = supabaseConnection.getClient();
    const { error: connectivityError } = await client
      .from("recovery_overrides")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    if (connectivityError) throw new Error("No hay conexion a internet para verificar el codigo de soporte.");
    const { data, error } = await client
      .from("recovery_overrides")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("username", user.username)
      .eq("override_code", code)
      .eq("used", false)
      .maybeSingle<{ id: string }>();
    if (error) throw new Error("No fue posible verificar el codigo de soporte. Revisa tu conexion.");
    if (!data) throw new Error("El codigo de soporte no existe, ya fue usado o no pertenece a este usuario.");
    const { data: consumed, error: consumeError } = await client
      .from("recovery_overrides")
      .update({ used: true })
      .eq("id", data.id)
      .eq("used", false)
      .select("id");
    if (consumeError) throw new Error("No fue posible usar el codigo de soporte.");
    if (!consumed?.length) throw new Error("El codigo de soporte ya fue utilizado.");
    return user.id;
  }
}

export const recoveryService = new RecoveryService();
