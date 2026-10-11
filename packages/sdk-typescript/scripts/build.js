/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

rmSync(join(rootDir, 'dist'), { recursive: true, force: true });
mkdirSync(join(rootDir, 'dist'), { recursive: true });

execSync('tsc --project tsconfig.build.json', {
  stdio: 'inherit',
  cwd: rootDir,
});

try {
  execSync(
    'npx dts-bundle-generator --project tsconfig.build.json -o dist/index.d.ts src/index.ts',
    {
      stdio: 'inherit',
      cwd: rootDir,
    },
  );

  const dirsToRemove = ['mcp', 'query', 'transport', 'types', 'utils'];
  for (const dir of dirsToRemove) {
    const dirPath = join(rootDir, 'dist', dir);
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.warn(
    'Could not bundle type definitions, keeping separate .d.ts files',
    error.message,
  );
}

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: join(rootDir, 'dist', 'index.mjs'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: join(rootDir, 'dist', 'index.cjs'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

// Copy LICENSE from root directory to dist
const licenseSource = join(rootDir, '..', '..', 'LICENSE');
const licenseTarget = join(rootDir, 'dist', 'LICENSE');
if (existsSync(licenseSource)) {
  try {
    cpSync(licenseSource, licenseTarget);
  } catch (error) {
    console.warn('Could not copy LICENSE:', error.message);
  }
}

console.log('Bundling CLI into SDK package...');
const repoRoot = join(rootDir, '..', '..');
const rootDistDir = join(repoRoot, 'dist');

// ALWAYS rebuild the CLI bundle before copying it. `dist/cli/cli.js` is the
// file the SDK actually spawns (see src/utils/cliPath.ts), so skipping the
// rebuild whenever a root `dist/cli.js` merely EXISTS pins every spawned
// agent to whichever bundle was built first -- and nothing anywhere says so.
// That is not hypothetical: `raiseToMinPixels` landed in packages/core, its
// unit test passed, `packages/core/dist` was rebuilt, and the running agent
// went on sending 1024x1024 to a provider that rejects anything under
// 3,686,400 px, because the bundle it was spawning predated the fix by days.
// A stale copy that reports success is worse than a slower build.
console.log('Building CLI bundle...');
try {
  execSync('npm run bundle', { stdio: 'inherit', cwd: repoRoot });
} catch (error) {
  // Only tolerable when a bundle is already there to fall back on (e.g. a
  // packaged tree with no repo root to build from). Say it is stale, loudly.
  if (!existsSync(join(rootDistDir, 'cli.js'))) {
    console.error('Failed to build CLI bundle:', error.message);
    throw error;
  }
  console.warn(
    `Could not rebuild the CLI bundle (${error.message}). ` +
      'Falling back to the existing dist/cli.js, which may be STALE: ' +
      'changes in packages/cli or packages/core will not be in it.',
  );
}

const cliDistDir = join(rootDir, 'dist', 'cli');
mkdirSync(cliDistDir, { recursive: true });

console.log('Copying CLI bundle...');
cpSync(join(rootDistDir, 'cli.js'), join(cliDistDir, 'cli.js'));

const vendorSource = join(rootDistDir, 'vendor');
if (existsSync(vendorSource)) {
  cpSync(vendorSource, join(cliDistDir, 'vendor'), { recursive: true });
}

const localesSource = join(rootDistDir, 'locales');
if (existsSync(localesSource)) {
  cpSync(localesSource, join(cliDistDir, 'locales'), { recursive: true });
}

console.log('CLI bundle copied successfully to SDK package');
