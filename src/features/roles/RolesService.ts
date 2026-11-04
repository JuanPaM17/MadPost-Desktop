import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { sessionContext } from "../../core/session/SessionContext";
import { auditService } from "../audit/AuditService";
import type { PermissionCode } from "./permissions";
import { ADMIN_DEFAULT_PERMISSIONS, DEMO_PERMISSIONS, SELLER_DEFAULT_PERMISSIONS } from "./permissions";

export type Role = {
  id: string;
  tenant_id: string;
  name: string;
  is_system: number; // 1 = no se puede eliminar ni renombrar
};

class RolesService {
  // -----------------------------------------------------------------------
  // Roles
  // -----------------------------------------------------------------------

  async listRoles(tenantId: string, includeDemo = false): Promise<Role[]> {
    const db = await databaseManager.database();
    const filter = includeDemo ? "" : "AND name != 'DEMO'";
    return db.select<Role[]>(
      `SELECT id, tenant_id, name, is_system FROM roles WHERE tenant_id = $1 ${filter} ORDER BY is_system DESC, name COLLATE NOCASE`,
      [tenantId],
    );
  }

  async createRole(tenantId: string, name: string): Promise<Role> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("El nombre del rol es obligatorio.");
    const db = await databaseManager.database();
    const existing = await db.select<{ total: number }[]>(
      "SELECT COUNT(*) AS total FROM roles WHERE tenant_id = $1 AND name = $2 COLLATE NOCASE",
      [tenantId, trimmed],
    );
    if ((existing[0]?.total ?? 0) > 0) throw new Error("Ya existe un rol con ese nombre.");
    const role: Role = { id: crypto.randomUUID(), tenant_id: tenantId, name: trimmed, is_system: 0 };
    await db.execute(
      "INSERT INTO roles(id, tenant_id, name, is_system, created_at) VALUES ($1, $2, $3, 0, $4)",
      [role.id, role.tenant_id, role.name, new Date().toISOString()],
    );
    const session = sessionContext.current();
    if (session) await auditService.log("CREAR_ROL", "ROLES", `Rol: ${role.name}`, role.id);
    return role;
  }

  async renameRole(role: Role, newName: string): Promise<Role> {
    if (role.is_system) throw new Error("Los roles del sistema no se pueden renombrar.");
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("El nombre es obligatorio.");
    const db = await databaseManager.database();
    const existing = await db.select<{ total: number }[]>(
      "SELECT COUNT(*) AS total FROM roles WHERE tenant_id = $1 AND name = $2 COLLATE NOCASE AND id != $3",
      [role.tenant_id, trimmed, role.id],
    );
    if ((existing[0]?.total ?? 0) > 0) throw new Error("Ya existe un rol con ese nombre.");
    await db.execute("UPDATE roles SET name = $1 WHERE id = $2", [trimmed, role.id]);
    const session = sessionContext.current();
    if (session) await auditService.log("EDITAR_ROL", "ROLES", `Rol renombrado: ${trimmed}`, role.id);
    return { ...role, name: trimmed };
  }

  async deleteRole(role: Role): Promise<void> {
    if (role.is_system) throw new Error("Los roles del sistema no se pueden eliminar.");
    const db = await databaseManager.database();
    const users = await db.select<{ username: string; display_name: string | null }[]>(
      "SELECT username, display_name FROM users WHERE tenant_id = $1 AND role = $2 ORDER BY username COLLATE NOCASE",
      [role.tenant_id, role.name],
    );
    if (users.length > 0) {
      const names = users.map((u) => u.display_name ? `${u.display_name} (${u.username})` : u.username).join(", ");
      throw new Error(`Este rol tiene ${users.length} usuario${users.length > 1 ? "s" : ""} asignado${users.length > 1 ? "s" : ""}: ${names}.`);
    }
    await db.execute("DELETE FROM role_permissions WHERE role_id = $1", [role.id]);
    await db.execute("DELETE FROM roles WHERE id = $1", [role.id]);
    const session = sessionContext.current();
    if (session) await auditService.log("ELIMINAR_ROL", "ROLES", `Rol: ${role.name}`, role.id);
  }

  async getUsersWithRole(tenantId: string, roleName: string): Promise<{ username: string; display_name: string | null }[]> {
    const db = await databaseManager.database();
    return db.select<{ username: string; display_name: string | null }[]>(
      "SELECT username, display_name FROM users WHERE tenant_id = $1 AND role = $2 ORDER BY username COLLATE NOCASE",
      [tenantId, roleName],
    );
  }

  // -----------------------------------------------------------------------
  // Permisos
  // -----------------------------------------------------------------------

  async getPermissions(roleId: string): Promise<PermissionCode[]> {
    const db = await databaseManager.database();
    const rows = await db.select<{ permission_code: string }[]>(
      "SELECT permission_code FROM role_permissions WHERE role_id = $1",
      [roleId],
    );
    return rows.map((r) => r.permission_code as PermissionCode);
  }

  async setPermissions(role: Role, codes: PermissionCode[]): Promise<void> {
    const db = await databaseManager.database();
    await db.execute("DELETE FROM role_permissions WHERE role_id = $1", [role.id]);
    for (const code of codes) {
      await db.execute(
        "INSERT OR IGNORE INTO role_permissions(role_id, permission_code) VALUES ($1, $2)",
        [role.id, code],
      );
    }
    const session = sessionContext.current();
    if (session) await auditService.log("EDITAR_PERMISOS_ROL", "ROLES", `Rol: ${role.name} (${codes.length} permisos)`, role.id);
  }

  // -----------------------------------------------------------------------
  // Permisos del usuario actual (se carga al login)
  // -----------------------------------------------------------------------

  async loadUserPermissions(tenantId: string, userRole: string): Promise<PermissionCode[]> {
    // SUPERADMIN siempre tiene todo, sin consultar DB
    if (userRole === "SUPERADMIN") return [];

    const db = await databaseManager.database();

    // Buscar si existe un rol con ese nombre en la tabla roles
    const roles = await db.select<{ id: string }[]>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND name = $2 COLLATE NOCASE LIMIT 1",
      [tenantId, userRole],
    );

    if (!roles[0]) {
      // El rol no existe en la tabla todavia (base de datos sin migrar aun)
      if (userRole === "DEMO") return DEMO_PERMISSIONS;
      return userRole === "ADMIN" ? ADMIN_DEFAULT_PERMISSIONS : SELLER_DEFAULT_PERMISSIONS;
    }

    const permissions = await this.getPermissions(roles[0].id);

    // Si el rol existe pero no tiene permisos asignados:
    // - ADMIN, SELLER y DEMO de sistema usan sus defaults
    // - Roles custom sin permisos = sin acceso
    if (permissions.length === 0) {
      if (userRole === "DEMO") return DEMO_PERMISSIONS;
      if (userRole === "ADMIN" || userRole === "SELLER") {
        return userRole === "ADMIN" ? ADMIN_DEFAULT_PERMISSIONS : SELLER_DEFAULT_PERMISSIONS;
      }
      return [];
    }

    return permissions;
  }

  // -----------------------------------------------------------------------
  // Seed: crea los roles ADMIN y SELLER del sistema si no existen
  // -----------------------------------------------------------------------

  async ensureSystemRoles(tenantId: string): Promise<void> {
    const db = await databaseManager.database();
    for (const { name, defaults } of [
      { name: "ADMIN",  defaults: ADMIN_DEFAULT_PERMISSIONS },
      { name: "SELLER", defaults: SELLER_DEFAULT_PERMISSIONS },
      { name: "DEMO",   defaults: DEMO_PERMISSIONS },
    ]) {
      const existing = await db.select<{ id: string }[]>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND name = $2 LIMIT 1",
        [tenantId, name],
      );
      let roleId: string;
      if (!existing[0]) {
        roleId = crypto.randomUUID();
        await db.execute(
          "INSERT INTO roles(id, tenant_id, name, is_system, created_at) VALUES ($1, $2, $3, 1, $4)",
          [roleId, tenantId, name, new Date().toISOString()],
        );
      } else {
        roleId = existing[0].id;
        // Marcar como sistema por si no lo estaba
        await db.execute("UPDATE roles SET is_system = 1 WHERE id = $1", [roleId]);
      }

      // Solo poblar permisos si la tabla esta vacia para este rol
      const count = await db.select<{ total: number }[]>(
        "SELECT COUNT(*) AS total FROM role_permissions WHERE role_id = $1",
        [roleId],
      );
      if ((count[0]?.total ?? 0) === 0) {
        for (const code of defaults) {
          await db.execute(
            "INSERT OR IGNORE INTO role_permissions(role_id, permission_code) VALUES ($1, $2)",
            [roleId, code],
          );
        }
      }
    }
  }
}

export const rolesService = new RolesService();
