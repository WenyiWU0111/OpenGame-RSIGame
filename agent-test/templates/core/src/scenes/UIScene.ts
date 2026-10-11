import Phaser from 'phaser';
import * as utils from '../utils';
import gameConfig from '../gameConfig.json';

/**
 * UI Scene - In-game HUD overlay (UNIVERSAL BASE)
 *
 * SKELETON-OWNED — DO NOT rewrite to hand-position HUD elements. The in-game HUD
 * is drawn by the fixed UI chrome (window.Chrome), which owns the layout so it
 * cannot overlap/clip. Your gameplay scene supplies DATA only:
 *   window.Chrome.hud.set([{icon,label,value,color}, ...], 'objective text')
 * Theme it via `uiPalette` in gameConfig.json, not by editing this scene.
 * This scene only mounts the chrome, applies the palette, and keeps the pause button.
 */
export default class UIScene extends Phaser.Scene {
  public currentGameSceneKey: string | null;
  public uiContainer: Phaser.GameObjects.DOMElement | null;

  constructor() {
    super({
      key: 'UIScene',
    });
    this.currentGameSceneKey = null;
    this.uiContainer = null;
  }

  /**
   * Receive game scene key from level scene
   * Called when level scene launches this UI scene
   */
  init(data: { gameSceneKey?: string }): void {
    this.currentGameSceneKey = data.gameSceneKey || null;
  }

  create(): void {
    // fixed UI chrome: mount + theme (game supplies HUD data via Chrome.hud.set)
    window.Chrome.mount();
    window.Chrome.theme((gameConfig as any).uiPalette || {});
    this.createDOMUI();
    this.setupPauseControls();
  }

  private _lastHud = '';

  /**
   * Auto-populate the fixed-chrome HUD from the gameplay scene. Zero per-game work:
   * reads the RL-contract fields (`this.player.health`, `this.score`). A game can
   * override by setting `this.hudFields` (an array of {icon,label,value,color}) and
   * optionally `this.hudObjective` on its gameplay scene — data only, never layout.
   */
  update(): void {
    const key = this.currentGameSceneKey;
    if (!key || !this.scene.isActive(key)) return;
    const gs = this.scene.get(key) as any;
    if (!gs) return;

    let fields: any[];
    if (Array.isArray(gs.hudFields)) {
      fields = gs.hudFields;
    } else {
      fields = [];
      const p = gs.player;
      if (p && typeof p.health === 'number') {
        const max = typeof p.maxHealth === 'number' ? p.maxHealth : 0;
        const hp = Math.max(0, Math.round(p.health));
        fields.push({
          icon: 'hp',
          label: 'HP',
          value: max && max <= 12 ? `${hp}/${max}` : hp,
          color: '#ff8f8f',
        });
      }
      if (typeof gs.score === 'number')
        fields.push({
          icon: 'score',
          label: 'SCORE',
          value: gs.score,
          color: '#ffe08a',
        });
    }
    const objective = gs.hudObjective || '';
    const sig = JSON.stringify(fields) + '|' + objective;
    if (sig === this._lastHud) return; // change-detection: no per-frame DOM churn
    this._lastHud = sig;
    if (fields.length) window.Chrome.hud.set(fields, objective);
  }

  /**
   * Setup pause button click and ESC key listener
   */
  private setupPauseControls(): void {
    this.time.delayedCall(100, () => {
      const pauseBtn = document.getElementById('pause-btn');
      if (pauseBtn) {
        pauseBtn.addEventListener('click', () => this.pauseGame());
      }
    });

    this.input.keyboard?.on('keydown-ESC', () => {
      this.pauseGame();
    });
  }

  /**
   * Pause the game and show pause menu
   */
  private pauseGame(): void {
    if (!this.currentGameSceneKey) return;

    const gameScene = this.scene.get(this.currentGameSceneKey);
    if (!gameScene || !this.scene.isActive(this.currentGameSceneKey)) return;

    this.scene.pause(this.currentGameSceneKey);
    this.scene.launch('PauseUIScene', {
      currentLevelKey: this.currentGameSceneKey,
    });
  }

  /**
   * The only DOM this scene owns is the universal pause button. The in-game HUD
   * is the fixed chrome (see update() + window.Chrome.hud) — do NOT add HUD elements
   * here, and do NOT provide a per-archetype UIScene that overwrites this file.
   */
  createDOMUI(): void {
    const uiHTML = `
      <div id="ui-container" class="fixed top-0 left-0 w-full h-full pointer-events-none z-[1000] font-retro p-4">
        <!-- Pause Button (universal) -->
        <button id="pause-btn" class="absolute top-4 right-4 px-4 py-2 bg-gray-800 bg-opacity-80 hover:bg-blue-600 text-white text-sm rounded-lg border-2 border-gray-600 hover:border-blue-400 transition-all duration-200 pointer-events-auto cursor-pointer" style="text-shadow: 2px 2px 0 #000;">
          PAUSE
        </button>
      </div>
    `;

    this.uiContainer = utils.initUIDom(this, uiHTML);
  }
}
