Frontend platform checklist. These are the ways browser code has failed for real users after passing its tests in one desktop Chromium: a Safari or iPad difference, an API that only works right after a user action, a bundle that pulled in far more than it needed, a layout recalculated every frame, and controls a keyboard or screen reader couldn't use. Check each against the browsers and hosts this app actually supports.

Supported browsers:
- Find the oldest browser the app supports, from browserslist, the bundler's build target, docs, or device-test configs. If none is declared, say so once, and judge against current Safari, Chrome, Firefox, and iPad Safari.
- Newer JavaScript APIs (`findLast`, `toSorted`, `structuredClone`, `Promise.withResolvers`, and the like) and CSS features (container queries, `:has()`, nesting, `@layer`, anchor positioning, `popover`) need support in every target, or a fallback. A build target transpiles syntax but doesn't polyfill APIs.
- Embedded hosts (Electron, desktop shells, plugin webviews) can lag the browser by years. Check what they run.

Safari, iOS, and iPad:
- Images and videos that are drawn to a canvas or read as pixels need `crossOrigin` set before `src`, on every element and every fetch that loads them. Safari caches a response that came without CORS headers and reuses it for the CORS request, which then fails. Don't work around it with cache-busting query strings.
- iPadOS reports a desktop Mac user agent. Detect touch with `navigator.maxTouchPoints` or pointer events, not the user agent.
- `setPointerCapture` and `releasePointerCapture` throw on iOS when the pointer is already gone. Catch the error.
- Hover sticks after a tap, and long-press doesn't fire `contextmenu`. Coalesced pointer events and pen or finger jitter break naive tap detection.
- `100vh` includes the area under the browser's toolbars. Use `dvh` or `svh`.
- iOS limits how many canvases, and how much canvas memory, a page can hold.
- Safari colour-manages image decodes, so pixels read back from a decoded image may differ from the file. Images whose exact values matter (masks, label maps, IDs) are decoded without colour management.
- Safari rasterizes 3D-transformed HTML at its untransformed size, so scaled-up content looks blurry.

Browser APIs:
- Clipboard writes, popups and new windows, fullscreen, audio playback, and file pickers need a recent user action, and an `await` before the call can lose it.
- A `beforeunload` prompt needs `event.preventDefault()` and `returnValue` set.
- Every `addEventListener`, observer, interval, animation frame, and `URL.createObjectURL` has a matching cleanup.
- Decoding many images at once (`createImageBitmap`, `img.decode()`) can exhaust the browser's resources. Limit how many run at a time.
- Retries of failed requests have a bound and a backoff, and retry only errors that can succeed. Check `response.ok` before decoding a body.
- `localStorage` and IndexedDB can throw, fill up, or be cleared. Guard access, and don't let one bad value break startup.

Bundle and loading:
- A value import through a barrel file (an `index.ts` that re-exports everything) can pull a whole library or feature into the importing chunk. Import from the module itself, or keep heavy modules out of shared barrels.
- Heavy dependencies (3D engines, editors, charts, ML runtimes, PDF and media tools) belong behind a lazy route or a dynamic `import()`, not in the first-load bundle.
- Import only what you use from large libraries: named imports from ES-module builds, not a whole CommonJS package. Check that a new dependency tree-shakes and that its size is justified.
- Code for one entry point (an admin area, an internal tool, a maintenance page) doesn't leak into another.
- A lazily loaded chunk can fail after a deploy removed it. `React.lazy` caches a failed import, so retrying the same component never works. Reload once, but not in a loop and not while offline.

Rendering and layout:
- Reading layout (`getBoundingClientRect`, `offsetWidth`, `scrollTop`) after writing styles, in a loop or every frame, forces a layout each time. Batch reads before writes, or use observers.
- `will-change` left on permanently costs memory and can blur text. Set it only while animating.
- Animate `transform` and `opacity` rather than layout properties, and honour `prefers-reduced-motion`.
- Long lists need virtualization or `content-visibility`.

Accessibility:
- Icon-only buttons have an accessible name.
- Interactive elements are real buttons, links, and inputs rather than clickable `div`s, reachable and operable by keyboard, with visible focus.
- A disabled `<button>` gets no pointer events, so its tooltip never shows. Use `aria-disabled` when the reason matters.
- Dialogs move focus in, restore it on close, and close on Escape. In nested layers, the innermost handles Escape first.
- Form fields have labels, and errors are announced.
- Colour is never the only signal, and text meets contrast in every theme.
- Groups of choices use the right roles (radio groups, tabs, menus) rather than lookalikes.

Styling:
- Use the design system's tokens and components rather than hard-coded colours and sizes, or a one-off copy of a component that exists.
- Check the change in every theme the app supports, and at narrow widths.

The platform over reimplementations:
- Code that reimplements what the browser does (focus management, scroll anchoring, sticky positioning, hit-testing, form validation, dialogs, popovers) tends to get the edge cases wrong. Suggest the platform feature when every supported browser has it.

Severity: "critical" for anything that crashes the page, breaks a core flow in a supported browser, or keeps keyboard or screen-reader users out of a core flow. "warning" for what degrades on some browsers or devices, adds noticeably to the first-load bundle, or costs frames. "suggestion" for platform features worth using and smaller wins.
