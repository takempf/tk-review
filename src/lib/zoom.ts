import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toasts } from "tk-design-system";

/**
 * Cmd +/−/0 page zoom, done here rather than by Tauri's `zoomHotkeysEnabled`,
 * whose script keeps the level to itself. The title bar needs it: webview zoom
 * scales the page but never the native traffic lights, so the bar reads
 * `--zoom` to keep their room the same size on screen.
 *
 * View's Actual Size, Zoom In and Zoom Out (`app_menu` in `lib.rs`) show the
 * same hotkeys and send a click here as a `zoom` event.
 *
 * The steps and limits are Tauri's own.
 */

/**
 * One step below the webview's 100%, which reads large for a diff tool. Rust
 * applies the same level before the first paint (`DEFAULT_ZOOM` in `lib.rs`);
 * keep the two in step.
 */
export const DEFAULT_ZOOM = 0.8;
const STEP = 0.2;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 10;
/** How long the level stays on screen after the last change. */
const READOUT_MS = 1500;

type ZoomStep = "in" | "out" | "reset";

let level = DEFAULT_ZOOM;

function setZoom(next: number) {
  // Rounded, so repeated steps land back on the default rather than drifting.
  level = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) * 10) / 10;
  document.documentElement.style.setProperty("--zoom", String(level));
  void getCurrentWebview()
    .setZoom(level)
    .catch(() => {});
}

/**
 * Zooms by a step and shows the new level for a moment. One toast, updated in
 * place, so a run of steps doesn't stack them. The level reads against the
 * default, so the size the app opens at is 100%.
 */
function zoom(step: ZoomStep) {
  setZoom(step === "reset" ? DEFAULT_ZOOM : level + (step === "in" ? STEP : -STEP));
  toasts.add({
    id: "zoom",
    title: `Zoom ${Math.round((level / DEFAULT_ZOOM) * 100)}%`,
    timeout: READOUT_MS,
  });
}

/** Starts at the default level and takes over the zoom hotkeys. Call once, at startup. */
export function installZoom() {
  // A plain browser (the dev harness) zooms natively and leaves `--zoom` at 1.
  if (!isTauri()) return;
  const mac = navigator.userAgent.includes("Mac OS X");
  setZoom(DEFAULT_ZOOM);

  window.addEventListener("keydown", (event) => {
    if (!(mac ? event.metaKey : event.ctrlKey)) return;
    if (event.key === "-") zoom("out");
    else if (event.key === "=" || event.key === "+") zoom("in");
    else if (event.key === "0") zoom("reset");
    else return;
    // Also keeps the menu's copy of the hotkey from zooming a second time.
    event.preventDefault();
  });

  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoom(event.deltaY < 0 ? "in" : "out");
    },
    { passive: false },
  );

  void listen<ZoomStep>("zoom", (event) => zoom(event.payload));
}
