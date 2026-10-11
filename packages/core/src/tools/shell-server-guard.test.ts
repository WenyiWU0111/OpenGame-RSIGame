/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The refusal that stops an agent blocking itself on a dev server.
 *
 * Seven of the eight shell calls that ran past twenty minutes across three
 * generation workers were `npm run dev` in the foreground -- a process built
 * never to exit, holding the tool for 25-35 minutes until a timeout or a
 * reaper ended it. One agent added `CHOKIDAR_USEPOLLING=1` on the way,
 * diagnosing a file-watching problem it did not have.
 *
 * THE HALF THAT MATTERS HERE IS THE PASSES. A rule that also blocks
 * `npm run build` would cost more than the seven hangs it prevents, and a
 * blocked build looks to the agent exactly like a broken toolchain. So the
 * cases below are weighted toward what must still get through.
 */
import { describe, expect, it } from 'vitest';

// Transcribed from shell.ts. The tool needs a Config to construct, and what
// is under test is the predicate, not the plumbing.
function longRunningServer(command: string): string | null {
  const bare = command.replace(/&&/g, '').trim();
  if (/&\s*$/.test(bare) || /\bnohup\b/.test(command)) return null;
  if (/\bdisown\b|\bsetsid\b/.test(command)) return null;
  const SERVERS: Array<[RegExp, string]> = [
    [/\b(npm|pnpm|yarn)\s+(run\s+)?dev\b/, 'npm run dev'],
    [/\b(npm|pnpm|yarn)\s+(run\s+)?(start|serve|preview)\b/, 'npm run start'],
    [/\bvite\b(?!\s+build)/, 'vite'],
    [/\bnext\s+dev\b/, 'next dev'],
    [/\bwebpack(-dev)?-server\b/, 'webpack-dev-server'],
    [/\bhttp-server\b/, 'http-server'],
    [/\bpython3?\s+-m\s+http\.server\b/, 'python -m http.server'],
  ];
  for (const [re, label] of SERVERS) if (re.test(command)) return label;
  return null;
}

describe('what must still be allowed', () => {
  // Every one of these is real work that the loop does constantly.
  it.each([
    'npm run build',
    'npm ci',
    'npm install',
    'npm test',
    'npx vite build',
    'npm run build && ls dist',
    'cat package.json',
    'godot --headless --path . --quit-after 5',
    'grep -r "dev" src/',
  ])('allows %s', (cmd) => {
    expect(longRunningServer(cmd)).toBeNull();
  });

  it('allows a server that was backgrounded, which is the correct form', () => {
    expect(longRunningServer('npm run dev &')).toBeNull();
    expect(longRunningServer('npm run dev > /tmp/d.log 2>&1 &')).toBeNull();
    expect(longRunningServer('nohup npm run dev')).toBeNull();
  });

  it('does not mistake && for backgrounding', () => {
    // `a && b` chains; it does not detach. This one MUST be refused, and an
    // earlier draft that stripped `&` characters naively would have passed it.
    expect(longRunningServer('npm ci && npm run dev')).toBe('npm run dev');
  });
});

describe('what must be refused', () => {
  it.each([
    ['npm run dev', 'npm run dev'],
    ['npm run dev -- --host 0.0.0.0', 'npm run dev'],
    ['CHOKIDAR_USEPOLLING=1 npm run dev -- --host 0.0.0.0', 'npm run dev'],
    ['npm run dev -- --host 127.0.0.1 --port 5180', 'npm run dev'],
    ['npx vite', 'vite'],
    ['python3 -m http.server 8080', 'python -m http.server'],
  ])('refuses %s', (cmd, label) => {
    expect(longRunningServer(cmd)).toBe(label);
  });

  it('refuses the exact commands that hung the fleet', () => {
    // Taken verbatim from the trajectories, with what each one cost.
    const observed = [
      'npm run dev -- --host 0.0.0.0', //                      28.1 min
      'npm run dev -- --host 127.0.0.1 --port 5180', //        29.9 min
      'CHOKIDAR_USEPOLLING=1 npm run dev -- --host 0.0.0.0', // 25.2 min
      'CHOKIDAR_USEPOLLING=true npm run dev -- --host 127.0.0.1 --port 5173',
    ];
    for (const cmd of observed) {
      expect(longRunningServer(cmd)).not.toBeNull();
    }
  });
});
