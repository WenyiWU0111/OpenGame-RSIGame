import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
const M = await import('../dist/src/services/tileGeometry.js');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tilegeo-'));
const gameRoot = path.join(tmp, 'game');
await fs.mkdir(path.join(gameRoot, 'src'), { recursive: true });
const cfgPath = path.join(gameRoot, 'src', 'gameConfig.json');
const packPath = path.join(gameRoot, 'asset-pack.json');
let pass = 0;
const t = async (name, fn) => { await fn(); console.log(`  ✅ ${name}`); pass++; };

await t('falls back to the param when no config declares one', async () => {
  await fs.writeFile(cfgPath, JSON.stringify({ screenSize: {} }));
  const r = await M.resolveTileSize(gameRoot, 48);
  assert.strictEqual(r.tileSize, 48);
  assert.strictEqual(r.source, 'param');
});

await t('falls back to the default 64 with neither config nor param', async () => {
  const r = await M.resolveTileSize(gameRoot, undefined);
  assert.strictEqual(r.tileSize, 64);
  assert.strictEqual(r.source, 'default');
});

await t('recordTileSize writes the value back as the declaration', async () => {
  await M.recordTileSize(gameRoot, 48);
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
  assert.strictEqual(cfg.tileConfig.tile_size.value, 48);
  assert.ok(cfg.screenSize, 'must not drop the other fields');
});

await t('★ conflict: config declares 48, caller passes 64 -> config wins', async () => {
  const r = await M.resolveTileSize(gameRoot, 64);
  assert.strictEqual(r.tileSize, 48, 'the parameter must lose to the declaration');
  assert.strictEqual(r.source, 'gameConfig');
});

await t('★ both producers read the same value', async () => {
  const a = await M.resolveTileSize(gameRoot, 64);   // atlas side passes 64
  const b = await M.resolveTileSize(gameRoot, 48);   // tilemap side passes 48
  assert.strictEqual(a.tileSize, b.tileSize, 'this divergence is what produced 448 vs 336');
});

await t('reads the bare-number config format too', async () => {
  await fs.writeFile(cfgPath, JSON.stringify({ tile_size: 32 }));
  assert.strictEqual((await M.resolveTileSize(gameRoot, 64)).tileSize, 32);
});

await t('missing asset-pack -> explicit error rather than silence', async () => {
  const msg = await M.assertTilesetExists(packPath, 'mine_tiles');
  assert.ok(msg && msg.includes('generate_assets must run'));
});

await t('unknown tileset_key -> error listing the keys that do exist', async () => {
  await fs.writeFile(packPath, JSON.stringify({ images: { files: [{ key: 'oil_can' }] } }));
  const msg = await M.assertTilesetExists(packPath, 'mine_tiles');
  assert.ok(msg && msg.includes('oil_can'));
});

await t('known tileset_key -> passes', async () => {
  await fs.writeFile(packPath, JSON.stringify({ tilesets: { files: [{ key: 'mine_tiles' }] } }));
  assert.strictEqual(await M.assertTilesetExists(packPath, 'mine_tiles'), null);
});

console.log(`\n${pass}/9 passed`);
await fs.rm(tmp, { recursive: true, force: true });
