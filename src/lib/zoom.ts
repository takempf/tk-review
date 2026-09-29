import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * Cmd +/−/0 page zoom, done here rather than by Tauri's `zoomHotkeysEnabled`,
 * whose script keeps the level to itself. The title bar needs it: webview zoom
 * scales the page but never the native traffic lights, so the bar reads
 * `--zoom` to keep their room the same size on screen.
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

let level = DEFAULT_ZOOM;

function setZoom(next: number) {
  // Rounded, so repeated steps land back on the default rather than drifting.
  level = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) * 10) / 10;
  document.documentElement.style.setProperty("--zoom", String(level));
  void getCurrentWebview()
    .setZoom(level)
    .catch(() => {});
}

/** Starts at the default level and takes over the zoom hotkeys. Call once, at startup. */
export function installZoom() {
  // A plain browser (the dev harness) zooms natively and leaves `--zoom` at 1.
  if (!isTauri()) return;
  const mac = navigator.userAgent.includes("Mac OS X");
  setZoom(DEFAULT_ZOOM);

  window.addEventListener("keydown", (event) => {
    if (!(mac ? event.metaKey : event.ctrlKey)) return;
    if (event.key === "-") setZoom(level - STEP);
    else if (event.key === "=" || event.key === "+") setZoom(level + STEP);
    else if (event.key === "0") setZoom(DEFAULT_ZOOM);
    else return;
    event.preventDefault();
  });

  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom(level + (event.deltaY < 0 ? STEP : -STEP));
    },
    { passive: false },
  );
}
