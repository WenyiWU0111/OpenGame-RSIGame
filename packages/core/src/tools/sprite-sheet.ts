/**
 * Animations as ONE sprite sheet instead of a chain of per-frame edits.
 *
 * WHY. The per-frame chain asks an image-EDIT call to redraw "the same exact
 * character as reference" for every frame. On the openai-compat provider that
 * call drops the reference image and falls back to plain text-to-image, and
 * the frame prompt carries no description of the character -- so every frame
 * is a fresh, different character. Measured offline: 4/4 per-frame sets
 * inconsistent (VLM, 2 passes each), and in game the zombies changed clothes
 * frame to frame. One image holding all poses keeps them one character:
 * 14/20 consistent, and 0/12 flicker flags against 6/12 in the same game.
 *
 * The sheet is one row of N panels on a white background. It is cut on the
 * white GAPS between poses (the model does not space panels evenly), thin
 * panel dividers are dropped, and every frame is placed on one shared canvas,
 * horizontally centred, keeping its height in the sheet so all frames stand
 * on the same ground line.
 */
import sharp from 'sharp';

const WHITE = 235;
const GAP_INK = 0.012;
const SEARCH = 0.3;

export interface SheetAnimation {
  name: string;
  frameCount: number;
  action_desc: string;
}

export function sheetPrompt(
  description: string,
  styleAnchor: string,
  styleBlock: string,
  anim: SheetAnimation,
): string {
  const n = anim.frameCount;
  return [
    `A sprite sheet for a 2D game: ONE character, ${description}.`,
    styleAnchor ? `Style: ${styleAnchor}.` : '',
    styleBlock,
    `Exactly ${n} frames of its "${anim.name}" animation, laid out in a single horizontal row of ${n} equal-width panels, left to right: ${anim.action_desc}.`,
    `It is the SAME character in every panel: identical design, clothing, colours, proportions, size and art style.`,
    `Any hat, helmet, weapon or other prop it carries is the SAME object with the SAME shape and condition in every panel; only its position follows the pose.`,
    `Each panel is a clearly DIFFERENT key pose of the cycle: arms, legs and body in visibly different positions from one panel to the next, so the frames read as motion when played in a loop. Never repeat the same pose in two panels.`,
    `Every panel shows the full body, centred in its panel, at the same scale, standing on the same ground line, facing the same direction.`,
    `Plain white background, no panel borders, no dividing lines, no text, no numbers, no shadows between panels.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function sheetSize(n: number): string {
  return n <= 2 ? '2560*1440' : n === 3 ? '3072*1280' : '3840*1024';
}

interface Mask {
  w: number;
  h: number;
  ink: Uint8Array;
}

async function inkMask(buf: Buffer): Promise<Mask> {
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ink = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    ink[i] = Math.min(data[p], data[p + 1], data[p + 2]) < WHITE ? 1 : 0;
  }
  return { w, h, ink };
}

function colShare(m: Mask, x0: number, x1: number): Float32Array {
  const out = new Float32Array(x1 - x0);
  for (let x = x0; x < x1; x++) {
    let s = 0;
    for (let y = 0; y < m.h; y++) s += m.ink[y * m.w + x];
    out[x - x0] = s / m.h;
  }
  return out;
}

export function findCuts(
  col: Float32Array,
  n: number,
): { cuts: number[]; fallbacks: number } {
  const W = col.length;
  const pw = W / n;
  const cuts = [0];
  let fallbacks = 0;
  for (let i = 1; i < n; i++) {
    const c = Math.floor(i * pw);
    const lo = Math.max(1, Math.floor(c - SEARCH * pw));
    const hi = Math.min(W - 1, Math.floor(c + SEARCH * pw));
    let best: [number, number] | null = null;
    let run: [number, number] | null = null;
    for (let x = lo; x < hi; x++) {
      if (col[x] < GAP_INK) {
        run = run && run[1] === x - 1 ? [run[0], x] : [x, x];
        if (
          !best ||
          run[1] - run[0] > best[1] - best[0] ||
          (run[1] - run[0] === best[1] - best[0] &&
            Math.abs((run[0] + run[1]) / 2 - c) <
              Math.abs((best[0] + best[1]) / 2 - c))
        ) {
          best = [run[0], run[1]];
        }
      } else {
        run = null;
      }
    }
    if (!best || best[1] - best[0] < 3) {
      cuts.push(c);
      fallbacks++;
    } else {
      cuts.push(Math.floor((best[0] + best[1]) / 2));
    }
  }
  cuts.push(W);
  return { cuts, fallbacks };
}

function contentBox(
  m: Mask,
  x0: number,
  x1: number,
): [number, number, number, number] | null {
  const W = x1 - x0;
  const col = colShare(m, x0, x1);
  const inked = Array.from(col, (v) => v >= GAP_INK);
  const runs: Array<[number, number]> = [];
  for (let x = 0; x < W; ) {
    if (inked[x]) {
      let y = x;
      while (y < W && inked[y]) y++;
      runs.push([x, y]);
      x = y;
    } else x++;
  }
  if (!runs.length) return null;
  const main = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  const keep = runs.filter(
    (r) =>
      r[1] - r[0] >= 0.02 * W ||
      Math.abs(r[0] - main[1]) < 0.03 * W ||
      Math.abs(main[0] - r[1]) < 0.03 * W,
  );
  const left = Math.min(...keep.map((r) => r[0]));
  const right = Math.max(...keep.map((r) => r[1]));
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < m.h; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += m.ink[y * m.w + x];
    if (s / W >= 0.002) {
      if (top < 0) top = y;
      bottom = y + 1;
    }
  }
  if (top < 0) return null;
  return [x0 + left, top, x0 + right, bottom];
}

export interface SlicedSheet {
  frames: Buffer[];
  cuts: number[];
  fallbacks: number;
  empty: number;
}

/** Cut a one-row sheet into `n` PNG frames on a shared white canvas. */
export async function sliceSheet(buf: Buffer, n: number): Promise<SlicedSheet> {
  const m = await inkMask(buf);
  const { cuts, fallbacks } = findCuts(colShare(m, 0, m.w), n);
  const boxes = [];
  for (let i = 0; i < n; i++) boxes.push(contentBox(m, cuts[i], cuts[i + 1]));
  const ok = boxes.filter((b): b is [number, number, number, number] => !!b);
  if (!ok.length) throw new Error('sprite sheet has no content');
  const cw = Math.max(...ok.map((b) => b[2] - b[0]));
  const top = Math.min(...ok.map((b) => b[1]));
  const bot = Math.max(...ok.map((b) => b[3]));
  const pad = Math.floor(0.06 * cw);
  const W = cw + 2 * pad;
  const H = bot - top + 2 * pad;
  const flat = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .png()
    .toBuffer();
  const frames: Buffer[] = [];
  let empty = 0;
  for (const b of boxes) {
    const base = sharp({
      create: { width: W, height: H, channels: 3, background: '#ffffff' },
    });
    if (!b) {
      empty++;
      frames.push(await base.png().toBuffer());
      continue;
    }
    const crop = await sharp(flat)
      .extract({
        left: b[0],
        top: b[1],
        width: b[2] - b[0],
        height: b[3] - b[1],
      })
      .png()
      .toBuffer();
    frames.push(
      await base
        .composite([
          {
            input: crop,
            left: Math.floor((W - (b[2] - b[0])) / 2),
            top: pad + b[1] - top,
          },
        ])
        .png()
        .toBuffer(),
    );
  }
  return { frames, cuts, fallbacks, empty };
}
