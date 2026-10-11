/**
 * Tile geometry — ONE source of truth for `tile_size`.
 *
 * `tile_size` (the pixel edge length of one tile) is consumed by two independent
 * producers:
 *   - generate-assets `handleTileset`  → decides how big the atlas PNG is
 *                                        (image = tile_size × columns)
 *   - generate-tilemap                 → writes `tilewidth` into the map JSON,
 *                                        which is how Phaser SLICES that PNG
 *
 * Both used to take it as their own optional parameter (each defaulting to 64).
 * When the agent passed different values in its two tool calls — observed in the
 * wild: the asset registry said 64, the tilemap call said 48 — the engine sliced a
 * 448px atlas on a 48px grid, so every cell straddled two real tiles and the
 * terrain rendered as a band of scrambled fragments. Build and smoke both passed;
 * nothing detected it.
 *
 * Fix: the value is DECLARED once in `src/gameConfig.json` (this repo's existing
 * config-first pattern — see generate-gdd's "Numeric values go in gameConfig.json")
 * and both producers read it from there. The explicit tool parameter is kept only
 * as a fallback for callers that predate the config field.
 *
 * This module covers the DECLARED value only. Whether the produced PNG actually
 * matches the declaration is a separate check — see agent-test/eval/contracts/.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const DEFAULT_TILE_SIZE = 64;

/** Where the resolved value came from — surfaced in logs so a fallback is visible. */
export type TileSizeSource = 'gameConfig' | 'param' | 'default';

export interface ResolvedTileSize {
  tileSize: number;
  source: TileSizeSource;
}

/**
 * gameConfig.json stores numbers wrapped as `{ "value": X }`. Accept both the
 * wrapper and a bare number so hand-edited configs still work.
 */
function unwrap(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as Record<string, unknown>)['value'];
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
  }
  return undefined;
}

/**
 * Read the declared tile size from `<gameRoot>/src/gameConfig.json`.
 * Looks at `tileConfig.tile_size` first, then a top-level `tile_size`.
 */
export async function readDeclaredTileSize(
  gameRoot: string,
): Promise<number | undefined> {
  const configPath = path.join(gameRoot, 'src', 'gameConfig.json');
  try {
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const tileCfg = cfg['tileConfig'] as Record<string, unknown> | undefined;
    return unwrap(tileCfg?.['tile_size']) ?? unwrap(cfg['tile_size']);
  } catch {
    return undefined;
  }
}

/**
 * Resolve tile size with an explicit precedence, so both producers agree:
 *   gameConfig.json  >  the caller's explicit parameter  >  DEFAULT_TILE_SIZE
 *
 * The parameter deliberately loses to the config: the config is the shared
 * declaration, the parameter is one caller's private opinion.
 */
export async function resolveTileSize(
  gameRoot: string,
  paramTileSize?: number,
): Promise<ResolvedTileSize> {
  const declared = await readDeclaredTileSize(gameRoot);
  if (declared) return { tileSize: declared, source: 'gameConfig' };
  if (paramTileSize) return { tileSize: paramTileSize, source: 'param' };
  return { tileSize: DEFAULT_TILE_SIZE, source: 'default' };
}

/**
 * Record the value actually used back into gameConfig.json, so the FIRST producer
 * to run establishes the declaration for the second. Merges; never clobbers other
 * fields. Best-effort: a failure here must not fail asset generation.
 */
export async function recordTileSize(
  gameRoot: string,
  tileSize: number,
): Promise<void> {
  const configPath = path.join(gameRoot, 'src', 'gameConfig.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const tileCfg = (cfg['tileConfig'] ?? {}) as Record<string, unknown>;
    if (unwrap(tileCfg['tile_size']) === tileSize) return; // already agrees
    tileCfg['tile_size'] = {
      value: tileSize,
      type: 'number',
      description:
        'Pixel edge length of one tile. Shared by the tileset atlas and the tilemap; do not diverge.',
    };
    cfg['tileConfig'] = tileCfg;
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  } catch {
    /* config not present yet (assets can run before it) — the other producer will declare it */
  }
}

/**
 * Record which role markers the atlas actually carries, so generate-tilemap can
 * tell whether a marker it wants to paint exists.
 *
 * Markers are opt-in on the tileset request, and the two tools run in separate
 * calls, so without this the tilemap would paint `markerIds[role]` regardless -
 * an index that, in an atlas built without markers, holds ordinary terrain. The
 * map would look fine and the warning would simply not be there.
 */
export async function recordMarkerRoles(
  gameRoot: string,
  roles: readonly string[],
): Promise<void> {
  const configPath = path.join(gameRoot, 'src', 'gameConfig.json');
  try {
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const tileCfg = (cfg['tileConfig'] ?? {}) as Record<string, unknown>;
    tileCfg['marker_roles'] = {
      value: [...roles].sort(),
      type: 'string[]',
      description:
        'Role markers painted into the tileset atlas. generate-tilemap may only place these.',
    };
    cfg['tileConfig'] = tileCfg;
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  } catch {
    /* config not present yet - the tilemap falls back to permitting nothing */
  }
}

/** Which role markers the atlas declared, or null when nothing was recorded. */
export async function readMarkerRoles(
  gameRoot: string,
): Promise<string[] | null> {
  const configPath = path.join(gameRoot, 'src', 'gameConfig.json');
  try {
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const tileCfg = cfg['tileConfig'] as Record<string, unknown> | undefined;
    const entry = tileCfg?.['marker_roles'] as
      | { value?: unknown }
      | string[]
      | undefined;
    const v = Array.isArray(entry) ? entry : entry?.value;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Precondition for generate-tilemap: the tileset image it is about to reference
 * must already exist in asset-pack.json. The tool's own schema already states
 * `tileset_key` "must match generate_assets key" — this turns that stated
 * dependency into an enforced one, and makes a dangling reference fail loudly
 * instead of shipping a map that points at a missing PNG.
 *
 * Returns an error message, or null when the reference resolves.
 */
export async function assertTilesetExists(
  assetPackPath: string,
  tilesetKey: string,
): Promise<string | null> {
  let pack: Record<string, unknown>;
  try {
    pack = JSON.parse(await fs.readFile(assetPackPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return (
      `asset-pack.json not found at ${assetPackPath}. generate_assets must run ` +
      `before generate_tilemap (asset_protocol.md: tilesets are produced in Call 1).`
    );
  }
  const keys = new Set<string>();
  for (const group of Object.values(pack)) {
    const files = (group as { files?: Array<{ key?: string }> })?.files;
    if (Array.isArray(files)) {
      for (const f of files) if (f?.key) keys.add(f.key);
    }
  }
  if (keys.has(tilesetKey)) return null;
  return (
    `tileset_key "${tilesetKey}" is not in asset-pack.json (known keys: ` +
    `${[...keys].slice(0, 12).join(', ')}${keys.size > 12 ? ', …' : ''}). ` +
    `Generate the tileset with generate_assets first.`
  );
}
