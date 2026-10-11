/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `OPENGAME_ASSET_MODE=library` now HANDS OVER rather than picking.
 *
 * This file used to assert the keyword scorer's provenance rows. That scorer
 * no longer runs anywhere: it was kept for a deliberate library run on the
 * grounds that a whole-run choice is a human decision, and that argument died
 * when library mode became how every game is built. Measured on one forced
 * run, it answered `coin_gold_side.png` for a mirrorball enemy, the same coin
 * for a tileset, one blonde sprite for all twelve frames of an animation, and
 * a voice clip saying "final round" for level 3's music.
 *
 * So the test is rewritten rather than deleted: the old assertions describe a
 * path nothing takes, and a green test over dead code is worse than no test.
 * What must hold now is that a deliberate library run behaves exactly like a
 * stalled one -- no image chosen for the agent, every pack entry reserved,
 * the library named in what the agent reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';

import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { GenerateAssetsTool } from './generate-assets.js';
import type {
  AssetPack,
  AssetPackSection,
  GenerateAssetsParams,
} from './generate-assets-types.js';

describe('a deliberate library run hands over, like a stall does', () => {
  let tempDir: string | undefined;
  const originalMode = process.env.OPENGAME_ASSET_MODE;
  const originalIndex = process.env.OPENGAME_ASSET_LIBRARY_INDEX;

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.OPENGAME_ASSET_MODE;
    else process.env.OPENGAME_ASSET_MODE = originalMode;
    if (originalIndex === undefined)
      delete process.env.OPENGAME_ASSET_LIBRARY_INDEX;
    else process.env.OPENGAME_ASSET_LIBRARY_INDEX = originalIndex;
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('chooses nothing for the agent and reserves every path', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opengame-library-'));
    const libraryDir = path.join(tempDir, 'library');
    const propPath = path.join(libraryDir, '2D', 'test-pack', 'PNG', 'oil.png');
    const characterPath = path.join(
      libraryDir,
      '2D',
      'character-pack',
      'Characters',
      'hero.png',
    );
    await fs.mkdir(path.dirname(propPath), { recursive: true });
    await fs.mkdir(path.dirname(characterPath), { recursive: true });
    await sharp({
      create: {
        width: 31,
        height: 37,
        channels: 4,
        background: { r: 200, g: 120, b: 40, alpha: 0.5 },
      },
    })
      .png()
      .toFile(propPath);
    await sharp({
      create: {
        width: 80,
        height: 110,
        channels: 4,
        background: { r: 100, g: 120, b: 140, alpha: 0.5 },
      },
    })
      .png()
      .toFile(characterPath);

    const indexPath = path.join(tempDir, 'library_index.json');
    await fs.writeFile(
      indexPath,
      JSON.stringify([
        {
          p: propPath,
          k: 'image',
          s: 'test-pack',
          fn: ['oil'],
          dir: ['test', 'pack', 'png'],
          tg: ['prop'],
        },
        {
          p: characterPath,
          k: 'image',
          s: 'character-pack',
          fn: ['hero'],
          dir: ['character', 'characters', 'pack'],
          tg: ['character'],
        },
      ]),
    );
    await fs.mkdir(path.join(tempDir, 'docs', 'modules', 'platformer'), {
      recursive: true,
    });

    process.env.OPENGAME_ASSET_MODE = 'library';
    process.env.OPENGAME_ASSET_LIBRARY_INDEX = indexPath;
    const config = {
      getProjectRoot: vi.fn().mockReturnValue(tempDir),
      getWorkspaceContext: vi
        .fn()
        .mockReturnValue(createMockWorkspaceContext(tempDir)),
      getOpenGameProviders: vi.fn(),
    } as unknown as Config;
    const tool = new GenerateAssetsTool(config);
    const first: GenerateAssetsParams = {
      style_anchor: 'test style',
      assets: [
        { type: 'image', key: 'oil_can', description: 'oil can pickup' },
        {
          type: 'animation',
          key: 'hero',
          description: 'hero character',
          animations: [
            { name: 'idle', frameCount: 2, action_desc: 'standing' },
            { name: 'run', frameCount: 1, action_desc: 'running' },
          ],
        },
      ],
    };

    const result = await tool.buildAndExecute(
      first,
      new AbortController().signal,
    );

    // Nothing was chosen on the agent's behalf.
    const assetsDir = path.join(tempDir, 'public', 'assets');
    const written = (await fs.readdir(assetsDir)).filter((f) =>
      /\.(png|ogg|wav)$/.test(f),
    );
    expect(written).toEqual([]);

    // But every file the game will try to load is declared, under the same
    // keys the generate path uses -- animations.json depends on those.
    const pack = JSON.parse(
      await fs.readFile(path.join(assetsDir, 'asset-pack.json'), 'utf8'),
    ) as AssetPack;
    const urls = Object.entries(pack)
      .filter(([k]) => k !== 'meta')
      .flatMap(([, v]) => (v as AssetPackSection).files)
      .map((f) => f.url)
      .sort();
    expect(urls).toEqual([
      'assets/hero_idle_01.png',
      'assets/hero_idle_02.png',
      'assets/hero_run_01.png',
      'assets/oil_can.png',
    ]);

    // The scorer is gone, so nothing claims a source it picked.
    expect(pack.meta?.provenance).toBeUndefined();

    const handoff = (pack.meta as Record<string, unknown>)[
      'library_handoff'
    ] as Array<{ key: string }>;
    expect(handoff.map((h) => h.key).sort()).toEqual(['hero', 'oil_can']);

    // The agent reads llmContent; an instruction only in returnDisplay is one
    // nobody follows.
    const said = String(result.llmContent);
    expect(said).toContain(path.join(tempDir, 'library'));
    expect(said).toContain('assets/hero_run_01.png');
  });
});
