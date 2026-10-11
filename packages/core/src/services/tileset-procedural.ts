/**
 * Procedural tileset generation - no image model involved.
 *
 * Why the model was taken out of this loop entirely
 * -------------------------------------------------
 * Four attempts were made to get a tileable terrain atlas out of the image model,
 * each with a stronger prompt than the last. Every one came back as a picture of
 * a place, rendered with volume and a light direction:
 *
 *   mine      -> isometric platforms floating on black; 69% of the centre tile's
 *                border ring was empty
 *   glacier    -> a photo of a finished brick wall, every cell framed and guttered
 *   warehouse  -> an entire top-down room, its perimeter crates tiled as terrain
 *   glacier #2 -> after "FLAT ORTHOGRAPHIC, ZERO perspective, no isometric": a
 *                single ice brick with a lit top face and a shaded side face,
 *                stamped 49 times. Edges matched numerically; the surface could
 *                never be continuous because every copy implies the same camera.
 *
 * The last one is the instructive failure. Seam matching passed, and three
 * different automated checks (border darkness, edge mismatch, gradient coherence)
 * all called it acceptable - a person spotted it instantly. "brick" and "stone"
 * in the model's training distribution ARE lit three-dimensional renders, so no
 * amount of prompt negation gets a flat swatch reliably.
 *
 * Tileability is fully decidable, so it belongs to code. Terrain material at
 * 48-64px is texture, and texture is something a few lines of noise do exactly
 * right and a diffusion model does not. What is NOT decidable - which colours
 * this game should use - stays with the art direction: the palette is read from
 * the game's own docs/art_style.md.
 *
 * Seamlessness here is structural, not repaired after the fact: the value-noise
 * lattice wraps, so opposite edges are continuous by construction.
 *
 * What this file does and does not own
 * ------------------------------------
 * Material - the surface of one tile, its structural motif, its wear, its cap -
 * lives in tileset-texture.ts. This file owns the atlas: which of the 49 blob
 * cells gets which tile, which cells carry a fill variant, and how a cell's
 * exposed sides are lit. The split matters because the material half is pure
 * and testable on its own, while the layout half is tied to the blob
 * convention that TilesetProcessor and the AutoTiler already agree on.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import { TILE_STRUCTURES, TILE_CAPS } from '../data/style-presets.js';
import type { TileStructure, TileCap } from '../data/style-presets.js';
import {
  classifyMarkerRole,
  hexToRgb,
  markerColors,
  MARKER_ROLES,
  renderCapBand,
  renderMarkerOverlay,
  renderMaterialTile,
  type LabeledColor,
  type MarkerRole,
  type RGB,
} from './tileset-texture.js';

export { classifyMarkerRole, MARKER_ROLES } from './tileset-texture.js';
export type { MarkerRole } from './tileset-texture.js';

const DEFAULT_PALETTE = ['#0B1017', '#1E2A36', '#46586A', '#8FA6B8'];
const DEFAULT_LIT = '#E8D3A8';

/**
 * Pull the declared colours out of docs/art_style.md. That file is the game's
 * stated colour contract and is already what paletteCheck scores assets against,
 * so terrain generated from it is coherent with everything else by construction.
 */
export async function readArtStylePalette(gameRoot: string): Promise<{
  ramp: RGB[];
  lit: RGB;
  shade: RGB;
  all: RGB[];
  labeled: LabeledColor[];
}> {
  let hexes: string[] = [];
  let labeled: LabeledColor[] = [];
  try {
    const txt = await fs.readFile(
      path.join(gameRoot, 'docs', 'art_style.md'),
      'utf-8',
    );
    hexes = [...txt.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
    // The line a colour is declared on is the game's own statement of what that
    // colour is FOR ("hazard warning red", "health pickup"). Keeping the prose
    // next to the hex is what lets a marker be painted in the colour this game
    // already reserved for danger instead of in a hardcoded warning yellow.
    for (const line of txt.split('\n')) {
      for (const m of line.matchAll(/#[0-9a-fA-F]{6}/g)) {
        labeled.push({ rgb: hexToRgb(m[0]), label: line });
      }
    }
  } catch {
    /* fall through to the neutral default */
  }
  if (hexes.length < 4) {
    hexes = DEFAULT_PALETTE.concat(DEFAULT_LIT);
    labeled = [];
  }

  const rgb = hexes.map(hexToRgb);
  const lum = (c: RGB): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const byLum = [...rgb].sort((a, b) => lum(a) - lum(b));

  // A colour the art guide reserved for a ROLE must not become terrain.
  // Luminance alone treats every declared colour as a candidate ground tone, and
  // a saturated accent sits mid-range by construction - a mid-red is simply
  // mid-bright - so the accent lands on the median far more often than chance.
  // Observed: a frozen-tundra game declared "#D84F6A red scarf accent and danger
  // feedback", it fell exactly on the median of seven colours, and every ice
  // cliff rendered crimson. Worse, renderMarkerOverlay picks its hazard colour
  // from the same prose, so the danger stripe and the floor came out identical.
  // One word list, one answer: a colour that names a role is not ground.
  const neutral = labeled
    .filter((l) => classifyMarkerRole(l.label) === null)
    .map((l) => l.rgb);
  // Fall back to the full set rather than shade with too few tones: a plain ramp
  // merely looks flat, an under-filled one renders broken.
  const rampPool = [...(neutral.length >= 4 ? neutral : rgb)].sort(
    (a, b) => lum(a) - lum(b),
  );
  // Terrain reads from the darker end; the brightest entry becomes the lit rim so
  // walkable surfaces stay legible against whatever the background turned out to
  // be. Hold it back only while four tones still remain to choose from.
  const spread = rampPool.length > 4 ? rampPool.slice(0, -1) : rampPool;
  // Evenly spaced, not the former [0, 1, median, length-2]: those fixed indices
  // collide on a small pool - at four entries median === length-2, so the ramp
  // repeated one tone and never reached its light end.
  const ramp = [0, 1, 2, 3].map(
    (i) => spread[Math.round((i * (spread.length - 1)) / 3)] as RGB,
  );
  // `all` keeps every declared colour, not just the four the terrain ramp uses:
  // a cap needs to reach for the palette's green or its rust, which are exactly
  // the entries a luminance-sorted terrain ramp throws away.
  return {
    ramp,
    lit: byLum[byLum.length - 1],
    shade: byLum[0],
    all: rgb,
    labeled,
  };
}

/** Which sides of a cell face open space. Mirrors TilesetProcessor's blob layout. */
function exposureFor(i: number): string {
  if (i === 0) return 'TL';
  if (i === 6) return 'TR';
  if (i === 42) return 'BL';
  if (i === 48) return 'BR';
  if ([1, 2, 3, 4, 5].includes(i)) return 'T';
  if ([43, 44, 45, 46, 47].includes(i)) return 'B';
  if ([7, 14, 21, 28, 35].includes(i)) return 'L';
  if ([13, 20, 27, 34, 41].includes(i)) return 'R';
  if (i === 33) return 'tl';
  if (i === 34) return 'tr';
  if (i === 40) return 'bl';
  if (i === 41) return 'br';
  return '';
}

/**
 * Atlas indices that carry a distinct fill variant, most canonical first.
 *
 * 17 and 24 are the blob layout's own CENTER and CENTER_ALT. The rest are
 * indices the layout never assigns, so a variant placed there is invisible to
 * the AutoTiler and only appears where a tilemap deliberately asks for it.
 *
 * This list is exported because the tilemap generator has to know which grid
 * ids it may scatter into a floor. A hand-copied list in two places is exactly
 * the class of drift this module exists to remove - the asset protocol
 * documented 3x3/192px tilesets for months while the code emitted 7x7/448px,
 * because the document and the generator were independent sources of truth.
 */
export const FILL_VARIANT_SLOTS: readonly number[] = [17, 24, 30, 31, 16, 18];

/** Lowest and highest number of fill variants the generator will emit. */
export const MIN_FILL_VARIANTS = 2;
export const MAX_FILL_VARIANTS = 6;

/**
 * The atlas indices that actually carry a variant for a given variant count.
 * Callers should use this rather than slicing {@link FILL_VARIANT_SLOTS}
 * themselves, so the clamping rule lives in one place.
 */
export function fillVariantIndices(count = 4): number[] {
  const n = Math.max(
    MIN_FILL_VARIANTS,
    Math.min(MAX_FILL_VARIANTS, Math.round(count)),
  );
  return FILL_VARIANT_SLOTS.slice(0, n);
}

/**
 * Atlas indices that carry a marker tile, one per marker role.
 *
 * 37 and 38 are interior cells of the 7x7 blob layout: the AutoTiler never
 * emits them (it only ever emits 0, 3, 6, 17, 21, 27, 33, 34, 40, 41, 42, 45
 * and 48) and {@link FILL_VARIANT_SLOTS} does not claim them, so a marker can
 * only ever appear where a tilemap deliberately painted one. 36 and 39 are left
 * free next to them for whatever role is needed next.
 *
 * A marker is signage, and signage that nothing in the game means is worse than
 * no signage at all - it competes with the warnings that ARE load-bearing. So
 * the only caller allowed to place these is the tilemap generator, and only at
 * coordinates the game itself declared.
 */
export const MARKER_SLOTS: Readonly<Record<MarkerRole, number>> = {
  // 23 and 25 are two of the seven cells the blob layout does not claim. They
  // were 37 and 38, which are T_BOTTOM terrain tiles: painting a marker there
  // replaced a shape the AutoTiler selects, so maps that asked for a bottom
  // T-junction rendered a hazard stripe as ground. Observed in every game
  // generated after markers landed - 6 to 8 references per level.
  hazard: 23,
  pickup: 25,
};

/**
 * The atlas index carrying each marker role. Callers should use this rather
 * than the constant, for the same reason {@link fillVariantIndices} exists: the
 * tilemap generator and the atlas producer must never hold separate copies of
 * a grid id.
 */
export function markerTileIndices(): Record<MarkerRole, number> {
  return { ...MARKER_SLOTS };
}

export interface ProceduralTilesetOptions {
  tileSize: number;
  gridSize?: number;
  /** Stable per-game seed so regenerating a game reproduces its terrain. */
  seed?: number;
  /** 0 = soft cloudy stone, 1 = cracked and bedded. */
  ridgeMix?: number;
  /** Structural motif for the tile body. Unknown values fall back to `grain`. */
  structure?: TileStructure;
  /** A band of different material along the top edge of terrain. */
  cap?: TileCap;
  /** 0..1 - how much staining, scratching and scatter the richness layer adds. */
  wear?: number;
  /** How many distinct fill variants to emit, clamped to 2..6. */
  variants?: number;
  /**
   * Which role markers to paint into the atlas. Empty by default: a marker is a
   * painted warning, so a game with no tile-based hazards should not carry one.
   * The caller knows which it needs - it wrote the design before it asked for
   * assets - and the tilemap only paints a marker where the game data declares
   * one, so a role listed here but never declared just leaves an unused cell.
   */
  markers?: readonly MarkerRole[];
}

const DEFAULT_STRUCTURE: TileStructure = 'grain';
const DEFAULT_CAP: TileCap = 'none';
const DEFAULT_WEAR = 0.4;
const DEFAULT_VARIANTS = 4;

const KNOWN_STRUCTURES = new Set<string>(TILE_STRUCTURES);
const KNOWN_CAPS = new Set<string>(TILE_CAPS);

export async function generateProceduralTileset(
  gameRoot: string,
  opts: ProceduralTilesetOptions,
): Promise<Buffer> {
  const T = opts.tileSize;
  const G = opts.gridSize ?? 7;
  const seed = opts.seed ?? 1234;
  const ridgeMix = opts.ridgeMix ?? 0.3;
  // A bad style value must never stop an asset from being generated, so
  // anything unrecognised silently degrades to the neutral default.
  const structure: TileStructure =
    opts.structure && KNOWN_STRUCTURES.has(opts.structure)
      ? opts.structure
      : DEFAULT_STRUCTURE;
  const cap: TileCap =
    opts.cap && KNOWN_CAPS.has(opts.cap) ? opts.cap : DEFAULT_CAP;
  const wear = Number.isFinite(opts.wear)
    ? Math.max(0, Math.min(1, opts.wear as number))
    : DEFAULT_WEAR;
  const variantIndices = fillVariantIndices(opts.variants ?? DEFAULT_VARIANTS);

  const { ramp, lit, shade, all, labeled } =
    await readArtStylePalette(gameRoot);

  // One material tile per variant, each with its own noise seed. Variant 0 is
  // the plain fill: every cell that is not a declared variant slot uses it, so
  // the edge cells stay consistent with the bulk of the terrain.
  const tiles = variantIndices.map((_, i) =>
    renderMaterialTile({
      size: T,
      seed: seed + i * 911,
      structure,
      wear,
      ridgeMix,
      ramp,
      lit,
      shade,
    }),
  );
  const byIndex = new Map<number, Uint8Array>();
  variantIndices.forEach((idx, i) => byIndex.set(idx, tiles[i]));
  const plain = tiles[0];

  // The cap is a property of the terrain's top surface rather than of an
  // individual tile, so it is rendered independently of the fill variants. It
  // is rendered three times with different seeds, though: the blob layout
  // treats the five top-edge cells as interchangeable variants, so giving
  // neighbouring ones a different silhouette stops a long ledge from repeating
  // the same fringe every tile.
  // Markers are painted ON the plain fill, in the colours this game's own art
  // guide reserved for danger and for reward. They are composited here rather
  // than rendered as their own material because a marking has to read as paint
  // applied to the floor, not as a different floor.
  const roleColors = markerColors(labeled, all);
  // Only the roles the caller asked for. A marker is a painted warning; a game
  // with no tile-based hazards has nothing to warn about, and an unrequested
  // marker just leaves a red cell sitting in an otherwise clean atlas.
  const wantedRoles = MARKER_ROLES.filter((r) =>
    (opts.markers ?? []).includes(r),
  );
  const markerOverlays = new Map(
    wantedRoles.map((role, i) => [
      MARKER_SLOTS[role],
      renderMarkerOverlay({
        size: T,
        role,
        color: roleColors[role],
        lit,
        shade,
        seed: seed + 5701 + i * 233,
        wear,
      }),
    ]),
  );

  const CAP_BANDS = 3;
  const capBands = Array.from({ length: CAP_BANDS }, (_, i) =>
    renderCapBand({
      size: T,
      cap,
      seed: seed + 3301 + i * 149,
      palette: all,
      lit,
      shade,
      wear,
    }),
  );

  const AW = G * T;
  const atlas = new Uint8Array(AW * AW * 3);
  const mix = (o: number, c: RGB, a: number): void => {
    atlas[o] = Math.round(atlas[o] * (1 - a) + c[0] * a);
    atlas[o + 1] = Math.round(atlas[o + 1] * (1 - a) + c[1] * a);
    atlas[o + 2] = Math.round(atlas[o + 2] * (1 - a) + c[2] * a);
  };

  // Three-stage edge transition: a lit rim where the terrain meets air, then a
  // gradient of grime accumulated against it, then the body. The single bright
  // line this replaces read as a drawn outline; the accumulation is what makes
  // it read as a place where things have settled.
  const rimPx = Math.max(1, Math.round(T / 21));
  const grimeTop = Math.max(2, Math.round((T * 7) / 64));
  const grimeSide = Math.max(2, Math.round((T * 6) / 64));
  const cornerPx = Math.max(4, Math.round(T / 6));

  for (let idx = 0; idx < G * G; idx++) {
    const gx = (idx % G) * T;
    const gy = Math.floor(idx / G) * T;
    const e = exposureFor(idx);
    const base = byIndex.get(idx) ?? plain;
    const topExposed = e.includes('T');
    const capped = topExposed && cap !== 'none';
    const capBand = capBands[idx % CAP_BANDS];
    const marker = markerOverlays.get(idx);

    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const k = y * T + x;
        const s = k * 3;
        const d = ((gy + y) * AW + gx + x) * 3;
        atlas[d] = base[s];
        atlas[d + 1] = base[s + 1];
        atlas[d + 2] = base[s + 2];

        if (marker) {
          const a = marker.alpha[k];
          if (a > 0) {
            mix(d, [marker.rgb[s], marker.rgb[s + 1], marker.rgb[s + 2]], a);
          }
        }

        let capA = 0;
        if (capped) {
          capA = capBand.alpha[k];
          if (capA > 0) {
            mix(
              d,
              [capBand.rgb[s], capBand.rgb[s + 1], capBand.rgb[s + 2]],
              capA,
            );
          }
        }

        if (topExposed) {
          // Under a cap there is no bare lit rim - the cap is the top surface.
          // The grime still fades in as the cap thins out, which is what puts
          // dirt in the contact line instead of a hard edge.
          const open = 1 - capA;
          if (!capped && y < rimPx) mix(d, lit, 0.8);
          else if (y >= rimPx && y < rimPx + grimeTop) {
            mix(d, shade, 0.34 * (1 - (y - rimPx) / grimeTop) * open);
          }
        }
        if (e.includes('B')) {
          if (y >= T - rimPx) mix(d, shade, 0.55);
          else if (y >= T - rimPx - grimeSide) {
            mix(d, shade, 0.26 * (1 - (T - rimPx - y) / grimeSide));
          }
        }
        if (e.includes('L')) {
          if (x < rimPx) mix(d, lit, 0.3);
          else if (x < rimPx + grimeSide)
            mix(d, shade, 0.24 * (1 - (x - rimPx) / grimeSide));
        }
        if (e.includes('R')) {
          if (x >= T - rimPx) mix(d, lit, 0.3);
          else if (x >= T - rimPx - grimeSide) {
            mix(d, shade, 0.24 * (1 - (T - rimPx - x) / grimeSide));
          }
        }

        // Inner corners: the concave meeting of two exposed sides, lifted just
        // enough that the AutoTiler's corner cells do not look like holes.
        if (
          (e === 'tl' && x < cornerPx && y < cornerPx) ||
          (e === 'tr' && x >= T - cornerPx && y < cornerPx) ||
          (e === 'bl' && x < cornerPx && y >= T - cornerPx) ||
          (e === 'br' && x >= T - cornerPx && y >= T - cornerPx)
        ) {
          mix(d, lit, 0.26);
        }
      }
    }
  }

  return sharp(Buffer.from(atlas), {
    raw: { width: AW, height: AW, channels: 3 },
  })
    .png()
    .toBuffer();
}
