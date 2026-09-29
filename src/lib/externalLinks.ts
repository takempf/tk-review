import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Schemes the system opens better than the webview does. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function externalUrl(event: MouseEvent): string | null {
  if (event.defaultPrevented || !(event.target instanceof Element)) return null;
  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  const url = new URL(anchor.href, location.href);
  if (!EXTERNAL_PROTOCOLS.has(url.protocol) || url.origin === location.origin) return null;
  return url.href;
}

/**
 * Sends links to the default browser. Left to itself the webview follows a
 * link in place, leaving the app for GitHub with no way back, and drops
 * `target="_blank"` ones. In-page links (footnotes) share the page's origin
 * and stay put. Call once, at startup.
 */
export function installExternalLinks() {
  // A plain browser (the dev harness) already opens links where it should.
  if (!isTauri()) return;

  const handle = (event: MouseEvent) => {
    // Middle-click arrives as `auxclick`; right-click keeps the context menu.
    if (event.button > 1) return;
    const url = externalUrl(event);
    if (!url) return;
    event.preventDefault();
    void openUrl(url).catch(() => {});
  };
  window.addEventListener("click", handle);
  window.addEventListener("auxclick", handle);
}
