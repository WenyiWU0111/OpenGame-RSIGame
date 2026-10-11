/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The refusal that stops an agent scanning the whole machine.
 *
 * On 2026-08-30 this host carried 21 abandoned `find /` processes, each pinned
 * to a core. The oldest had run 39 hours; 13 had outlived their session by over
 * a day and been reparented to init, so nothing was left to read their output.
 * Together they had burned 628 core-hours and found nothing. The blocked cases
 * below are those exact command lines, transcribed off `ps`.
 *
 * THE HALF THAT MATTERS HERE IS THE PASSES. `find` is the ordinary way to
 * locate a file, and a rule that also refused `find . -name '*.tscn'` would
 * cost far more than the 21 hangs it prevents -- to the agent a blocked search
 * is indistinguishable from a missing file. So the passing cases are weighted
 * toward what must still get through.
 */
import { describe, expect, it } from 'vitest';

// Transcribed from shell.ts. What is under test is the predicate, not the
// plumbing around it.
function wholeFilesystemScan(command: string): string | null {
  const bare = command.replace(/'[^']*'|"[^"]*"/g, ' ');
  if (/\bfind\s+\/(\s|$)/.test(bare)) return 'find /';
  if (/\bgrep\b[^|;]*\s-\w*r\w*\b[^|;]*\s\/(\s|$)/.test(bare)) {
    return 'grep -r /';
  }
  return null;
}

describe('wholeFilesystemScan', () => {
  describe('refuses what was actually found running', () => {
    const REAL = [
      'find / -name save.json -path *Mech*',
      'find / -name frame01.jpg -newer package.json -mmin -3',
      'find / -maxdepth 4 -name puppeteer -type d',
      'find / -name zone_debug.txt -newer /tmp/shot_zones2.png',
      'find / -name playwright -maxdepth 6 -type d',
      'find / -name frame01.jpg -newermt -5 minutes',
      'find / -maxdepth 6 -name "playwright*" -path "*node_modules*" -type d',
      'find / -maxdepth 6 -type d -name node_modules -path *playwright*',
      'find / -name "*.json" -path *repair_evidence* -newer package.json',
      'find / -name echo_climb_save.json',
      'find / -name PIL -maxdepth 6 -type d',
      'find / -name demo_debug.log -newer /workspace/game/project.godot',
      '{ ls node_modules | grep -iE "^(playwright|puppeteer)"; ' +
        'find / -maxdepth 6 -name "playwright*" -type d | head -3; }',
      'grep -rln "No click" / --include=*.py -m1',
    ];
    it.each(REAL)('refuses %s', (cmd) => {
      expect(wholeFilesystemScan(cmd)).not.toBeNull();
    });

    it('is not fooled by -maxdepth: the 39-hour one had it', () => {
      expect(wholeFilesystemScan('find / -maxdepth 6 -name x')).toBe('find /');
    });
  });

  describe('lets ordinary searches through', () => {
    const FINE = [
      "find . -name '*.tscn'",
      'find src -type f',
      "find /workspace/game -name '*.gd'",
      'find ./demo_outputs -name "*.json"',
      'find "$PWD" -maxdepth 2',
      'find /home/user -name x',
      'grep -rn "foo" src/',
      'grep -rn TODO .',
      'npm ls playwright',
      'which godot',
      'ls / && echo hi',
    ];
    it.each(FINE)('allows %s', (cmd) => {
      expect(wholeFilesystemScan(cmd)).toBeNull();
    });

    it('reads a quoted span as data, not as a command', () => {
      expect(wholeFilesystemScan('echo "find / -name x"')).toBeNull();
    });

    it('still catches a real scan whose pattern is quoted', () => {
      expect(wholeFilesystemScan('find / -name "playwright*" -type d')).toBe(
        'find /',
      );
    });
  });
});
