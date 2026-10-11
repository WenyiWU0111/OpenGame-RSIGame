/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vendors a Lospec palette into `packages/core/src/data/palettes.json`.
 *
 * WHY VENDOR RATHER THAN FETCH AT GENERATION TIME
 * -----------------------------------------------
 * A preset's `palette` slug names a palette that lives on lospec.com. The
 * obvious implementation is to fetch it while assets are being generated, but
 * that puts a network call on the critical path of every run, and the pipeline
 * is expected to work in environments with no outbound internet. A fetch there
 * is a new failure mode - a timeout, a captive portal or a rate limit would
 * silently change what the game looks like, and two runs of the same game could
 * disagree about the colour contract.
 *
 * So the network call happens HERE, once, at author time, and the result is
 * committed. `packages/core/src/data/palettes.json` becomes part of the repo's
 * source of truth: reviewable in a diff, identical on every machine, and
 * readable with no network at all. The cost is that a palette edited upstream
 * on Lospec does not follow us until someone re-runs this script - which is
 * the right trade, because a colour contract that changes underneath a shipped
 * game is a bug, not a feature.
 *
 * Usage:
 *   node scripts/fetch-lospec-palette.mjs <slug> [<slug> ...]
 *   node scripts/fetch-lospec-palette.mjs --list
 *
 * A slug is the last path segment of a Lospec palette URL, e.g.
 * https://lospec.com/palette-list/nintendo-gameboy-bgb -> nintendo-gameboy-bgb
 */

import fs from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const PALETTES_PATH = join(
  root,
  'packages',
  'core',
  'src',
  'data',
  'palettes.json',
);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

function paletteUrl(slug) {
  return `https://lospec.com/palette-list/${slug}.json`;
}

function readVendored() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PALETTES_PATH, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // No file yet, or an unreadable one: start from an empty table.
  }
  return {};
}

/** Lospec returns bare six-digit hex; normalise to lowercase `#rrggbb`. */
function normaliseColors(colors, slug) {
  if (!Array.isArray(colors) || colors.length === 0) {
    throw new Error(`${slug}: response carries no colours`);
  }
  return colors.map((raw) => {
    const hit = HEX_RE.exec(String(raw).trim());
    if (!hit)
      throw new Error(`${slug}: "${raw}" is not a six-digit hex colour`);
    return `#${hit[1].toLowerCase()}`;
  });
}

async function fetchPalette(slug) {
  const url = paletteUrl(slug);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${slug}: ${url} returned HTTP ${response.status}`);
  }
  const body = await response.json();
  return {
    name: typeof body?.name === 'string' && body.name ? body.name : slug,
    author: typeof body?.author === 'string' ? body.author : '',
    colors: normaliseColors(body?.colors, slug),
    source: url,
    fetched: new Date().toISOString().slice(0, 10),
  };
}

function writeVendored(table) {
  const sorted = {};
  for (const slug of Object.keys(table).sort()) sorted[slug] = table[slug];
  fs.writeFileSync(PALETTES_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.length === 0) {
    const table = readVendored();
    const slugs = Object.keys(table);
    if (slugs.length === 0) {
      console.log(`No palettes vendored in ${relative(root, PALETTES_PATH)}.`);
    } else {
      for (const slug of slugs) {
        const entry = table[slug];
        console.log(
          `${slug}  ${entry.name} (${entry.colors.length} colours, fetched ${entry.fetched})`,
        );
      }
    }
    if (args.length === 0) {
      console.log('');
      console.log('Usage: node scripts/fetch-lospec-palette.mjs <slug> [...]');
    }
    return;
  }

  const table = readVendored();
  let failed = 0;
  for (const slug of args) {
    if (!SLUG_RE.test(slug)) {
      console.error(`Skipping "${slug}": not a lowercase-dashed Lospec slug.`);
      failed++;
      continue;
    }
    try {
      table[slug] = await fetchPalette(slug);
      console.log(`Fetched ${slug}: ${table[slug].colors.length} colours.`);
    } catch (error) {
      console.error(`Failed ${slug}: ${error.message}`);
      failed++;
    }
  }

  writeVendored(table);
  console.log(
    `Wrote ${Object.keys(table).length} palettes into ${relative(root, PALETTES_PATH)}.`,
  );
  console.log(`Now run: npx prettier --write ${relative(root, PALETTES_PATH)}`);
  if (failed > 0) process.exit(1);
}

await main();
