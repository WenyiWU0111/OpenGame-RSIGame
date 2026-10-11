import Phaser from 'phaser';

/**
 * Code-drawn geometry primitives (SKELETON-OWNED).
 *
 * The CSS-first / draw-with-code policy: **geometric infrastructure** (projectiles,
 * particles, orbs, pickups, grid cells, bars, portals, plain platforms, hazard
 * shapes) should be drawn HERE as crisp Phaser textures — NOT generated as PNGs and
 * NOT hand-authored as SVG. Reserve `generate_game_assets` (the image API) for
 * **brand-identifiable content**: the hero, named enemies/bosses, NPCs, backgrounds,
 * tilesets with real texture, and thematic/branded pickups.
 *
 * Each helper registers a texture under `key` (idempotent — skips if it exists) so
 * you can `scene.add.image(x, y, key)` / use it as a particle or projectile texture.
 * All drawing is deterministic (no RNG) so RL/replay stays reproducible.
 *
 * Usage (in a scene's preload/create):
 *   Shapes.orb(this, 'seed', { radius: 12, color: 0xffe08a, glow: true });
 *   this.add.image(x, y, 'seed');
 */

export interface ShapeOpts {
  /** Fill color, Phaser hex int (e.g. 0x6ee7ff). */
  color?: number;
  /** Optional outline color; omit for no stroke. */
  stroke?: number;
  /** Outline thickness in px (with `stroke`). */
  strokeWidth?: number;
}

const has = (scene: Phaser.Scene, key: string): boolean =>
  scene.textures.exists(key);

const gfx = (scene: Phaser.Scene): Phaser.GameObjects.Graphics =>
  scene.make.graphics({ x: 0, y: 0 }, false);

/** Soft radial glow behind a core, drawn as stacked translucent rings. */
function drawGlow(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  radius: number,
  color: number,
): void {
  for (let i = 4; i >= 1; i--) {
    g.fillStyle(color, 0.1 + (4 - i) * 0.04);
    g.fillCircle(cx, cy, radius * (1 + i * 0.22));
  }
}

/** A tiny glossy highlight — makes a flat fill read as a rounded object. */
function drawHighlight(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  radius: number,
): void {
  g.fillStyle(0xffffff, 0.4);
  g.fillCircle(cx - radius * 0.32, cy - radius * 0.32, radius * 0.34);
}

export const Shapes = {
  /** Glowing orb — players, energy pickups, projectiles, bullets. */
  orb(
    scene: Phaser.Scene,
    key: string,
    opts: ShapeOpts & { radius?: number; glow?: boolean } = {},
  ): string {
    if (has(scene, key)) return key;
    const r = opts.radius ?? 14;
    const color = opts.color ?? 0x6ee7ff;
    const glow = opts.glow ?? true;
    const pad = glow ? Math.ceil(r * 2.1) : (opts.strokeWidth ?? 0) + 2;
    const size = Math.ceil(r * 2 + pad * 2);
    const c = size / 2;
    const g = gfx(scene);
    if (glow) drawGlow(g, c, c, r, color);
    if (opts.stroke !== undefined) {
      g.fillStyle(opts.stroke, 1);
      g.fillCircle(c, c, r + (opts.strokeWidth ?? 2));
    }
    g.fillStyle(color, 1);
    g.fillCircle(c, c, r);
    drawHighlight(g, c, c, r);
    g.generateTexture(key, size, size);
    g.destroy();
    return key;
  },

  /** Hollow ring / portal outline. */
  ring(
    scene: Phaser.Scene,
    key: string,
    opts: ShapeOpts & { radius?: number; thickness?: number } = {},
  ): string {
    if (has(scene, key)) return key;
    const r = opts.radius ?? 18;
    const t = opts.thickness ?? 4;
    const color = opts.color ?? 0x8b5cf6;
    const size = Math.ceil((r + t) * 2 + 4);
    const c = size / 2;
    const g = gfx(scene);
    g.lineStyle(t, color, 1); // stroke a circle → clean hollow ring, no blend tricks
    g.strokeCircle(c, c, r);
    g.generateTexture(key, size, size);
    g.destroy();
    return key;
  },

  /** Rounded tile / chip — grid cells, buttons, plain platforms, blocks. */
  chip(
    scene: Phaser.Scene,
    key: string,
    opts: ShapeOpts & { width?: number; height?: number; radius?: number } = {},
  ): string {
    if (has(scene, key)) return key;
    const w = opts.width ?? 48;
    const h = opts.height ?? 48;
    const rad = opts.radius ?? Math.min(w, h) * 0.22;
    const sw = opts.stroke !== undefined ? (opts.strokeWidth ?? 3) : 0;
    const size = { w: w + sw * 2, h: h + sw * 2 };
    const g = gfx(scene);
    if (opts.stroke !== undefined) {
      g.fillStyle(opts.stroke, 1);
      g.fillRoundedRect(0, 0, size.w, size.h, rad + sw);
    }
    g.fillStyle(opts.color ?? 0x2a3346, 1);
    g.fillRoundedRect(sw, sw, w, h, rad);
    // top edge sheen
    g.fillStyle(0xffffff, 0.12);
    g.fillRoundedRect(sw, sw, w, Math.max(4, h * 0.28), rad);
    g.generateTexture(key, size.w, size.h);
    g.destroy();
    return key;
  },

  /** Pill / bar — HUD fills, energy bars, tokens. */
  bar(
    scene: Phaser.Scene,
    key: string,
    opts: ShapeOpts & { width?: number; height?: number } = {},
  ): string {
    if (has(scene, key)) return key;
    const w = opts.width ?? 64;
    const h = opts.height ?? 18;
    const g = gfx(scene);
    g.fillStyle(opts.color ?? 0x7cf29c, 1);
    g.fillRoundedRect(0, 0, w, h, h / 2);
    g.fillStyle(0xffffff, 0.22);
    g.fillRoundedRect(2, 2, w - 4, h * 0.4, h * 0.3);
    g.generateTexture(key, w, h);
    g.destroy();
    return key;
  },

  /** Regular polygon — diamonds (sides:4, rot:45°), triangles (3), hexes (6). */
  poly(
    scene: Phaser.Scene,
    key: string,
    opts: ShapeOpts & {
      radius?: number;
      sides?: number;
      rotationDeg?: number;
    } = {},
  ): string {
    if (has(scene, key)) return key;
    const r = opts.radius ?? 16;
    const sides = Math.max(3, opts.sides ?? 4);
    const rot = ((opts.rotationDeg ?? 0) * Math.PI) / 180;
    const sw = opts.stroke !== undefined ? (opts.strokeWidth ?? 3) : 0;
    const size = Math.ceil(r * 2 + sw * 2 + 4);
    const c = size / 2;
    const pts: Phaser.Types.Math.Vector2Like[] = [];
    for (let i = 0; i < sides; i++) {
      const a = rot - Math.PI / 2 + (i * 2 * Math.PI) / sides;
      pts.push({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r });
    }
    const g = gfx(scene);
    if (opts.stroke !== undefined) {
      g.lineStyle(sw, opts.stroke, 1);
    }
    g.fillStyle(opts.color ?? 0xffd54a, 1);
    g.fillPoints(pts, true);
    if (opts.stroke !== undefined) g.strokePoints(pts, true);
    g.generateTexture(key, size, size);
    g.destroy();
    return key;
  },

  /** Five-pointed star — collectibles, rewards. */
  star(
    scene: Phaser.Scene,
    key: string,
    opts: ShapeOpts & { radius?: number; points?: number } = {},
  ): string {
    if (has(scene, key)) return key;
    const R = opts.radius ?? 16;
    const inner = R * 0.44;
    const n = opts.points ?? 5;
    const sw = opts.stroke !== undefined ? (opts.strokeWidth ?? 2) : 0;
    const size = Math.ceil(R * 2 + sw * 2 + 4);
    const c = size / 2;
    const pts: Phaser.Types.Math.Vector2Like[] = [];
    for (let i = 0; i < n * 2; i++) {
      const rad = i % 2 === 0 ? R : inner;
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      pts.push({ x: c + Math.cos(a) * rad, y: c + Math.sin(a) * rad });
    }
    const g = gfx(scene);
    if (opts.stroke !== undefined) g.lineStyle(sw, opts.stroke, 1);
    g.fillStyle(opts.color ?? 0xffe08a, 1);
    g.fillPoints(pts, true);
    if (opts.stroke !== undefined) g.strokePoints(pts, true);
    g.generateTexture(key, size, size);
    g.destroy();
    return key;
  },

  /** Tiny soft square — the default particle / spark texture. */
  spark(
    scene: Phaser.Scene,
    key: string,
    opts: ShapeOpts & { size?: number } = {},
  ): string {
    if (has(scene, key)) return key;
    const s = opts.size ?? 8;
    const g = gfx(scene);
    g.fillStyle(opts.color ?? 0xffffff, 1);
    g.fillRoundedRect(0, 0, s, s, s * 0.3);
    g.generateTexture(key, s, s);
    g.destroy();
    return key;
  },
};

export default Shapes;
