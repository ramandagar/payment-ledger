import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend calls the backend at import.meta.env.VITE_API_URL (absolute URL).
// No dev proxy needed — CORS is enabled on the API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // allowedHosts: true, // uncomment if previewing through a tunnel (ngrok, etc.)
  },
});
