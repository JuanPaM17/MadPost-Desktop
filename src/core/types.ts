export type UserRole = "ADMIN" | "SELLER" | "SUPERADMIN" | string;

export type Tenant = {
  id: string;
  name: string;
  slug: string | null;
  address: string | null;
  phone: string | null;
  tax_id: string | null;
};

export type LocalUser = {
  id: string;
  tenant_id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  active: number;
};

export type CachedLicense = {
  key: string;
  tenant_id: string;
  tenant_name: string | null;
  expires_at: string;
  validated_at: string;
  sync_enabled: number;
  device_id: string | null;
};
