import archivoUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?inline";
import designSystemCss from "tk-design-system/styles.css?inline";
import geistUrl from "../../styles/fonts/Geist-Variable.woff2?inline";
import geistMonoUrl from "../../styles/fonts/GeistMono-Variable.woff2?inline";
import viewerTemplate from "./viewer/viewer.html?raw";
import viewerScript from "./viewer/viewer.js?raw";

const FONT_FACES = `
@font-face{font-family:"Geist Variable";font-weight:100 900;src:url(${geistUrl}) format("woff2")}
@font-face{font-family:"Geist Mono Variable";font-weight:100 900;src:url(${geistMonoUrl}) format("woff2")}
@font-face{font-family:"Archivo Variable";font-weight:100 900;font-stretch:62% 125%;src:url(${archivoUrl}) format("woff2")}`;

// The frame is sandboxed to an opaque origin, so its styles and fonts travel inside the page.
export const VIEWER_PAGE = viewerTemplate
  .replace("/*__STYLES__*/", () => `${designSystemCss}\n${FONT_FACES}`)
  .replace("/*__APP__*/", () => viewerScript);

/** App and design-system colours the viewer draws with; it paints a canvas, so they go as hex. */
const COLOR_TOKENS = [
  "--bg",
  "--bg-code",
  "--bg-raised",
  "--bg-sunken",
  "--bg-hover",
  "--bg-selected",
  "--border",
  "--border-strong",
  "--text",
  "--text-dim",
  "--text-faint",
  "--accent",
  "--added",
  "--deleted",
  "--modified",
  "--renamed",
  "--tk-accent",
  "--tk-accent-2",
  "--tk-label",
  "--tk-primary",
  "--tk-primary-hover",
  "--tk-primary-fg",
  "--tk-fg-bright",
  "--tk-blue",
  "--tk-purple",
  "--tk-orange",
  "--tk-yellow",
  "--tk-green",
  "--tk-pink",
];
/** Tokens the viewer takes as written. */
const PLAIN_TOKENS = ["--tk-root-size"];

/** The app's theme as the viewer needs it, read off the document now. */
export function viewerTheme(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = {};
  for (const name of PLAIN_TOKENS) theme[name] = root.getPropertyValue(name).trim();
  // Painting each colour and reading the pixel back resolves color-mix() and oklab alike.
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return theme;
  for (const name of COLOR_TOKENS) {
    const value = root.getPropertyValue(name).trim();
    if (!value) continue;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0] = probe.getImageData(0, 0, 1, 1).data;
    theme[name] =
      `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  return theme;
}
