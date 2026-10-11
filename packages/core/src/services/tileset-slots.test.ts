import { describe, expect, it } from 'vitest';
import { BLOB_CLAIMED_INDICES, BLOB_LAYOUT } from './tileset-processor.js';
import { FILL_VARIANT_SLOTS, MARKER_SLOTS } from './tileset-procedural.js';

/**
 * The 7x7 atlas is shared by three writers: the blob layout (terrain shapes the
 * AutoTiler selects), the fill variants, and the role markers. Nothing enforced
 * that they claimed different cells, and they did not - hazard and pickup sat on
 * indices 37 and 38, which are T_BOTTOM. Maps that asked for a bottom T-junction
 * got a hazard stripe rendered as ground, 6 to 8 times per level, in every game
 * generated after markers landed. Build and smoke both passed.
 */
describe('atlas slot allocation', () => {
  const overlays = [
    ...FILL_VARIANT_SLOTS.map((i) => ['fill variant', i] as const),
    ...Object.entries(MARKER_SLOTS).map(
      ([r, i]) => [`${r} marker`, i] as const,
    ),
  ];

  // A fill variant IS allowed to be the two centre cells - varying the centre
  // fill is the whole point - but nothing else the layout claims.
  const CENTRES = new Set([BLOB_LAYOUT.CENTER, BLOB_LAYOUT.CENTER_ALT]);

  it.each(FILL_VARIANT_SLOTS.map((i) => [i]))(
    'fill variant at index %i is a centre cell or an unclaimed one',
    (index) => {
      expect(CENTRES.has(index) || !BLOB_CLAIMED_INDICES.has(index)).toBe(true);
    },
  );

  it.each(Object.entries(MARKER_SLOTS))(
    '%s marker at index %i sits outside the blob layout',
    (_role, index) => {
      expect(BLOB_CLAIMED_INDICES.has(index)).toBe(false);
    },
  );

  it('overlays do not collide with each other', () => {
    const seen = new Map<number, string>();
    for (const [what, index] of overlays) {
      expect(seen.get(index), `index ${index} claimed twice`).toBeUndefined();
      seen.set(index, what);
    }
  });

  it('every overlay index is inside the atlas', () => {
    for (const [, index] of overlays) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(49);
    }
  });
});
