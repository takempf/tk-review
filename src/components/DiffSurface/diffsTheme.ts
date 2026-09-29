/**
 * Shipped light/dark themes. The surface pins `themeType` to dark, so only the
 * dark one renders; the light one is named so a light app theme is one option
 * away.
 */
export const DIFF_THEME = { light: "pierre-light", dark: "pierre-dark" } as const;

/**
 * Theme bridge between the app's tokens and `@pierre/diffs`.
 *
 * The renderer draws into a shadow root and takes its colours from CSS variables,
 * so the mapping happens in two places, for one reason:
 *
 * - Variables the library only *reads* (the fonts) inherit through the shadow
 *   boundary, so a normal stylesheet sets them. See `DiffSurface.module.css`.
 * - Variables the active Shiki theme *declares* cannot. It emits them on `:host`
 *   (`--diffs-light-bg`, `--diffs-dark-bg`), and a declaration on the host beats
 *   any value inherited from an ancestor — layers don't enter into it, because
 *   inheritance isn't a competing declaration. The library's own escape hatch is
 *   the `unsafeCSS` option, which it injects into `@layer unsafe`; the layer order
 *   is `base, theme, rendered, unsafe`, so declarations here win.
 *
 * Values still come from the app tokens rather than being restated: custom
 * properties inherit into the shadow root, so `var(--bg-code)` resolves to whatever
 * `global.css` has set for the active colour scheme. Both the light and dark slots
 * get the same token on purpose — `--bg-code` is already the right colour for the
 * scheme in effect, so whichever branch `light-dark()` picks is correct.
 */
export const DIFFS_THEME_CSS = `
:host {
  --diffs-light-bg: var(--bg-code);
  --diffs-dark-bg: var(--bg-code);

  /* The hunk separators — the "unmodified lines" bars and their expand
     buttons — default to lighter than the background. A gap in the file reads
     better as a recess, so use the sunken token instead. */
  --diffs-bg-separator-override: var(--bg-sunken);
}

/* A code column only ever scrolls sideways, yet the renderer gives it
   \`scrollbar-gutter: stable\`. WebKit reserves a native scrollbar's width for
   that (17px with classic scrollbars) even though the renderer styles the
   vertical scrollbar down to nothing, leaving a strip of dead space right of
   every column: between the two sides of a split diff, and down the right edge. */
[data-code] {
  scrollbar-gutter: auto;
}

/* Each file's header reads as a bar over the code rather than blending into the
   lines behind it, so it gets the chrome's surface, a step lighter than the
   code. The renderer paints it with plain --diffs-bg, hence the selector
   override.

   Not keyed to [data-sticky]: explain mode turns stickiness off (its headers
   carry a paragraph), and the bar should look the same either way. */
[data-diffs-header] {
  background-color: var(--bg);
}

/* Custom-header mode contributes no layout of its own — the slotted content
   brings its own — but the bar still needs to sit above the code it precedes. */
[data-diffs-header="custom"] {
  position: relative;
  z-index: 2;
}
`;
