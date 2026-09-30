// Image imports resolve to URLs via the consuming app's bundler (Vite). The
// apps get this declaration from vite/client; the UI package's own typecheck
// needs it here.
declare module "*.png" {
  const src: string;
  export default src;
}
