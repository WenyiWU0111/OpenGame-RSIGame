import Phaser from 'phaser';

/**
 * Game Complete UI Scene - All Levels Completed Screen
 * This file is a STANDARD TEMPLATE
 *
 * Displayed when player completes the final level
 * Returns to title screen on Enter/Space/Click
 *
 * SKELETON-OWNED — DO NOT rewrite the UI. The fixed UI chrome renders the end card.
 */
export class GameCompleteUIScene extends Phaser.Scene {
  private currentLevelKey: string | null;
  private isTransitioning: boolean;
  private uiContainer: Phaser.GameObjects.DOMElement | null;
  private enterKey?: Phaser.Input.Keyboard.Key;
  private spaceKey?: Phaser.Input.Keyboard.Key;

  constructor() {
    super({
      key: 'GameCompleteUIScene',
    });
    this.currentLevelKey = null;
    this.isTransitioning = false;
    this.uiContainer = null;
  }

  /**
   * Receive current level key from game scene
   */
  init(data: { currentLevelKey?: string }) {
    this.currentLevelKey = data.currentLevelKey || 'Level1Scene';
    // Reset transition flag
    this.isTransitioning = false;
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
    window.Chrome.endcard.show({ win: true, title: 'YOU WIN!', score: this._score(), onNext: () => this.returnToMenu() });
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
    this.input.on('pointerdown', () => this.returnToMenu());

    // Listen for key events
    this.enterKey.on('down', () => this.returnToMenu());
    this.spaceKey.on('down', () => this.returnToMenu());
  }

  /**
   * Return to title screen - DO NOT MODIFY structure
   */
  returnToMenu(): void {
    // Prevent multiple triggers
    if (this.isTransitioning) return;
    this.isTransitioning = true;
    window.Chrome.endcard.hide();

    console.log('Returning to title screen');

    // Stop current level's background music
    const currentScene = this.scene.get(this.currentLevelKey!) as any;
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

    // Start title screen
    this.scene.start('TitleScreen');
  }

  update(): void {
    // Game Complete UI scene doesn't need special update logic
  }
}
