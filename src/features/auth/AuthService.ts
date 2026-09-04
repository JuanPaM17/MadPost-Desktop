import { compare, hash } from "bcryptjs";
import type { LocalUser, UserRole } from "../../core/types";
import { recoveryRepository, syncQueueRepository, userRepository } from "../../infrastructure/sqlite/repositories";

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
    return user;
  }

  async generateRecoveryCode(userId: string) {
    const code = `MADP-${randomBlock()}-${randomBlock()}-${randomBlock()}`;
    await recoveryRepository.save(userId, await hash(code, 12));
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
