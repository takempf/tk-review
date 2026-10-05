import { useEffect, useRef, useState } from "react";
import { bayerMatrix, crispSize, Raster, type Vec4 } from "../ReviewLoader/raster";
import css from "./Spinner.module.css";
import { renderSpinner } from "./spin";

/** Matches the review loader's scenery rate. */
const FRAME_MS = 1000 / 15;
/**
 * One CSS pixel per dither cell, where the loader uses the scenery token's
 * two: at icon size, two would leave only seven or eight cells across.
 */
const PIXEL = 1;
/** A 4×4 matrix, since an 8×8 one's pattern is half the width of the icon. */
const BAYER = bayerMatrix(4);
/** Dimmest to brightest, from `Spinner.module.css`. */
const INKS = ["--spinner-ink-1", "--spinner-ink-2", "--spinner-ink-3"];
const TRANSPARENT: Vec4 = [0, 0, 0, 0];

type Frame = (time: number) => void;

/**
 * Every spinner draws off one shared clock, so a page with several of them
 * runs one animation loop and they all turn in step.
 */
const frames = new Set<Frame>();
let loop = 0;

function subscribe(frame: Frame) {
  frames.add(frame);
  if (frames.size === 1) {
    let last = Number.NEGATIVE_INFINITY;
    loop = requestAnimationFrame(function tick(now) {
      loop = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      for (const draw of frames) draw(now / 1000);
    });
  }
  return () => {
    frames.delete(frame);
    if (frames.size === 0) cancelAnimationFrame(loop);
  };
}

let probe: CanvasRenderingContext2D | null | undefined;
const resolved = new Map<string, Vec4>();

/** Any computed CSS colour as RGBA, resolved once per distinct value through a 2D context. */
function rgba(color: string): Vec4 {
  let value = resolved.get(color);
  if (!value) {
    probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!probe) return [128, 128, 128, 255];
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
    value = [r, g, b, a];
    resolved.set(color, value);
  }
  return value;
}

interface Props {
  className?: string;
}

/**
 * A small busy indicator for buttons and other async actions: a low-poly solid
 * turning over slowly, lit and dithered like the review loader's shapes. It
 * draws in the active inks (on a primary button, its label colour) and is
 * sized like an icon (1.15em); set `width` in CSS to change that. Decorative, so the label beside it should say what's
 * happening ("Refreshing…").
 */
export function Spinner({ className }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ cells: 0, width: 0 });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() =>
      setSize(crispSize(wrap.clientWidth, PIXEL, window.devicePixelRatio || 1)),
    );
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const { cells } = size;
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || cells === 0) return;

    const raster = new Raster(cells, cells);
    const image = context.createImageData(cells, cells);
    let key = "";
    let inks: Vec4[] = [];
    const draw = (time: number) => {
      // Re-read each frame, so it follows theme changes and the button it is in.
      const style = getComputedStyle(canvas);
      const colors = INKS.map((name) => style.getPropertyValue(name).trim() || "#808080");
      const current = colors.join();
      if (current !== key) {
        key = current;
        inks = [TRANSPARENT, ...colors.map(rgba)];
      }
      renderSpinner(raster, time);
      raster.dither(inks, BAYER, image.data);
      context.putImageData(image, 0, 0);
    };

    // Reduced motion gets a still frame; the label beside it says what's happening.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(0);
      return;
    }
    draw(performance.now() / 1000);
    return subscribe(draw);
  }, [cells]);

  return (
    <span
      ref={wrapRef}
      className={className ? `${css.spinner} ${className}` : css.spinner}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className={css.canvas}
        width={cells || 1}
        height={cells || 1}
        style={{ width: size.width, height: size.width }}
      />
    </span>
  );
}
