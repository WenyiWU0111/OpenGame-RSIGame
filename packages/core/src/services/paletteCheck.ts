/**
 * Palette conformance — does a generated asset actually use the colours the
 * game's art style guide declared?
 *
 * The art style guide (`docs/art_style.md`, written in Phase 2 before any asset
 * exists) is the game's colour contract. Prompts carry that contract to the
 * image model, but nothing enforced it: an asset could come back on a totally
 * different palette and the pipeline would happily ship it, which is most of
 * why a generated game's assets read as N separately-imagined pictures rather
 * than one art direction.
 *
 * This module measures the drift. It is deliberately forgiving — shading,
 * gradients and antialiasing legitimately produce colours that are NEAR a
 * palette entry without matching it, so the score is a distance-weighted,
 * area-weighted agreement rather than an exact-match count.
 *
 * Not a gate: a low score triggers ONE regeneration with the offending
 * colours named, and the better of the two is kept. Art is judged by the
 * vision judge (D4), not by this number; this only catches gross drift.
 */
import sharp from 'sharp';

export interface PaletteReport {
  /**
   * 0..1 — fraction of the DECLARED palette that actually shows up in the
   * image with meaningful area. This is the headline score; see checkPalette
   * for why coverage rather than per-pixel agreement.
   */
  conformance: number;
  /** Area-weighted nearest-distance agreement. Informational; see checkPalette. */
  areaAgreement: number;
  /** Dominant colours that sit far from every palette entry, worst first. */
  offPalette: string[];
  /** Fraction of the image that was transparent enough to ignore. */
  transparentFraction: number;
  /** False when there was nothing to measure (no palette, empty image). */
  measured: boolean;
}

/**
 * Below this, an asset is regenerated once.
 *
 * CALIBRATION (measured, not guessed): scoring Tick-Tock Torch's 11 shipped
 * assets gives coverage 0.40 against a palette drawn from its own moonlit-brass
 * mood and 0.00 against a deliberately wrong pastel palette — so the metric
 * separates "used this game's colours" from "ignored them" cleanly. A second
 * dark game (Luma and the Owlmoon) scores 0.32 against Tick-Tock's palette,
 * which is the honest overlap between two dark fantasy palettes and not
 * something this check should try to resolve.
 *
 * 0.25 therefore means "barely any declared colour is present" — a real
 * failure — while leaving normal shaded art well clear. Provisional: calibrated
 * on two games, revisit once a corpus exists.
 */
export const PALETTE_CONFORMANCE_FLOOR = 0.25;

const ALPHA_FLOOR = 32; // pixels below this alpha carry no colour information
const SAMPLE_EDGE = 96; // downscale before quantising; plenty for dominant colours
const TOP_COLOURS = 8;
/** A palette colour counts as present when at least this share of the art is near it. */
const MIN_PRESENCE = 0.02;

export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/**
 * Perceptual-ish distance in 0..1. Plain RGB euclidean over-weights blue and
 * under-weights green relative to how people actually see, so this uses the
 * common luminance-weighted approximation — good enough to tell "same colour,
 * shaded" from "wrong colour", which is the only distinction we need.
 */
function colorDistance(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const rMean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  const d = Math.sqrt(
    (2 + rMean / 256) * dr * dr +
      4 * dg * dg +
      (2 + (255 - rMean) / 256) * db * db,
  );
  return Math.min(1, d / 764.83); // 764.83 = distance between pure black and white
}

/**
 * Dominant colours of an image, as [hex, areaFraction] pairs, ignoring
 * near-transparent pixels (a background-removed sprite is mostly alpha and
 * must not be scored on it).
 */
export async function dominantColors(input: Buffer): Promise<{
  colors: Array<{ rgb: [number, number, number]; weight: number }>;
  transparentFraction: number;
}> {
  const { data, info } = await sharp(input)
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const total = info.width * info.height;
  // Coarse 5-bit-per-channel buckets: merges antialiasing noise, keeps hues apart.
  const buckets = new Map<
    number,
    { r: number; g: number; b: number; n: number }
  >();
  let opaque = 0;

  for (let i = 0; i < data.length; i += channels) {
    const alpha = channels === 4 ? data[i + 3] : 255;
    if (alpha < ALPHA_FLOOR) continue;
    opaque++;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const slot = buckets.get(key);
    if (slot) {
      slot.r += r;
      slot.g += g;
      slot.b += b;
      slot.n++;
    } else {
      buckets.set(key, { r, g, b, n: 1 });
    }
  }

  const transparentFraction = total > 0 ? 1 - opaque / total : 1;
  if (opaque === 0) return { colors: [], transparentFraction };

  const colors = [...buckets.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, TOP_COLOURS)
    .map((s) => ({
      rgb: [s.r / s.n, s.g / s.n, s.b / s.n] as [number, number, number],
      weight: s.n / opaque,
    }));
  return { colors, transparentFraction };
}

/**
 * Score an image against a declared palette.
 *
 * The headline number is COVERAGE: of the palette colours the art style guide
 * declared, how many actually appear in this image with meaningful area?
 *
 * The obvious alternative — area-weighted "how near is every pixel to the
 * palette" — was tried first and measured badly. Illustrated art is mostly
 * shading and gradient, so on real assets it compressed everything into
 * 0.09–0.24 whether the palette was right or wrong, which would have fired a
 * regeneration on every asset. Coverage asks the question we actually care
 * about ("did this asset use the game's colours?") and survives the shading
 * that fills the rest of the frame. The area figure is still returned as
 * `areaAgreement` because it is informative, just not decidable.
 *
 * `tolerance` 0.16 is measured, not guessed — see PALETTE_CONFORMANCE_FLOOR.
 * Wider tolerances erode the separation between a game's own palette and an
 * unrelated one.
 */
export async function checkPalette(
  input: Buffer,
  paletteHex: string[],
  tolerance = 0.16,
): Promise<PaletteReport> {
  const empty = (transparentFraction: number): PaletteReport => ({
    conformance: 1,
    areaAgreement: 1,
    offPalette: [],
    transparentFraction,
    measured: false,
  });

  const palette = paletteHex
    .map(parseHexColor)
    .filter((c): c is [number, number, number] => c !== null);
  if (palette.length === 0) return empty(0);

  const { colors, transparentFraction } = await dominantColors(input);
  if (colors.length === 0) return empty(transparentFraction);

  // Coverage: how much of the declared palette is really on screen.
  let present = 0;
  for (const p of palette) {
    let area = 0;
    for (const { rgb, weight } of colors) {
      if (colorDistance(rgb, p) <= tolerance) area += weight;
    }
    if (area >= MIN_PRESENCE) present++;
  }

  // Area agreement + offenders: which dominant colours sit far from everything.
  let agreement = 0;
  const offenders: Array<{ hex: string; weight: number }> = [];
  for (const { rgb, weight } of colors) {
    let nearest = 1;
    for (const p of palette) nearest = Math.min(nearest, colorDistance(rgb, p));
    const credit =
      nearest <= tolerance
        ? 1
        : Math.max(0, 1 - (nearest - tolerance) / (2 * tolerance));
    agreement += weight * credit;
    if (credit < 0.5) offenders.push({ hex: toHex(rgb), weight });
  }

  return {
    conformance: present / palette.length,
    areaAgreement: Math.max(0, Math.min(1, agreement)),
    offPalette: offenders.sort((a, b) => b.weight - a.weight).map((o) => o.hex),
    transparentFraction,
    measured: true,
  };
}
