import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    hmrSockets: WebSocket[];
    sameDocument?: boolean;
  }
}

test("a dropped HMR socket reconnects without reloading the page", async ({ page }) => {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    window.hmrSockets = sockets;
    window.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (protocols === "vite-hmr") sockets.push(this);
      }
    };
  });
  await page.goto("/dev-harness/");
  const openSockets = () =>
    page.evaluate(
      () => window.hmrSockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
    );
  await expect.poll(openSockets).toBe(1);

  await page.evaluate(() => {
    window.sameDocument = true;
    window.hmrSockets[0]?.close();
  });
  await expect.poll(() => page.evaluate(() => window.hmrSockets.length)).toBe(2);
  await expect.poll(openSockets).toBe(1);
  expect(await page.evaluate(() => window.sameDocument)).toBe(true);
});
