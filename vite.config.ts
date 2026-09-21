import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently falling back to another port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // @pierre/diffs ships its Shiki highlighter as an ES module worker.
  worker: { format: "es" },
  build: {
    target: "esnext",
    sourcemap: true,
  },
});
