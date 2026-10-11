/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Projects `packages/core/src/data/style-presets.json` into the generated
 * "style presets" section of `agent-test/docs/asset_protocol.md`.
 *
 * The JSON is the single source of truth. The documentation section is a
 * projection of it, never an independent statement of the same facts — that is
 * exactly how this repo ended up documenting tilesets as 3x3 / 192px while the
 * generator had always emitted 7x7 / 448px.
 *
 * Usage:
 *   node scripts/generate-preset-docs.mjs           # rewrite the section
 *   node scripts/generate-preset-docs.mjs --check   # exit 1 if it is stale
 */

import fs from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const PRESETS_PATH = join(
  root,
  'packages',
  'core',
  'src',
  'data',
  'style-presets.json',
);
const PALETTES_PATH = join(
  root,
  'packages',
  'core',
  'src',
  'data',
  'palettes.json',
);
const DOC_PATH = join(root, 'agent-test', 'docs', 'asset_protocol.md');

const BEGIN_MARKER = '<!-- BEGIN GENERATED: style-presets -->';
const END_MARKER = '<!-- END GENERATED: style-presets -->';
const REGEN_COMMAND = 'node scripts/generate-preset-docs.mjs';

const INTRO = [
  "Pick exactly one preset by name and put it in the tileset asset's `style_preset` field.",
  'The **style fragment** is handed to the image model verbatim as the style anchor for every',
  'model-generated asset in the game, so the whole game reads as one art direction.',
  '**Structure**, **cap** and **wear** are the procedural tile defaults the preset carries; they',
  'are only defaults and may be overridden per tileset when one surface needs to differ.',
  "**Restyle: no** means that preset's tiles skip the image-model repaint pass — its look depends",
  'on a hard colour-count limit, and a repaint destroys that limit, so the procedural output is',
  'kept as-is.',
  'A preset may also bind a **fixed palette** published outside this repo; when it does, its',
  'colours are listed under the table and the `palette:` block of `docs/art_style.md` MUST use',
  'exactly those hex values. Presets with no fixed palette leave the colours to that document,',
  'as before.',
].join('\n');

const COLUMNS = [
  { header: 'Preset', pick: (p) => p.name },
  { header: 'Style fragment', pick: (p) => p.fragment },
  { header: 'Structure', pick: (p) => p.structure },
  { header: 'Cap', pick: (p) => p.cap },
  { header: 'Wear', pick: (p) => String(p.wear) },
  { header: 'Material', pick: (p) => p.material },
  { header: 'Restyle', pick: (p) => (p.restyle ? 'yes' : 'no') },
];

/** Markdown cells cannot contain a bare pipe. */
function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

/**
 * Renders a padded Markdown table, matching the alignment prettier produces for
 * the hand-written tables already in this document.
 */
function renderTable(presets) {
  const rows = [
    COLUMNS.map((c) => c.header),
    ...presets.map((p) => COLUMNS.map((c) => cell(c.pick(p)))),
  ];
  const widths = COLUMNS.map((_, i) =>
    Math.max(3, ...rows.map((r) => r[i].length)),
  );
  const line = (cells) =>
    `| ${cells.map((v, i) => v.padEnd(widths[i])).join(' | ')} |`;
  return [
    line(rows[0]),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.slice(1).map(line),
  ].join('\n');
}

/** `docs/art_style.md` accepts 4-8 palette entries. */
const ART_STYLE_PALETTE_MAX = 8;

/**
 * Trim a palette to at most `max` colours while keeping its full value range.
 *
 * A preset's fixed palette reaches the game through this document: the agent is
 * told to copy these hex values verbatim into `art_style.md`. Taking the first N
 * would be wrong - Lospec palettes are ordered, so the first eight of a
 * 64-colour palette are usually one hue ramp with no lights or no darks in it.
 */
function representativeColors(colors, max = ART_STYLE_PALETTE_MAX) {
  if (colors.length <= max) return [...colors];
  const step = (colors.length - 1) / (max - 1);
  const picked = [];
  for (let i = 0; i < max; i++) picked.push(colors[Math.round(i * step)]);
  return picked;
}

/**
 * The fixed-palette list under the table. Renders to nothing while every preset
 * leaves its colours to the game's own `art_style.md`, which is the state this
 * repo starts in.
 */
function renderPalettes(presets, palettes) {
  const bound = presets.filter((p) => p.palette);
  if (bound.length === 0) return '';
  const lines = bound.map((preset) => {
    const entry = palettes[preset.palette];
    const swatches = representativeColors(entry.colors)
      .map((hex) => `\`${hex}\``)
      .join(', ');
    const author = entry.author ? ` by ${entry.author}` : '';
    return `- **${preset.name}** — ${entry.name}${author} (\`${preset.palette}\`): ${swatches}`;
  });
  return `\n\n**Fixed palettes.**\n\n${lines.join('\n')}`;
}

/**
 * The blank lines around the body keep the marker comments as standalone HTML
 * blocks, which is the shape prettier normalises this document to.
 */
function renderSection(presets, palettes) {
  return `\n\n${INTRO}\n\n${renderTable(presets)}${renderPalettes(presets, palettes)}\n\n`;
}

function loadPresets() {
  let raw;
  try {
    raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
  } catch (error) {
    console.error(
      `Cannot read ${relative(root, PRESETS_PATH)}: ${error.message}`,
    );
    process.exit(1);
  }
  const presets = JSON.parse(raw);
  if (!Array.isArray(presets) || presets.length === 0) {
    console.error(
      `${relative(root, PRESETS_PATH)} must be a non-empty array of presets.`,
    );
    process.exit(1);
  }
  return presets;
}

/**
 * The vendored palette table. A preset naming a slug that is not vendored is a
 * hard error rather than a silent omission: the whole point of an external
 * palette is that the colours are pinned, and a doc that quietly drops them
 * sends the agent back to inventing its own.
 */
function loadPalettes(presets) {
  let palettes = {};
  try {
    palettes = JSON.parse(fs.readFileSync(PALETTES_PATH, 'utf-8'));
  } catch {
    palettes = {};
  }
  const missing = presets
    .filter((p) => p.palette && !palettes[p.palette])
    .map((p) => p.palette);
  if (missing.length > 0) {
    console.error(
      [
        `These preset palettes are not vendored in ${relative(root, PALETTES_PATH)}:`,
        ...missing.map((slug) => `    ${slug}`),
        '',
        `Fetch them with:  node scripts/fetch-lospec-palette.mjs ${missing.join(' ')}`,
      ].join('\n'),
    );
    process.exit(1);
  }
  return palettes;
}

/** Splits the document into the text before, inside, and after the markers. */
function splitDoc(doc) {
  const beginAt = doc.indexOf(BEGIN_MARKER);
  const endAt = doc.indexOf(END_MARKER);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    console.error(
      [
        `Cannot find the generated-section markers in ${relative(root, DOC_PATH)}.`,
        '',
        'Add both marker lines, in this order, under a heading where the style',
        'preset table belongs, then re-run this script:',
        '',
        `    ${BEGIN_MARKER}`,
        `    ${END_MARKER}`,
        '',
        'This script never guesses a location — the placement is a human decision.',
      ].join('\n'),
    );
    process.exit(1);
  }
  return {
    before: doc.slice(0, beginAt + BEGIN_MARKER.length),
    inside: doc.slice(beginAt + BEGIN_MARKER.length, endAt),
    after: doc.slice(endAt),
  };
}

/**
 * A readable line-level diff of the two sections, built on a longest-common-
 * subsequence table so that an inserted or deleted line does not make every
 * following line look changed.
 */
function summariseDiff(actual, expected) {
  const a = actual.split('\n');
  const b = expected.split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`  - ${a[i++]}`);
    } else {
      out.push(`  + ${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`  - ${a[i++]}`);
  while (j < b.length) out.push(`  + ${b[j++]}`);
  if (out.length > 40) {
    out.length = 40;
    out.push('  ... (truncated)');
  }
  return out.length
    ? out.join('\n')
    : '  (identical text, differing whitespace)';
}

function main() {
  const check = process.argv.includes('--check');
  const presets = loadPresets();
  const palettes = loadPalettes(presets);
  const doc = fs.readFileSync(DOC_PATH, 'utf-8');
  const { before, inside, after } = splitDoc(doc);
  const expected = renderSection(presets, palettes);

  if (inside === expected) {
    console.log(
      check
        ? `Style preset docs are up to date (${presets.length} presets).`
        : `No change: style preset docs already match ${relative(root, PRESETS_PATH)}.`,
    );
    return;
  }

  if (check) {
    console.error(
      [
        `Style preset documentation is STALE.`,
        `  source: ${relative(root, PRESETS_PATH)}`,
        `  doc:    ${relative(root, DOC_PATH)}`,
        '',
        'Difference (- in the doc now, + what the source says it should be):',
        summariseDiff(inside, expected),
        '',
        `Regenerate it with:  ${REGEN_COMMAND}`,
      ].join('\n'),
    );
    process.exit(1);
  }

  fs.writeFileSync(DOC_PATH, `${before}${expected}${after}`, 'utf-8');
  console.log(
    `Wrote ${presets.length} style presets into ${relative(root, DOC_PATH)}.`,
  );
}

main();
