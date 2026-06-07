import type { Cohort, Phase } from "./types";

export const WIDTH = 960;
export const HEIGHT = 540;

export const TOWER = { x: 486, y: 278 };
export const DIRECTOR_COUNT = 7;
export const BODY_COUNT = 52;

export const FIELD = {
  left: 76,
  top: 62,
  right: WIDTH - 76,
  bottom: HEIGHT - 154,
};

export const BODY_SAFE = {
  left: FIELD.left + 18,
  top: FIELD.top + 24,
  right: FIELD.right - 18,
  bottom: FIELD.bottom - 28,
};

export const COHORT_COLORS: Record<Cohort, number> = {
  scout: 0x8de8ff,
  gatherer: 0xffdd7a,
  builder: 0xa9ffb4,
  coordinator: 0xff9ce2,
  critic: 0xff827a,
  memory: 0xc4b5ff,
};

export const COHORTS: Cohort[] = ["scout", "gatherer", "builder", "coordinator", "critic", "memory"];

export const STRATEGIES = [
  "wide scout sweep",
  "nearest-carrier assignment",
  "two-hop relay routing",
  "claim backoff after collision",
  "builder-first deposit windows",
  "tower orbit synchronization",
];

export const PATH_NODES = [
  { x: 304, y: 132 },
  { x: 650, y: 130 },
  { x: 742, y: 284 },
  { x: 610, y: 338 },
  { x: 350, y: 338 },
  { x: 224, y: 282 },
  { x: 388, y: 266 },
  { x: 576, y: 276 },
];

export const BASE_SYLLABLES = [
  "ka", "lum", "sha", "tek", "oru", "zu",
  "na", "fi", "mo", "ra", "ve", "xi",
  "po", "kre", "al", "nu", "thi", "wen",
];

export const GLYPH_EVENTS = [
  "claim_won", "claim_lost", "deposit", "gather",
  "scout_find", "coordination", "idle_near",
] as const;

export type GlyphEvent = typeof GLYPH_EVENTS[number];

export const PHASE_THRESHOLDS: Record<Phase, [number, number]> = {
  babble: [0, 30],
  structure: [30, 90],
  protocol: [90, 150],
  lockout: [150, Infinity],
};

export const HEAR_RANGE = 80;
export const LEARN_THRESHOLD = 3;
export const COMPOUND_MIN_AGE = 45;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function fieldPoint(point: { x: number; y: number }) {
  return {
    x: clamp(point.x, BODY_SAFE.left, BODY_SAFE.right),
    y: clamp(point.y, BODY_SAFE.top, BODY_SAFE.bottom),
  };
}
