/*
 * Robot Console auth — separate scope from the Portal.
 * DEMO mode authenticates the robot-operator locally. Wire keycloak-js here for
 * the drishti-robot-console client when VITE_USE_KEYCLOAK=true.
 */
export interface Session {
  username: string;
  role: "robot-operator";
  token: string;
}

const DEMO = { robotop: "robotop" } as Record<string, string>;
const KEY = "drishti.robot.session";

export function login(username: string, password: string): Session {
  if (DEMO[username] !== password) throw new Error("Invalid credentials");
  const s: Session = { username, role: "robot-operator", token: `demo.${username}.robot-operator` };
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}
export function logout() { localStorage.removeItem(KEY); }
export function getSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}
