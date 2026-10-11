import Phaser from 'phaser';
import { screenSize, debugConfig, renderConfig } from './gameConfig.json';
import './styles/tailwind.css';
// Fixed UI chrome (skeleton-owned). Defines window.Chrome — HUD / how-to / end
// card / juice with layout the game CANNOT rewrite. See src/chrome/chrome.js.
import './chrome/chrome.js';

// Import scenes
import { Preloader } from './scenes/Preloader';
import { TitleScreen } from './scenes/TitleScreen';
import UIScene from './scenes/UIScene';
import { PauseUIScene } from './scenes/PauseUIScene';
import { VictoryUIScene } from './scenes/VictoryUIScene';
import { GameCompleteUIScene } from './scenes/GameCompleteUIScene';
import { GameOverUIScene } from './scenes/GameOverUIScene';
// RL/world-model training hook (keep this import — see src/rlenv.ts).
import { installRLEnv } from './rlenv';

// TODO: Import your level scenes here
// import { Level1Scene } from "./scenes/Level1Scene";
// import { Level2Scene } from "./scenes/Level2Scene";

const config: Phaser.Types.Core.GameConfig = {
  // CANVAS (2D) by default so the game runs headless (no GPU/WebGL needed) for
  // RL/world-model capture; add ?webgl=1 to the URL for WebGL in a real browser.
  type:
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('webgl') === '1'
      ? Phaser.AUTO
      : Phaser.CANVAS,
  width: screenSize.width.value,
  height: screenSize.height.value,
  backgroundColor: '#1a1a2e',
  parent: 'game-container',
  dom: {
    createContainer: true,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade: {
      fps: 120,
      // Tolerant: non-physics archetypes (e.g. grid_logic) override debugConfig
      // with their own debug flags and have no `debug` key — default to false.
      debug: (debugConfig as any).debug?.value ?? false,
      debugShowBody: (debugConfig as any).debug?.value ?? false,
      debugShowStaticBody: (debugConfig as any).debug?.value ?? false,
      debugShowVelocity: (debugConfig as any).debug?.value ?? false,
    },
  },
  pixelArt: renderConfig.pixelArt.value,
};

const game = new Phaser.Game(config);

// Strictly add scenes in the following order: Preloader, TitleScreen, level scenes, UI-related scenes

// Preloader: Load all game resources
game.scene.add('Preloader', Preloader, true);

// TitleScreen
game.scene.add('TitleScreen', TitleScreen);

// TODO: Add your level scenes here
// game.scene.add("Level1Scene", Level1Scene);
// game.scene.add("Level2Scene", Level2Scene);

// UI-related scenes
game.scene.add('UIScene', UIScene);
game.scene.add('PauseUIScene', PauseUIScene);
game.scene.add('VictoryUIScene', VictoryUIScene);
game.scene.add('GameCompleteUIScene', GameCompleteUIScene);
game.scene.add('GameOverUIScene', GameOverUIScene);

// Install the RL/world-model training hook (window.__rlenv). Generic across
// games — do not remove. See src/rlenv.ts.
installRLEnv(game);
