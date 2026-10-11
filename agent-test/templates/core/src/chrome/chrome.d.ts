// Types for the fixed UI chrome (window.Chrome). See chrome.js.
export interface HudField {
  icon?: string;
  label?: string;
  value: string | number;
  color?: string;
}
/**
 * Everything `theme()` reads. This used to list eight colours and stop, while
 * custom.md told agents to write `text`, `cornerStyle`, `fontStyle`, `hudCSS`
 * and the rest — none of which were declared. It never produced a compile
 * error only because UIScene.ts passes the palette through `as any`, so the
 * gap sat behind a cast instead of showing up as a type error.
 */
export interface ChromePalette {
  /* colours */
  bg?: string;
  accent?: string;
  /** Second accent. Exposed as `--pg-accent2` for the free-CSS fields to use;
   *  nothing in chrome's own stylesheet reads it. */
  accent2?: string;
  ink?: string;
  panel?: string;
  good?: string;
  warn?: string;
  danger?: string;
  gold?: string;
  /** HUD stat labels (`--pg-dim`). */
  dim?: string;
  /* spellings theme() accepts for the slots above; the canonical key wins if
     both are present */
  text?: string;
  muted?: string;
  success?: string;
  warning?: string;
  error?: string;
  /* bounded presets */
  cornerStyle?: 'sharp' | 'soft' | 'round';
  shadowDepth?: 'flat' | 'soft' | 'deep';
  spacing?: 'compact' | 'cozy' | 'spacious';
  fontStyle?:
    | 'default'
    | 'serif-storybook'
    | 'pixel-retro'
    | 'geometric-modern'
    | 'rounded-playful';
  /* free CSS over the elements chrome renders */
  hudCSS?: string;
  howtoCSS?: string;
  endcardCSS?: string;
}
export interface ChromeAPI {
  mount(container?: HTMLElement): void;
  theme(palette: ChromePalette): void;
  hud: {
    set(fields: HudField[], objective?: string): void;
    show(): void;
    hide(): void;
  };
  howto: {
    show(
      d: { title: string; controls: [string[], string][]; goal?: string },
      onStart?: () => void,
    ): void;
    hide(): void;
  };
  endcard: {
    show(d: {
      win: boolean;
      title?: string;
      score?: number | string;
      onNext?: () => void;
    }): void;
    hide(): void;
  };
  fx: {
    flash(): void;
    shake(): void;
    pop(x: number, y: number, text: string, color?: string): void;
    /** Particle burst — N colored dots fly out radially (impact / collect / kill). */
    burst(x: number, y: number, color?: string, count?: number): void;
    /** Expanding shockwave ring (landing / explosion / big pickup). */
    ring(x: number, y: number, color?: string): void;
    /** Celebration confetti fall (win / level clear). Fired automatically on a win endcard. */
    confetti(count?: number): void;
  };
  sfx: ((name: string) => void) & {
    mute(m: boolean): void;
    bgm(url: string, vol?: number): void;
  };
}
declare global {
  interface Window {
    Chrome: ChromeAPI;
  }
}
export {};
