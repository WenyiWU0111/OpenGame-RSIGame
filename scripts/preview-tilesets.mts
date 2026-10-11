/**
 * Render tileset previews WITHOUT running the agent.
 *
 * Why this exists
 * ---------------
 * Judging a tile change used to cost a full generation run - roughly ninety
 * minutes of agent, build and smoke - to look at one 448x448 PNG at the end.
 * Everything that decides how a tile LOOKS (structure, cap, wear, variants,
 * decoration, the palette ramp) is pure code reachable without a model call, so
 * the visual half can be inspected in seconds and the loop only has to run when
 * the question is actually about the agent.
 *
 * Two views per preset, because they fail differently:
 *   atlas  - all 49 blob cells, shows caps, corners, variants and markers
 *   tiled  - the centre fill repeated 3x3, which is the ONLY view where a wrap
 *            seam is visible; a seam is invisible in a single tile by definition
 *
 * Usage
 *   tsx scripts/preview-tilesets.mts --structures
 *   tsx scripts/preview-tilesets.mts --all --out /tmp/all.png
 *   tsx scripts/preview-tilesets.mts --presets "Frozen Tundra,Cyberpunk"
 *   tsx scripts/preview-tilesets.mts --structures --palette output_batch/<game>
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  STYLE_PRESETS,
  TILE_CAPS,
  TILE_STRUCTURES,
} from '../packages/core/src/data/style-presets.js';
import type { StylePreset } from '../packages/core/src/data/style-presets.js';
import {
  FILL_VARIANT_SLOTS,
  generateProceduralTileset,
} from '../packages/core/src/services/tileset-procedural.js';
import { restyleTilesetAtlas } from '../packages/core/src/services/tileset-restyle.js';
import { createModelRouter } from '../packages/core/src/services/assetModelRouter.js';
import { measureWrapSeam } from '../packages/core/src/services/tileset-restyle.js';

/** Must match TILESET_RESTYLE_SIZE in generate-assets.ts. */
const RESTYLE_SIZE = '2048x2048';

/**
 * The restyle stage calls the image-edit API, so it needs the same credentials
 * the batch run uses. Loaded only on demand: the procedural preview must stay
 * runnable with no environment at all.
 */
async function loadEnv(): Promise<void> {
  const f = path.join(process.cwd(), 'agent-test', '.env');
  let txt: string;
  try {
    txt = await fs.readFile(f, 'utf-8');
  } catch {
    throw new Error(`--restyle needs ${f}, which was not readable`);
  }
  for (const line of txt.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** Neutral stone so structure, not hue, is what differs between cells. */
const DEFAULT_PALETTE = [
  '#0E1116 — deepest shadow and background void',
  '#1D242C — unlit rock planes and panel bodies',
  '#3A4650 — stone midtone and platform side faces',
  '#6C7C88 — cool rim light on exposed edges',
  '#A8B6C0 — bright highlight on upward faces',
  '#E8EEF2 — snow-bright specular and readable text',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** A gameRoot is just a directory with docs/art_style.md, so synthesise one. */
async function makePaletteRoot(): Promise<string> {
  const src = arg('palette');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tileprev-'));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  let lines = DEFAULT_PALETTE;
  if (src) {
    // Accept a game directory or the art_style.md itself.
    const p = src.endsWith('.md') ? src : path.join(src, 'docs', 'art_style.md');
    const txt = await fs.readFile(p, 'utf-8');
    lines = txt.split('\n').filter((l) => /^-\s*#[0-9a-fA-F]{6}/.test(l.trim()));
    if (lines.length < 4) throw new Error(`no palette lines found in ${p}`);
    lines = lines.map((l) => l.replace(/^-\s*/, ''));
  }
  await fs.writeFile(
    path.join(root, 'docs', 'art_style.md'),
    `# Art style\n\n## Palette\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`,
  );
  return root;
}

function chosen(): StylePreset[] {
  const names = arg('presets');
  if (names) {
    const want = names.split(',').map((s) => s.trim().toLowerCase());
    const hit = STYLE_PRESETS.filter((p) => want.includes(p.name.toLowerCase()));
    const missing = want.filter(
      (w) => !STYLE_PRESETS.some((p) => p.name.toLowerCase() === w),
    );
    if (missing.length) throw new Error(`unknown preset(s): ${missing.join(', ')}`);
    return hit;
  }
  if (has('all')) return [...STYLE_PRESETS];
  // Default: one preset per distinct structure - the smallest set that shows
  // every shape the renderer can make.
  const seen = new Set<string>();
  return STYLE_PRESETS.filter((p) => {
    const k = `${p.structure}/${p.cap}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const TILE = 64;
const GRID = 7;
const CENTRE = 24; // blob centre fill

/** Cut one cell out of the atlas and repeat it 3x3 so seams become visible. */
async function tiledView(atlas: Buffer, index: number, size: number): Promise<Buffer> {
  const sx = (index % GRID) * TILE;
  const sy = Math.floor(index / GRID) * TILE;
  const cell = await sharp(atlas)
    .extract({ left: sx, top: sy, width: TILE, height: TILE })
    .toBuffer();
  const composites = [];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 3; x++)
      composites.push({ input: cell, left: x * TILE, top: y * TILE });
  return sharp({
    create: { width: TILE * 3, height: TILE * 3, channels: 3, background: '#000' },
  })
    .composite(composites)
    .resize(size, size, { kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
}

function label(text: string, w: number, h: number): Buffer {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(
    `<svg width="${w}" height="${h}"><text x="4" y="${h - 6}" ` +
      `font-family="monospace" font-size="13" fill="#E8EEF2">${esc}</text></svg>`,
  );
}

/**
 * Report how well each preset's plain fill cell wraps, with no image call.
 * The procedural lattice is supposed to wrap BY CONSTRUCTION, so a high number
 * here is a defect in the structure renderer, not a style choice - and it is
 * invisible in the atlas view, which is why it gets its own mode.
 */
async function measure(presets: StylePreset[]): Promise<void> {
  const root = await makePaletteRoot();
  const byStructure = new Map<string, number[]>();
  for (const p of presets) {
    const atlas = await generateProceduralTileset(root, {
      tileSize: TILE,
      gridSize: GRID,
      structure: p.structure,
      cap: p.cap,
      wear: p.wear,
      seed: 1234,
    });
    const i = FILL_VARIANT_SLOTS[0];
    const cell = await sharp(atlas)
      .extract({
        left: (i % GRID) * TILE,
        top: Math.floor(i / GRID) * TILE,
        width: TILE,
        height: TILE,
      })
      .removeAlpha()
      .raw()
      .toBuffer();
    const m = measureWrapSeam(new Uint8Array(cell), TILE);
    const worst = Math.max(m.horizontal, m.vertical);
    const list = byStructure.get(p.structure) ?? [];
    list.push(worst);
    byStructure.set(p.structure, list);
    if (worst > 20) {
      process.stdout.write(
        `  HIGH ${worst.toFixed(1).padStart(6)}  ${p.name} ` +
          `[${p.structure}/${p.cap} w=${p.wear}]  ` +
          `h=${m.horizontal.toFixed(1)} v=${m.vertical.toFixed(1)}\n`,
      );
    }
  }
  process.stdout.write('\n  worst-axis wrap seam per structure (min/median/max):\n');
  for (const [k, v] of [...byStructure].sort()) {
    v.sort((a, b) => a - b);
    process.stdout.write(
      `    ${k.padEnd(11)} n=${String(v.length).padStart(2)}  ` +
        `${v[0].toFixed(1).padStart(5)} / ` +
        `${v[Math.floor(v.length / 2)].toFixed(1).padStart(5)} / ` +
        `${v[v.length - 1].toFixed(1).padStart(5)}\n`,
    );
  }
  await fs.rm(root, { recursive: true, force: true });
}

/**
 * Overrides for iterating on one look without editing the preset table. The
 * restyle prompt is assembled from `description` + the preset fragment's head +
 * `textureNouns`, so --desc and --nouns are the two knobs that actually change
 * what the model paints; --structure decides what it has to paint ONTO.
 */
function overrides(p: StylePreset): StylePreset {
  const s = arg('structure');
  const c = arg('cap');
  const w = arg('wear');
  if (s && !(TILE_STRUCTURES as readonly string[]).includes(s))
    throw new Error(`unknown structure "${s}" (${TILE_STRUCTURES.join(', ')})`);
  if (c && !(TILE_CAPS as readonly string[]).includes(c))
    throw new Error(`unknown cap "${c}" (${TILE_CAPS.join(', ')})`);
  return {
    ...p,
    structure: (s as StylePreset['structure']) ?? p.structure,
    cap: (c as StylePreset['cap']) ?? p.cap,
    wear: w ? Number(w) : p.wear,
  };
}

async function main(): Promise<void> {
  const presets = chosen().map(overrides);
  if (!presets.length) throw new Error('no presets selected');
  if (has('measure')) return measure(presets);
  const doRestyle = has('restyle');
  if (doRestyle) await loadEnv();
  const router = doRestyle ? createModelRouter() : null!;
  const root = await makePaletteRoot();

  const ATLAS = 224;
  const TILED = 224;
  const PAD = 10;
  const LABEL_H = 22;
  const cellW = PAD + ATLAS + PAD + TILED + PAD;
  const cellH = LABEL_H + ATLAS + PAD;
  const cols = Math.max(1, Number(arg('cols') ?? 3));
  const rowsN = Math.ceil(presets.length / cols);

  const parts: Array<{ input: Buffer; left: number; top: number }> = [];
  let i = 0;
  for (const p of presets) {
    let atlas = await generateProceduralTileset(root, {
      tileSize: TILE,
      gridSize: GRID,
      structure: p.structure,
      cap: p.cap,
      wear: p.wear,
      seed: 1234,
    });
    let note = '';
    // The repaint is stochastic - the same preset is accepted on one run and
    // rejected on the next - so allow a few tries before settling for the base.
    const attempts = Math.max(1, Number(arg('attempts') ?? 1));
    if (doRestyle && p.restyle) {
      // Never-worse: a failed or rejected restyle keeps the procedural atlas,
      // which is exactly what the pipeline does, so the preview shows the same
      // image the game would ship.
      for (let a = 1; a <= attempts; a++) {
      try {
        const r = await restyleTilesetAtlas(atlas, {
          tileSize: TILE,
          gridSize: GRID,
          fillIndex: FILL_VARIANT_SLOTS[0],
          description: arg('desc') ?? `${p.name} terrain`,
          styleFragment: p.fragment,
          // Mirror generate-assets: the preset names the material, --nouns
          // only overrides it while iterating.
          textureNouns: arg('nouns') ?? p.material,
          // Same two steps the tool performs: one i2i call, then fetch bytes.
          repaint: async (prompt, referenceDataUri) => {
            const url = await router.generateImage(
              prompt,
              RESTYLE_SIZE,
              referenceDataUri,
            );
            const res = await fetch(url);
            if (!res.ok) throw new Error(`download failed: ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
          },
        });
        const seam = (m: { horizontal: number; vertical: number }): string =>
          `${m.horizontal.toFixed(1)}/${m.vertical.toFixed(1)}`;
        if (r.applied) {
          atlas = r.atlas;
          note = ` restyled on try ${a}/${attempts}, seam ${seam(r.baseSeam)} -> ${seam(r.restyledSeam)}`;
          break;
        }
        note = ` restyle REJECTED after ${a}/${attempts} (${r.reason})`;
      } catch (e) {
        note = ` restyle FAILED (${String((e as Error).message).slice(0, 40)})`;
      }
      }
    } else if (doRestyle) {
      note = ' restyle skipped (hardware palette)';
    }

    const cx = (i % cols) * cellW;
    const cy = Math.floor(i / cols) * cellH;
    parts.push({
      input: label(
        `${p.name} [${p.structure}/${p.cap} w=${p.wear}]${note}`,
        cellW,
        LABEL_H,
      ),
      left: cx,
      top: cy,
    });
    parts.push({
      input: await sharp(atlas)
        .resize(ATLAS, ATLAS, { kernel: sharp.kernel.nearest })
        .png()
        .toBuffer(),
      left: cx + PAD,
      top: cy + LABEL_H,
    });
    parts.push({
      input: await tiledView(atlas, CENTRE, TILED),
      left: cx + PAD + ATLAS + PAD,
      top: cy + LABEL_H,
    });
    i++;
    process.stderr.write(`  ${i}/${presets.length} ${p.name}${note}\n`);
  }

  const out = arg('out') ?? '/tmp/tileset-preview.png';
  await sharp({
    create: {
      width: cellW * cols,
      height: cellH * rowsN,
      channels: 3,
      background: '#12161B',
    },
  })
    .composite(parts)
    .png()
    .toFile(out);
  await fs.rm(root, { recursive: true, force: true });
  process.stderr.write(`\nwrote ${out}  (${presets.length} presets, ${cols} cols)\n`);
}

main().catch((e) => {
  process.stderr.write(`${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
