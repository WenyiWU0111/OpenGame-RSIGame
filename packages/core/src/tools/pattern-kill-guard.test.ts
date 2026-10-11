/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The refusal that stops an agent killing the run it belongs to.
 *
 * On 2026-09-01 a repair session tidying up after itself ran
 * `pkill -f gamedoctor; pkill -f godot`. Every process in this project has
 * `gamedoctor_run` in its path, so that line took the other four games running
 * beside it, both batch drivers and the supervising units -- six systemd
 * services inside 24 milliseconds. The blocked cases below are transcribed off
 * the process sampler that finally caught it.
 *
 * THE HALF THAT MATTERS IS THE PASSES. Stopping a process you started is
 * ordinary; a rule that also refused `kill 12345` would make every session that
 * launches a server unable to end one, and the agent cannot tell a blocked
 * command from a broken one.
 */
import { describe, expect, it } from 'vitest';

// Transcribed from shell.ts, and that transcription is why the guard shipped
// with a hole for months: the copy here kept testing the old predicate while
// the real one changed, so the suite stayed green over four live bypasses.
// Kept as a copy only because `patternKill` is module-private in shell.ts; if
// it is ever exported, import it and delete this.
function patternKill(command: string): string | null {
  if (/\bpkill\b/.test(command)) return 'pkill';
  if (/\bkillall\b/.test(command)) return 'killall';
  const killArgs = command.match(/\bkill\b([^|;&]*)/);
  if (killArgs) {
    const targets = killArgs[1]
      .replace(/(^|\s)-(?:[A-Z]+|\d{1,2})(?=\s|$)/g, ' ')
      .replace(/(^|\s)-s\s+\S+/g, ' ')
      .replace(/(^|\s)--(?=\s|$)/g, ' ');
    if (/(^|\s)-\d+(\s|$)/.test(targets)) return 'kill on a process group';
  }
  return null;
}

describe('patternKill', () => {
  describe('refuses what was actually found running', () => {
    const REAL = [
      'pkill -f gamedoctor',
      "{ pkill -f gamedoctor 2>/dev/null; pkill -f 'godot' 2>/dev/null; sleep 1; }",
      'pkill -f godot',
      'pkill -f "godot" 2>/dev/null; sleep 1; pgrep -fl godot; echo cleaned',
      'kill -- -3845306 2>/dev/null',
      'kill -- -4023841 2>/dev/null; sleep 2; godot --headless --path . --quit',
      'pkill -g 4024018 2>/dev/null',
      // QUOTED SPANS THAT EXECUTE. The guard used to blank quoted text before
      // matching, so every one of these ran. Reported 2026-09-05 by the Godot
      // case-study session after a wide pkill wiped its batch three times in
      // one night.
      'sh -c "pkill -f godot"',
      "bash -c 'killall godot'",
      'python3 -c \'subprocess.run(["pkill", "-f", "godot"])\'',
      "python -c \"import subprocess; subprocess.run(['pkill', '-f', 'godot'])\"",
      // SIGNAL-THEN-GROUP. The old pattern wanted a bare `-` or `--` right
      // before the number, so the two spellings people actually type both got
      // through. Three epoch-4 lines died to the same second, three times.
      'kill -9 -1234',
      'kill -TERM -1234',
      'kill -s TERM -1234',
      'kill -1234',
    ];
    for (const cmd of REAL) {
      it(`blocks: ${cmd.slice(0, 60)}`, () => {
        expect(patternKill(cmd)).not.toBeNull();
      });
    }
  });

  // DELIBERATELY NOT HERE: `echo "do not run pkill -f godot"` and
  // `grep -rn 'pkill' scripts/`. Both are harmless, and both are now refused.
  //
  // They are the price of matching the raw command. Letting them pass requires
  // ignoring quoted text, and ignoring quoted text is exactly what let
  // `sh -c "pkill -f godot"` execute. An agent that wanted to echo the word can
  // rephrase; a batch that someone else was running for six hours cannot.
  describe('lets ordinary work through', () => {
    const OK = [
      'kill 12345',
      'kill -9 12345',
      'kill -TERM 3903579',
      'kill $pid',
      'kill "$SERVER_PID"',
      // Looking is not killing, and it is how a pid is found.
      'pgrep -f godot',
      'pgrep -fl godot',
      'pgrep -P 12345',
      'ps -eo pid,args | grep godot',
      // Negative numbers that are not process groups.
      'awk "$1 > -5" file.txt',
    ];
    for (const cmd of OK) {
      it(`allows: ${cmd.slice(0, 60)}`, () => {
        expect(patternKill(cmd)).toBeNull();
      });
    }
  });
});
