/// <reference types="vitest" />
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/build/**", "**/.mygo/**", "**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    exclude: ["**/node_modules/**", "**/.claude/**", "**/build/**", "**/.mygo/**"],
  },
});
