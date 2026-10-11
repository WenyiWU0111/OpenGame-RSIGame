/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Art-style presets: one named record per style, shared by every consumer.
 *
 * Why this file exists
 * --------------------
 * A single style declaration has to drive three very different consumers:
 *
 *  1. The model. `fragment` is handed verbatim to the image model as the
 *     `style_anchor` for everything that is *not* a tile - characters,
 *     backgrounds, props.
 *  2. Procedural tile generation. `structure`, `cap` and `wear` are read by the
 *     code that draws the tile base; the structure is a pattern the code knows
 *     how to render, not a phrase for a model to interpret.
 *  3. The palette source. `palette` will bind to an external palette (a Lospec
 *     slug) in a later phase; `null` means "derive the colours from the game's
 *     own docs/art_style.md".
 *
 * Keeping all three in one record is the point. The moment they live in
 * separate places they drift and start contradicting each other, and the
 * contradiction is invisible until an asset looks wrong. The precedent is
 * already in this repo: `asset_protocol.md` documents tilesets as 3x3 / 192px
 * while the code has always emitted 7x7 / 448px, because the document and the
 * generator were two independent sources of truth with nothing tying them
 * together. One record per style is how that failure is avoided here.
 *
 * The overall architecture this serves: code generates the structure, the model
 * optionally repaints the surface, code verifies the result.
 */

import presets from './style-presets.json' with { type: 'json' };

/**
 * Structural patterns the procedural tile renderer knows how to draw.
 * A preset's `structure` selects the pattern used for the tile base.
 */
export const TILE_STRUCTURES = [
  'grain',
  'slab',
  'plate',
  'brick',
  'plank',
  'cracked',
  'ridged',
  'hex',
  'checker',
  'dot-matrix',
] as const;

export type TileStructure = (typeof TILE_STRUCTURES)[number];

/**
 * Material bands drawn along the top edge of a terrain tile, in a material
 * different from the tile body. `none` means the body runs to the top edge.
 */
export const TILE_CAPS = ['none', 'grass', 'snow', 'moss', 'rust'] as const;

export type TileCap = (typeof TILE_CAPS)[number];

/** A named art style, and everything derived from it. */
export interface StylePreset {
  /** Display name. Matches the Phaser Game Agent preset vocabulary. */
  name: string;
  /**
   * One clause, 3-5 concrete visual nouns, no quality boosters. Used verbatim
   * as the `style_anchor` for model-generated assets (characters, backgrounds,
   * props).
   */
  fragment: string;
  /** Which procedural structural pattern the tile base uses. */
  structure: TileStructure;
  /**
   * A different material band along the top edge of terrain, or `none`.
   */
  cap: TileCap;
  /** 0..1 - how much scuffing/staining the procedural layer applies. */
  wear: number;
  /**
   * What the SURFACE is made of, as concrete material nouns, for the i2i
   * repaint prompt. `structure` decides the shape the model must preserve;
   * this decides what it paints onto that shape.
   *
   * Without it every preset fell back to one generic default - "fine grain,
   * grit, mineral speckle, staining and weathering" - which describes stone,
   * metal, ice and candy identically, so every restyled tile came out as the
   * same speckled surface in a different hue. Measured on Frozen Tundra: the
   * generic nouns produce flat blue noise, these produce translucent ice
   * blocks with frosted seams, from the same procedural base.
   *
   * Write it like a material sample, never like a place: no objects, no
   * lighting story, no scene.
   */
  material: string;
  /**
   * Whether the tile base is sent through the i2i repaint pass.
   *
   * Hardware-palette styles must be `false`: their look lives in the
   * colour-count limit, and a repaint measurably destroys it - a 4-colour base
   * came back from the repaint pass with 3367 colours.
   */
  restyle: boolean;
  /**
   * Lospec palette slug, or `null` to derive colours from the game's own
   * `docs/art_style.md`. All presets are `null` for now; the Lospec binding is
   * a later phase.
   */
  palette: string | null;
}

/** Every art-style preset, in declaration order. */
export const STYLE_PRESETS: StylePreset[] = presets as StylePreset[];

/**
 * Preset display names, derived from the data so it cannot fall out of sync
 * with {@link STYLE_PRESETS}.
 */
export const PRESET_NAMES: string[] = STYLE_PRESETS.map(
  (preset) => preset.name,
);

/** Look up a preset by display name, case-insensitively. */
export function findPreset(name: string): StylePreset | undefined {
  const needle = name.trim().toLowerCase();
  return STYLE_PRESETS.find((preset) => preset.name.toLowerCase() === needle);
}
