/**
 * Every case here is a real palette shape found in the corpus on 2026-08-24.
 *
 * The first two are the pair that matters: a game whose palette is complete but
 * wrapped, which was rendering factory defaults and must now pass, and a game
 * with no palette at all, which must be refused.
 */
import { describe, expect, it } from 'vitest';
import {
  checkPalette,
  paletteRepairPrompt,
  unwrapPalette,
} from './palette_gate.js';

/** grid-keys-D2-000, abridged: fourteen keys, all three CSS fields, wrapped. */
const WRAPPED_BUT_COMPLETE = {
  type: 'object',
  description: 'UI palette for the vault-keys grid puzzle',
  value: {
    bg: '#12161f',
    panel: '#1d2530',
    accent: '#7fd1ff',
    accent2: '#ffcc66',
    text: '#eaf2ff',
    danger: '#ff6b6b',
    warn: '#ffd54a',
    cornerStyle: 'sharp',
    shadowDepth: 'flat',
    spacing: 'compact',
    fontStyle: 'geometric-modern',
    hudCSS: '#pg-hud{height:auto}',
    howtoCSS: '.pg-panel{border-radius:6px}',
    endcardCSS: '.pg-panel{border:2px solid #7fd1ff}',
  },
};

/** platformer-basic-D1-000: per-field wrapping, which always worked. */
const PER_FIELD_WRAPPED = {
  bg: { value: '#263622', type: 'string', description: 'Warm base' },
  accent: { value: '#F4C85A', type: 'string', description: 'Gold' },
  fontStyle: { value: 'serif-storybook', type: 'string', description: 'Mood' },
  hudCSS: {
    value: '#pg-hud{min-height:56px}',
    type: 'string',
    description: '',
  },
};

const PLAIN = {
  bg: '#6B3F1D',
  accent: '#FFD34E',
  panel: '#FFF1C7',
  cornerStyle: 'round',
  hudCSS: '#pg-hud{border:4px solid var(--pg-accent)}',
};

describe('the palette a game actually ships', () => {
  it('accepts a complete palette that arrived wrapped whole', () => {
    const v = checkPalette(WRAPPED_BUT_COMPLETE);
    expect(v.ok).toBe(true);
    expect(v.wrapped).toBe(true);
    expect(v.filled.css).toBe(3);
    expect(v.filled.presets).toBe(4);
  });

  it('accepts per-field wrapping', () => {
    const v = checkPalette(PER_FIELD_WRAPPED);
    expect(v.ok).toBe(true);
    expect(v.filled.presets).toBe(1);
  });

  it('accepts plain strings', () => {
    expect(checkPalette(PLAIN).ok).toBe(true);
  });

  it('refuses a missing palette', () => {
    const v = checkPalette(undefined);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('bg');
    expect(v.problems.join(' ')).toContain('accent');
  });

  it('refuses an empty palette', () => {
    expect(checkPalette({}).ok).toBe(false);
  });

  it('refuses colours with no mood choice anywhere', () => {
    // The exact shape that renders as a factory default with a tinted canvas:
    // the game picked colours and stopped, so every overlay is still #0f1420.
    const v = checkPalette({ bg: '#101010', accent: '#ff0000' });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('factory defaults');
  });

  it('accepts colours plus a single preset', () => {
    // One deliberate axis is a real decision and must not be refused --
    // the gate exists to catch nothing, not to catch minimalism.
    const v = checkPalette({
      bg: '#101010',
      accent: '#ff0000',
      cornerStyle: 'sharp',
    });
    expect(v.ok).toBe(true);
  });
});

describe('alias spellings the generator actually emits', () => {
  it('counts `text` as ink and `muted` as dim', () => {
    const v = checkPalette({
      bg: '#111',
      accent: '#222',
      text: '#eee',
      muted: '#999',
      spacing: 'cozy',
    });
    expect(v.ok).toBe(true);
    // bg, accent, ink via text, dim via muted
    expect(v.filled.colours).toBe(4);
  });

  it('does not report an alias as an ignored key', () => {
    const v = checkPalette({
      bg: '#111',
      accent: '#222',
      success: '#0f0',
      spacing: 'cozy',
    });
    expect(v.ignoredKeys).not.toContain('success');
  });

  it('does not report accent2, which now has a slot', () => {
    // 60 of 84 games write it. It maps to --pg-accent2 as of 2026-08-24, so
    // reporting it as ignored would be stale advice.
    const v = checkPalette({
      bg: '#111',
      accent: '#222',
      accent2: '#333',
      spacing: 'cozy',
    });
    expect(v.ignoredKeys).not.toContain('accent2');
  });

  it('reports a key theme() still has no slot for', () => {
    // `purple` is real -- the hajimi palette declares it as a boba accent --
    // and chrome has nowhere to put it. Worth saying out loud, never fatal:
    // the game's own CSS usually hardcodes the hex anyway.
    const v = checkPalette({
      bg: '#111',
      accent: '#222',
      purple: '#8B5CFF',
      spacing: 'cozy',
    });
    expect(v.ignoredKeys).toContain('purple');
    expect(v.ok).toBe(true);
  });
});

describe('unwrapping is narrow on purpose', () => {
  it('unwraps only when every key belongs to the wrapper', () => {
    expect(unwrapPalette({ value: { bg: '#111' }, type: 'object' })).toEqual({
      bg: '#111',
    });
  });

  it('leaves a half-wrapped palette alone', () => {
    // Guessing at a mixed shape would be a different silent failure: the
    // sibling keys would vanish. Better to hand chrome what it was given.
    const mixed = { value: { bg: '#111' }, accent: '#222' };
    expect(unwrapPalette(mixed)).toEqual(mixed);
  });

  it('leaves a palette whose `value` is a colour alone', () => {
    const odd = { value: '#111', type: 'string' };
    expect(unwrapPalette(odd)).toEqual(odd);
  });

  it('does not recurse forever on a self-similar shape', () => {
    let deep: any = { bg: '#111' };
    for (let i = 0; i < 12; i++) deep = { value: deep, type: 'object' };
    expect(() => unwrapPalette(deep)).not.toThrow();
  });
});

describe('what the agent is told', () => {
  it('names the problems and forbids the wrapped shape', () => {
    const msg = paletteRepairPrompt('Vault Keys', checkPalette({}));
    expect(msg).toContain('uiPalette.bg is missing');
    expect(msg).toContain('PLAIN STRINGS');
    expect(msg).toContain('art_style.md');
    // it must not invite the agent to touch anything else
    expect(msg).toContain('Change NOTHING else');
  });
});
