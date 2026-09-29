/**
 * The spinner's one frame: a single low-poly solid, lit and dithered exactly
 * like the review loader's shapes, turning over slowly in front of a fixed
 * camera. No DOM here, so frames can be rendered from a plain script.
 */
import { type Camera, MESHES, type Raster, TONES, type Tones } from "../ReviewLoader/raster";

/**
 * The octahedron: its eight big faces still read as separate planes at 16px,
 * where the icosahedron's twenty blur into a ball.
 */
const MESH = MESHES[1] as (typeof MESHES)[number];

const DISTANCE = 4;
/** How much of the canvas the solid's bounding sphere spans. */
const FILL = 0.94;

/** Radians per second about each axis: an unhurried tumble rather than a flat spin. */
const RATE: [number, number, number] = [0.45, 0.8, 0.3];

/**
 * The loader's tones, pushed brighter: at a dozen or so cells across, faces
 * need to reach solid ink to read as separate planes rather than a grey blur.
 */
const SPINNER_TONES: Tones = { ...TONES, floor: TONES.background, unlit: 1.3, lit: 3.8 };

export function renderSpinner(raster: Raster, time: number) {
  // A unit sphere at `DISTANCE` projects to a radius of focal / √(d² − 1).
  const focal = ((raster.width * FILL) / 2) * Math.sqrt(DISTANCE * DISTANCE - 1);
  const camera: Camera = { position: [0, 0, -DISTANCE], pitch: 0, focal };
  raster.blank(SPINNER_TONES.background);
  raster.draw(
    {
      mesh: MESH,
      position: [0, 0, 0],
      rotation: [0.6 + time * RATE[0], time * RATE[1], 0.3 + time * RATE[2]],
      scale: 1,
    },
    camera,
    SPINNER_TONES,
  );
}
