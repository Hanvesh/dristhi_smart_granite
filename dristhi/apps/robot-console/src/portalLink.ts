// Navigation between the Robot View and the Portal (separate apps/origins).
// The Portal opens the Robot View with ?from=<portal path>; we remember that
// path so "Back to Portal" returns the operator to the page they came from.
// Only same-app relative paths are accepted, so this can't become an open
// redirect. No credentials ever travel in these URLs.

const PORTAL_BASE: string = import.meta.env.VITE_PORTAL_URL ?? "http://localhost:5173";
const KEY = "drishti.robot.returnPath";
const SAFE_PATH = /^\/[A-Za-z0-9/_-]*$/;

const isSafe = (p: string | null): p is string => !!p && SAFE_PATH.test(p) && !p.startsWith("//");

/** Call once on load: capture ?from= from the Portal link. */
export function rememberReturnPath() {
  const from = new URLSearchParams(window.location.search).get("from");
  if (isSafe(from)) sessionStorage.setItem(KEY, from);
}

/** Absolute Portal URL for a path (defaults to where the operator came from). */
export function portalUrl(path?: string, query?: Record<string, string>): string {
  const wanted = path ?? sessionStorage.getItem(KEY);
  const url = new URL(isSafe(wanted) ? wanted : "/", PORTAL_BASE);
  if (query) url.search = new URLSearchParams(query).toString();
  return url.toString();
}
