/**
 * What generate_game_assets tells the agent when the image service's content
 * moderation refuses an asset.
 *
 * WHY. A moderation refusal is not a transient failure, but it arrived in the
 * same list as one, under an instruction that says "retry, a retry usually
 * succeeds". Measured on platformer-plumber-kingdom, the one game where it
 * happened: in every arm, about half of the generate calls came back
 *   Seedream blocked this request through content moderation.
 * and the agent re-requested the same hero sprites with reworded descriptions
 * again and again (one session asked for plumber_small/plumber_big three
 * times), spending its calls and its 30 minutes on it.
 *
 * The rule the agent is given: an asset refused once may be reworded ONCE; an
 * asset refused twice is not requested again -- change the design or take art
 * from the asset library. Refusals are counted per asset key in a file inside
 * the game (so they carry across calls, attempts and rounds).
 */
import * as fs from 'fs/promises';
import * as path from 'path';

const MODERATION = /content moderation/i;

/** Keys of the failed assets whose error is a moderation refusal. */
export function moderationKeys(errors: string[]): string[] {
  const keys: string[] = [];
  for (const e of errors) {
    const i = e.indexOf(':');
    if (i > 0 && MODERATION.test(e.slice(i + 1))) {
      const k = e.slice(0, i).trim();
      if (k && !keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

export async function recordRefusals(
  file: string,
  keys: string[],
): Promise<Record<string, number>> {
  let counts: Record<string, number> = {};
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    if (raw && typeof raw === 'object') counts = raw;
  } catch {
    /* first refusal in this game */
  }
  for (const k of keys) counts[k] = (Number(counts[k]) || 0) + 1;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(counts, null, 1));
    await fs.rename(tmp, file);
  } catch {
    /* the message below still goes out; only the count is lost */
  }
  return counts;
}

export function moderationBlock(
  counts: Record<string, number>,
  keysNow: string[],
  libraryRoot: string,
): string {
  if (!keysNow.length) return '';
  const once = keysNow.filter((k) => (counts[k] || 0) <= 1);
  const again = keysNow.filter((k) => (counts[k] || 0) >= 2);
  const lines = [
    '',
    `🚫 REFUSED BY THE IMAGE SERVICE'S CONTENT MODERATION: ${keysNow.length} asset(s).`,
    'This is NOT a transient failure: the service refuses what the image depicts,',
    'so asking again with different words for the same picture is refused again.',
  ];
  for (const k of once) {
    lines.push(
      `  - ${k}: refused 1 time. You may reword it ONCE -- change what it looks like`,
      `    (colours, clothing, shape, what it resembles), not only the phrasing.`,
    );
  }
  for (const k of again) {
    lines.push(
      `  - ${k}: refused ${counts[k]} times. Do NOT request it again. Change the design`,
      `    so the game no longer needs this image, or copy art for it from the asset`,
      `    library: ${libraryRoot}  (2D/ has one directory per art pack).`,
    );
  }
  return lines.join('\n') + '\n';
}
