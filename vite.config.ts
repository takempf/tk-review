import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// tk-design-system is consumed from source in a sibling checkout, the way its
// own playground does: no build step, and edits there show up here live.
const designSystem = decodeURIComponent(new URL("../tk-design-system", import.meta.url).pathname);
const designSystemSrc = `${designSystem}/src`;

// The HMR socket drops whenever macOS takes a network interface down, as it does on sleep.
const RELOAD_AFTER_DROP = /await waitForSuccessfulPing\(url\.href\);\s*location\.reload\(\);/;

// An update sent just before the drop may never have arrived.
const IN_FLIGHT_MS = 2_000;

const SERVER_STATE_PATH = "/__tk-review/dev-server";

/** Reconnects Vite's client after its socket drops, rather than reloading, when nothing changed. */
function reconnectHmr(): Plugin {
  const serverId = crypto.randomUUID();
  let lastChangeAt = 0;

  const reconnectOrReload = `const droppedAt = Date.now();
await waitForSuccessfulPing(url.href);
if (await tkReviewSameServerSince(droppedAt)) await transport.connect(createHMRHandler(handleMessage));
else location.reload();`;

  const sameServerSince = `
async function tkReviewSameServerSince(droppedAt) {
  try {
    const server = await (await fetch(${JSON.stringify(SERVER_STATE_PATH)})).json();
    return server.serverId === ${JSON.stringify(serverId)} && server.lastChangeAt < droppedAt - ${IN_FLIGHT_MS};
  } catch {
    return false;
  }
}`;

  return {
    name: "tk-review:reconnect-hmr",
    apply: "serve",
    configureServer(server) {
      server.watcher.on("all", () => {
        lastChangeAt = Date.now();
      });
      server.middlewares.use(SERVER_STATE_PATH, (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ serverId, lastChangeAt }));
      });
    },
    transform(code, id) {
      if (!id.endsWith("/vite/dist/client/client.mjs")) return;
      if (!RELOAD_AFTER_DROP.test(code)) {
        this.warn("Vite's client changed shape: a dropped HMR socket will reload the page again.");
        return;
      }
      return code.replace(RELOAD_AFTER_DROP, reconnectOrReload) + sameServerSince;
    },
  };
}

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently falling back to another port.
export default defineConfig({
  plugins: [react(), reconnectHmr()],
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
