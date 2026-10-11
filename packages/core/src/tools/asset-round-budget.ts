/**
 * A per-round cap on how many images generate_game_assets may produce.
 *
 * WHY. An art round's repair session can spend its whole 30 minutes generating
 * images and never wire one in. It is then cut off holding no edited file, the
 * retry ladder reads that as a dead session, and the next attempt generates
 * another batch. Measured on one platformer round: three attempts, 63 images,
 * zero files edited, 96 minutes. Across 260 art rounds the median was 5 images
 * and the 90th percentile 21.
 *
 * OFF unless both are set, so every other caller of this tool is unchanged:
 *   OPENGAME_ASSET_ROUND_CAP  images allowed in one round (e.g. 20)
 *   OPENGAME_ASSET_LEDGER     JSON file shared by every attempt of that round
 *
 * The ledger counts files actually written, not files asked for, so a failed
 * generation does not spend budget. Requests are admitted in the order given
 * while their planned image count fits what is left; audio costs nothing.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export interface BudgetLedger {
  cap: number;
  used: number;
  events: Array<Record<string, unknown>>;
}

export interface BudgetConfig {
  cap: number;
  ledgerPath: string;
}

export function budgetFromEnv(env = process.env): BudgetConfig | null {
  const cap = parseInt(env['OPENGAME_ASSET_ROUND_CAP'] || '', 10);
  const ledgerPath = (env['OPENGAME_ASSET_LEDGER'] || '').trim();
  if (!Number.isFinite(cap) || cap <= 0 || !ledgerPath) return null;
  return { cap, ledgerPath };
}

export async function readLedger(cfg: BudgetConfig): Promise<BudgetLedger> {
  try {
    const raw = JSON.parse(await fs.readFile(cfg.ledgerPath, 'utf-8'));
    return {
      cap: cfg.cap,
      used: Number(raw.used) || 0,
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  } catch {
    return { cap: cfg.cap, used: 0, events: [] };
  }
}

export async function writeLedger(
  cfg: BudgetConfig,
  ledger: BudgetLedger,
): Promise<void> {
  await fs.mkdir(path.dirname(cfg.ledgerPath), { recursive: true });
  const tmp = `${cfg.ledgerPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 1));
  await fs.rename(tmp, cfg.ledgerPath);
}

/** Split requests into what fits the remaining budget and what does not. */
export function admit<T>(
  requests: T[],
  cost: (r: T) => number,
  remaining: number,
): { granted: T[]; refused: T[]; planned: number } {
  const granted: T[] = [];
  const refused: T[] = [];
  let planned = 0;
  for (const r of requests) {
    const c = Math.max(0, cost(r));
    if (c === 0 || planned + c <= remaining) {
      granted.push(r);
      planned += c;
    } else {
      refused.push(r);
    }
  }
  return { granted, refused, planned };
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** Image files under `dir` modified at or after `sinceMs`. */
export async function imagesWrittenSince(
  dir: string,
  sinceMs: number,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(p);
      } else if (IMAGE_EXT.test(e.name)) {
        try {
          const st = await fs.stat(p);
          if (st.mtimeMs >= sinceMs) out.push(p);
        } catch {
          /* vanished */
        }
      }
    }
  }
  await walk(dir);
  return out;
}

export function balanceLine(cap: number, before: number, made: number): string {
  const used = before + made;
  return (
    `IMAGE BUDGET THIS ROUND: at most ${cap} new images. ` +
    `Used before this call: ${before}. This call produced: ${made}. ` +
    `Remaining: ${Math.max(0, cap - used)}.`
  );
}
