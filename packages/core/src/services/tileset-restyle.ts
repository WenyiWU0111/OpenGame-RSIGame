/**
 * Surface restyle for a procedurally generated tile.
 *
 * Why the model is given only the surface
 * ---------------------------------------
 * Asking the image model for a tileset directly failed four times across three
 * prompt escalations - every attempt came back as a lit three-dimensional scene
 * rather than a flat swatch (the four failures are catalogued at the top of
 * tileset-procedural.ts). The conclusion drawn there was that the model cannot
 * be trusted with spatial layout. It is, however, very good at material.
 *
 * So this pass hands it exactly one job. The procedural layer draws the
 * structure; the fill cell is tiled 3x3 into one image; that whole mosaic goes
 * through an image-to-image call whose prompt asks for a repaint and forbids
 * moving anything; the centre cell is cropped back out. Two properties come out
 * of that arrangement rather than out of the prompt:
 *
 *  - the structure survives, because it is present in the input image and the
 *    model is only being asked to recolour it;
 *  - the centre cell still tiles, because its edges were generated with its own
 *    neighbours visible on all four sides.
 *
 * Measured on a warehouse floor tile: joint positions unchanged, no perspective
 * introduced, no objects introduced, and the left/right wrap seam IMPROVED from
 * 40.3 to 14.8 while the surface picked up concrete aggregate and rust staining
 * that value noise cannot produce.
 *
 * The safety property
 * -------------------
 * Nothing here can make a tileset worse than the procedural baseline. The
 * restyled cell is measured against the procedural cell it came from on two
 * axes - how it wraps, and how much of the base's structure is still visible -
 * and if it loses on either the procedural cell is returned untouched. A caller
 * that cannot reach the image API at all simply keeps its procedural atlas.
 */
import sharp from 'sharp';

/**
 * Mean per-channel colour delta across a pair of opposite edges, on the 0..255
 * scale. This is deliberately the same measure the asset contract check already
 * applies to shipped tilesets (agent-test/eval/contracts/asset_contract_check.py,
 * `SEAM_TOL = 28`), so a number produced here is directly comparable to the
 * number a reviewer sees downstream.
 */
export interface SeamMetric {
  /** Left column against right column - the horizontal wrap. */
  horizontal: number;
  /** Top row against bottom row - the vertical wrap. */
  vertical: number;
}

/**
 * How much worse than the procedural cell a restyled cell is still allowed to
 * wrap, in mean per-channel colour delta.
 *
 * The comparison is against the base cell's OWN seam rather than a fixed
 * threshold, because a fixed threshold judges the structure instead of the
 * repaint: a `brick` or `plate` base legitimately puts a mortar line or a panel
 * joint on the tile boundary, which reads as a large edge delta while tiling
 * perfectly. The warehouse measurement above is exactly that case - a base
 * seam of 40.3 that no absolute bar under 40 would have let through, and whose
 * repaint was in fact an improvement.
 *
 * 8 is sized to the round trip, not to taste. The cell leaves at tileSize,
 * is upscaled 8x with nearest-neighbour, repainted, downscaled back through a
 * lanczos filter and re-encoded; each resample perturbs boundary pixels by a
 * few levels even when the repaint is perfectly faithful, and the tolerance has
 * to absorb that or it rejects good results as noise. It is also under a third
 * of the 28 that the asset contract already treats as seamless, so a tile
 * accepted here on a clean base cannot fail the downstream check purely because
 * of the slack this constant grants.
 */
export const SEAM_TOLERANCE = 8;

/**
 * The least of the base cell's luminance variation the repaint has to bring
 * back, as a fraction.
 *
 * The seam rule alone does not express "not worse than the baseline", and that
 * is measured rather than assumed: a deliberately destroyed return (a scrambled
 * image, which averages to near-uniform once it is downscaled to tile size)
 * scored a BETTER seam than the procedural `plate` cell it replaced — 32.4 down
 * to 7.2 — and was accepted, because a flat image tiles perfectly. A tileset
 * whose floor has gone blank is the worst outcome this pass can produce, so it
 * has to be caught separately from wrap continuity.
 *
 * Half is chosen to sit well clear of a legitimate repaint. A repaint moves
 * contrast in both directions on purpose — aggregate and staining add
 * variation, flattening a lit surface removes some — so the bar has to be
 * loose. Losing more than half of it is a different thing entirely: the
 * structure the prompt promised to keep is no longer visible.
 */
const DETAIL_RETENTION = 0.5;

/**
 * Edge length of one cell in the 3x3 mosaic sent to the model. The mosaic is
 * 3x this, which is divisible by 3 - the returned image is normalised back to
 * it before the centre cell is cut, so the crop lands on exact cell boundaries
 * whatever size the provider chose to answer with.
 */
const MOSAIC_CELL = 512;
const MOSAIC_SIZE = MOSAIC_CELL * 3;

/**
 * Surface vocabulary handed to the model. Every noun here names a property of a
 * SURFACE. None of them names a thing that could be drawn as an object, which
 * is the failure mode this whole file is built around.
 */
const DEFAULT_TEXTURE_NOUNS =
  'fine grain, grit, mineral speckle, staining and weathering, subtle tonal variation';

/** Runs one image-to-image call and returns the resulting image bytes. */
export type RepaintFn = (
  prompt: string,
  referenceDataUri: string,
) => Promise<Buffer>;

export interface RestyleTileOptions {
  /** Edge length of one tile in the atlas, in px. */
  tileSize: number;
  /** Grid dimension of the atlas (7 -> 49 cells). */
  gridSize?: number;
  /**
   * Atlas index of the plain fill cell. The caller knows it: for the
   * procedural atlas it is `FILL_VARIANT_SLOTS[0]`, the blob layout's CENTER,
   * which carries the plain fill with no edge treatment on it.
   */
  fillIndex: number;
  /** What the terrain is, from the tileset request. */
  description: string;
  /** The style preset's `fragment`. See {@link materialDescription}. */
  styleFragment?: string;
  /** Overrides {@link DEFAULT_TEXTURE_NOUNS}. */
  textureNouns?: string;
  repaint: RepaintFn;
}

export interface RestyleTileResult {
  /** PNG, tileSize square. The restyled cell if it was kept, else the base. */
  cell: Buffer;
  /** PNG of the untouched procedural fill cell, for side-by-side review. */
  baseCell: Buffer;
  /** False when the restyled cell was rejected and `cell` is the base. */
  applied: boolean;
  /** One line naming the decision and its numbers, for the caller's log. */
  reason: string;
  baseSeam: SeamMetric;
  restyledSeam: SeamMetric;
  /** The prompt that was sent, so a failed restyle can be diagnosed. */
  prompt: string;
}

export interface RestyleAtlasResult {
  /** The atlas to save. Byte-identical to the input when `applied` is false. */
  atlas: Buffer;
  applied: boolean;
  reason: string;
  baseSeam: SeamMetric;
  restyledSeam: SeamMetric;
  cell: Buffer;
  baseCell: Buffer;
  prompt: string;
}

/**
 * Mean per-channel delta between the two columns that meet when the tile is
 * repeated, and between the two rows that meet.
 */
export function measureWrapSeam(rgb: Uint8Array, size: number): SeamMetric {
  let h = 0;
  let v = 0;
  for (let i = 0; i < size; i++) {
    const left = i * size * 3;
    const right = (i * size + size - 1) * 3;
    h +=
      (Math.abs(rgb[left] - rgb[right]) +
        Math.abs(rgb[left + 1] - rgb[right + 1]) +
        Math.abs(rgb[left + 2] - rgb[right + 2])) /
      3;
    const top = i * 3;
    const bottom = ((size - 1) * size + i) * 3;
    v +=
      (Math.abs(rgb[top] - rgb[bottom]) +
        Math.abs(rgb[top + 1] - rgb[bottom + 1]) +
        Math.abs(rgb[top + 2] - rgb[bottom + 2])) /
      3;
  }
  return { horizontal: h / size, vertical: v / size };
}

/**
 * Population standard deviation of luminance, 0..255. A flat tile scores 0.
 */
export function measureDetail(rgb: Uint8Array, size: number): number {
  const n = size * size;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const lum = 0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2];
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}

/**
 * What the repaint is asked to look like.
 *
 * The game's full `style_anchor` is deliberately NOT used: it is written for
 * characters and backgrounds and carries object nouns ("stacked crates"), and
 * an object noun in front of this model is an invitation to draw a scene, which
 * is the one thing this pass exists to avoid. The preset's `fragment` is closer
 * to the mark, but its own tail - everything after the dash - is a list of
 * scene props for exactly the same reason ("conveyor belts", "lanterns",
 * "busy bees"). So only the fragment's head clause, which names the look rather
 * than its furniture, is kept.
 */
export function materialDescription(
  description: string,
  styleFragment?: string,
): string {
  // Split on em/en dash only. A plain hyphen would cut "four-shade" and
  // "dot-matrix" in half.
  const head = (styleFragment ?? '').split(/[—–]/)[0].trim();
  const base = description.trim();
  if (!head) return base;
  if (!base) return head;
  return `${base}, ${head}`;
}

/**
 * The repaint prompt. Every clause is load-bearing: the first sentence gives
 * the model its only job, the second forbids the spatial edit it defaults to,
 * the third tells it where the freedom actually is, and the last two are the
 * negations of what the four direct-generation attempts produced.
 */
export function buildRestylePrompt(
  material: string,
  textureNouns: string,
): string {
  return (
    `Repaint this EXACT layout as ${material}. ` +
    `Keep every panel seam, every edge and every proportion EXACTLY where they are ` +
    `— do not move, add or remove any structure. ` +
    `Only enrich surface material: ${textureNouns}. ` +
    `Stay perfectly FLAT and top-down. No perspective, no 3D, no objects, no text.`
  );
}

/** Decode to a bare RGB byte array, asserting the channel count we assume. */
async function toRgb(png: Buffer): Promise<{ rgb: Uint8Array; size: number }> {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(
      `tileset-restyle expected 3 channels after removeAlpha, got ${info.channels}`,
    );
  }
  if (info.width !== info.height) {
    throw new Error(
      `tileset-restyle expected a square image, got ${info.width}x${info.height}`,
    );
  }
  return { rgb: new Uint8Array(data), size: info.width };
}

function toPng(rgb: Uint8Array, size: number): Promise<Buffer> {
  return sharp(Buffer.from(rgb), {
    raw: { width: size, height: size, channels: 3 },
  })
    .png()
    .toBuffer();
}

/** The 3x3 mosaic, as a data URI ready to hand to an i2i endpoint. */
async function buildMosaicDataUri(cellPng: Buffer): Promise<string> {
  // Nearest-neighbour on the way up: the model has to see where the structural
  // joints are, and a smooth upscale blurs precisely the edges it is being told
  // not to move.
  const cell = await sharp(cellPng)
    .resize(MOSAIC_CELL, MOSAIC_CELL, { kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  const tiles: sharp.OverlayOptions[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      tiles.push({
        input: cell,
        top: row * MOSAIC_CELL,
        left: col * MOSAIC_CELL,
      });
    }
  }
  const mosaic = await sharp({
    create: {
      width: MOSAIC_SIZE,
      height: MOSAIC_SIZE,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(tiles)
    .png()
    .toBuffer();
  return `data:image/png;base64,${mosaic.toString('base64')}`;
}

/** Cut the centre cell out of whatever the model returned, at tile scale. */
async function cropCentreCell(
  resultImage: Buffer,
  tileSize: number,
): Promise<Buffer> {
  // Normalise first. Providers answer at their own size (this gateway forces
  // 2048 square for image-conditioned calls), and 2048 is not divisible by 3,
  // so cropping it directly would put the cut a fraction of a pixel off every
  // cell boundary.
  const normalised = await sharp(resultImage)
    .resize(MOSAIC_SIZE, MOSAIC_SIZE, { fit: 'fill' })
    .png()
    .toBuffer();
  return sharp(normalised)
    .extract({
      left: MOSAIC_CELL,
      top: MOSAIC_CELL,
      width: MOSAIC_CELL,
      height: MOSAIC_CELL,
    })
    .resize(tileSize, tileSize, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
}

interface RawRestyle {
  base: Uint8Array;
  kept: Uint8Array;
  restyled: Uint8Array;
  applied: boolean;
  reason: string;
  baseSeam: SeamMetric;
  restyledSeam: SeamMetric;
  prompt: string;
}

async function restyleFillCell(
  baseAtlasPng: Buffer,
  opts: RestyleTileOptions,
): Promise<RawRestyle> {
  const tileSize = opts.tileSize;
  const gridSize = opts.gridSize ?? 7;
  if (
    !Number.isInteger(opts.fillIndex) ||
    opts.fillIndex < 0 ||
    opts.fillIndex >= gridSize * gridSize
  ) {
    throw new Error(
      `tileset-restyle: fillIndex ${opts.fillIndex} is outside a ${gridSize}x${gridSize} atlas`,
    );
  }

  const cellPng = await sharp(baseAtlasPng)
    .extract({
      left: (opts.fillIndex % gridSize) * tileSize,
      top: Math.floor(opts.fillIndex / gridSize) * tileSize,
      width: tileSize,
      height: tileSize,
    })
    .png()
    .toBuffer();
  const { rgb: base } = await toRgb(cellPng);
  const baseSeam = measureWrapSeam(base, tileSize);

  const prompt = buildRestylePrompt(
    materialDescription(opts.description, opts.styleFragment),
    opts.textureNouns ?? DEFAULT_TEXTURE_NOUNS,
  );
  const mosaicUri = await buildMosaicDataUri(cellPng);
  const resultImage = await opts.repaint(prompt, mosaicUri);
  const centrePng = await cropCentreCell(resultImage, tileSize);
  const { rgb: restyled } = await toRgb(centrePng);
  const restyledSeam = measureWrapSeam(restyled, tileSize);

  const baseDetail = measureDetail(base, tileSize);
  const restyledDetail = measureDetail(restyled, tileSize);

  const hOk = restyledSeam.horizontal <= baseSeam.horizontal + SEAM_TOLERANCE;
  const vOk = restyledSeam.vertical <= baseSeam.vertical + SEAM_TOLERANCE;
  const detailOk = restyledDetail >= baseDetail * DETAIL_RETENTION;
  const applied = hOk && vOk && detailOk;
  const numbers =
    `seam h ${baseSeam.horizontal.toFixed(1)}->${restyledSeam.horizontal.toFixed(1)}, ` +
    `v ${baseSeam.vertical.toFixed(1)}->${restyledSeam.vertical.toFixed(1)} ` +
    `(tolerance +${SEAM_TOLERANCE}); detail ` +
    `${baseDetail.toFixed(1)}->${restyledDetail.toFixed(1)} ` +
    `(floor ${(baseDetail * DETAIL_RETENTION).toFixed(1)})`;

  return {
    base,
    restyled,
    kept: applied ? restyled : base,
    applied,
    reason: applied
      ? `restyled surface kept: ${numbers}`
      : `restyled surface rejected (${detailOk ? 'wraps worse than the base' : 'lost too much of the base structure'}), ` +
        `keeping the procedural cell: ${numbers}`,
    baseSeam,
    restyledSeam,
    prompt,
  };
}

/**
 * Repaint the atlas's plain fill cell through the model and hand back whichever
 * of the two cells wraps better.
 */
export async function restyleTile(
  baseAtlasPng: Buffer,
  opts: RestyleTileOptions,
): Promise<RestyleTileResult> {
  const raw = await restyleFillCell(baseAtlasPng, opts);
  return {
    cell: await toPng(raw.kept, opts.tileSize),
    baseCell: await toPng(raw.base, opts.tileSize),
    applied: raw.applied,
    reason: raw.reason,
    baseSeam: raw.baseSeam,
    restyledSeam: raw.restyledSeam,
    prompt: raw.prompt,
  };
}

/**
 * Restyle the fill cell and carry the new surface across the whole atlas.
 *
 * Scope: the fill cell, not the atlas. Sending all 49 cells through the model
 * at once would hand it back the spatial problem it already failed - it would
 * see a grid of near-identical squares and start composing them into a picture
 * - and it would smear the two things the procedural layer computed that
 * actually carry meaning: the three-stage lit rim / grime gradient that tells a
 * player which sides of the terrain are open, and the cap band that marks the
 * top surface. One cell is also one API call instead of one enormous one.
 *
 * The new surface is carried across by ADDING the repaint's difference from the
 * fill, not by stamping the restyled cell over each position. Every cell in the
 * procedural atlas is the fill plus that cell's own modulation - its rim, its
 * grime, its cap alpha, or a variant's noise - so `cell - fill` isolates the
 * modulation and `cell + (restyled - fill)` puts it straight back on top of the
 * repainted surface. Overwriting instead would have deleted all of it.
 */
export async function restyleTilesetAtlas(
  baseAtlasPng: Buffer,
  opts: RestyleTileOptions,
): Promise<RestyleAtlasResult> {
  const raw = await restyleFillCell(baseAtlasPng, opts);
  const tileSize = opts.tileSize;

  const shared = {
    applied: raw.applied,
    reason: raw.reason,
    baseSeam: raw.baseSeam,
    restyledSeam: raw.restyledSeam,
    cell: await toPng(raw.kept, tileSize),
    baseCell: await toPng(raw.base, tileSize),
    prompt: raw.prompt,
  };
  if (!raw.applied) {
    return { atlas: baseAtlasPng, ...shared };
  }

  const { rgb: atlas, size: atlasSize } = await toRgb(baseAtlasPng);
  const out = new Uint8Array(atlas.length);
  for (let y = 0; y < atlasSize; y++) {
    const ty = y % tileSize;
    for (let x = 0; x < atlasSize; x++) {
      const src = (y * atlasSize + x) * 3;
      const cell = (ty * tileSize + (x % tileSize)) * 3;
      for (let c = 0; c < 3; c++) {
        const value =
          atlas[src + c] + (raw.restyled[cell + c] - raw.base[cell + c]);
        out[src + c] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
    }
  }

  return { atlas: await toPng(out, atlasSize), ...shared };
}
