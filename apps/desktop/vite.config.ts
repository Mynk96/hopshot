import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri drives this dev server; the port must be fixed and matched in tauri.conf.json.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Matches the webviews Hopshot actually supports (PRD §1: macOS 13+, Windows 10 22H2
    // / 11). macOS 13 ships Safari 16; the Tauri template's `safari13` default is three
    // majors below that and cannot even lower destructuring in function parameters.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari16",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
  },
});
