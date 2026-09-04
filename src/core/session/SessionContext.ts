import type { LocalUser } from "../types";

type Session = { user: LocalUser; tenantId: string; tenantName: string };

class SessionContext {
  private session: Session | null = null;
  login(user: LocalUser, tenantName: string) { this.session = { user, tenantId: user.tenant_id, tenantName }; }
  logout() { this.session = null; }
  current() { return this.session; }
}

export const sessionContext = new SessionContext();
