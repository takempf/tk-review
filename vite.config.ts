import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// tk-design-system is consumed from source in a sibling checkout, the way its
// own playground does: no build step, and edits there show up here live.
const designSystem = decodeURIComponent(new URL("../tk-design-system", import.meta.url).pathname);
const designSystemSrc = `${designSystem}/src`;

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently falling back to another port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^tk-design-system$/, replacement: `${designSystemSrc}/index.ts` },
      { find: /^tk-design-system\/(.+)$/, replacement: `${designSystemSrc}/$1` },
    ],
    // The sibling checkout has its own node_modules. One copy of each of these
    // is load-bearing: React hooks and Base UI's contexts break across copies.
    dedupe: ["react", "react-dom", "@base-ui/react", "zustand"],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    fs: { allow: [".", designSystem] },
  },
  // @pierre/diffs ships its Shiki highlighter as an ES module worker.
  worker: { format: "es" },
  build: {
    target: "esnext",
    sourcemap: true,
  },
});
