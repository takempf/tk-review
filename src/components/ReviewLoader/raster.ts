/**
 * A tiny software renderer for the review loader: flat- and smooth-shaded
 * convex meshes rasterized into a low-resolution tone buffer, then quantized to
 * a four-colour palette with an ordered (Bayer) dither. No DOM here, so the
 * whole pipeline can be exercised from a plain script.
 */

export type Vec3 = [number, number, number];
/** An RGBA colour, 0–255 per channel. */
export type Vec4 = [number, number, number, number];

export interface Mesh {
  vertices: Vec3[];
  /** Convex polygons, wound counter-clockwise seen from outside. */
  faces: number[][];
  /** Shade from vertex normals (spheres) rather than one tone per face. */
  smooth: boolean;
  /** Distance from the origin down to the resting face, at unit scale. */
  bottom: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** Newell's method: robust for any planar polygon, and its length is twice the area. */
function polygonNormal(vertices: Vec3[], face: number[]): Vec3 {
  const normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i] as number] as Vec3;
    const b = vertices[face[(i + 1) % face.length] as number] as Vec3;
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normal;
}

function centroid(vertices: Vec3[], face: number[]): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  for (const index of face) {
    const v = vertices[index] as Vec3;
    sum[0] += v[0];
    sum[1] += v[1];
    sum[2] += v[2];
  }
  return [sum[0] / face.length, sum[1] / face.length, sum[2] / face.length];
}

/**
 * Finishes a hand-listed convex solid: fits it to the unit sphere, winds every
 * face outward (so the lists above need only name the right vertices), and
 * turns it so its largest face is underneath. That last step is what lets a
 * shape come to rest on the pile with a yaw alone — a prism lies on its side,
 * a pyramid sits on its base.
 */
function solid(vertices: Vec3[], faces: number[][], smooth = false): Mesh {
  const radius = Math.max(...vertices.map((v) => Math.hypot(v[0], v[1], v[2])));
  let points = vertices.map((v): Vec3 => [v[0] / radius, v[1] / radius, v[2] / radius]);
  const wound = faces.map((face) =>
    dot(polygonNormal(points, face), centroid(points, face)) < 0 ? [...face].reverse() : face,
  );

  let largest = wound[0] as number[];
  let largestArea = 0;
  for (const face of wound) {
    const area = Math.hypot(...polygonNormal(points, face));
    if (area > largestArea + 1e-6) {
      largest = face;
      largestArea = area;
    }
  }
  points = rotateOnto(points, normalize(polygonNormal(points, largest)), [0, -1, 0]);
  const bottom = -Math.min(...points.map((v) => v[1]));
  return { vertices: points, faces: wound, smooth, bottom };
}

/** Rodrigues' rotation taking direction `from` onto direction `to`. */
function rotateOnto(points: Vec3[], from: Vec3, to: Vec3): Vec3[] {
  const cosine = dot(from, to);
  if (cosine > 0.9999) return points;
  const axis = cosine < -0.9999 ? ([1, 0, 0] as Vec3) : normalize(cross(from, to));
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return points.map((p): Vec3 => {
    const k = cross(axis, p);
    const d = dot(axis, p) * (1 - cos);
    return [
      p[0] * cos + k[0] * sin + axis[0] * d,
      p[1] * cos + k[1] * sin + axis[1] * d,
      p[2] * cos + k[2] * sin + axis[2] * d,
    ];
  });
}

function prism(sides: number, halfHeight: number): Mesh {
  const vertices: Vec3[] = [];
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      vertices.push([Math.cos(angle), ring === 0 ? -halfHeight : halfHeight, Math.sin(angle)]);
    }
  }
  const faces = [
    Array.from({ length: sides }, (_, i) => i),
    Array.from({ length: sides }, (_, i) => sides + i),
    ...Array.from({ length: sides }, (_, i) => {
      const next = (i + 1) % sides;
      return [i, next, sides + next, sides + i];
    }),
  ];
  return solid(vertices, faces);
}

const PHI = (1 + Math.sqrt(5)) / 2;

const ICOSAHEDRON_VERTICES: Vec3[] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];

const ICOSAHEDRON_FACES = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

/** An icosahedron split `levels` times and pushed out to the sphere. */
function icosphere(levels: number): Mesh {
  const vertices = ICOSAHEDRON_VERTICES.map(normalize);
  let faces = ICOSAHEDRON_FACES;
  for (let level = 0; level < levels; level++) {
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let index = midpoints.get(key);
      if (index === undefined) {
        const va = vertices[a] as Vec3;
        const vb = vertices[b] as Vec3;
        index = vertices.push(normalize([va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]])) - 1;
        midpoints.set(key, index);
      }
      return index;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = midpoint(a as number, b as number);
      const bc = midpoint(b as number, c as number);
      const ca = midpoint(c as number, a as number);
      return [
        [a as number, ab, ca],
        [b as number, bc, ab],
        [c as number, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  return solid(vertices, faces, true);
}

// Cube vertex i sits at (±1, ±1, ±1) with bits x=1, y=2, z=4 set for the + side.
const CUBE_VERTICES = Array.from(
  { length: 8 },
  (_, i): Vec3 => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1],
);

export const MESHES: Mesh[] = [
  solid(CUBE_VERTICES, [
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 1, 3, 2],
    [4, 6, 7, 5],
  ]),
  solid(
    [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ],
    [
      [0, 2, 4],
      [0, 4, 3],
      [0, 3, 5],
      [0, 5, 2],
      [1, 4, 2],
      [1, 3, 4],
      [1, 5, 3],
      [1, 2, 5],
    ],
  ),
  prism(3, 0.75),
  icosphere(2),
  solid(
    [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ],
    [
      [0, 1, 2],
      [0, 3, 1],
      [0, 2, 3],
      [1, 3, 2],
    ],
  ),
  prism(6, 0.45),
  solid(ICOSAHEDRON_VERTICES, ICOSAHEDRON_FACES),
  solid(
    [
      [1, -0.7, 1],
      [-1, -0.7, 1],
      [-1, -0.7, -1],
      [1, -0.7, -1],
      [0, 1, 0],
    ],
    [
      [0, 1, 2, 3],
      [0, 4, 1],
      [1, 4, 2],
      [2, 4, 3],
      [3, 4, 0],
    ],
  ),
];

/** Row-major rotation from yaw (about y), then pitch (about x), then roll (about z). */
export function rotation([pitch, yaw, roll]: Vec3): number[] {
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cz = Math.cos(roll);
  const sz = Math.sin(roll);
  // Ry · Rx · Rz: a yaw alone spins the shape in place on the floor.
  return [
    cy * cz + sy * sx * sz,
    -cy * sz + sy * sx * cz,
    sy * cx,
    cx * sz,
    cx * cz,
    -sx,
    -sy * cz + cy * sx * sz,
    sy * sz + cy * sx * cz,
    cy * cx,
  ];
}

function apply(m: number[], v: Vec3): Vec3 {
  return [
    (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
    (m[3] as number) * v[0] + (m[4] as number) * v[1] + (m[5] as number) * v[2],
    (m[6] as number) * v[0] + (m[7] as number) * v[1] + (m[8] as number) * v[2],
  ];
}

/** A pinhole camera raised above the scene and pitched down toward it. */
export interface Camera {
  position: Vec3;
  /** Downward tilt in radians. */
  pitch: number;
  /** Focal length in buffer pixels. */
  focal: number;
}

/**
 * Where everything maps into the palette, as fractional ink indices: the dither
 * rounds each pixel to a neighbouring whole index. Ink 0 is the background —
 * transparent, so the panel shows through — and inks 1–3 are the text colour at
 * rising strength, so light is added to the scene the way text sits on the page.
 */
export interface Tones {
  background: number;
  /** The floor right under the pile; it fades back to the background with distance. */
  floor: number;
  shadow: number;
  /** Faces turned fully away from the light, and faces turned fully toward it. */
  unlit: number;
  lit: number;
}

export const TONES: Tones = { background: 0, floor: 0.55, shadow: 0, unlit: 1, lit: 3 };

export interface Instance {
  mesh: Mesh;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  /** 0–1: how far the shape has turned from the plain inks to the accent ones. */
  accent?: number;
}

export interface Shadow {
  x: number;
  z: number;
  /** Footprint radius on the floor. */
  radius: number;
  /** 0–1: how dark, falling off as the shape rises away from the floor. */
  strength: number;
}

/** Upper left, a little in front: the side of each shape the eye meets is lit. */
const LIGHT = normalize([-0.55, 0.8, -0.45]);

/** The recursive 2×2 step of the design system's `bayer()` in finish.frag.glsl. */
function bayer2(x: number, y: number): number {
  const px = x & 1;
  const py = y & 1;
  return 2 * px + 3 * py - 4 * px * py;
}

/**
 * Ordered thresholds for a 2, 4 or 8 cell matrix, built the way the design
 * system's finish shader builds them and centred in their bins, so a flat tone
 * of exactly n.5 splits its two neighbours evenly. Row-major, `size` a side.
 */
export function bayerMatrix(size: 2 | 4 | 8): Float32Array {
  const matrix = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const two = bayer2(x, y);
      const four = 4 * two + bayer2(x >> 1, y >> 1);
      const value =
        size === 2
          ? (two + 0.5) / 4
          : size === 4
            ? (four + 0.5) / 16
            : (4 * four + bayer2(x >> 2, y >> 2) + 0.5) / 64;
      matrix[y * size + x] = value;
    }
  }
  return matrix;
}

export class Raster {
  readonly tone: Float32Array;
  /** 0–1 per pixel: how much of the accent palette it takes, from the shape drawn there. */
  readonly accent: Float32Array;
  private readonly depth: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.tone = new Float32Array(width * height);
    this.accent = new Float32Array(width * height);
    this.depth = new Float32Array(width * height);
  }

  /**
   * Background, then the floor plane under the pile: each pixel's ray is cast
   * down to it, faded out with distance from `floorCenter`, and darkened (or
   * lightened) by each shape's soft round shadow.
   */
  clear(
    camera: Camera,
    tones: Tones,
    floorY: number,
    floorCenter: [number, number],
    shadows: Shadow[],
  ) {
    const { width, height, tone, depth } = this;
    depth.fill(Number.POSITIVE_INFINITY);
    this.accent.fill(0);
    const cos = Math.cos(camera.pitch);
    const sin = Math.sin(camera.pitch);
    const drop = floorY - camera.position[1];
    for (let py = 0; py < height; py++) {
      const v = -(py + 0.5 - height / 2) / camera.focal;
      // Camera up is (0, cos, sin) and forward (0, -sin, cos) in world space.
      const dy = v * cos - sin;
      const dz = v * sin + cos;
      for (let px = 0; px < width; px++) {
        const index = py * width + px;
        if (dy >= 0) {
          tone[index] = tones.background;
          continue;
        }
        const t = drop / dy;
        const x = camera.position[0] + ((px + 0.5 - width / 2) / camera.focal) * t;
        const z = camera.position[2] + dz * t;
        const reach = Math.hypot(x - floorCenter[0], (z - floorCenter[1]) * 1.3);
        const fade = 1 - smoothstep(1.1, 2.9, reach);
        let shade = 0;
        for (const shadow of shadows) {
          const distance = Math.hypot(x - shadow.x, z - shadow.z) / shadow.radius;
          shade = Math.max(shade, shadow.strength * (1 - smoothstep(0.35, 1, distance)));
        }
        const floor = tones.background + (tones.floor - tones.background) * fade;
        tone[index] = floor + (tones.shadow - floor) * shade * fade;
      }
    }
  }

  /** A plain background, for scenes with no floor. */
  blank(tone: number) {
    this.tone.fill(tone);
    this.accent.fill(0);
    this.depth.fill(Number.POSITIVE_INFINITY);
  }

  draw(instance: Instance, camera: Camera, tones: Tones) {
    const { mesh, accent = 0 } = instance;
    const matrix = rotation(instance.rotation);
    const cos = Math.cos(camera.pitch);
    const sin = Math.sin(camera.pitch);
    const [cx, cy, cz] = camera.position;

    const world = mesh.vertices.map((v): Vec3 => {
      const r = apply(matrix, v);
      return [
        instance.position[0] + r[0] * instance.scale,
        instance.position[1] + r[1] * instance.scale,
        instance.position[2] + r[2] * instance.scale,
      ];
    });
    // Screen x, screen y, view depth.
    const screen = world.map((p): Vec3 => {
      const x = p[0] - cx;
      const y = p[1] - cy;
      const z = p[2] - cz;
      const up = y * cos + z * sin;
      const forward = -y * sin + z * cos;
      return [
        this.width / 2 + (camera.focal * x) / forward,
        this.height / 2 - (camera.focal * up) / forward,
        forward,
      ];
    });
    const light = (normal: Vec3) => {
      const lambert = Math.max(0, dot(normal, LIGHT));
      return tones.unlit + (tones.lit - tones.unlit) * (0.12 + 0.88 * lambert);
    };
    const vertexTones = mesh.smooth
      ? mesh.vertices.map((v) => light(normalize(apply(matrix, v))))
      : null;

    for (const face of mesh.faces) {
      const normal = normalize(apply(matrix, polygonNormal(mesh.vertices, face)));
      const toCamera = sub(camera.position, world[face[0] as number] as Vec3);
      if (dot(normal, toCamera) <= 0) continue;
      const flat = light(normal);
      const first = face[0] as number;
      for (let i = 1; i < face.length - 1; i++) {
        const b = face[i] as number;
        const c = face[i + 1] as number;
        this.triangle(
          screen[first] as Vec3,
          screen[b] as Vec3,
          screen[c] as Vec3,
          vertexTones ? (vertexTones[first] as number) : flat,
          vertexTones ? (vertexTones[b] as number) : flat,
          vertexTones ? (vertexTones[c] as number) : flat,
          accent,
        );
      }
    }
  }

  private triangle(a: Vec3, b: Vec3, c: Vec3, ta: number, tb: number, tc: number, accent: number) {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let py = minY; py <= maxY; py++) {
      const y = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const x = px + 0.5;
        // Barycentric weights; all share the area's sign inside the triangle.
        const wa = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / area;
        const wb = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const z = wa * a[2] + wb * b[2] + wc * c[2];
        const index = py * this.width + px;
        if (z >= (this.depth[index] as number)) continue;
        this.depth[index] = z;
        this.tone[index] = wa * ta + wb * tb + wc * tc;
        this.accent[index] = accent;
      }
    }
  }

  /**
   * Writes RGBA pixels the way the design system's finish pass does: each tone
   * snapped to one of the inks by the ordered threshold. Inks carry their own
   * alpha, so the background ink can be transparent.
   *
   * A pixel takes the same ink from `accentInks` where its accent clears the
   * same threshold, so a shape turning over to the accent dissolves into it
   * pixel by pixel, never showing a colour outside the two palettes. Both
   * palettes need the same number of inks.
   */
  dither(inks: Vec4[], bayer: Float32Array, out: Uint8ClampedArray, accentInks = inks) {
    const last = inks.length - 1;
    const size = Math.round(Math.sqrt(bayer.length));
    for (let py = 0; py < this.height; py++) {
      for (let px = 0; px < this.width; px++) {
        const index = py * this.width + px;
        const threshold = bayer[(py % size) * size + (px % size)] as number;
        const level = Math.min(
          last,
          Math.max(0, Math.floor((this.tone[index] as number) + threshold)),
        );
        const palette = (this.accent[index] as number) > threshold ? accentInks : inks;
        const color = palette[level] as Vec4;
        out[index * 4] = color[0];
        out[index * 4 + 1] = color[1];
        out[index * 4 + 2] = color[2];
        out[index * 4 + 3] = color[3];
      }
    }
  }
}

/**
 * The largest size, up to `available` CSS pixels, that is a whole number of
 * dither cells, each a whole number of device pixels. A fractional cell makes
 * some a device pixel wider than others, which reads as banding across the
 * pattern.
 */
export function crispSize(available: number, pixel: number, ratio: number) {
  const devicePerCell = Math.max(1, Math.round(pixel * ratio));
  const cells = Math.max(1, Math.floor((available * ratio) / devicePerCell));
  return { cells, width: (cells * devicePerCell) / ratio };
}

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
