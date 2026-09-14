import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Set when developing through the reverse proxy, e.g. https://ai.example.com → nginx → Vite.
const publicUrl = process.env.AI_EMPLOYEE_PUBLIC_URL ? new URL(process.env.AI_EMPLOYEE_PUBLIC_URL) : undefined;
const secure = publicUrl?.protocol === "https:";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: publicUrl ? [publicUrl.hostname] : [],
    hmr: publicUrl ? { host: publicUrl.hostname, protocol: secure ? "wss" : "ws", clientPort: secure ? 443 : 80 } : undefined,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.AI_EMPLOYEE_PORT || 7717}` } },
  },
});
