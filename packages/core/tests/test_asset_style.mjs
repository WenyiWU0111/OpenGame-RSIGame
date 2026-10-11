/**
 * Offline checks for the art-style/palette pipeline: the `art_style.md` parser
 * and the palette conformance scorer. No network, no image API — synthetic PNGs
 * of known colours built with sharp.
 *
 * Run: node packages/core/tests/test_asset_style.mjs
 */
import sharp from 'sharp';
import { checkPalette, parseHexColor } from '../dist/src/services/paletteCheck.js';
import { parseArtStyle, artStylePromptBlock } from '../dist/src/tools/generate-assets.js';

const failures = [];
function expect(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function expectTrue(label, cond, detail = '') {
  if (!cond) failures.push(`${label}: expected true ${detail}`);
}

// ---------- art_style.md parser ----------
const GOOD = `# Art Style Guide

palette:
- #2b1b3d — deep background / night sky
- #d9a355 — primary warm accent
- #7fbf8f — secondary accent, foliage
- #e9e2d6 — highlights and text

line_quality: soft painterly edges, no hard outlines
lighting: single warm key from upper-left
material: worn brass and aged wood, matte
silhouette: chunky readable shapes
forbidden: neon, chrome, photographic realism
`;
const style = parseArtStyle(GOOD);
expect('parse palette count', style?.palette.length, 4);
expect('parse first hex', style?.palette[0].hex, '#2b1b3d');
expect('parse first role', style?.palette[0].role, 'deep background / night sky');
expect('parse lighting', style?.lighting, 'single warm key from upper-left');
expect('parse forbidden', style?.forbidden, 'neon, chrome, photographic realism');
expectTrue('prompt block mentions palette', (artStylePromptBlock(style) || '').includes('#d9a355'));
expect('prompt block empty for null', artStylePromptBlock(null), '');

// Regression: the palette block must not truncate at a letter inside a role
// description. The original block regex used `\Z` (unsupported in JS = literal
// 'Z') under the `i` flag, so it stopped at the first lowercase z — "safe zones"
// silently cost the game its 4th colour. Caught by an end-to-end run, not by
// the earlier version of this test, which is why this case is explicit.
const ZTRAP = `palette:
- #111111 — zenith sky
- #222222 — hazy horizon
- #333333 — safe zones
- #444444 — buzzing fireflies
- #555555 — the last colour

lighting: warm
`;
expect('z in role does not truncate palette', parseArtStyle(ZTRAP)?.palette.length, 5);
expect('z-trap keeps last colour', parseArtStyle(ZTRAP)?.palette[4].hex, '#555555');
expect('z-trap still reads later fields', parseArtStyle(ZTRAP)?.lighting, 'warm');

// a hex appearing in a LATER field must not be swept into the palette
const AFTER = `palette:
- #aaaaaa — base

forbidden: never use #ff00ff magenta
`;
expect('palette stops at next field', parseArtStyle(AFTER)?.palette.length, 1);

// malformed / missing palette must degrade to null, never throw
expect('no palette -> null', parseArtStyle('# Art Style Guide\nlighting: warm\n'), null);
expect('empty -> null', parseArtStyle(''), null);
expectTrue('garbage does not throw', parseArtStyle('#### ??? \n- notahex — x') === null);

// hex parsing
expect('hex with hash', parseHexColor('#ff8000'), [255, 128, 0]);
expect('hex without hash', parseHexColor('ff8000'), [255, 128, 0]);
expect('bad hex', parseHexColor('#xyz'), null);

// ---------- palette conformance ----------
const PALETTE = ['#2b1b3d', '#d9a355', '#7fbf8f', '#e9e2d6'];

async function solid(hex, opts = {}) {
  const [r, g, b] = parseHexColor(hex);
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r, g, b, alpha: opts.alpha ?? 1 },
    },
  })
    .png()
    .toBuffer();
}

// `conformance` is COVERAGE: how many of the 4 declared colours appear. A
// single-colour swatch therefore scores 1/4 by construction — that is correct,
// not a bug, and is why the floor is low.
let rep = await checkPalette(await solid('#d9a355'), PALETTE);
expectTrue('on-palette measured', rep.measured);
expect('one-of-four covered', Number(rep.conformance.toFixed(2)), 0.25);
expectTrue('on-palette full area agreement', rep.areaAgreement > 0.95, `got ${rep.areaAgreement}`);
expect('on-palette no offenders', rep.offPalette, []);

// a shaded variant still counts as its palette colour — the case the tolerance exists for
rep = await checkPalette(await solid('#c9963f'), PALETTE);
expectTrue('shaded variant still covers', rep.conformance >= 0.25, `got ${rep.conformance}`);
expectTrue('shaded variant no offender', rep.offPalette.length === 0, JSON.stringify(rep.offPalette));

// a colour nowhere near the palette -> covers nothing, and is named
rep = await checkPalette(await solid('#00ff00'), PALETTE);
expect('off-palette covers nothing', rep.conformance, 0);
expectTrue('off-palette low area agreement', rep.areaAgreement < 0.3, `got ${rep.areaAgreement}`);
expectTrue('off-palette names offender', rep.offPalette.length > 0);

// fully transparent -> nothing to measure, must NOT be reported as a failure
rep = await checkPalette(await solid('#00ff00', { alpha: 0 }), PALETTE);
expect('transparent not measured', rep.measured, false);
expect('transparent conformance neutral', rep.conformance, 1);

// no palette declared -> not measured, neutral
rep = await checkPalette(await solid('#00ff00'), []);
expect('no palette not measured', rep.measured, false);

// an image using several declared colours covers more of the palette than one using one
async function stripes(hexes) {
  const h = Math.floor(64 / hexes.length);
  const [r0, g0, b0] = parseHexColor(hexes[0]);
  const base = sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: r0, g: g0, b: b0, alpha: 1 } },
  });
  const layers = [];
  for (let i = 1; i < hexes.length; i++) {
    const [r, g, b] = parseHexColor(hexes[i]);
    layers.push({
      input: await sharp({ create: { width: 64, height: h, channels: 4, background: { r, g, b, alpha: 1 } } })
        .png()
        .toBuffer(),
      top: i * h,
      left: 0,
    });
  }
  return base.composite(layers).png().toBuffer();
}
const threeOfFour = await checkPalette(await stripes(['#2b1b3d', '#d9a355', '#7fbf8f']), PALETTE);
expectTrue('three colours cover more', threeOfFour.conformance >= 0.75, `got ${threeOfFour.conformance}`);

// half declared / half foreign -> partial coverage AND the foreign colour is named
const mixed = await checkPalette(await stripes(['#d9a355', '#00ff00']), PALETTE);
expectTrue('mixed partial coverage', mixed.conformance > 0 && mixed.conformance < 1, `got ${mixed.conformance}`);
expectTrue('mixed names the green', mixed.offPalette.length > 0, JSON.stringify(mixed.offPalette));

if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('OK: art_style.md parser + palette conformance verified on synthetic images');
