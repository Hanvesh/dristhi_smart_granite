/*
 * Lightweight auth layer.
 * In DEMO mode (default) it authenticates against the local user table below so the
 * UI is fully usable without a running Keycloak. When VITE_USE_KEYCLOAK=true it
 * expects a bearer token flow (wire up keycloak-js here).
 */
export type Role = "operator" | "officer" | "admin";

export interface Session {
  username: string;
  role: Role;
  token: string;
}

const DEMO_USERS: Record<string, { password: string; role: Role }> = {
  operator: { password: "operator", role: "operator" },
  officer: { password: "officer", role: "officer" },
  "admin-user": { password: "admin", role: "admin" },
};

const KEY = "drishti.portal.session";

export function login(username: string, password: string): Session {
  const u = DEMO_USERS[username];
  if (!u || u.password !== password) {
    throw new Error("Invalid username or password");
  }
  const session: Session = { username, role: u.role, token: `demo.${username}.${u.role}` };
  localStorage.setItem(KEY, JSON.stringify(session));
  return session;
}

export function logout() {
  localStorage.removeItem(KEY);
}

export function getSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}
