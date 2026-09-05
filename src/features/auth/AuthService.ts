import { compare, hash } from "bcryptjs";
import type { LocalUser, UserRole } from "../../core/types";
import { pendingDeletesRepository, recoveryRepository, syncQueueRepository, userRepository } from "../../infrastructure/sqlite/repositories";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { auditService } from "../audit/AuditService";

const SUPERADMIN_USERNAME = "juanpamacast";
const SUPERADMIN_PASSWORD = "1039700598";

class AuthService {
  async hasAdminUser(tenantId: string) {
    return userRepository.hasAdmin(tenantId);
  }

  async login(tenantId: string, username: string, password: string): Promise<LocalUser> {
    const user = await userRepository.findByUsername(tenantId, username);
    if (!user || !user.active || !(await compare(password, user.password_hash))) {
      throw new Error("Usuario o contrasena incorrectos.");
    }
    return user;
  }

  async createUser(tenantId: string, username: string, password: string, displayName: string, role: UserRole) {
    const normalizedUsername = username.trim().toLowerCase();
    if (password.length < 4) throw new Error("La contrasena debe tener al menos 4 caracteres.");
    if (!normalizedUsername) throw new Error("El usuario es obligatorio.");
    if (await userRepository.findByUsername(tenantId, normalizedUsername)) throw new Error("Ese usuario ya existe.");
    const user: LocalUser = {
      id: crypto.randomUUID(), tenant_id: tenantId, username: normalizedUsername,
      password_hash: await hash(password, 12), display_name: displayName.trim(), role, active: 1,
    };
    await userRepository.insert(user);
    await syncQueueRepository.ensureUserInsert(user.id, { ...user, password_hash: undefined });
    await auditService.log("CREAR_USUARIO", "USUARIOS", `Usuario: ${user.username}`, user.id);
    return user;
  }

  async generateRecoveryCode(userId: string) {
    const code = `MADP-${randomBlock()}-${randomBlock()}-${randomBlock()}`;
    await recoveryRepository.save(userId, await hash(code, 12));
    await auditService.log("RESET_PASSWORD", "USUARIOS", "Codigo de acceso generado", userId);
    return code;
  }

  async findRecoverableUser(tenantId: string, username: string) {
    const user = await userRepository.findByUsername(tenantId, username.trim().toLowerCase());
    if (!user || !user.active) throw new Error("No existe un usuario activo con ese nombre.");
    if (user.role === "SUPERADMIN") throw new Error("Esta cuenta no puede recuperarse desde esta pantalla.");
    return user;
  }

  async verifyRecoveryCode(tenantId: string, username: string, code: string) {
    const record = await recoveryRepository.findForUser(tenantId, username.trim().toLowerCase());
    if (!record) throw new Error("No se encontro un codigo de recuperacion para este usuario.");
    if (record.role === "SUPERADMIN") throw new Error("Esta cuenta no puede recuperarse desde esta pantalla.");
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode || !(await compare(normalizedCode, record.code_hash))) {
      throw new Error("El codigo de recuperacion no es valido.");
    }
    return record.id;
  }

  async resetPassword(userId: string, password: string) {
    if (password.length < 4) throw new Error("La contrasena debe tener al menos 4 caracteres.");
    await userRepository.updatePassword(userId, await hash(password, 12));
  }

  async updateProfile(user: LocalUser, username: string, displayName: string, password: string | null) {
    const normalizedUsername = username.trim().toLowerCase();
    const normalizedName = displayName.trim();
    if (!normalizedUsername) throw new Error("El nombre de usuario es obligatorio.");
    if (!normalizedName) throw new Error("El nombre para mostrar es obligatorio.");
    if (password !== null && password.length < 4) throw new Error("La contrasena debe tener al menos 4 caracteres.");
    const existing = await userRepository.findByUsername(user.tenant_id, normalizedUsername);
    if (existing && existing.id !== user.id) throw new Error("Ese nombre de usuario ya esta en uso.");
    const passwordHash = password === null ? undefined : await hash(password, 12);
    await userRepository.updateProfile(user.id, normalizedUsername, normalizedName, passwordHash);
    const updatedUser = { ...user, username: normalizedUsername, display_name: normalizedName, ...(passwordHash ? { password_hash: passwordHash } : {}) };
    await syncQueueRepository.enqueue("users", user.id, "UPDATE", updatedUser);
    return updatedUser;
  }

  async listUsers(tenantId: string) {
    const database = await databaseManager.database();
    return database.select<LocalUser[]>("SELECT id,tenant_id,username,password_hash,display_name,role,active FROM users WHERE tenant_id=$1 AND role != 'SUPERADMIN' ORDER BY username COLLATE NOCASE", [tenantId]);
  }

  async updateUser(user: LocalUser, username: string, displayName: string, role: Extract<UserRole, "ADMIN" | "SELLER">) {
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername) throw new Error("El usuario es obligatorio.");
    const existing = await userRepository.findByUsername(user.tenant_id, normalizedUsername);
    if (existing && existing.id !== user.id) throw new Error("Ese usuario ya existe.");
    const database = await databaseManager.database(); const now = new Date().toISOString();
    await database.execute("UPDATE users SET username=$1,display_name=$2,role=$3,updated_at=$4 WHERE id=$5 AND tenant_id=$6", [normalizedUsername, displayName.trim() || null, role, now, user.id, user.tenant_id]);
    const updated = { ...user, username: normalizedUsername, display_name: displayName.trim() || null, role } as LocalUser;
    await syncQueueRepository.enqueue("users", user.id, "UPDATE", { id: updated.id, tenant_id: updated.tenant_id, username: updated.username, display_name: updated.display_name, role: updated.role, active: updated.active, updated_at: now });
    await auditService.log("EDITAR_USUARIO", "USUARIOS", `Usuario: ${updated.username}`, updated.id);
    return updated;
  }

  async setUserActive(user: LocalUser, active: boolean) {
    const database = await databaseManager.database(); const now = new Date().toISOString();
    await database.execute("UPDATE users SET active=$1,updated_at=$2 WHERE id=$3 AND tenant_id=$4", [active ? 1 : 0, now, user.id, user.tenant_id]);
    const updated = { ...user, active: active ? 1 : 0 } as LocalUser;
    await syncQueueRepository.enqueue("users", user.id, "UPDATE", { id: user.id, active, updated_at: now });
    await auditService.log(active ? "ACTIVAR_USUARIO" : "DESACTIVAR_USUARIO", "USUARIOS", `Usuario: ${user.username}`, user.id);
    return updated;
  }

  async deletionCheck(user: LocalUser) {
    const database = await databaseManager.database();
    const [cash, tables] = await Promise.all([
      database.select<{ total: number }[]>("SELECT COUNT(*) AS total FROM cash_sessions WHERE user_id=$1 AND status='OPEN'", [user.id]),
      database.select<{ total: number }[]>("SELECT COUNT(*) AS total FROM table_orders WHERE user_id=$1 AND status='OPEN'", [user.id]),
    ]);
    const reason = (cash[0]?.total ?? 0) > 0 ? "Tiene caja abierta" : (tables[0]?.total ?? 0) > 0 ? "Tiene mesa abierta" : null;
    return { canDelete: reason === null, reason };
  }

  async deleteUser(user: LocalUser) {
    const database = await databaseManager.database();
    await recoveryRepository.remove(user.id);
    await syncQueueRepository.clearForRecord("users", user.id);
    await database.execute("DELETE FROM users WHERE id=$1 AND tenant_id=$2", [user.id, user.tenant_id]);
    await pendingDeletesRepository.enqueue("users", user.id);
    await auditService.log("ELIMINAR_USUARIO", "USUARIOS", `Usuario: ${user.username}`, user.id);
  }
}

export async function ensureSuperAdmin(tenantId: string) {
  let user = await userRepository.findByUsername(tenantId, SUPERADMIN_USERNAME);
  if (!user || user.role !== "SUPERADMIN") {
    user = {
      id: crypto.randomUUID(), tenant_id: tenantId, username: SUPERADMIN_USERNAME,
      password_hash: await hash(SUPERADMIN_PASSWORD, 12), display_name: "Soporte MadPost", role: "SUPERADMIN", active: 1,
    };
    await userRepository.insert(user);
  }
  await syncQueueRepository.ensureUserInsert(user.id, { ...user, password_hash: undefined });
}

function randomBlock() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export const authService = new AuthService();
