/**
 * Refuse a game that ships no usable `uiPalette`.
 *
 * WHY A GATE AND NOT A PROMPT LINE. custom.md already explains the palette over
 * ~180 lines, ending with "Omitting any of these is fine — each defaults to the
 * value that reproduces the original look." It is accurate and it is why a
 * third of the corpus omits everything: the model is told the default is
 * acceptable, so on a long generation it is the first thing dropped. A default
 * palette is not a design decision, though — it is #0f1420 navy, #161a26
 * panels, Arial, and a cyan kicker, identical on every game that skipped the
 * step. Nothing downstream catches it either: the D4 layout checks measure
 * rendered geometry (overflow, clipping), and a factory-default card is laid
 * out perfectly.
 *
 * WHAT IT DOES NOT DO. It never fails the run. A palette is worth one extra
 * agent turn, not thirty minutes of generation thrown away, so it feeds the
 * existing smoke→repair loop and the game continues either way.
 *
 * THE BAR IS SET WHERE THE DATA IS BIMODAL. Measured over 83 games on
 * 2026-08-24: games fill either all three free-CSS fields or none — 0 or 3,
 * never 1 or 2 — and the same 26 have every preset unset. So a bar anywhere
 * between "nothing" and "something" separates the two populations cleanly and
 * cannot catch a game that made a real but minimal choice, because such a game
 * has set at least one preset.
 */

/** Colour keys `Chrome.theme()` actually reads, canonical names only. */
export const THEME_COLOURS = [
  'bg',
  'accent',
  'ink',
  'good',
  'warn',
  'danger',
  'gold',
  'panel',
  'dim',
  'accent2',
] as const;

/** Spellings theme() accepts as an existing slot. */
export const THEME_ALIASES: Record<string, string> = {
  text: 'ink',
  muted: 'dim',
  success: 'good',
  warning: 'warn',
  error: 'danger',
};

export const PRESET_KEYS = [
  'cornerStyle',
  'shadowDepth',
  'spacing',
  'fontStyle',
] as const;
export const CSS_KEYS = ['hudCSS', 'howtoCSS', 'endcardCSS'] as const;

const WRAPPER_KEYS = new Set(['value', 'type', 'description']);

/** One field, which may be a bare string or `{value, type, description}`. */
export function unwrap(v: unknown): string {
  if (v && typeof v === 'object' && 'value' in (v as any)) {
    const inner = (v as any).value;
    return typeof inner === 'string' ? inner : '';
  }
  return typeof v === 'string' ? v : '';
}

/**
 * The whole palette, which may itself be wrapped.
 *
 * Mirrors `unwrapPalette` in templates/core/src/chrome/chrome.js, including its
 * narrowness: only when EVERY key belongs to the wrapper signature and `value`
 * is an object. The gate has to see exactly what chrome will see — a checker
 * that unwrapped more eagerly than the runtime would pass palettes the game
 * then fails to apply, which is worse than no checker.
 */
export function unwrapPalette(p: unknown): Record<string, unknown> {
  let cur: any = p;
  for (let depth = 0; depth < 4; depth++) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return {};
    const keys = Object.keys(cur);
    const onlyWrapper = keys.every((k) => WRAPPER_KEYS.has(k));
    if (!onlyWrapper || !cur.value || typeof cur.value !== 'object') {
      return cur as Record<string, unknown>;
    }
    cur = cur.value;
  }
  return cur as Record<string, unknown>;
}

export interface PaletteVerdict {
  ok: boolean;
  problems: string[];
  /** Keys written that theme() will still ignore — reported, never fatal. */
  ignoredKeys: string[];
  filled: { colours: number; presets: number; css: number };
  wrapped: boolean;
}

export function checkPalette(raw: unknown): PaletteVerdict {
  const wrapped = unwrapPalette(raw);
  const wasWrapped =
    !!raw &&
    typeof raw === 'object' &&
    Object.keys(raw as object).length > 0 &&
    Object.keys(raw as object).every((k) => WRAPPER_KEYS.has(k));

  const get = (k: string): string => {
    const direct = unwrap(wrapped[k]);
    if (direct) return direct;
    for (const [alias, canon] of Object.entries(THEME_ALIASES)) {
      if (canon === k) {
        const v = unwrap(wrapped[alias]);
        if (v) return v;
      }
    }
    return '';
  };

  const colours = THEME_COLOURS.filter((k) => get(k)).length;
  const presets = PRESET_KEYS.filter((k) => unwrap(wrapped[k])).length;
  const css = CSS_KEYS.filter((k) => unwrap(wrapped[k]).trim()).length;

  const problems: string[] = [];
  // bg and accent alone decide factory-vs-themed: every other token has a
  // default that reads as neutral, these two are the navy and the cyan.
  if (!get('bg')) problems.push('uiPalette.bg is missing or empty');
  if (!get('accent')) problems.push('uiPalette.accent is missing or empty');
  if (presets === 0 && css === 0) {
    problems.push(
      'none of cornerStyle / shadowDepth / spacing / fontStyle is set and no ' +
        'hudCSS / howtoCSS / endcardCSS is written, so the chrome renders its ' +
        'factory defaults',
    );
  }

  const known = new Set<string>([
    ...THEME_COLOURS,
    ...Object.keys(THEME_ALIASES),
    ...PRESET_KEYS,
    ...CSS_KEYS,
  ]);
  const ignoredKeys = Object.keys(wrapped).filter((k) => !known.has(k));

  return {
    ok: problems.length === 0,
    problems,
    ignoredKeys,
    filled: { colours, presets, css },
    wrapped: wasWrapped,
  };
}

/**
 * Read a built game's palette off disk and judge it.
 *
 * A game with no `gameConfig.json` at all is refused for the same reason as an
 * empty palette -- chrome will render its defaults either way -- but the
 * problem says which of the two happened, because "the file is missing" and
 * "the file has no palette" call for different repairs.
 */
export async function checkPaletteAt(
  outputDir: string,
): Promise<PaletteVerdict> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const cfg = path.join(outputDir, 'src', 'gameConfig.json');
  let parsed: any;
  try {
    parsed = JSON.parse(await fs.readFile(cfg, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      problems: [
        `src/gameConfig.json could not be read (${String(e).slice(0, 80)})`,
      ],
      ignoredKeys: [],
      filled: { colours: 0, presets: 0, css: 0 },
      wrapped: false,
    };
  }
  return checkPalette(parsed?.uiPalette);
}

/** What the agent is told when the gate refuses. */
export function paletteRepairPrompt(
  gameName: string,
  verdict: PaletteVerdict,
): string {
  return (
    `The game you built for "${gameName}" runs, but it ships no usable UI ` +
    `palette:\n\n` +
    verdict.problems.map((p) => `    - ${p}`).join('\n') +
    `\n\nWithout one, every overlay renders the chrome's factory defaults — a ` +
    `#0f1420 navy panel, Arial, and a cyan "HOW TO PLAY" kicker — identical to ` +
    `every other game that skipped this step, and unrelated to this game's art ` +
    `direction.\n\n` +
    `Fill in \`uiPalette\` in \`src/gameConfig.json\`, taking the hex values ` +
    `from \`docs/art_style.md\` so the chrome matches the generated art. It ` +
    `needs, at minimum:\n` +
    `    - "bg" and "accent" (plus "panel" and "text" if the art guide has them)\n` +
    `    - one of "cornerStyle" / "shadowDepth" / "spacing" / "fontStyle" chosen ` +
    `for this game's visual mood\n` +
    `    - ideally "hudCSS" / "howtoCSS" / "endcardCSS" restyling the panels to ` +
    `match\n\n` +
    `Write the values as PLAIN STRINGS — \`"bg": "#6B3F1D"\`, not ` +
    `\`"bg": {"value": "#6B3F1D"}\` and not a palette wrapped in ` +
    `\`{"value": {...}}\`.\n\n` +
    `Change NOTHING else: no gameplay, no difficultyConfig, no scene files. ` +
    `Then run \`npm run build\`.`
  );
}
