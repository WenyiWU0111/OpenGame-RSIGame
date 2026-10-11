/**
 * RL / world-model training hook (GENERIC — do not make game-specific).
 *
 * Exposes `window.__rlenv` so an external driver (Playwright + Python gym.Env /
 * eval harness) can read observations, detect win/lose, and deterministically
 * step ANY game built on this template — including archetypes that don't use a
 * classic `player` (grid puzzles, paddle/ball games).
 *
 * It does NOT hardcode game scene names. The active gameplay scene is "the one
 * active scene that isn't a boot/title/UI-overlay scene". The controllable
 * entity is found by convention (player / paddle / hero / ball / selected grid
 * entity). Win/lose is read from scene STATE (Victory/GameComplete/GameOver
 * overlays, or scene.gameCompleted/won/lost), so it generalizes even when there
 * is no `scene.player` (grid/bounce). This matches the eval harness's detection,
 * so both share one source of truth.
 *
 * Conventions the coding agent must keep (see prompts/custom.md RL contract):
 *   - gameplay scene exposes `this.player` (controllable entity with .x/.y;
 *     for grid = the player grid-entity, for paddle games = the paddle),
 *     `this.score` (number), and `this.enemies` (Group) if it has enemies.
 *   - win  -> start VictoryUIScene / GameCompleteUIScene (or set scene.gameCompleted)
 *   - lose -> start GameOverUIScene (or set scene.lost)
 *
 * Determinism: seed() seeds Phaser RNG AND overrides Math.random; tick(n)
 * detaches the RAF loop and advances exactly n frames at a fixed delta, so
 * (seed + action sequence) -> identical trajectory every run.
 */
import Phaser from 'phaser';

const FIXED_DT = 1000 / 60; // ms per frame; physics integrates against this

// Scenes that are NOT gameplay (boot / title / UI overlays / menus).
const OVERLAY_SCENES = new Set<string>([
  'Boot', 'Preloader', 'TitleScreen', 'UIScene', 'PauseUIScene',
  'VictoryScene', 'VictoryUIScene', 'GameOverUIScene', 'GameCompleteUIScene',
  'CharacterSelectScene', 'ChapterSelectScene',
]);

export function installRLEnv(game: Phaser.Game): void {
  let manual = false;
  let simTime = 0;

  // First ACTIVE scene that isn't a boot/title/UI overlay.
  const gameplayScene = (): any => {
    for (const s of game.scene.getScenes(true)) {
      if (!OVERLAY_SCENES.has((s as any).scene.key)) return s;
    }
    return null;
  };

  // Controllable entity by convention (player-first, with fallbacks so grid /
  // paddle games work too).
  const controllable = (s: any): any =>
    (s &&
      (s.player ?? s.paddle ?? s.hero ?? s.ball ?? s.selectedEntity ??
        (Array.isArray(s.entities) ? s.entities[0] : undefined))) || null;

  // Win/lose from scene state — archetype-agnostic (mirrors the eval harness).
  const status = (): { win: boolean; lose: boolean; running: boolean } => {
    const keys = game.scene.getScenes(true).map((x: any) => x.scene.key);
    const has = (k: string) => keys.includes(k);
    const s: any = gameplayScene();
    const win =
      has('VictoryUIScene') || has('VictoryScene') ||
      has('GameCompleteUIScene') || !!(s && (s.gameCompleted || s.won));
    const lose = has('GameOverUIScene') || !!(s && s.lost);
    return { win, lose, running: !win && !lose && !!s };
  };

  (window as unknown as { __rlenv: unknown }).__rlenv = {
    game,
    /** Gameplay scene is up (regardless of whether it exposes a player). */
    ready(): boolean {
      return !!gameplayScene();
    },
    /** Archetype-agnostic terminal detection: {win, lose, running}. */
    status,
    /** State observation. Non-null whenever a gameplay scene is active (even for
     *  grid/bounce with no player — player fields are 0 and hasPlayer=0). */
    observe(): unknown {
      const s: any = gameplayScene();
      if (!s) return null;
      const st = status();
      const p: any = controllable(s);
      const enemies: any[] = s.enemies?.getChildren?.() ?? [];
      let edx = 0, edy = 0, ealive = 0, best = Infinity;
      if (p) {
        for (const e of enemies) {
          if (!e || !e.active) continue;
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          if (d < best) { best = d; edx = e.x - p.x; edy = e.y - p.y; ealive = 1; }
        }
      }
      const hp = p?.health;
      return {
        px: p?.x ?? 0, py: p?.y ?? 0,
        vx: p?.body?.velocity?.x ?? 0, vy: p?.body?.velocity?.y ?? 0,
        onGround: p?.body?.onFloor?.() ? 1 : 0,
        hp: hp ?? 0, maxHp: p?.maxHealth ?? 100,
        score: s.score ?? 0,
        enemyDx: edx, enemyDy: edy, enemyAlive: ealive,
        hasPlayer: p ? 1 : 0,
        won: st.win ? 1 : 0, lost: st.lose ? 1 : 0,
        done: st.win || st.lose || (hp != null ? hp <= 0 : false),
      };
    },
    /** Runtime difficulty audit: count what the RUNNING game actually has, so an
     *  external auditor can cross-check against the DECLARED values in
     *  src/gameConfig.json's difficultyConfig (which the auditor reads from disk).
     *  config = what the agent SAID it would do; this = what it actually DID.
     *  All fields best-effort — 0/false when the game doesn't expose that group. */
    debugCounts(): unknown {
      const s: any = gameplayScene();
      if (!s) return null;
      const count = (g: any): number =>
        g?.getChildren ? g.getChildren().filter((e: any) => e && e.active).length
          : Array.isArray(g) ? g.length : 0;
      return {
        scene_key: s.scene.key,
        enemies: count(s.enemies),
        hazards: count(s.hazards ?? s.obstacles ?? s.spikes ?? s.traps),
        pickups: count(s.pickups ?? s.healthPickups ?? s.collectibles),
        has_timer: !!(s.timeLimit || s.timer || s.timeRemaining || s.timerText),
      };
    },
    /** Seed all RNG. Call BEFORE the gameplay scene is created (so spawns are
     *  deterministic) and again per episode. Overrides Math.random too. */
    seed(n: number): void {
      Phaser.Math.RND.sow([String(n)]);
      let s = (n >>> 0) || 1;
      Math.random = () => {
        // LCG (Numerical Recipes) -> [0,1)
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
    },
    /** Advance EXACTLY `frames` frames at a fixed delta (default 1/60s). Stops
     *  the real-time RAF loop on first call so stepping is wall-clock free and
     *  reproducible. */
    tick(frames: number, dt: number = FIXED_DT): void {
      if (!manual) {
        game.loop.stop(); // detach requestAnimationFrame; we drive manually now
        manual = true;
        simTime = game.loop.time || 0;
      }
      for (let i = 0; i < frames; i++) {
        simTime += dt;
        (game as any).step(simTime, dt);
      }
    },
  };
}
