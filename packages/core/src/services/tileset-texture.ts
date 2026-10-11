/**
 * Texture primitives for procedural tiles: noise, structural motifs, the
 * richness layer, and material caps.
 *
 * Everything in this file is written to be *tile-periodic*. That is not a
 * decoration constraint, it is the whole point: a terrain tile is stamped
 * hundreds of times across a level, so any feature whose period does not
 * divide the tile size shows up as a seam. Two rules are therefore enforced
 * throughout and should be preserved by anything added later:
 *
 *   1. Every grid period divides the tile size, and any grid with a per-row
 *      offset has an even number of rows (otherwise the offset itself fails to
 *      wrap).
 *   2. Every noise octave has a lattice count of at least 8. The lattice count
 *      is features-per-tile, so 8 means features no larger than a
 *      tile-size/8 blob. An earlier attempt used counts of 2 and 4 - 32px and
 *      16px blobs inside a 64px tile - and stamped across a platform they read
 *      as a repeating houndstooth rather than as material.
 *
 * The algorithms here were prototyped and eyeballed in Python before being
 * ported; the constants are the ones that looked right, not fresh guesses.
 */
import type { TileStructure, TileCap } from '../data/style-presets.js';

export type RGB = [number, number, number];

/* ------------------------------------------------------------------ */
/* Scalar helpers                                                      */
/* ------------------------------------------------------------------ */

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampSigned(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Compile-time exhaustiveness guard for a switch over a closed union.
 *
 * The point is not the runtime throw - that branch is unreachable by
 * construction. It is that adding a member to TILE_STRUCTURES or TILE_CAPS
 * without adding a case for it here stops being a silently plain tile and
 * becomes a build error: the new member is no longer assignable to `never`.
 * The preset table is the single source of truth for those vocabularies, so
 * the renderer has to fail loudly when it falls behind the table.
 */
function assertUnreachable(value: never, what: string): never {
  throw new Error(`Unhandled ${what}: ${String(value)}`);
}

/**
 * Integer hash of a cell coordinate. Every per-cell decision (tonal offset,
 * whether a cell carries a bolt, where that bolt sits) goes through this, so a
 * given seed always produces the identical tile - regeneration is reproducible
 * and two runs of the same game cannot drift apart.
 */
export function hash2(a: number, b: number, seed: number): number {
  let v =
    (Math.imul(a, 73856093) ^
      Math.imul(b, 19349663) ^
      Math.imul(seed, 83492791)) >>>
    0;
  v ^= v >>> 13;
  v = Math.imul(v, 1274126177) >>> 0;
  return (v >>> 8) / 16777216;
}

/** Largest divisor of `size` nearest `target`, never below `min`. */
export function nearestDivisor(size: number, target: number, min = 2): number {
  let best = size;
  for (let d = min; d <= size; d++) {
    if (size % d !== 0) continue;
    if (Math.abs(d - target) < Math.abs(best - target)) best = d;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function mixRgb(c: RGB, other: RGB, a: number): RGB {
  const k = clamp01(a);
  return [
    clampInt(Math.round(c[0] * (1 - k) + other[0] * k), 0, 255),
    clampInt(Math.round(c[1] * (1 - k) + other[1] * k), 0, 255),
    clampInt(Math.round(c[2] * (1 - k) + other[2] * k), 0, 255),
  ];
}

export function scaleRgb(c: RGB, f: number): RGB {
  return [
    clampInt(Math.round(c[0] * f), 0, 255),
    clampInt(Math.round(c[1] * f), 0, 255),
    clampInt(Math.round(c[2] * f), 0, 255),
  ];
}

export function luminance(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/** Sample a colour ramp at t in [0,1). */
export function rampAt(stops: RGB[], t: number): RGB {
  const n = stops.length - 1;
  const f = Math.max(0, Math.min(0.999, t)) * n;
  const i = Math.floor(f);
  const k = f - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

/**
 * Value noise on a wrapping lattice. `latX`/`latY` are lattice counts across
 * the tile, so the field is periodic in both axes by construction and a larger
 * count means *smaller* features. Separate counts per axis give anisotropic
 * grain - horizontal bedding for strata, vertical fibre for planks.
 */
export function periodicValueNoise(
  size: number,
  latX: number,
  latY: number,
  seed: number,
): Float64Array {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  const rnd = (): number => {
    // xorshift32 - deterministic, so a given game always regenerates identically
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const lat = new Float64Array(latX * latY);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y * latY) / size;
    const y0 = Math.floor(fy) % latY;
    const y1 = (y0 + 1) % latY;
    const ty = smooth(fy - Math.floor(fy));
    for (let x = 0; x < size; x++) {
      const fx = (x * latX) / size;
      const x0 = Math.floor(fx) % latX;
      const x1 = (x0 + 1) % latX;
      const tx = smooth(fx - Math.floor(fx));
      const a = lat[y0 * latX + x0] * (1 - tx) + lat[y0 * latX + x1] * tx;
      const b = lat[y1 * latX + x0] * (1 - tx) + lat[y1 * latX + x1] * tx;
      out[y * size + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** One-dimensional wrapping value noise, used for cap boundaries. */
export function periodicValueNoise1D(
  size: number,
  lat: number,
  seed: number,
): Float64Array {
  let s = seed >>> 0;
  if (s === 0) s = 0x85ebca6b;
  const rnd = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const pts = new Float64Array(lat);
  for (let i = 0; i < lat; i++) pts[i] = rnd();
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const out = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    const fx = (x * lat) / size;
    const x0 = Math.floor(fx) % lat;
    const x1 = (x0 + 1) % lat;
    const tx = smooth(fx - Math.floor(fx));
    out[x] = pts[x0] * (1 - tx) + pts[x1] * tx;
  }
  return out;
}

export function normalize(a: Float64Array): Float64Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const r = Math.max(hi - lo, 1e-6);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - lo) / r;
  return out;
}

/** Anisotropic fractal sum. Octaves are [latX, latY] pairs; both stay >= 8. */
export function fbmAniso(
  size: number,
  seed: number,
  octaves: Array<[number, number]>,
  weights: number[],
): Float64Array {
  const acc = new Float64Array(size * size);
  octaves.forEach((oct, i) => {
    const n = periodicValueNoise(
      size,
      oct[0],
      oct[1],
      seed + oct[0] * 97 + oct[1] * 53,
    );
    for (let k = 0; k < acc.length; k++) acc[k] += n[k] * weights[i];
  });
  return normalize(acc);
}

/** Isotropic fractal sum. */
export function fbm(
  size: number,
  seed: number,
  lattices: number[],
  weights: number[],
): Float64Array {
  return fbmAniso(
    size,
    seed,
    lattices.map((l) => [l, l] as [number, number]),
    weights,
  );
}

/**
 * Ridged variant: folding the noise at its midpoint turns soft cloud into
 * creases, which is what cracks and bedding planes actually look like.
 */
export function ridgedAniso(
  size: number,
  seed: number,
  octaves: Array<[number, number]>,
  weights: number[],
): Float64Array {
  const acc = new Float64Array(size * size);
  octaves.forEach((oct, i) => {
    const n = periodicValueNoise(
      size,
      oct[0],
      oct[1],
      seed + oct[0] * 131 + oct[1] * 71,
    );
    for (let k = 0; k < acc.length; k++)
      acc[k] += (1 - Math.abs(2 * n[k] - 1)) * weights[i];
  });
  return normalize(acc);
}

export function ridged(
  size: number,
  seed: number,
  lattices: number[],
  weights: number[],
): Float64Array {
  return ridgedAniso(
    size,
    seed,
    lattices.map((l) => [l, l] as [number, number]),
    weights,
  );
}

/* ------------------------------------------------------------------ */
/* Structural motifs                                                   */
/* ------------------------------------------------------------------ */

/**
 * Per-pixel structure of a tile, independent of colour.
 *
 * The five richness techniques all read from this: `tone` is the per-cell
 * brightness offset, `joint`/`ao`/`bevel` are the relief, and `cols`/`rows`
 * plus `originOf` place the detail scatter. Structures without a cell grid
 * (grain, cracked, ridged, dot-matrix) fill the same fields from the height
 * field instead, so downstream code never branches on the structure name.
 */
export interface StructureField {
  /** 0..1 - how much of this pixel is recessed joint. */
  joint: Float64Array;
  /** 0..1 - soft occlusion beside a joint, or in a cavity. */
  ao: Float64Array;
  /** -1..1 - relief with a fixed light direction: + is lit, - is shaded. */
  bevel: Float64Array;
  /** Multiplier applied to the surface value, one fixed value per cell. */
  tone: Float64Array;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Top-left pixel of a cell, for placing detail scatter. */
  originOf: (cx: number, cy: number) => [number, number];
}

interface GridSpec {
  cellW: number;
  cellH: number;
  /** Horizontal shift applied to odd rows. Requires an even row count. */
  offset: number;
  /** Groove width along the left edge of a cell; 0 disables vertical joints. */
  jointW: number;
  /** Groove height along the top edge of a cell; 0 disables horizontal joints. */
  jointH: number;
  bevelPx: number;
  bevelGain: number;
  aoPx: number;
  toneRange: number;
  /** Amplitude of the light/dark checkerboard parity, 0 for everything else. */
  parity: number;
}

function buildGridField(
  size: number,
  seed: number,
  spec: GridSpec,
): StructureField {
  const joint = new Float64Array(size * size);
  const ao = new Float64Array(size * size);
  const bevel = new Float64Array(size * size);
  const tone = new Float64Array(size * size);
  const cols = Math.max(1, Math.round(size / spec.cellW));
  const rows = Math.max(1, Math.round(size / spec.cellH));

  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / spec.cellH);
    const shift = (row % 2) * spec.offset;
    const iy = y - row * spec.cellH;
    for (let x = 0; x < size; x++) {
      const xs = (x + shift) % size;
      const col = Math.floor(xs / spec.cellW);
      const ix = xs - col * spec.cellW;
      const k = y * size + x;

      // (1) Per-cell tonal offset. Real concrete is never uniform panel to
      // panel, and this contributes more to "not a repeated stamp" than any
      // other single effect here.
      let t = 1 + (hash2(col, row, seed) - 0.5) * 2 * spec.toneRange;
      if (spec.parity > 0)
        t *= (col + row) % 2 === 0 ? 1 + spec.parity : 1 - spec.parity;
      tone[k] = t;

      const inJointX = spec.jointW > 0 && ix < spec.jointW;
      const inJointY = spec.jointH > 0 && iy < spec.jointH;
      if (inJointX || inJointY) {
        joint[k] = 1;
        continue;
      }

      // (3) Ambient occlusion: a soft falloff beside the joint rather than a
      // hard line. Only the left/top sides get it; the right/bottom sides
      // carry the shaded half of the bevel instead.
      const dx = spec.jointW > 0 ? ix : Number.POSITIVE_INFINITY;
      const dy = spec.jointH > 0 ? iy : Number.POSITIVE_INFINITY;
      const d = Math.min(dx, dy);
      const jw = Math.max(spec.jointW, spec.jointH);
      if (d < spec.aoPx && spec.aoPx > jw)
        ao[k] = clamp01(1 - (d - jw) / (spec.aoPx - jw));

      // (2) Bevel with one consistent light direction - lit on top/left,
      // shaded on bottom/right. This gives relief without implying a camera,
      // which is the distinction that makes a tile stamp flat and tileable.
      let b = 0;
      if (spec.cellW < size) {
        if (ix >= spec.jointW && ix < spec.jointW + spec.bevelPx) b += 0.77;
        else if (ix >= spec.cellW - spec.bevelPx) b -= 0.77;
      }
      if (spec.cellH < size) {
        if (iy >= spec.jointH && iy < spec.jointH + spec.bevelPx) b += 1.0;
        else if (iy >= spec.cellH - spec.bevelPx) b -= 0.92;
      }
      bevel[k] = clampSigned(b * spec.bevelGain);
    }
  }

  return {
    joint,
    ao,
    bevel,
    tone,
    cols,
    rows,
    cellW: spec.cellW,
    cellH: spec.cellH,
    originOf: (cx, cy) => [
      (((cx * spec.cellW - (cy % 2) * spec.offset) % size) + size) % size,
      (cy * spec.cellH) % size,
    ],
  };
}

/**
 * Hexagonal cells on a wrapping grid. The cell count per axis is even so the
 * half-cell row offset wraps, and the cell size divides the tile.
 */
function buildHexField(size: number, seed: number): StructureField {
  const cell = nearestDivisor(size, size / 4, 4);
  const cols = Math.max(2, Math.round(size / cell));
  const rows = cols;
  const joint = new Float64Array(size * size);
  const ao = new Float64Array(size * size);
  const bevel = new Float64Array(size * size);
  const tone = new Float64Array(size * size);
  const half = cell / 2;

  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / cell);
    const off = (row % 2) * half;
    const cy = (y % cell) - half;
    for (let x = 0; x < size; x++) {
      const xs = (x + off) % size;
      const col = Math.floor(xs / cell);
      const cx = (xs % cell) - half;
      const k = y * size + x;
      // Hexagonal distance field: the flat-top hex is the intersection of a
      // slab and a rotated slab, which is exactly this max of two half-spaces.
      const d = Math.max(
        Math.abs(cx) * 0.866 + Math.abs(cy) * 0.5,
        Math.abs(cy),
      );
      const edge = clamp01(1 - d / (cell * 0.42));
      tone[k] = 0.9 + hash2(col, row, seed) * 0.2;
      if (edge < 0.12) {
        joint[k] = 1;
        continue;
      }
      if (edge < 0.3) ao[k] = clamp01(1 - (edge - 0.12) / 0.18);
      // Lit on the upper half of a cell, shaded on the lower half.
      bevel[k] = clampSigned((-cy / half) * (0.35 + edge * 0.5));
    }
  }

  return {
    joint,
    ao,
    bevel,
    tone,
    cols,
    rows,
    cellW: cell,
    cellH: cell,
    originOf: (cx, cy) => [
      (((cx * cell - (cy % 2) * half) % size) + size) % size,
      (cy * cell) % size,
    ],
  };
}

/**
 * Structures with no cell grid still get all five richness techniques - they
 * just derive them from the surface itself instead of from panel edges:
 * `veins` (when present) act as the joints, the height gradient supplies the
 * bevel, cavities supply the occlusion, and a low-frequency field supplies the
 * tonal variation that a cell hash would otherwise give.
 */
function buildFieldFromHeight(
  size: number,
  seed: number,
  height: Float64Array,
  opts: { veins?: Float64Array; bevelGain: number; toneRange: number },
): StructureField {
  const joint = new Float64Array(size * size);
  const ao = new Float64Array(size * size);
  const bevel = new Float64Array(size * size);
  const tone = new Float64Array(size * size);
  const mottle = fbm(size, seed + 4177, [8, 16], [0.6, 0.4]);
  const at = (x: number, y: number): number =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      tone[k] = 1 + (mottle[k] - 0.5) * 2 * opts.toneRange;
      if (opts.veins) {
        const v = opts.veins[k];
        // Only the top of the ridge distribution becomes a crack, so the veins
        // stay thin instead of turning the whole surface into a web.
        joint[k] = clamp01((v - 0.72) / 0.14);
        ao[k] = clamp01((v - 0.55) / 0.17) * (1 - joint[k]);
      } else {
        ao[k] = clamp01((0.4 - height[k]) / 0.4) * 0.6;
      }
      const lit = (at(x, y - 1) + at(x - 1, y)) * 0.5;
      const dark = (at(x, y + 1) + at(x + 1, y)) * 0.5;
      bevel[k] = clampSigned((lit - dark) * opts.bevelGain);
    }
  }

  const halfW = Math.max(1, Math.round(size / 2));
  return {
    joint,
    ao,
    bevel,
    tone,
    cols: 2,
    rows: 2,
    cellW: halfW,
    cellH: halfW,
    originOf: (cx, cy) => [(cx * halfW) % size, (cy * halfW) % size],
  };
}

/** Cell geometry per structure, or null for the structures with no cell grid. */
function gridSpecFor(structure: TileStructure, size: number): GridSpec | null {
  const u = (n: number): number => Math.max(1, Math.round((n * size) / 64));
  switch (structure) {
    case 'slab': {
      const cell = nearestDivisor(size, size / 2, 8);
      return {
        cellW: cell,
        cellH: cell,
        offset: 0,
        jointW: u(2),
        jointH: u(2),
        bevelPx: u(3),
        bevelGain: 1,
        aoPx: u(5),
        toneRange: 0.15,
        parity: 0,
      };
    }
    case 'plate': {
      // Same panel grid as slab, but a metal read: the joints are tighter and
      // the bevel is much harder, because rolled plate has a crisp edge where
      // cast concrete has a soft one.
      const cell = nearestDivisor(size, size / 2, 8);
      return {
        cellW: cell,
        cellH: cell,
        offset: 0,
        jointW: u(1),
        jointH: u(1),
        bevelPx: u(2),
        bevelGain: 1.5,
        aoPx: u(4),
        toneRange: 0.09,
        parity: 0,
      };
    }
    case 'brick': {
      // Roughly 2:1 courses, offset half a brick per row. The row count must be
      // even or the offset does not wrap.
      let cellH = nearestDivisor(size, size / 4, 4);
      if (Math.round(size / cellH) % 2 !== 0)
        cellH = nearestDivisor(size, size / 2, 4);
      const cellW = nearestDivisor(size, cellH * 2, 4);
      return {
        cellW,
        cellH,
        offset: Math.round(cellW / 2),
        jointW: u(2),
        jointH: u(2),
        bevelPx: u(2),
        bevelGain: 0.9,
        aoPx: u(4),
        toneRange: 0.15,
        parity: 0,
      };
    }
    case 'plank': {
      // Boards run top to bottom, so there are vertical joints only: cellH is
      // the whole tile, which switches off every horizontal edge effect.
      const cellW = nearestDivisor(size, size / 4, 4);
      return {
        cellW,
        cellH: size,
        offset: 0,
        jointW: u(2),
        jointH: 0,
        bevelPx: u(2),
        bevelGain: 0.85,
        aoPx: u(4),
        toneRange: 0.15,
        parity: 0,
      };
    }
    case 'checker': {
      // A tonal pattern rather than a built one: no grooves, just alternating
      // squares with a hint of edge so it does not read as flat paper.
      const cell = nearestDivisor(size, size / 4, 4);
      return {
        cellW: cell,
        cellH: cell,
        offset: 0,
        jointW: 0,
        jointH: 0,
        bevelPx: u(1),
        bevelGain: 0.45,
        aoPx: 0,
        toneRange: 0.05,
        parity: 0.1,
      };
    }
    case 'grain':
    case 'cracked':
    case 'ridged':
    case 'hex':
    case 'dot-matrix':
      // No cell grid at all. `hex` has cells but not rectangular ones, so it
      // builds its own field; the other four take theirs from the height field.
      return null;
    default:
      return assertUnreachable(structure, 'tile structure');
  }
}

/* ------------------------------------------------------------------ */
/* Material tile                                                       */
/* ------------------------------------------------------------------ */

export interface MaterialTileSpec {
  size: number;
  seed: number;
  structure: TileStructure;
  /** 0..1 - how much staining, scratching and scatter the richness layer adds. */
  wear: number;
  /** 0 = soft cloudy stone, 1 = cracked and bedded. */
  ridgeMix: number;
  ramp: RGB[];
  lit: RGB;
  shade: RGB;
}

/** Ordered dither matrix - the classic 4x4 Bayer threshold set. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Render one seamless tile of material.
 *
 * Stages: surface height -> structure (joints, bevel, occlusion, per-cell
 * tone) -> wear -> detail scatter. `dot-matrix` runs the identical pipeline in
 * value space and quantises at the end, so a hardware-palette style keeps
 * exactly the colours in its ramp - the richness shows up as a change in the
 * dither pattern rather than as new colours.
 */
export function renderMaterialTile(spec: MaterialTileSpec): Uint8Array {
  const T = spec.size;
  const seed = spec.seed;
  const wear = clamp01(spec.wear);
  const structure = spec.structure;
  const { ramp, lit, shade } = spec;

  // --- surface height ------------------------------------------------
  const fine = periodicValueNoise(T, 32, 32, seed + 777);
  let height: Float64Array;
  let veins: Float64Array | undefined;
  if (structure === 'ridged') {
    // Strata: features stretched along x so they read as bedding planes. Both
    // lattice counts stay >= 8, so the "beds" are fine banding, not blobs.
    const strata = ridgedAniso(
      T,
      seed + 911,
      [
        [8, 24],
        [16, 48],
      ],
      [0.62, 0.38],
    );
    height = new Float64Array(T * T);
    for (let k = 0; k < height.length; k++)
      height[k] = strata[k] * 0.86 + fine[k] * 0.14;
  } else if (structure === 'plank') {
    // Wood fibre runs along the board, so the grain is stretched the other way.
    const wood = fbmAniso(
      T,
      seed + 1301,
      [
        [24, 8],
        [48, 16],
      ],
      [0.6, 0.4],
    );
    height = new Float64Array(T * T);
    for (let k = 0; k < height.length; k++)
      height[k] = wood[k] * 0.86 + fine[k] * 0.14;
  } else {
    const smooth = fbm(T, seed, [8, 16, 32], [0.45, 0.33, 0.22]);
    const rid = ridged(T, seed + 555, [8, 16, 24], [0.5, 0.32, 0.18]);
    const mix = clamp01(spec.ridgeMix);
    height = new Float64Array(T * T);
    for (let k = 0; k < height.length; k++) {
      height[k] =
        (smooth[k] * (1 - mix) + rid[k] * mix) * 0.88 + fine[k] * 0.12;
    }
  }
  if (structure === 'cracked') {
    veins = ridged(T, seed + 2081, [8, 16, 24], [0.5, 0.3, 0.2]);
  }

  // --- structure -----------------------------------------------------
  let field: StructureField;
  const gridSpec = gridSpecFor(structure, T);
  if (gridSpec) field = buildGridField(T, seed, gridSpec);
  else if (structure === 'hex') field = buildHexField(T, seed);
  else {
    field = buildFieldFromHeight(T, seed, height, {
      veins,
      // Strata already carry a strong vertical gradient of their own, so the
      // same gain that gives grain its relief would blow them out.
      bevelGain:
        structure === 'dot-matrix' ? 0 : structure === 'ridged' ? 4 : 8,
      toneRange: structure === 'dot-matrix' ? 0.04 : 0.07,
    });
  }

  // --- wear ----------------------------------------------------------
  // Low-frequency staining plus sparse high-frequency scratches. Both are
  // thresholded so only the top of the distribution shows: wear that covers
  // the whole surface stops reading as wear and starts reading as colour.
  // The prototype used a lattice count of 4 for the stain; raised to 8 here so
  // no octave puts a feature larger than an eighth of the tile on screen.
  const stain = fbm(T, seed + 31, [8, 16], [0.6, 0.4]);
  const scuff = fbm(T, seed + 61, [24, 48], [0.5, 0.5]);
  // Calibrated so wear = 0.5 reproduces the prototype's amounts.
  const stainAmt = 0.44 * wear;
  const scuffAmt = 2.4 * wear;

  const out = new Uint8Array(T * T * 3);
  const dither = structure === 'dot-matrix';
  const levels = ramp.length;

  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const k = y * T + x;
      let c: RGB;

      if (dither) {
        // Value-space path: everything perturbs the ramp position, and the
        // ordered dither picks an exact palette entry at the end.
        let v = height[k] * field.tone[k];
        if (stain[k] > 0.5) v -= (stain[k] - 0.5) * stainAmt * 0.7;
        if (scuff[k] > 0.8) v += (scuff[k] - 0.8) * scuffAmt * 0.35;
        v -= field.joint[k] * 0.35 + field.ao[k] * 0.18;
        let f =
          clamp01(0.1 + v * 0.85) * (levels - 1) +
          BAYER[y % 4][x % 4] / 16 -
          0.5;
        if (y % 4 === 3) f -= 0.35; // dot-matrix scan line, as a dither bias
        c = ramp[clampInt(Math.round(f), 0, levels - 1)];
      } else {
        c = rampAt(ramp, 0.26 + height[k] * 0.7);
        c = scaleRgb(c, field.tone[k]);
        if (stain[k] > 0.5) c = mixRgb(c, shade, (stain[k] - 0.5) * stainAmt);
        if (scuff[k] > 0.8) c = mixRgb(c, lit, (scuff[k] - 0.8) * scuffAmt);
        const j = field.joint[k];
        if (j > 0) c = mixRgb(c, shade, 0.62 * j);
        if (j < 1) {
          const rest = 1 - j;
          if (field.ao[k] > 0) c = mixRgb(c, shade, 0.3 * field.ao[k] * rest);
          const b = field.bevel[k];
          if (b > 0) c = mixRgb(c, lit, 0.26 * b * rest);
          else if (b < 0) c = mixRgb(c, shade, 0.26 * -b * rest);
        }
      }

      out[k * 3] = c[0];
      out[k * 3 + 1] = c[1];
      out[k * 3 + 2] = c[2];
    }
  }

  // --- detail scatter ------------------------------------------------
  // Bolts and chips, placed by hashing the cell coordinate so they land in the
  // same spot every run and the tile still wraps.
  const rad = Math.max(1, Math.round(T / 32));
  const pad = rad + 2;
  const chance = 0.2 + 0.5 * wear;
  for (let cy = 0; cy < field.rows; cy++) {
    for (let cx = 0; cx < field.cols; cx++) {
      if (hash2(cx, cy, seed + 7) > chance) continue;
      const [ox, oy] = field.originOf(cx, cy);
      const spanW = Math.max(1, field.cellW - 2 * pad);
      const spanH = Math.max(1, field.cellH - 2 * pad);
      const bx = ox + pad + Math.round(hash2(cx, cy, seed + 11) * spanW);
      const by = oy + pad + Math.round(hash2(cx, cy, seed + 13) * spanH);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          const px = (((bx + dx) % T) + T) % T;
          const py = (((by + dy) % T) + T) % T;
          const o = (py * T + px) * 3;
          // The lit half of the stud faces the same way as every other bevel.
          const target = dx + dy < 0 ? lit : shade;
          if (dither) {
            out[o] = target[0];
            out[o + 1] = target[1];
            out[o + 2] = target[2];
          } else {
            const c = mixRgb([out[o], out[o + 1], out[o + 2]], target, 0.42);
            out[o] = c[0];
            out[o + 1] = c[1];
            out[o + 2] = c[2];
          }
        }
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Caps                                                                */
/* ------------------------------------------------------------------ */

/**
 * Canonical hue for each cap material. A cap has to read as a different
 * substance sitting on the terrain, and a palette with no green in it cannot
 * express grass on its own - so the palette entry closest to the cap's hue
 * family is blended toward this reference rather than used raw. The palette
 * still sets the value and the character; this only guarantees the substance
 * is recognisable.
 */
const CAP_REFERENCE: Record<Exclude<TileCap, 'none'>, string> = {
  grass: '#4E7F35',
  snow: '#EDF3F8',
  moss: '#3D5A32',
  rust: '#8A4B22',
};

function capScore(cap: Exclude<TileCap, 'none'>, c: RGB): number {
  switch (cap) {
    case 'grass':
    case 'moss':
      return c[1] - (c[0] + c[2]) / 2;
    case 'snow':
      return luminance(c);
    case 'rust':
      return c[0] - c[2] + (c[1] - c[2]) * 0.5;
    default:
      return assertUnreachable(cap, 'tile cap');
  }
}

/** Three-stop ramp for the cap material, derived from the game's own palette. */
export function capRamp(
  cap: Exclude<TileCap, 'none'>,
  palette: RGB[],
  lit: RGB,
): RGB[] {
  const reference = hexToRgb(CAP_REFERENCE[cap]);
  let best = palette[0] ?? reference;
  let bestScore = -Infinity;
  for (const c of palette) {
    const s = capScore(cap, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  const base = mixRgb(best, reference, cap === 'snow' ? 0.35 : 0.45);
  return [scaleRgb(base, 0.58), base, mixRgb(base, lit, 0.3)];
}

export interface CapBandSpec {
  size: number;
  cap: TileCap;
  seed: number;
  /** Every colour declared by the game, not just the terrain ramp. */
  palette: RGB[];
  lit: RGB;
  shade: RGB;
  wear: number;
}

export interface CapBand {
  /** size*size*3 - the cap material's colour at each pixel. */
  rgb: Uint8Array;
  /** size*size - how much of the cap covers each pixel, 0 below the band. */
  alpha: Float64Array;
}

/**
 * A band of different material along the top edge of terrain.
 *
 * Three properties make it read as a substance rather than as lighting: the
 * boundary is driven by the noise field so it is irregular, the colour comes
 * from the palette's own hue family rather than from brightening the body, and
 * a little of it bleeds down into the body below the boundary.
 */
export function renderCapBand(spec: CapBandSpec): CapBand {
  const T = spec.size;
  const rgb = new Uint8Array(T * T * 3);
  const alpha = new Float64Array(T * T);
  if (spec.cap === 'none') return { rgb, alpha };
  const cap = spec.cap;

  const stops = capRamp(cap, spec.palette, spec.lit);
  const depthFrac = cap === 'rust' ? 0.2 : cap === 'snow' ? 0.26 : 0.3;
  const baseDepth = Math.max(2, Math.round(T * depthFrac));
  const bleed = Math.max(2, Math.round(T * 0.14));
  // Ragged for the organic and corrosive caps, smooth drifts for snow.
  const patchy = cap === 'moss' || cap === 'rust';

  const edge = periodicValueNoise1D(T, 8, spec.seed + 401);
  const edge2 = periodicValueNoise1D(T, 16, spec.seed + 409);
  // Drips come from a smooth field rather than a per-column hash: a hash gives
  // isolated single-pixel spikes, which read as stray hairs instead of as
  // material running down into the body.
  const dripN = periodicValueNoise1D(T, 16, spec.seed + 443);
  const grain = fbm(T, spec.seed + 421, [8, 24], [0.55, 0.45]);
  const patch = fbm(T, spec.seed + 433, [8, 16], [0.6, 0.4]);
  const rim = Math.max(1, Math.round(T / 32));

  for (let x = 0; x < T; x++) {
    const e = edge[x] * 0.7 + edge2[x] * 0.3;
    const depth = baseDepth * (0.45 + e * 0.95);
    // Drips: a minority of columns carry the cap further down, which is what
    // stops the boundary from reading as a contour line.
    const drip = clamp01((dripN[x] - 0.6) / 0.4);
    const reach = depth + drip * bleed * 0.9;
    for (let y = 0; y < Math.min(T, Math.ceil(reach + bleed) + 1); y++) {
      const k = y * T + x;
      let a: number;
      if (y < reach - 1) a = 1;
      else if (y < reach + bleed)
        a = clamp01(1 - (y - (reach - 1)) / bleed) * 0.6;
      else a = 0;
      if (a <= 0) continue;
      if (patchy && y > reach * 0.5) {
        a *= clamp01((patch[k] - 0.28) / 0.34);
      }
      alpha[k] = clamp01(a);

      let c = rampAt(stops, 0.28 + grain[k] * 0.62);
      if (y < rim) c = mixRgb(c, spec.lit, 0.35); // the cap catches the light too
      // The underside of the cap sits in its own shadow, and what bleeds into
      // the body below is the darker part of the material.
      if (y >= reach - 2) c = mixRgb(c, spec.shade, 0.35);
      if (spec.wear > 0 && grain[k] > 0.82)
        c = mixRgb(c, spec.shade, (grain[k] - 0.82) * spec.wear);
      rgb[k * 3] = c[0];
      rgb[k * 3 + 1] = c[1];
      rgb[k * 3 + 2] = c[2];
    }
  }

  return { rgb, alpha };
}

/* ------------------------------------------------------------------ */
/* Markers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decoration and signage are different things, and the difference was learned
 * by getting it wrong.
 *
 * An early pass scattered yellow-and-black hazard stripes across a warehouse
 * floor because they looked good. They landed on 1 of 14 real objects by
 * coincidence, while the game already marked its genuine damage-dealing tiles
 * with a separate red overlay - two competing warning languages, one of them
 * meaningless, and the meaningless one diluting the signal the other was
 * carrying. Repainting the stripes at the real hazard coordinates produced
 * exact 6/6 alignment and turned the floor marking and the overlay into two
 * views of one fact.
 *
 * So the rule this section exists to hold: wear, stains, bolts and grime may be
 * scattered freely; anything that READS AS SIGNAGE must be traceable to a
 * game-logic source. A marker overlay is only ever composited onto a tile that
 * the map places at a coordinate the game itself declared.
 */
export type MarkerRole = 'hazard' | 'pickup';

/** Every marker role, in the order a caller should iterate them. */
export const MARKER_ROLES: readonly MarkerRole[] = ['hazard', 'pickup'];

/** One declared palette colour together with the prose that names its job. */
export interface LabeledColor {
  rgb: RGB;
  /** The art guide's own words for this colour, e.g. "hazard warning red". */
  label: string;
}

/**
 * The role vocabulary, as word stems with a weight.
 *
 * Two independent decisions read from this one table: which palette colour a
 * marker is painted in, and which `object_markers` type earns a marker at all.
 * Keeping both on one vocabulary is the point - a game whose art guide calls a
 * colour "danger red for spikes" and whose map calls an object "spike_trap" is
 * naming the same thing twice, and the tileset and the tilemap should agree
 * about that without a second list to keep in sync.
 *
 * Stems, not words, so plurals and compounds match ("spikes", "damaged",
 * "health_pickup"). Weight 2 is a word that names the role outright; weight 1
 * is a word that merely leans that way, so two leaning words cannot outvote one
 * naming word.
 *
 * `enemy` is deliberately absent from the hazard stems even though art guides
 * routinely say "danger accent for enemies": it would classify the extremely
 * common `enemy_spawn` object type as a hazard and paint warning stripes under
 * every enemy.
 */
const ROLE_STEMS: Record<
  MarkerRole,
  ReadonlyArray<readonly [string, number]>
> = {
  hazard: [
    ['hazard', 2],
    ['danger', 2],
    ['damag', 2],
    ['spike', 2],
    ['trap', 2],
    ['warn', 1],
    ['threat', 1],
    ['alarm', 1],
    ['hurt', 1],
  ],
  pickup: [
    ['pickup', 2],
    ['pick-up', 2],
    ['pick_up', 2],
    ['heal', 2],
    ['collect', 2],
    ['reward', 2],
    ['coin', 2],
    ['loot', 2],
    ['treasur', 2],
    ['safe', 1],
    ['success', 1],
    ['bonus', 1],
    ['gem', 1],
  ],
};

/** How strongly a piece of prose names a role. 0 = not at all. */
export function roleScore(role: MarkerRole, text: string): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const [stem, weight] of ROLE_STEMS[role]) {
    if (t.includes(stem)) score += weight;
  }
  return score;
}

/**
 * Which role a name or a description denotes, or null when it denotes neither.
 *
 * A tie is null rather than a guess: "danger reward" is genuinely ambiguous,
 * and a marker placed on a coin because the sentence also said "danger" is the
 * exact failure this whole section is written against.
 */
export function classifyMarkerRole(text: string): MarkerRole | null {
  const hazard = roleScore('hazard', text);
  const pickup = roleScore('pickup', text);
  if (hazard === 0 && pickup === 0) return null;
  if (hazard === pickup) return null;
  return hazard > pickup ? 'hazard' : 'pickup';
}

/** Redness / greenness, used only when the art guide names no role at all. */
function warmth(c: RGB): number {
  return c[0] - (c[1] + c[2]) / 2;
}
function greenness(c: RGB): number {
  return c[1] - (c[0] + c[2]) / 2;
}

/**
 * The colour each marker is painted in, taken from the palette's own semantic
 * labels rather than from a hardcoded warning yellow.
 *
 * Every generated game's docs/art_style.md labels its colours by job - "hazard
 * warning red, enemy sensor pressure, damage feedback", "health pickup and safe
 * success feedback" - so the colour a game already reserved for danger is the
 * colour its danger markings should be. A game that names no such colour falls
 * back to the reddest / greenest entry it does declare, which is still one of
 * ITS colours; only a game with no palette at all reaches a literal.
 */
export function markerColors(
  labeled: readonly LabeledColor[],
  palette: readonly RGB[],
): Record<MarkerRole, RGB> {
  const pool = palette.length ? [...palette] : [hexToRgb('#B84A3A')];
  const chosen: Partial<Record<MarkerRole, RGB>> = {};
  for (const role of MARKER_ROLES) {
    let best: RGB | null = null;
    let bestScore = 0;
    for (const entry of labeled) {
      const s = roleScore(role, entry.label);
      // The other role winning this label means the label is not about us.
      if (
        s === 0 ||
        roleScore(role === 'hazard' ? 'pickup' : 'hazard', entry.label) >= s
      )
        continue;
      if (s > bestScore) {
        bestScore = s;
        best = entry.rgb;
      }
    }
    chosen[role] = best ?? undefined;
  }
  const taken = new Set(
    MARKER_ROLES.map((r) => chosen[r])
      .filter(Boolean)
      .map((c) => (c as RGB).join(',')),
  );
  // Two roles must never end up the same colour: a marking that cannot be told
  // from another marking carries no information at all.
  const fallback = (rank: (c: RGB) => number): RGB => {
    const free = pool.filter((c) => !taken.has(c.join(',')));
    const from = free.length ? free : pool;
    const pick = from.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    taken.add(pick.join(','));
    return pick;
  };
  const hazard = chosen.hazard ?? fallback(warmth);
  return { hazard, pickup: chosen.pickup ?? fallback(greenness) };
}

export interface MarkerTileSpec {
  size: number;
  role: MarkerRole;
  /** The palette colour this role owns - see {@link markerColors}. */
  color: RGB;
  lit: RGB;
  shade: RGB;
  seed: number;
  /** 0..1 - how much of the paint has been scuffed off the floor. */
  wear: number;
}

export interface MarkerOverlay {
  /** size*size*3 - the paint's colour at each pixel. */
  rgb: Uint8Array;
  /** size*size - how much paint covers each pixel, 0 outside the marking. */
  alpha: Float64Array;
}

/**
 * A marking painted ON the floor rather than a different floor.
 *
 * It is inset from the tile edge and never tiles with itself, which is what
 * separates it from terrain: a player reads a full-bleed pattern as "this is
 * what the ground is made of" and an inset shape with a border as "someone
 * painted this here on purpose". The paint is then scuffed by the same noise
 * the material uses, so it sits in the surface instead of floating over it.
 */
export function renderMarkerOverlay(spec: MarkerTileSpec): MarkerOverlay {
  const T = spec.size;
  const rgb = new Uint8Array(T * T * 3);
  const alpha = new Float64Array(T * T);

  const wear = clamp01(spec.wear);
  const scuff = fbm(T, spec.seed + 617, [8, 24], [0.6, 0.4]);
  const inset = Math.max(2, Math.round(T * 0.09));
  const stroke = Math.max(2, Math.round(T * 0.075));
  const bright = mixRgb(spec.color, spec.lit, 0.12);
  const dark = mixRgb(spec.shade, spec.color, 0.2);
  const lo = inset;
  const hi = T - 1 - inset;
  const cx = (T - 1) / 2;
  const cy = (T - 1) / 2;
  const rOuter = (T / 2 - inset) * 0.98;
  const rInner = rOuter - stroke;
  const rDot = Math.max(1.5, T * 0.11);
  // Stripe pitch: wide enough to survive a 48px tile, narrow enough that a
  // 64px tile carries more than one full cycle.
  const pitch = Math.max(5, Math.round(T / 6));

  const put = (k: number, c: RGB, a: number): void => {
    if (a <= 0) return;
    alpha[k] = clamp01(a);
    rgb[k * 3] = c[0];
    rgb[k * 3 + 1] = c[1];
    rgb[k * 3 + 2] = c[2];
  };

  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const k = y * T + x;
      // Paint flakes off where the surface noise peaks - the same field the
      // material's own wear uses, so the two agree about where traffic runs.
      const chipped = 1 - wear * clamp01((scuff[k] - 0.6) / 0.4) * 0.85;
      if (spec.role === 'hazard') {
        if (x < lo || x > hi || y < lo || y > hi) continue;
        const onBorder =
          x < lo + stroke ||
          x > hi - stroke ||
          y < lo + stroke ||
          y > hi - stroke;
        if (onBorder) {
          put(k, dark, 0.9 * chipped);
          continue;
        }
        // Diagonal bands: the one warning language every player already reads.
        const band = ((x + y) % pitch) / pitch;
        put(k, band < 0.5 ? bright : dark, 0.92 * chipped);
      } else {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rDot) {
          put(k, bright, 0.94 * chipped * clamp01(rDot + 0.5 - d));
        } else if (d <= rOuter && d >= rInner) {
          const edge = Math.min(rOuter + 0.5 - d, d - rInner + 0.5);
          put(k, bright, 0.92 * chipped * clamp01(edge));
        } else if (d < rInner) {
          // A faint wash inside the ring marks the whole cell, not just its rim.
          put(k, mixRgb(spec.color, spec.shade, 0.35), 0.22 * chipped);
        }
      }
    }
  }

  return { rgb, alpha };
}
