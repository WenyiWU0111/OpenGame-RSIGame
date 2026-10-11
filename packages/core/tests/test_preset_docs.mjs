/**
 * Doc/code drift guard for the art-style presets.
 *
 * `packages/core/src/data/style-presets.json` is the single source of truth for
 * the preset table. The section between the `style-presets` markers in
 * `agent-test/docs/asset_protocol.md` is a projection of that file, produced by
 * `scripts/generate-preset-docs.mjs`. This test runs that generator in --check
 * mode, so editing the JSON without regenerating the docs fails here rather
 * than silently shipping a document that contradicts the code.
 *
 * Run: node packages/core/tests/test_preset_docs.mjs
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const generator = path.join(repoRoot, 'scripts', 'generate-preset-docs.mjs');
const doc = path.join(repoRoot, 'agent-test', 'docs', 'asset_protocol.md');
const presets = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'data',
  'style-presets.json',
);
const REGEN = 'node scripts/generate-preset-docs.mjs';

const failures = [];
function expectTrue(label, cond, detail = '') {
  if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

expectTrue('generator script is missing', fs.existsSync(generator), generator);
expectTrue('preset source is missing', fs.existsSync(presets), presets);
expectTrue('asset protocol doc is missing', fs.existsSync(doc), doc);

if (!failures.length) {
  const markers = fs.readFileSync(doc, 'utf-8');
  expectTrue(
    'the generated-section markers are gone from asset_protocol.md',
    markers.includes('<!-- BEGIN GENERATED: style-presets -->') &&
      markers.includes('<!-- END GENERATED: style-presets -->'),
    'restore both marker lines, then run: ' + REGEN,
  );
}

if (!failures.length) {
  const run = spawnSync(process.execPath, [generator, '--check'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd();
  expectTrue(
    'the style preset section of agent-test/docs/asset_protocol.md is out of date\n' +
      `${output}\n` +
      `  Fix it by running, from the repo root:  ${REGEN}`,
    run.status === 0,
  );
}

if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log(
  'OK: asset_protocol.md style preset section matches style-presets.json',
);
