import type { LocalUser } from "../types";
import type { PermissionCode } from "../../features/roles/permissions";

type Session = { user: LocalUser; tenantId: string; tenantName: string; permissions: PermissionCode[]; isDemo: boolean };

class SessionContext {
  private session: Session | null = null;
  login(user: LocalUser, tenantName: string, permissions: PermissionCode[] = [], isDemo = false) {
    this.session = { user, tenantId: user.tenant_id, tenantName, permissions, isDemo };
  }
  logout() { this.session = null; }
  current() { return this.session; }
  isDemo(): boolean { return this.session?.isDemo ?? false; }
  hasPermission(code: PermissionCode): boolean {
    if (!this.session) return false;
    if (this.session.user.role === "SUPERADMIN") return true;
    return this.session.permissions.includes(code);
  }
}

export const sessionContext = new SessionContext();
