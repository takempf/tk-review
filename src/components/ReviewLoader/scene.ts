/**
 * The review loader's little world: a handful of shapes standing in for the
 * files under review, and an unseen "entity" that fetches one at a time to the
 * middle, turns it over for a while, and sets it down on a pile.
 *
 * With known progress the pile tracks it: every shape starts out drifting, and
 * one is put down per unit of progress. Without it the entity just browses —
 * picking shapes out of the air or back off the pile, inspecting, and putting
 * them down again — so the scene stays busy without claiming to measure
 * anything.
 *
 * The shapes arrive one after another around the loop, dropping in as they
 * grow to size, and leave the same way once told to: top to bottom, each
 * winding up a touch before shrinking away upward.
 */
import {
  type Camera,
  type Instance,
  MESHES,
  type Mesh,
  type Raster,
  type Shadow,
  smoothstep,
  type Tones,
  type Vec3,
} from "./raster";

interface Pose {
  position: Vec3;
  rotation: Vec3;
  scale: number;
}

type Active =
  | { kind: "entering"; start: number }
  | { kind: "drifting" }
  | { kind: "fetching"; from: Pose; start: number; to: Pose }
  | { kind: "inspecting"; start: number; base: Pose }
  | { kind: "resting"; slot: number }
  | { kind: "setting"; from: Pose; start: number; slot: number }
  | { kind: "releasing"; from: Pose; start: number; spin: Vec3 };

/** Leaving carries on whatever the shape was doing, shrinking it away as it goes. */
type Phase = Active | { kind: "leaving"; prior: Active; start: number };

interface Shape {
  mesh: Mesh;
  /** Where on the drifting loop it sits, and how it tumbles while there. */
  orbit: { angle: number; speed: number; height: number; bob: number };
  tumble: { base: Vec3; rate: Vec3 };
  /** Per-shape yaw on the pile, so neighbours don't all face the same way. */
  restYaw: number;
  phase: Phase;
}

export const CAMERA: Camera = { position: [0, 2.3, -7], pitch: 0.3, focal: 182 };
export const FLOOR_Y = -1.25;

const PILE: [number, number] = [0, 0.55];
const INSPECT_AT: Vec3 = [0, 1.05, -0.9];
const DRIFT_SCALE = 0.28;
const PILE_SCALE = 0.34;
const INSPECT_SCALE = 0.58;
const LAYER_RISE = 0.5;

const FETCH_SECONDS = 1.6;
const SET_SECONDS = 1.8;
const RELEASE_SECONDS = 1.9;

/** Arrivals: one shape after another, each dropping in from above as it grows. */
const ENTER_DELAY = 0.15;
const ENTER_STAGGER = 0.11;
const ENTER_SECONDS = 0.9;
const ENTER_DROP = 0.8;
const ENTER_SPIN = 2.4;

/** Departures: brisker than arrivals, and spread over at most `LEAVE_SPREAD`. */
const LEAVE_STAGGER = 0.07;
const LEAVE_SPREAD = 0.35;
const LEAVE_SECONDS = 0.5;
const LEAVE_RISE = 0.6;
const LEAVE_SPIN = 1.6;

/**
 * Pile positions, bottom layer first and nearest-the-middle first within it,
 * so filling them in order grows a mound and emptying them in reverse always
 * lifts off the top.
 */
const SLOTS: { x: number; z: number; layer: number }[] = (() => {
  const step = 0.7;
  const ring = (count: number, radius: number, turn: number, layer: number) =>
    Array.from({ length: count }, (_, i) => {
      const angle = turn + (i / count) * Math.PI * 2;
      // Squashed front to back, so the rows behind don't read as a stack.
      return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius * 0.6, layer };
    });
  // A hex mound: a centre and its six neighbours, three in the hollows above,
  // and one on top.
  return [
    { x: 0, z: 0, layer: 0 },
    ...ring(6, step, 0, 0),
    ...ring(3, step * 0.58, Math.PI / 6, 1),
    { x: 0, z: 0, layer: 2 },
  ];
})();

export const PILE_CAPACITY = SLOTS.length;

/** A tiny seeded PRNG, so a given shape count always lays out the same way. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** Eases out past 1 and settles back: a shape popping to size. */
const backOut = (t: number) => 1 + 2.6 * (t - 1) ** 3 + 1.6 * (t - 1) ** 2;
/** Dips below 0 before accelerating to 1: a shape swelling slightly before it shrinks. */
const backIn = (t: number) => 2.6 * t ** 3 - 1.6 * t ** 2;
/** The same angle, moved by whole turns to within half a turn of `near`. */
const nearest = (angle: number, near: number) =>
  angle - Math.round((angle - near) / (Math.PI * 2)) * Math.PI * 2;
const nearest3 = (angles: Vec3, near: Vec3): Vec3 => [
  nearest(angles[0], near[0]),
  nearest(angles[1], near[1]),
  nearest(angles[2], near[2]),
];

/** Interpolates two poses, lifting the path into an arc as it goes. */
function travel(from: Pose, to: Pose, t: number, lift: number): Pose {
  const e = ease(Math.min(1, Math.max(0, t)));
  const position = lerp3(from.position, to.position, e);
  position[1] += Math.sin(Math.PI * e) * lift;
  return {
    position,
    rotation: lerp3(from.rotation, nearest3(to.rotation, from.rotation), e),
    scale: lerp(from.scale, to.scale, e),
  };
}

export class Scene {
  private readonly shapes: Shape[];
  private readonly rand: () => number;
  /** Slot index → shape index, in fill order. */
  private readonly pile: number[] = [];
  /** Which shape the entity holds, and when it next acts. */
  private holding: number | null = null;
  private nextAt: number;
  private inspectFor = 0;
  /** How many shapes the pile should be holding; `null` when progress is unknown. */
  private target: number | null = null;
  /** When the last shape has arrived; 0 for a scene that starts settled. */
  private arrivedBy: number;
  /** When the shapes started leaving and when the last is gone, once told to. */
  private departure: { start: number; end: number } | null = null;

  constructor(count: number, seed = 7) {
    this.rand = random(seed);
    const total = Math.max(1, Math.min(PILE_CAPACITY, count));
    this.shapes = Array.from({ length: total }, (_, i) => ({
      mesh: MESHES[i % MESHES.length] as Mesh,
      orbit: {
        angle: (i / total) * Math.PI * 2 + this.rand() * 0.4,
        speed: 0.16 + this.rand() * 0.06,
        height: 0.55 + this.rand() * 0.5,
        bob: this.rand() * Math.PI * 2,
      },
      tumble: {
        base: [this.rand() * 6, this.rand() * 6, this.rand() * 6],
        rate: [0.3 + this.rand() * 0.5, 0.4 + this.rand() * 0.6, 0.2 + this.rand() * 0.4],
      },
      restYaw: this.rand() * Math.PI * 2,
      // In loop order, so they fill the loop in turn.
      phase: { kind: "entering", start: ENTER_DELAY + i * ENTER_STAGGER },
    }));
    this.arrivedBy = ENTER_DELAY + (total - 1) * ENTER_STAGGER + ENTER_SECONDS;
    // The entity waits for everyone to arrive before it starts browsing.
    this.nextAt = this.arrivedBy + 0.2;
  }

  get count() {
    return this.shapes.length;
  }

  /** When every shape has arrived and the scene is fully drawn. */
  get arrived() {
    return this.arrivedBy;
  }

  /** 0–1 when the review reports how far along it is, `null` when it doesn't. */
  setProgress(progress: number | null) {
    this.target =
      progress === null
        ? null
        : Math.round(Math.min(1, Math.max(0, progress)) * this.shapes.length);
  }

  /**
   * Starts every shape already resting or drifting at time `now` rather than
   * flying in from nowhere — used so a known-progress scene resumes sensibly.
   */
  settle(progress: number) {
    const done = Math.round(Math.min(1, Math.max(0, progress)) * this.shapes.length);
    this.shapes.forEach((shape, i) => {
      if (i < done) this.pile.push(i);
      shape.phase = i < done ? { kind: "resting", slot: i } : { kind: "drifting" };
    });
    this.arrivedBy = 0;
    this.nextAt = 0.4;
  }

  /**
   * Sends every shape off, top to bottom as they stand, and stops the entity.
   * Calling it again changes nothing; `gone` says when the last has left.
   */
  leave(time: number) {
    if (this.departure) return;
    const stagger = Math.min(LEAVE_STAGGER, LEAVE_SPREAD / Math.max(1, this.count - 1));
    const order = this.shapes
      .map((shape) => ({ shape, height: this.pose(shape, time).position[1] }))
      .sort((a, b) => b.height - a.height);
    order.forEach(({ shape }, i) => {
      if (shape.phase.kind === "leaving") return;
      shape.phase = { kind: "leaving", prior: shape.phase, start: time + i * stagger };
    });
    this.holding = null;
    this.departure = { start: time, end: time + (this.count - 1) * stagger + LEAVE_SECONDS };
  }

  /** True once every shape has left, after `leave`. */
  gone(time: number) {
    return this.departure !== null && time >= this.departure.end;
  }

  /** How much of the floor is drawn: it fades in with the arrivals and out with the departures. */
  private presence(time: number) {
    const arrived =
      this.arrivedBy === 0 ? 1 : smoothstep(ENTER_DELAY, ENTER_DELAY + ENTER_SECONDS, time);
    if (!this.departure) return arrived;
    return arrived * (1 - smoothstep(this.departure.start, this.departure.end, time));
  }

  private driftPose(shape: Shape, time: number): Pose {
    const angle = shape.orbit.angle + time * shape.orbit.speed;
    const { base, rate } = shape.tumble;
    return {
      position: [
        Math.cos(angle) * 2.1,
        // Tilted: low as it passes in front, beneath the inspected shape, and
        // high around the back, so the loop never runs through the middle.
        shape.orbit.height + Math.sin(angle) * 0.75 + Math.sin(time * 0.9 + shape.orbit.bob) * 0.15,
        0.35 + Math.sin(angle) * 1.5,
      ],
      rotation: [base[0] + time * rate[0], base[1] + time * rate[1], base[2] + time * rate[2]],
      scale: DRIFT_SCALE,
    };
  }

  private slotPose(shape: Shape, slot: number): Pose {
    const place = SLOTS[slot] as (typeof SLOTS)[number];
    return {
      position: [
        PILE[0] + place.x,
        FLOOR_Y + shape.mesh.bottom * PILE_SCALE + place.layer * LAYER_RISE,
        PILE[1] + place.z,
      ],
      rotation: [0, shape.restYaw, 0],
      scale: PILE_SCALE,
    };
  }

  /**
   * Held in front of the eye: a slow turn, a nod back and forth, and every so
   * often a quarter-turn roll, as if checking the underside.
   */
  private inspectPose(base: Pose, elapsed: number): Pose {
    const nod = Math.sin(elapsed * 0.8) * 0.35;
    const flips = Math.floor(elapsed / 3.2);
    const within = (elapsed % 3.2) / 3.2;
    const roll = (flips + smoothstep(0.75, 1, within)) * (Math.PI / 2);
    return {
      position: [
        base.position[0] + Math.sin(elapsed * 0.7) * 0.05,
        base.position[1] + Math.sin(elapsed * 1.3) * 0.06,
        base.position[2],
      ],
      rotation: [
        base.rotation[0] + nod,
        base.rotation[1] + elapsed * 0.55,
        base.rotation[2] + roll,
      ],
      scale: base.scale,
    };
  }

  /** Dropping onto its place on the loop, spinning to a stop as it grows to size. */
  private enterPose(shape: Shape, start: number, time: number): Pose {
    const to = this.driftPose(shape, time);
    const t = clamp01((time - start) / ENTER_SECONDS);
    const fall = 1 - easeOut(t);
    return {
      position: [to.position[0], to.position[1] + fall * ENTER_DROP, to.position[2]],
      rotation: [to.rotation[0], to.rotation[1] - fall * ENTER_SPIN, to.rotation[2]],
      scale: to.scale * backOut(t),
    };
  }

  private pose(shape: Shape, time: number, phase: Phase = shape.phase): Pose {
    switch (phase.kind) {
      case "entering":
        return this.enterPose(shape, phase.start, time);
      case "drifting":
        return this.driftPose(shape, time);
      case "resting":
        return this.slotPose(shape, phase.slot);
      case "fetching":
        return travel(phase.from, phase.to, (time - phase.start) / FETCH_SECONDS, 0.25);
      case "inspecting":
        return this.inspectPose(phase.base, time - phase.start);
      case "setting":
        return travel(
          phase.from,
          this.slotPose(shape, phase.slot),
          (time - phase.start) / SET_SECONDS,
          0.55,
        );
      case "releasing": {
        const to = this.driftPose(shape, time);
        // Whole turns only, so the handoff back to drifting is seamless.
        to.rotation = [
          to.rotation[0] - phase.spin[0],
          to.rotation[1] - phase.spin[1],
          to.rotation[2] - phase.spin[2],
        ];
        return travel(phase.from, to, (time - phase.start) / RELEASE_SECONDS, 0.2);
      }
      case "leaving": {
        const from = this.pose(shape, time, phase.prior);
        const t = clamp01((time - phase.start) / LEAVE_SECONDS);
        return {
          position: [from.position[0], from.position[1] + t * t * LEAVE_RISE, from.position[2]],
          rotation: [from.rotation[0], from.rotation[1] + t * t * LEAVE_SPIN, from.rotation[2]],
          scale: from.scale * (1 - backIn(t)),
        };
      }
    }
  }

  /**
   * How far a shape has taken the accent: it warms up as it is fetched, holds
   * while inspected, and cools off again on the way back to the pile or the
   * loop. A shape told to leave keeps whatever it had.
   */
  private focus(time: number, phase: Phase): number {
    switch (phase.kind) {
      case "fetching":
        return smoothstep(0, FETCH_SECONDS, time - phase.start);
      case "inspecting":
        return 1;
      case "setting":
        return 1 - smoothstep(0, SET_SECONDS, time - phase.start);
      case "releasing":
        return 1 - smoothstep(0, RELEASE_SECONDS, time - phase.start);
      case "leaving":
        return this.focus(time, phase.prior);
      default:
        return 0;
    }
  }

  /** Advances the entity: finishes moves that have landed and decides the next one. */
  update(time: number) {
    // Leaving shapes carry their last phase through to the end on their own.
    if (this.departure) return;
    for (const shape of this.shapes) {
      const phase = shape.phase;
      if (phase.kind === "entering" && time - phase.start >= ENTER_SECONDS) {
        shape.phase = { kind: "drifting" };
      } else if (phase.kind === "fetching" && time - phase.start >= FETCH_SECONDS) {
        shape.phase = { kind: "inspecting", start: time, base: phase.to };
      } else if (phase.kind === "setting" && time - phase.start >= SET_SECONDS) {
        shape.phase = { kind: "resting", slot: phase.slot };
        this.nextAt = time + 0.35 + this.rand() * 0.5;
      } else if (phase.kind === "releasing" && time - phase.start >= RELEASE_SECONDS) {
        shape.phase = { kind: "drifting" };
      }
    }

    if (this.holding !== null) {
      const shape = this.shapes[this.holding] as Shape;
      if (shape.phase.kind !== "inspecting") return;
      const elapsed = time - shape.phase.start;
      const done =
        this.target === null
          ? elapsed >= this.inspectFor
          : // Known progress: hold it until the review moves past it, but never
            // snatch it away before it has had a proper look.
            this.pile.length < this.target && elapsed >= Math.min(1.2, this.inspectFor);
      if (done) this.putDown(this.holding, time);
      return;
    }

    if (time < this.nextAt) return;
    const next = this.choose();
    if (next === null) {
      this.nextAt = time + 0.5;
      return;
    }
    this.pickUp(next, time);
  }

  private choose(): number | null {
    const drifting = this.shapes
      .map((shape, i) => (shape.phase.kind === "drifting" ? i : -1))
      .filter((i) => i >= 0);
    if (this.target !== null) {
      // In order, so the pile reads as files worked through one by one.
      return drifting[0] ?? null;
    }
    const top = this.pile.at(-1);
    const topSettled = top !== undefined && (this.shapes[top] as Shape).phase.kind === "resting";
    const fromPile =
      topSettled && (drifting.length === 0 || this.rand() < (this.pile.length / this.count) * 0.8);
    if (fromPile) return top as number;
    if (drifting.length === 0) return null;
    return drifting[Math.floor(this.rand() * drifting.length)] as number;
  }

  private pickUp(index: number, time: number) {
    const shape = this.shapes[index] as Shape;
    const from = this.pose(shape, time);
    if (shape.phase.kind === "resting") this.pile.pop();
    const to: Pose = {
      position: INSPECT_AT,
      rotation: [
        from.rotation[0] + 0.3 + this.rand() * 0.4,
        from.rotation[1] + 0.6 + this.rand() * 0.8,
        from.rotation[2] + this.rand() * 0.3,
      ],
      scale: INSPECT_SCALE,
    };
    shape.phase = { kind: "fetching", from, start: time, to };
    this.holding = index;
    this.inspectFor = 1.8 + this.rand() * 2;
  }

  private putDown(index: number, time: number) {
    const shape = this.shapes[index] as Shape;
    const from = this.pose(shape, time);
    this.holding = null;
    // Unknown progress keeps a few shapes in the air, so there is always
    // something to fetch and the pile rises and falls rather than filling up.
    const toPile =
      this.target !== null ||
      this.pile.length < 2 ||
      (this.pile.length < this.count - 2 && this.rand() < 0.6);
    if (toPile) {
      const slot = this.pile.length;
      this.pile.push(index);
      shape.phase = { kind: "setting", from, start: time, slot };
      return;
    }
    const drift = this.driftPose(shape, time + RELEASE_SECONDS);
    const spin: Vec3 = [
      drift.rotation[0] - nearest(drift.rotation[0], from.rotation[0]),
      drift.rotation[1] - nearest(drift.rotation[1], from.rotation[1]),
      drift.rotation[2] - nearest(drift.rotation[2], from.rotation[2]),
    ];
    shape.phase = { kind: "releasing", from, start: time, spin };
    this.nextAt = time + 0.6 + this.rand() * 0.6;
  }

  render(raster: Raster, tones: Tones, time: number) {
    // The camera is framed for a 120-pixel buffer; a finer one sees the same view.
    const camera: Camera = { ...CAMERA, focal: (CAMERA.focal * raster.width) / 120 };
    // Shapes yet to arrive, or already gone, have shrunk to nothing: not even a shadow.
    const instances: Instance[] = this.shapes
      .map((shape) => ({
        mesh: shape.mesh,
        ...this.pose(shape, time),
        accent: this.focus(time, shape.phase),
      }))
      .filter((instance) => instance.scale > 0.002);
    const shadows: Shadow[] = instances.map((instance) => {
      const height = instance.position[1] - FLOOR_Y - instance.mesh.bottom * instance.scale;
      return {
        x: instance.position[0],
        z: instance.position[2],
        radius: instance.scale * (1.15 + height * 0.35),
        strength: 0.9 / (1 + height * 1.4),
      };
    });
    const floor = tones.background + (tones.floor - tones.background) * this.presence(time);
    raster.clear(camera, { ...tones, floor }, FLOOR_Y, PILE, shadows);
    for (const instance of instances) raster.draw(instance, camera, tones);
  }
}
