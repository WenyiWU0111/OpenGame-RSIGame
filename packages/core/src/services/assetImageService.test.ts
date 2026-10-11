/**
 * @license
 * Copyright 2025 OpenGame Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { raiseToMinPixels, sniffImageMime } from './assetImageService.js';

// Measured against OpenRouter's bytedance-seed/seedream-5-0-lite, which
// refuses anything smaller with a 400 naming this exact number.
const SEEDREAM_MIN = 3_686_400;

describe('raiseToMinPixels', () => {
  it("raises the sprite path's 1024x1024, which seedream refuses outright", () => {
    // generate-assets.ts passes `req.size || '1024*1024'` = 1,048,576 px, and
    // the 400 it earns is not transient, so nothing upstream retries past it.
    expect(raiseToMinPixels('1024x1024', SEEDREAM_MIN)).toBe('1920x1920');
  });

  it('lands at or above the floor, never just below it', () => {
    for (const size of [
      '1024x1024',
      '512x512',
      '1024x512',
      '800x600',
      '64x64',
    ]) {
      const [w, h] = raiseToMinPixels(size, SEEDREAM_MIN)
        .split('x')
        .map(Number);
      expect(w * h).toBeGreaterThanOrEqual(SEEDREAM_MIN);
    }
  });

  it('keeps the aspect ratio the caller asked for', () => {
    // A 7x7 tile atlas is square and a banner is not; scaling one axis would
    // silently change what the caller gets back.
    const [w, h] = raiseToMinPixels('1024x512', SEEDREAM_MIN)
      .split('x')
      .map(Number);
    expect(w / h).toBeCloseTo(2, 1);
  });

  it('leaves a request that already clears the floor alone', () => {
    expect(raiseToMinPixels('2048x2048', SEEDREAM_MIN)).toBe('2048x2048');
    expect(raiseToMinPixels('4096x4096', SEEDREAM_MIN)).toBe('4096x4096');
  });

  it('is inert for providers with no minimum', () => {
    // Unset means unset: every provider that never had this problem must be
    // untouched, which is why the floor is env-driven and not a model table.
    expect(raiseToMinPixels('1024x1024', 0)).toBe('1024x1024');
    expect(raiseToMinPixels('1024x1024', NaN)).toBe('1024x1024');
  });

  it('passes a size it cannot parse straight through', () => {
    expect(raiseToMinPixels('auto', SEEDREAM_MIN)).toBe('auto');
    expect(raiseToMinPixels('', SEEDREAM_MIN)).toBe('');
  });
});

describe('sniffImageMime', () => {
  it('reads the container off the bytes rather than assuming png', () => {
    // seedream returns JPEG. The data URL used to say png regardless, so every
    // generated asset travelled with a label contradicting its own content.
    expect(sniffImageMime('/9j/4AAQSkZJRgABAQ')).toBe('image/jpeg');
    expect(sniffImageMime('iVBORw0KGgoAAAANS')).toBe('image/png');
    expect(sniffImageMime('R0lGODlhAQABAIAAA')).toBe('image/gif');
    expect(sniffImageMime('UklGRiQAAABXRUJQ')).toBe('image/webp');
  });

  it('falls back to png for anything it does not recognise', () => {
    expect(sniffImageMime('zzzz')).toBe('image/png');
  });
});
