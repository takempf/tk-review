import { useSyncExternalStore } from "react";

/**
 * Keep decoded avatars for the app's lifetime, independently of their bylines.
 * Drawing this image again needs neither another request nor another decode.
 * Include the host: the same login can name different Enterprise accounts.
 */
const avatars = new Map<string, ReturnType<typeof avatar>>();

function avatar(src: string) {
  let decoded: HTMLImageElement | null = null;
  let loading = false;
  let retryAt = 0;
  const listeners = new Set<() => void>();

  function load() {
    if (decoded || loading || Date.now() < retryAt) return;
    loading = true;
    const image = new Image();
    image.src = src;
    void image.decode().then(
      () => {
        decoded = image;
        loading = false;
        for (const notify of listeners) notify();
      },
      () => {
        loading = false;
        // Leave the initial on show; another byline can retry after a brief
        // outage, without every occurrence retrying a broken URL at once.
        retryAt = Date.now() + 30_000;
      },
    );
  }

  return {
    getSnapshot: () => decoded,
    subscribe(notify: () => void) {
      listeners.add(notify);
      load();
      return () => {
        listeners.delete(notify);
      };
    },
  };
}

export function useAvatar(name: string, host: string): HTMLImageElement | null {
  const src = `https://${host.toLowerCase()}/${encodeURIComponent(name.toLowerCase())}.png?size=64`;
  let entry = avatars.get(src);
  if (!entry) {
    entry = avatar(src);
    avatars.set(src, entry);
  }
  return useSyncExternalStore(entry.subscribe, entry.getSnapshot);
}
