/**
 * Puts `text` on the clipboard. Call it straight from a click handler: both
 * routes only work while the click still counts as the user's.
 *
 * `navigator.clipboard` only exists in a secure context, and whether the
 * webview counts its own app scheme as one varies by platform, so there is a
 * fallback through a hidden textarea and the old `copy` command.
 */
export function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);

  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  // Selecting the textarea took focus; hand it back to whatever pressed copy.
  if (focused instanceof HTMLElement) focused.focus();
  return copied ? Promise.resolve() : Promise.reject(new Error("The clipboard is unavailable."));
}
