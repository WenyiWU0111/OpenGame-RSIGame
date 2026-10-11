import Phaser from 'phaser';
import { LevelManager } from '../LevelManager.js';

/**
 * Game Over UI Scene - Death/Failure Screen
 * This file is a STANDARD TEMPLATE
 *
 * Displayed when player dies or fails the level.
 * Restarts current level on Enter/Space/Click.
 *
 * CALLER CONTRACT (when launching this scene):
 *   this.scene.launch('GameOverUIScene', { currentLevelKey: this.scene.key });
 *   OR: { gameSceneKey: this.scene.key }  (both accepted)
 *
 * Fallback: LevelManager.getFirstLevelScene() when no key passed.
 * Requires: LevelManager.LEVEL_ORDER populated, TitleScreen registered.
 *
 * SKELETON-OWNED — DO NOT rewrite the UI. The fixed UI chrome renders the end card.
 */
export class GameOverUIScene extends Phaser.Scene {
  private currentLevelKey: string | null;
  private isRestarting: boolean;
  private uiContainer: Phaser.GameObjects.DOMElement | null;
  private enterKey?: Phaser.Input.Keyboard.Key;
  private spaceKey?: Phaser.Input.Keyboard.Key;
  private _transitioning: boolean;

  constructor() {
    super({
      key: 'GameOverUIScene',
    });
    this.currentLevelKey = null;
    this.isRestarting = false;
    this.uiContainer = null;
    this._transitioning = false;
  }

  /**
   * Receive game scene key from caller.
   * Accepts currentLevelKey or gameSceneKey (callers may use either).
   * Fallback: LevelManager.getFirstLevelScene() for robustness.
   */
  init(data?: { currentLevelKey?: string; gameSceneKey?: string }): void {
    this.currentLevelKey =
      data?.currentLevelKey ??
      data?.gameSceneKey ??
      LevelManager.getFirstLevelScene();
    this.isRestarting = false;
    // Reset every fresh launch — Phaser reuses this scene instance across
    // deaths, so a stale true here would silently no-op the next restartGame().
    this._transitioning = false;
  }

  create(): void {
    // Create DOM UI
    this.createDOMUI();
    // Setup input controls
    this.setupInputs();
  }

  /** SKELETON-OWNED: read the gameplay score (this.score, the RL contract field). */
  private _score(): number {
    for (const s of this.scene.manager.getScenes(false)) {
      const v = (s as any).score;
      if (typeof v === 'number') return v;
    }
    return 0;
  }

  /** SKELETON-OWNED — renders via the fixed UI chrome. Do NOT rewrite. */
  createDOMUI(): void {
    window.Chrome.endcard.show({
      win: false,
      title: 'GAME OVER',
      score: this._score(),
      onNext: () => this.restartGame(),
    });
  }

  /**
   * Standard input setup - pointer always works; keyboard if available
   */
  setupInputs(): void {
    this.input.off('pointerdown');
    this.input.on('pointerdown', () => this.restartGame());

    if (this.input.keyboard) {
      this.enterKey = this.input.keyboard.addKey(
        Phaser.Input.Keyboard.KeyCodes.ENTER,
      );
      this.spaceKey = this.input.keyboard.addKey(
        Phaser.Input.Keyboard.KeyCodes.SPACE,
      );
      this.enterKey.on('down', () => this.restartGame());
      this.spaceKey.on('down', () => this.restartGame());
    }
  }

  /**
   * Restart current level - robust against missing/invalid scene key.
   * Stops BGM (backgroundMusic or bgm) before restart.
   */
  restartGame(): void {
    if (this._transitioning) return;
    this._transitioning = true;
    window.Chrome.endcard.hide();
    if (this.isRestarting) return;
    this.isRestarting = true;

    let keyToRestart =
      this.currentLevelKey ?? LevelManager.getFirstLevelScene();
    if (!keyToRestart) {
      this.safeReturnToTitleOrFirstLevel();
      return;
    }

    const sceneExists = !!this.scene.get(keyToRestart);
    if (!sceneExists) {
      const fallback = LevelManager.getFirstLevelScene();
      if (fallback && this.scene.get(fallback)) {
        keyToRestart = fallback;
      } else {
        this.safeReturnToTitleOrFirstLevel();
        return;
      }
    }

    this.stopBgmAndCleanup(keyToRestart);
    this.scene.stop('UIScene');
    this.scene.stop(keyToRestart);
    this.scene.stop('GameOverUIScene');
    this.scene.start(keyToRestart);
  }

  /** Stop BGM (supports both backgroundMusic and bgm property names) */
  private stopBgmAndCleanup(sceneKey: string): void {
    const scene = this.scene.get(sceneKey) as unknown as
      | Record<string, unknown>
      | undefined;
    const bgm = scene?.backgroundMusic ?? scene?.bgm;
    if (bgm && typeof (bgm as { stop?: () => void }).stop === 'function') {
      (bgm as { stop: () => void }).stop();
    }
    this.input.off('pointerdown');
    if (this.enterKey) this.enterKey.off('down');
    if (this.spaceKey) this.spaceKey.off('down');
  }

  /** Fallback when no valid level to restart - go to TitleScreen or first level */
  private safeReturnToTitleOrFirstLevel(): void {
    const firstLevel = LevelManager.getFirstLevelScene();
    const target = this.scene.get('TitleScreen')
      ? 'TitleScreen'
      : firstLevel && this.scene.get(firstLevel)
        ? firstLevel
        : null;
    if (!target) {
      console.error(
        'GameOverUIScene: No TitleScreen or level scene found. Cannot restart.',
      );
      this.isRestarting = false;
      return;
    }
    this.input.off('pointerdown');
    if (this.enterKey) this.enterKey.off('down');
    if (this.spaceKey) this.spaceKey.off('down');
    this.scene.stop('UIScene');
    this.scene.stop('GameOverUIScene');
    this.scene.start(target);
  }

  update(): void {
    // Game Over UI scene doesn't need special update logic
  }
}
