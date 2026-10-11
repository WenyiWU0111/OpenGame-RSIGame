import Phaser from 'phaser';
import { LevelManager } from '../LevelManager.js';

/**
 * Victory UI Scene - Level Complete Screen
 *
 * SKELETON-OWNED — DO NOT rewrite the UI. The fixed UI chrome (window.Chrome)
 * renders the end card with a layout the game cannot break. This scene only
 * keeps: win/lose scene-state (so the RL hook detects the win) + the
 * next-level transition. To theme it, set the palette in gameConfig, not here.
 */
export class VictoryUIScene extends Phaser.Scene {
  private currentLevelKey: string | null;
  private uiContainer: Phaser.GameObjects.DOMElement | null;
  private enterKey?: Phaser.Input.Keyboard.Key;
  private spaceKey?: Phaser.Input.Keyboard.Key;
  private _transitioning: boolean;

  constructor() {
    super({
      key: 'VictoryUIScene',
    });
    this.currentLevelKey = null;
    this.uiContainer = null;
    this._transitioning = false;
  }

  /**
   * Receive current level key from game scene
   */
  init(data: { currentLevelKey?: string }) {
    this.currentLevelKey = data.currentLevelKey || null;
    // Reset every fresh launch — Phaser reuses this scene instance across
    // level completions, so a stale true here would silently no-op the next
    // goToNextLevel() (e.g. level2 -> level3 after level1 -> level2 already ran).
    this._transitioning = false;
  }

  create(): void {
    // Create DOM UI
    this.createDOMUI();
    // Setup input controls
    this.setupInputs();
  }

  /**
   * SKELETON-OWNED — renders via the fixed UI chrome. Do NOT rewrite. The score
   * is read from the level scene's `this.score` (the RL contract field).
   */
  createDOMUI(): void {
    const level = this.currentLevelKey
      ? (this.scene.get(this.currentLevelKey) as any)
      : null;
    const score = level && level.score != null ? level.score : 0;
    window.Chrome.endcard.show({
      win: true,
      title: 'LEVEL COMPLETE',
      score,
      onNext: () => this.goToNextLevel(),
    });
  }

  /**
   * Standard input setup - DO NOT MODIFY
   */
  setupInputs(): void {
    // Clear previous event listeners
    this.input.off('pointerdown');

    // Create keyboard input
    this.enterKey = this.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.ENTER,
    );
    this.spaceKey = this.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.SPACE,
    );

    // Listen for mouse click events
    this.input.on('pointerdown', () => this.goToNextLevel());

    // Listen for key events
    this.enterKey.on('down', () => this.goToNextLevel());
    this.spaceKey.on('down', () => this.goToNextLevel());
  }

  /**
   * Transition to next level - DO NOT MODIFY structure
   */
  goToNextLevel(): void {
    if (this._transitioning) return; // keyboard + endcard button both call this
    this._transitioning = true;
    window.Chrome.endcard.hide();
    // Use LevelManager to get next level info
    const nextLevelKey = LevelManager.getNextLevelScene(this.currentLevelKey!);
    if (!nextLevelKey) {
      // No next level -- fall back to GameCompleteUIScene
      this.scene.stop('UIScene');
      this.scene.stop(this.currentLevelKey!);
      this.scene.stop('VictoryUIScene');
      this.scene.start('GameCompleteUIScene', {
        currentLevelKey: this.currentLevelKey,
      });
      return;
    }

    // Get current level scene to stop background music
    const currentScene = this.scene.get(this.currentLevelKey!) as any;

    // Stop current level's background music
    if (currentScene?.backgroundMusic) {
      currentScene.backgroundMusic.stop();
    }

    // Clear event listeners
    this.input.off('pointerdown');
    if (this.enterKey) {
      this.enterKey.off('down');
    }
    if (this.spaceKey) {
      this.spaceKey.off('down');
    }

    // Stop all game-related scenes
    this.scene.stop('UIScene');
    this.scene.stop(this.currentLevelKey!);
    this.scene.stop('VictoryUIScene');

    // Start next level
    this.scene.start(nextLevelKey);
  }

  update(): void {
    // Victory UI scene doesn't need special update logic
  }
}
