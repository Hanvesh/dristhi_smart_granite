import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        // The gateway serves routes at the root (/health, /robots, ...), while
        // the UI calls them under /api. Strip the /api prefix when proxying,
        // otherwise the gateway 404s and the console falls back to "offline".
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
