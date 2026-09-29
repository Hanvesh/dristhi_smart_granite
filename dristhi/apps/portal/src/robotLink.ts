// Link from the Portal to the Robot View (separate app). The current Portal
// path rides along as ?from= so the Robot View's "Back to Portal" returns the
// operator to the same page. Only a relative path is passed; never a token.

const ROBOT_BASE: string = import.meta.env.VITE_ROBOT_CONSOLE_URL ?? "http://localhost:5174";

export function robotViewUrl(fromPath: string): string {
  const url = new URL("/", ROBOT_BASE);
  url.searchParams.set("from", fromPath.startsWith("/") ? fromPath : "/");
  return url.toString();
}
