import { useEffect, useRef, useState } from "react";
import css from "./ReviewLoader.module.css";
import { bayerMatrix, crispSize, Raster, TONES, type Vec4 } from "./raster";
import { Scene } from "./scene";

const MAX_WIDTH = 480;
/** The design system's scenery renders at 15fps; a slow pile suits it too. */
const FRAME_MS = 1000 / 15;

interface Look {
  /** Transparent, then the three shades from `ReviewLoader.module.css`. */
  inks: Vec4[];
  bayer: Float32Array;
  /** CSS pixels a side for one dither cell. */
  pixel: number;
}

const TRANSPARENT: Vec4 = [0, 0, 0, 0];

/**
 * The palette and the dither, read from the stylesheet so they follow the
 * theme. The three shades are the text colour at rising strength; the Bayer
 * size and pixel scale are the design system's scenery tokens, so the pattern
 * matches its scenery. Colours are resolved through a 2D context rather than
 * parsed, which accepts any CSS colour, `color-mix()` and alpha included.
 */
function readLook(element: HTMLElement): Look {
  const style = getComputedStyle(element);
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const color = (name: string): Vec4 => {
    if (!probe) return [128, 128, 128, 255];
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = style.getPropertyValue(name).trim() || "#808080";
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a];
  };
  const bayer = Number(style.getPropertyValue("--tk-scenery-bayer"));
  const pixel = Math.round(Number(style.getPropertyValue("--tk-scenery-pixel")));
  return {
    inks: [TRANSPARENT, color("--loader-ink-1"), color("--loader-ink-2"), color("--loader-ink-3")],
    bayer: bayerMatrix(bayer === 2 || bayer === 4 ? bayer : 8),
    pixel: Number.isFinite(pixel) && pixel >= 1 ? pixel : 2,
  };
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Props {
  /** How many shapes to lay out — the number of files under review, say. Read once, on mount. */
  count: number;
  /**
   * 0–1 when the run can say how far along it is: one shape is set on the pile
   * per step. `null` (the default) runs the open-ended version, where shapes are
   * picked up and put back without implying any measure of progress. A value on
   * mount starts the scene settled at that point, with no arrivals.
   */
  progress?: number | null;
  /** True once the run is over: the shapes leave, and then `onLeft` is called. */
  leaving?: boolean;
  onLeft?: () => void;
}

/**
 * A waiting animation for agent runs: three shades of the text colour on a
 * transparent ground, under the design system's ordered dither. Shapes arrive
 * one by one, are held up and turned over by something unseen, and are set
 * down in a pile; when the run ends they leave, top to bottom.
 */
export function ReviewLoader({ count, progress = null, leaving = false, onLeft }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ cells: 0, width: 0 });
  // The scene and its clock belong to the mount rather than to a canvas size,
  // so a resize redraws the same moment instead of starting the arrivals over.
  const [world] = useState(() => {
    const scene = new Scene(count);
    if (progress !== null) scene.settle(progress);
    return { scene, start: performance.now() };
  });
  // Read every frame, so these steer the running scene rather than rebuilding it.
  const progressRef = useRef(progress);
  const leavingRef = useRef(leaving);
  const onLeftRef = useRef(onLeft);
  useEffect(() => {
    progressRef.current = progress;
    leavingRef.current = leaving;
    onLeftRef.current = onLeft;
  });
  // Reduced motion has no departure to wait for: told to go, it has gone.
  useEffect(() => {
    if (leaving && prefersReducedMotion()) onLeftRef.current?.();
  }, [leaving]);

  // Refit whenever the panel is resized or the page is zoomed (which changes both
  // the available CSS width and the device pixel ratio).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() =>
      setSize(
        crispSize(
          Math.min(wrap.clientWidth, MAX_WIDTH),
          readLook(wrap).pixel,
          window.devicePixelRatio || 1,
        ),
      ),
    );
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const { cells } = size;
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || cells === 0) return;

    const { scene, start } = world;
    const raster = new Raster(cells, cells);
    const image = context.createImageData(cells, cells);
    const look = readLook(canvas);

    const draw = (time: number) => {
      if (leavingRef.current) scene.leave(time);
      scene.setProgress(progressRef.current);
      scene.update(time);
      scene.render(raster, TONES, time);
      raster.dither(look.inks, look.bayer, image.data);
      context.putImageData(image, 0, 0);
      if (scene.gone(time)) onLeftRef.current?.();
    };

    // Reduced motion gets a single still frame, with every shape in place; the
    // status text says what is happening.
    if (prefersReducedMotion()) {
      draw(scene.arrived);
      return;
    }
    let last = Number.NEGATIVE_INFINITY;
    let frame = requestAnimationFrame(function tick(now) {
      frame = requestAnimationFrame(tick);
      // A low frame rate suits the look, and spares the CPU while an agent runs.
      if (now - last < FRAME_MS) return;
      // Out of sight (a screen kept out of view, a panel slid away), it waits.
      if (!canvas.checkVisibility({ visibilityProperty: true })) return;
      last = now;
      const time = Math.max(0, now - start) / 1000;
      draw(time);
      // Nothing more to draw once the shapes have all left.
      if (scene.gone(time)) cancelAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(frame);
  }, [world, cells]);

  return (
    // Decorative: the status text beside it says what is happening.
    <div ref={wrapRef} className={css.loader} aria-hidden="true">
      <canvas
        ref={canvasRef}
        className={css.canvas}
        width={cells || 1}
        height={cells || 1}
        style={{ width: size.width, height: size.width }}
      />
    </div>
  );
}
