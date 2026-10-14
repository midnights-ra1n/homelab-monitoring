import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../server/web/dist", emptyOutDir: true, chunkSizeWarningLimit: 600 },
  // Dev proxy to a hub started with `cd server && go run .` (override with HLM_API=http://host:port).
  server: { proxy: { "/api": { target: process.env.HLM_API || "http://127.0.0.1:8080", ws: true } } },
});
