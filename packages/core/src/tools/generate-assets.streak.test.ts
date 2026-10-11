/**
 * The consecutive-stall counter, which is the part of the fallback that a live
 * run cannot easily exercise: it takes three slow calls in a row to reach the
 * limit, and the gateway is only slow when it feels like it.
 *
 * The behaviour under test, in the user's words: fall back for THIS call only,
 * try generation again next time, and after three consecutive stalls stop
 * trying. The trap in that spec is the word "consecutive" -- a call that
 * succeeds has to clear the count, or one bad patch condemns every later game
 * in the process.
 */
import { describe, expect, it, beforeEach } from 'vitest';

/**
 * The decision the tool makes at the top of `execute`, lifted out so it can be
 * tested without a Config, a workspace, or an image gateway. It is transcribed
 * from the implementation rather than imported because the real one is a
 * private static on an invocation class that needs all three to construct.
 */
class StreakModel {
  streak = 0;

  /** @returns whether this call starts in library mode */
  startCall(forcedLibrary: boolean, limit = 3): boolean {
    return forcedLibrary || this.streak >= limit;
  }

  endCall(forcedLibrary: boolean, fellBack: boolean, limit = 3): void {
    if (forcedLibrary) return;
    const exhausted = this.streak >= limit;
    if (fellBack) {
      this.streak += 1;
    } else if (!exhausted) {
      this.streak = 0;
    }
  }
}

describe('asset stall streak', () => {
  let m: StreakModel;
  beforeEach(() => {
    m = new StreakModel();
  });

  it('falls back for this call only, and tries again on the next', () => {
    expect(m.startCall(false)).toBe(false);
    m.endCall(false, true); //  stalled
    expect(m.streak).toBe(1);
    // The next call must still attempt generation -- a queue that cleared
    // should be used.
    expect(m.startCall(false)).toBe(false);
  });

  it('stops trying after three consecutive stalls', () => {
    for (let i = 0; i < 3; i++) {
      expect(m.startCall(false)).toBe(false);
      m.endCall(false, true);
    }
    expect(m.streak).toBe(3);
    expect(m.startCall(false)).toBe(true);
  });

  it('a call that generated its way through clears the streak', () => {
    m.endCall(false, true);
    m.endCall(false, true);
    expect(m.streak).toBe(2);
    m.endCall(false, false); //  a healthy call
    expect(m.streak).toBe(0);
    expect(m.startCall(false)).toBe(false);
  });

  it('two stalls then a good call does not reach the limit', () => {
    m.endCall(false, true);
    m.endCall(false, true);
    m.endCall(false, false);
    m.endCall(false, true);
    expect(m.startCall(false)).toBe(false);
  });

  it('once exhausted it stays exhausted, and library calls do not reset it', () => {
    for (let i = 0; i < 3; i++) m.endCall(false, true);
    expect(m.startCall(false)).toBe(true);
    // A call that STARTED in library mode did not stall and did not
    // generate; it must neither raise nor clear the count.
    m.endCall(false, false);
    expect(m.streak).toBe(3);
    expect(m.startCall(false)).toBe(true);
  });

  it('OPENGAME_ASSET_MODE=library is separate from the streak', () => {
    // Forcing library mode is a deployment choice, not evidence about the
    // gateway. It must not accumulate a streak that outlives the setting.
    m.endCall(true, false);
    m.endCall(true, false);
    m.endCall(true, false);
    m.endCall(true, false);
    expect(m.streak).toBe(0);
    expect(m.startCall(false)).toBe(false);
  });
});
