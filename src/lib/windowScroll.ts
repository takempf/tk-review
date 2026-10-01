/**
 * Keeps the window itself from ever scrolling. The app scrolls in regions of
 * its own; the window only has somewhere to go because of the title bar.
 *
 * The page runs under the macOS title bar, and WebKit treats that strip as
 * covered: focusing something inside it scrolls the page down, past its top,
 * until the element clears the bar. Popups that open over their trigger (the
 * repository menu in the title bar) are focused as they open, so the whole
 * page dropped by the bar's height, with the bar's own material showing above
 * it. Scroll events run before the next paint, so putting the window back here
 * means that frame is never drawn.
 */
export function installWindowScrollLock() {
  window.addEventListener("scroll", () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  });
}
