/**
 * Asset Generation Types - V2
 * Inspired by PiXelDa architecture
 */

import type { MarkerRole } from '../services/tileset-procedural.js';
import type { TileStructure, TileCap } from '../data/style-presets.js';

// ============== Model Configuration ==============

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  modelType: 'tongyi' | 'doubao' | 'openai-compat';
}

export interface ImageModelConfig extends ModelConfig {
  modelNameGeneration: string;
  modelNameEditing: string;
  temperature?: number;
  timeout?: number;
}

export interface VideoModelConfig extends ModelConfig {
  modelNameVideo: string;
  modelNameVideoText?: string;
  resolution?: '480P' | '720P';
}

export interface AudioModelConfig extends ModelConfig {
  modelNameChat: string;
  maxTokens?: number;
}

// ============== Request Types ==============

export interface BaseAssetRequest {
  key: string;
  description: string;
  /**
   * The size this asset will actually be DRAWN at, in pixels along its longest
   * side. The file is written at this size.
   *
   * Why it has to be declared. The generator asks the model for 1024x1024 and
   * gets back files that are 1920x1920, and a 4:1 sprite sheet came back at
   * 3840x960. Godot's `draw_set_transform(pos, rot, scale)` treats `scale` as a
   * MULTIPLIER ON THE NATIVE SIZE, so the gap between native and intended size
   * is the factor a mistake gets multiplied by. In shooter-sky-duel a
   * projectile written as `Vector2(bsc * 1.25, ...)` -- an ordinary-looking 2.5x
   * -- drew a 3840px texture at about 10000px on a 1280x720 viewport: one
   * bullet covered the whole screen, and the game shipped that way. The same
   * file normalized to 24px would have drawn at 60px.
   *
   * Declaring it makes `scale` land near 1, so a wrong multiplier is off by a
   * factor of two instead of a factor of fifty. Omitted, the file is written at
   * whatever the model returned and an oversized one is logged.
   */
  target_px?: number;
}

export interface BackgroundRequest extends BaseAssetRequest {
  type: 'background';
  resolution?: '1024*1024' | '1536*1024' | '2048*2048';
}

export interface ImageRequest extends BaseAssetRequest {
  type: 'image';
  size?: '512*512' | '1024*1024';
}

export interface AnimationDef {
  name: string;
  frameCount: number;
  action_desc: string;
}

export interface AnimationRequest extends BaseAssetRequest {
  type: 'animation';
  animations: AnimationDef[];
  /**
   * Use I2V (Image-to-Video) for animation generation
   * Default: true (recommended - outputs to Beijing OSS which is accessible)
   * If set to false, uses I2I (Image-to-Image) which may have OSS network issues
   */
  useI2V?: boolean;
}

export interface AudioRequest extends BaseAssetRequest {
  type: 'audio';
  audioType: 'bgm' | 'sfx';
  duration?: number;
  genre?: string;
  tempo?: 'slow' | 'medium' | 'fast';
}

export interface TilesetRequest extends BaseAssetRequest {
  type: 'tileset';
  /** Grid size (default 7 = 7x7 = 49 tiles) */
  tileset_size?: number;
  /** Pixel size per tile (default 64) */
  tile_size?: number;
  /**
   * Name of an art-style preset from the shared table in
   * `data/style-presets.ts` (see `PRESET_NAMES`). Chosen by the agent that
   * authors the game's GDD and read by the tileset handler in
   * `generate-assets.ts`, which uses the preset's `structure`, `cap` and
   * `wear` as the defaults for the three fields below. An unknown name is a
   * warning, not an error: generation falls back to the built-in defaults.
   */
  style_preset?: string;
  /**
   * Structural pattern for the tile base, overriding whatever the named
   * preset would have supplied. Consumed by the procedural tile renderer,
   * which only knows the patterns listed in `TILE_STRUCTURES`.
   */
  structure?: TileStructure;
  /**
   * Material band drawn along the top edge of terrain tiles, in a material
   * different from the tile body, overriding the preset's choice. `none`
   * lets the tile body run all the way to the top edge. Consumed by the
   * procedural tile renderer.
   */
  cap?: TileCap;
  /**
   * 0..1 - how much scuffing and staining the procedural surface pass
   * applies, overriding the preset's value. Consumed by the procedural tile
   * renderer.
   */
  wear?: number;
  /**
   * Which role markers the atlas should carry, e.g. `["hazard"]`.
   *
   * Empty by default: a marker is a painted warning, and a game with no
   * tile-based hazards has nothing to warn about, so its atlas should not carry
   * one. Declare only the roles this game's own data actually uses - the
   * tilemap paints a marker only at coordinates the game declares, so a role
   * listed here but never declared just leaves an unused cell.
   */
  markers?: MarkerRole[];
}

export type AssetRequest =
  | BackgroundRequest
  | ImageRequest
  | AnimationRequest
  | AudioRequest
  | TilesetRequest;

// ============== Generation Parameters ==============

export interface GenerateAssetsParams {
  style_anchor: string;
  composition_env?: string;
  output_dir_name?: string;
  model_type?: 'tongyi' | 'doubao' | 'openai-compat';
  assets: AssetRequest[];
}

// ============== Response Types ==============

export interface GenerationResult {
  success: boolean;
  key: string;
  url?: string;
  error?: string;
}

export interface ImageGenerationResponse {
  url: string;
  taskId?: string;
}

export interface VideoGenerationResponse {
  videoUrl: string;
  taskId: string;
}

export interface AudioGenerationResponse {
  originalUrl: string;
  chiptuneUrl?: string;
}

// ============== Asset Pack Types ==============

export interface AssetPackFile {
  type: 'image' | 'audio' | 'video' | 'tileset';
  key: string;
  url: string;
}

export interface LibraryAssetProvenance {
  key: string;
  target: string;
  source_mode: 'library';
  source_pack: string;
  source_file: string;
  requested_description: string;
  intended_role: AssetRequest['type'];
  match_score: number;
  width: number | null;
  height: number | null;
  has_alpha: boolean | null;
  static_animation: boolean;
  frames?: number;
}

export interface AssetPackMeta {
  provenance?: LibraryAssetProvenance[];
  [key: string]: unknown;
}

export interface AssetPackSection {
  files: AssetPackFile[];
}

export interface AssetPack {
  meta?: AssetPackMeta;
  [section: string]: AssetPackSection | AssetPackMeta | undefined;
}

// ============== Frame Split Types ==============

export interface FrameSplitRequest {
  videoUrl: string;
  fromTime: number;
  toTime: number;
  frameCount: number;
}

export interface FrameSplitResult {
  frames: Buffer[];
  frameUrls?: string[];
}
