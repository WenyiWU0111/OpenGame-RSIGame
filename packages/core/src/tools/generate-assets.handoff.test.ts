/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a stall hands back, and what it must NOT hand back.
 *
 * The scorer is still there for `OPENGAME_ASSET_MODE=library`, where a human
 * asked for it. A stall is not that: it is the tool discovering it cannot do
 * the job, and the measured cost of letting it guess anyway was a gold coin
 * standing in for a mirrorball enemy and one blonde sprite copied over all
 * twelve frames of an animation. So the stall path writes NO image and instead
 * reserves the pack entries and tells the agent where the library is.
 *
 * Reserving the entries is the load-bearing half. It means a key the agent
 * skips is a missing file the browser complains about, not a picture nobody
 * chose -- the failure stays visible.
 *
 * `OPENGAME_ASSET_STALL_STREAK=-1` makes `streak >= limit` true on the first
 * call, which is the same branch three real stalls reach, without needing a
 * gateway that hangs on demand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { GenerateAssetsTool } from './generate-assets.js';
import type {
  AssetPack,
  GenerateAssetsParams,
} from './generate-assets-types.js';

describe('asset stall hands the choice to the agent', () => {
  let tempDir: string | undefined;
  const originalMode = process.env.OPENGAME_ASSET_MODE;
  const originalIndex = process.env.OPENGAME_ASSET_LIBRARY_INDEX;
  const originalStreak = process.env.OPENGAME_ASSET_STALL_STREAK;

  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  afterEach(async () => {
    restore('OPENGAME_ASSET_MODE', originalMode);
    restore('OPENGAME_ASSET_LIBRARY_INDEX', originalIndex);
    restore('OPENGAME_ASSET_STALL_STREAK', originalStreak);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('writes no image, reserves every pack entry, and names the library', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opengame-handoff-'));
    const indexPath = path.join(tempDir, 'library_index.json');
    await fs.writeFile(indexPath, '[]');

    delete process.env.OPENGAME_ASSET_MODE; //  NOT a deliberate library run
    process.env.OPENGAME_ASSET_LIBRARY_INDEX = indexPath;
    process.env.OPENGAME_ASSET_STALL_STREAK = '-1';

    const config = {
      getProjectRoot: vi.fn().mockReturnValue(tempDir),
      getWorkspaceContext: vi
        .fn()
        .mockReturnValue(createMockWorkspaceContext(tempDir)),
      getOpenGameProviders: vi.fn(),
    } as unknown as Config;

    const params: GenerateAssetsParams = {
      style_anchor: 'test style',
      assets: [
        { type: 'image', key: 'oil_can', description: 'oil can pickup' },
        {
          type: 'audio',
          key: 'level1_bgm',
          description: 'upbeat loop',
          audioType: 'bgm',
        },
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

    const result = await new GenerateAssetsTool(config).buildAndExecute(
      params,
      new AbortController().signal,
    );

    // Nothing was chosen for the agent.
    const assetsDir = path.join(tempDir, 'public', 'assets');
    const written = (await fs.readdir(assetsDir)).filter((f) =>
      /\.(png|ogg|wav)$/.test(f),
    );
    expect(written).toEqual([]);

    // But every file the game will try to load is already declared, under the
    // same keys the generate path uses -- animations.json depends on those.
    const pack = JSON.parse(
      await fs.readFile(path.join(assetsDir, 'asset-pack.json'), 'utf8'),
    ) as AssetPack;
    const urls = Object.entries(pack)
      .filter(([k]) => k !== 'meta')
      .flatMap(([, v]) => (v as { files: Array<{ url: string }> }).files)
      .map((f) => f.url)
      .sort();
    expect(urls).toEqual([
      'assets/hero_idle_01.png',
      'assets/hero_idle_02.png',
      'assets/hero_run_01.png',
      'assets/level1_bgm.ogg',
      'assets/oil_can.png',
    ]);

    const handoff = (pack.meta as Record<string, unknown>)[
      'library_handoff'
    ] as Array<{ key: string }>;
    // Sorted, because the order is the lane order (fast types first), which
    // is an implementation detail and not part of what a handoff promises.
    expect(handoff.map((h) => h.key).sort()).toEqual([
      'hero',
      'level1_bgm',
      'oil_can',
    ]);

    // The agent reads llmContent. An instruction that lands only in
    // returnDisplay is an instruction nobody follows.
    const said = String(result.llmContent);
    expect(said).toContain(path.join(tempDir, 'library'));
    expect(said).toContain('assets/hero_run_01.png');
    expect(said).toContain('assets/level1_bgm.ogg');
  });
});
