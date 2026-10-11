/**
 * The rule that decides a session has hung, tested without a model.
 *
 * `runAgent` needs a real SDK stream, so what is under test here is the
 * decision itself, transcribed from the loop: which budget applies, and
 * whether the elapsed silence has passed it. Getting THAT wrong is the
 * expensive mistake -- a budget that never fires leaves the 30-minute stall in
 * place, and one that fires early kills a `generate_game_assets` call that was
 * working.
 *
 * The numbers come from 13,204 real gaps between trajectory records:
 *   waiting on a model  p99 1.1 min, and 13 of 6,839 gaps passed five minutes
 *   a tool in flight    p99 16 min, longest 102 min, 81 of the 87 long ones
 *                       being generate_game_assets
 */
import { describe, expect, it } from 'vitest';

const MODEL_SILENCE_MS = 5 * 60_000;
const TOOL_SILENCE_MS = 25 * 60_000;

/** Transcribed from the interval in runAgent. */
function hung(quietMs: number, toolsInFlight: number): boolean {
  const limit = toolsInFlight ? TOOL_SILENCE_MS : MODEL_SILENCE_MS;
  return quietMs >= limit;
}

const min = (m: number) => m * 60_000;

describe('the hang rule', () => {
  it('leaves a normal model wait alone', () => {
    // p99 of model waits is 1.1 min; this is well past it and still healthy.
    expect(hung(min(3), 0)).toBe(false);
  });

  it('abandons a model wait that passes five minutes', () => {
    // The observed hang: a `session` line and then nothing at all.
    expect(hung(min(6), 0)).toBe(true);
    expect(hung(min(30), 0)).toBe(true);
  });

  it('lets a slow tool run, which is what asset generation is', () => {
    // 81 of the 87 gaps over five minutes were generate_game_assets, and the
    // asset stall watchdog only gives up at ten minutes -- so a sixteen
    // minute call is work, not a fault.
    expect(hung(min(6), 1)).toBe(false);
    expect(hung(min(16), 1)).toBe(false);
    expect(hung(min(24), 1)).toBe(false);
  });

  it('still gives up on a tool that never returns', () => {
    expect(hung(min(26), 1)).toBe(true);
  });

  it('beats the external watchdog, which is the entire point', () => {
    // The reaper frees a stuck worker at 30 minutes. A limit at or above that
    // would change nothing.
    expect(MODEL_SILENCE_MS).toBeLessThan(min(30));
    expect(TOOL_SILENCE_MS).toBeLessThan(min(30));
  });
});

describe('the retry predicate', () => {
  // Copied from agent_run.ts. A silence that the retry does not recognise is
  // a session abandoned for good -- the fix would turn a 30-minute stall into
  // a lost game, which is worse.
  const TRANSPORT_FAULT_RE =
    /request body must be valid json|invalid_json|socket hang up|ECONNRESET|EPIPE|premature close|went silent for/i;

  it('retries an abandoned session', () => {
    expect(
      TRANSPORT_FAULT_RE.test(
        'the session went silent for 312s and was abandoned',
      ),
    ).toBe(true);
  });

  it('still retries the 400 that starts the whole sequence', () => {
    expect(
      TRANSPORT_FAULT_RE.test(
        '[API Error: 400 Request body must be valid JSON]',
      ),
    ).toBe(true);
  });

  it('does not retry a genuine failure', () => {
    expect(TRANSPORT_FAULT_RE.test('the build does not compile')).toBe(false);
  });
});
