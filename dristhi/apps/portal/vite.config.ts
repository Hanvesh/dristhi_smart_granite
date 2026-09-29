import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        // Gateway serves routes at the root (/blocks, /audit, ...); the UI calls
        // them under /api. Strip the prefix so the gateway doesn't 404.
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
