# Codemap zoom performance — issue #2

The highlighted renderer scanned every active import twice per draw to find added and removed links. The fix partitions those links when visibility, link settings, or impact scope changes, so zooming visits only changed links. It preserves curve clipping, dashes, and highlighting.

## Reproduction

- Recorded November 9, 2026, against `main` at `58818c5`, then the optimized viewer in this PR.
- Repository under test: the deterministic `monorepo` graph from `dev-harness/codemapSynthetic.ts`, seed / `BENCH_FILES=6800`. Full graph: 6,801 files, 1,180,383 lines, 32,348 imports. Default filters leave 6,003 visible files and 24,095 active imports.
- Apple M3 Pro, 36 GiB RAM, macOS 27.2 (Darwin 27.2.0). Playwright Chromium 153.0.8010.12, headless with Metal GPU acceleration; renderer: ANGLE Metal / Apple M3 Pro.
- Browser viewport: 1500 × 1000 CSS pixels; Codemap frame: 860 × 823; device scale factor: 2.
- Flat and 3D each run with **Highlight affected files** enabled and disabled. That checkbox controls both diff and blast-radius marking; **Everything**, filters, layout, and graph stay fixed.
- Fly to `packages/shared/src/gql/graphql.ts`, deselect it, clamp to 0.2%, then dispatch the same 330 centered Ctrl-wheel events (`deltaY=-3`) once per animation frame, reaching the 1,200% maximum. The benchmark asserts both endpoints.

```sh
BENCH_LABEL=baseline BENCH_ONLY="full range" pnpm bench:codemap
# Apply the viewer fix, using the same benchmark harness for both runs.
BENCH_LABEL=optimized BENCH_BASELINE=baseline BENCH_ONLY="full range" pnpm bench:codemap
```

Timings include CPU tracing overhead. Input-to-draw measures scripted dispatch to the next viewer draw completing; it excludes hardware/OS delivery and compositor presentation. rAF intervals do not prove display presentation, so the captures also include GPU raster and display events. Canvas-call counts in the raw report are a separate 30-frame pan at the end of the gesture, rather than counts across the zoom sweep.

## Results

Whole-sweep p95 times, milliseconds (baseline → optimized):

| View / highlighting | Draw | Wheel handler | GPU raster / displayed frame | rAF interval |
| --- | --- | --- | --- | --- |
| 3D / on | 2.90 → 2.70 | 0.60 → 0.50 | 3.30 → 2.34 | 16.80 → 16.70 |
| 3D / off | 2.60 → 2.70 | 0.50 → 0.50 | 3.28 → 3.27 | 16.80 → 16.70 |
| Flat / on | 1.30 → 0.90 | 0.10 → 0.10 | 1.25 → 1.23 | 16.70 → 16.70 |
| Flat / off | 0.90 → 0.80 | 0.10 → 0.10 | 1.17 → 1.22 | 16.80 → 16.70 |

Sampled inclusive CPU time in `drawFaint` over the sweep fell from **73.95 to 2.58 ms in 3D** and **86.21 to 0.70 ms in flat view** with highlighting enabled. Highlighting-off controls have effectively no work in this function. These sampled totals are approximate; they isolate the removed scan more clearly than small whole-frame differences.

Draw p95 by zoom band, milliseconds (baseline → optimized):

| Zoom | 3D / on | 3D / off | Flat / on | Flat / off |
| --- | --- | --- | --- | --- |
| 0.2–4.7% | 5.20 → 4.40 | 3.00 → 2.80 | 1.40 → 1.00 | 1.00 → 0.90 |
| 4.7–20.0% | 5.10 → 4.90 | 4.70 → 4.70 | 1.20 → 0.90 | 0.80 → 0.90 |
| 20.0–37.0% | 1.10 → 0.90 | 0.80 → 0.80 | 0.60 → 0.30 | 0.30 → 0.20 |
| 37.0–48.0% | 1.10 → 0.90 | 0.80 → 0.80 | 0.80 → 0.40 | 0.30 → 0.30 |
| 48.0–100.0% | 1.50 → 1.40 | 1.20 → 1.10 | 0.60 → 0.40 | 0.30 → 0.30 |
| 100.0–267.0% | 0.90 → 0.60 | 0.60 → 0.70 | 0.60 → 0.30 | 0.30 → 0.20 |
| 267.0–520.0% | 0.70 → 0.60 | 0.60 → 0.50 | 0.50 → 0.20 | 0.30 → 0.30 |
| 520.0–667.0% | 0.90 → 0.60 | 0.50 → 0.50 | 0.50 → 0.10 | 0.10 → 0.20 |
| 667.0–1200.0% | 0.70 → 0.60 | 0.50 → 0.60 | 0.50 → 0.20 | 0.20 → 0.20 |

The controlled pair had no rAF gap above 16.8 ms in any configuration. Scripted input-to-draw p95 remained roughly 17–19 ms across all bands. This machine did not reproduce a sustained zoom stall; the optimization reduces highlighted CPU work without claiming a display-rate improvement.

## Remaining costs and focused follow-ups

- **0.2–20% in 3D:** many towers remain visible. `drawTower` accounts for about 236–242 ms of sampled CPU time per sweep, and `hit3D` about 49–63 ms. Broad views, tower faces, and hit testing dominate after the scan is removed. If native traces still show trouble here, measure batching tiny tower faces and a spatial index for hit testing.
- **Around 4.7%:** cards cross the seven-pixel detail threshold and code-shape bitmaps begin decoding. Existing decoding already has a four-millisecond budget; keep that budget and profile cold-cache transitions before changing it.
- **Around 37–60%:** 3D name tags, high-resolution code shapes (48%), and line-count labels appear. The modest 48–100% bump exists with highlighting both on and off; it is not a reason to disable diff marking.
- **Above 267%:** flat code-shape row gaps appear. The ordinary text fade thresholds are around 520–667%, but this synthetic fixture has no source-text payload (`tx`), so this capture does not exercise the shape-to-source-text fade. A native trace on a real changed file carrying text is needed before proposing text-rendering changes.

## Evidence and validation

[Download the trace archive](traces.tar.xz). Extract it with `tar -xJf traces.tar.xz`; import any `.trace.json` into Chrome DevTools Performance. It contains eight complete Chrome traces (baseline / optimized × flat / 3D × highlighting on / off), zoom markers, per-frame samples, environment metadata, and the full per-band reports. The trace filenames identify each configuration.

All four minimum-zoom canvas snapshots are byte-identical before and after. Browser regression coverage checks added and removed links when toggling type-only imports, barrel resolution, and change highlighting in both views. The full Codemap suite passes in Chromium and WebKit (17 passed, one Chromium-only GPU restart check skipped in WebKit). Typechecking, JavaScript syntax checking, and production build pass. Biome passes on the changed TypeScript files; repository-wide lint reports the existing formatting of tracked `.vscode/settings.json`.
