/**
 * Batch game generator.
 *
 * Reads instructions.json (produced by instruction_gen/gen_instructions.py) and
 * runs the OpenGame code-agent on each `prompt`, producing one complete Godot... no —
 * one complete Phaser game project per instruction under `output_batch/<id>/`.
 *
 * Mirrors scripts/test.ts exactly, but:
 *   - loops over every instruction,
 *   - makes the agent MODEL + API endpoint configurable via env (plug in your
 *     own company API),
 *   - is resumable (skips instructions already generated successfully),
 *   - writes a batch_manifest.json summarizing every run.
 *
 * Config (env / .env in agent-test/):
 *   GAME_AGENT_MODEL   agent model id            (default: anthropic/claude-opus-4.6)
 *   OPENAI_BASE_URL    OpenAI-compatible endpoint(default: https://openrouter.ai/api/v1)
 *   OPENAI_API_KEY     key for that endpoint     (default: $OPENROUTER_API_KEY)
 *   OPENGAME_ASSET_MODE        library | generate (assets; see README)
 *   OPENGAME_REASONING_*       GDD reasoning model
 *   OPENGAME_IMAGE_* / VIDEO_* image/video models (only when ASSET_MODE=generate)
 *
 * Usage:
 *   npm run batch                                  # all instructions, resume
 *   npm run batch -- --limit 5                     # first 5
 *   npm run batch -- --filter platformer           # only platformer
 *   npm run batch -- --ids platformer-001,top_down-003
 *   npm run batch -- --instructions ../instruction_gen/instructions.json --no-resume
 */
import 'dotenv/config';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  PROJECT_ROOT,
  SmokeResult,
  TRAJECTORY_FILE,
  prepareEnvironment,
  restoreBuildConfig,
  runAgent,
  runAgentWithRetry,
  runSmoke,
} from './lib/agent_run.js';

/**
 * The checks this archetype's predecessors failed, as a block to append to a
 * generation prompt.
 *
 * Read from the JSON the extractor writes rather than reimplemented here: two
 * copies of "what counts as a check" is how the generator and the verifier end
 * up enforcing different lists, and one node serving both sides is the whole
 * point of the design.
 *
 * A missing or unreadable checklist yields an empty string. The generator has
 * built games without it for months; it must not stop building because a file
 * it treats as advice is absent.
 */
interface ChecklistStamp {
  hash: string; // of the whole file -- two games are comparable iff equal
  n: number; // how many checks this archetype was given
  ids: string[];
}

async function checklistFor(
  archetype: string,
): Promise<{ text: string; stamp?: ChecklistStamp }> {
  try {
    const raw = await fs.readFile(
      path.join(PROJECT_ROOT, 'gamedoctor', 'verifier', 'checklist.json'),
      'utf-8',
    );
    const all = (JSON.parse(raw).checks ?? []) as Array<{
      check: string;
      id?: string;
      how_to_tell?: string;
      archetypes?: string[];
      seen_on?: string[];
    }>;
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const mine = all
      .filter(
        (c) =>
          !c.archetypes?.length ||
          c.archetypes.includes('any') ||
          c.archetypes.includes(archetype),
      )
      // Most-evidenced first: a prompt is read from the top, and a check six
      // games failed should not sit below one that two did.
      .sort(
        (a, b) => new Set(b.seen_on ?? []).size - new Set(a.seen_on ?? []).size,
      );
    if (!mine.length) return { text: '', stamp: { hash, n: 0, ids: [] } };
    const lines = mine.map(
      (c) =>
        `  - ${c.check}` +
        (c.how_to_tell ? `\n      (how to tell: ${c.how_to_tell})` : '') +
        `\n      (shipped broken in ${new Set(c.seen_on ?? []).size} games already)`,
    );
    const text =
      '\n\n## CHECKS THAT GAMES LIKE THIS ONE HAVE ALREADY FAILED\n\n' +
      'Each of these was found broken on at least two finished games from ' +
      'this pipeline. They are not hypothetical, and the same agent that ' +
      'plays your game afterwards is told to go and test them.\n\n' +
      lines.join('\n') +
      '\n';
    return {
      text,
      stamp: { hash, n: mine.length, ids: mine.map((c) => c.id ?? '') },
    };
  } catch {
    // No checklist is a fact about this game, not an error. An ABSENT stamp
    // and a stamp with n:0 mean different things, and a later scorer needs
    // both: one game never saw a list, the other saw one with nothing for it.
    return { text: '' };
  }
}

// Which tool names count as an edit. Kept as one pattern because the engines
// disagree on the name -- qwen says `edit` and `write_file`, others `replace`
// or `str_replace_editor` -- and a count that silently missed one engine's
// edits would read as "the agent changed nothing".
const EDIT_TOOL_RE = /edit|write|replace|create_file|apply_patch/i;
import type { PaletteVerdict } from './lib/palette_gate.js';
import { checkPaletteAt, paletteRepairPrompt } from './lib/palette_gate.js';

interface Instruction {
  id: string;
  name: string;
  archetype: string;
  difficulty: number;
  prompt: string;
}

interface RunRecord {
  id: string;
  archetype: string;
  success: boolean;
  durationSec: number;
  files: number;
  outputDir: string;
  error?: string;
  env_ok?: boolean; // headless smoke: does the built game actually boot?
  smokeError?: string; // the runtime boot error, if smoke failed
  repairAttempts?: number; // how many smoke-driven repair rounds we ran
  degradedAssets?: boolean; // shipped hand-drawn SVG placeholders, not generated art
  // Recorded on EVERY run, pass or fail, so the rate is measurable from the
  // manifest alone. Reading it back out of 80 gameConfig.json files is how
  // this problem was found in the first place, three weeks too late.
  // WHICH MODEL WROTE THIS GAME. Recorded on every run because the moment
  // slots start rotating across models -- the whole point of rotating them is
  // to spread the load over eight separate quotas -- there is no way back to
  // it. The build is on disk; the name of the thing that produced it is not
  // written anywhere else, and 1500 games in, "is this one hard to repair
  // because of the game or because of the model that wrote it" becomes an
  // unanswerable question.
  //
  // The same lesson as `palette_ok` two lines down, which is here because
  // reading it back out of 80 gameConfig.json files was how that gap was
  // found, three weeks late.
  model?: string;
  // What the API answered with. `model` is the alias we asked for; the router
  // resolves it to a dated snapshot, and only this one says which.
  resolvedModel?: string;
  palette_ok?: boolean; // does the game ship a usable uiPalette?
  paletteProblems?: string[]; // why not, if not
  paletteRepaired?: boolean; // did the gate spend a repair turn on it?
  paletteIgnoredKeys?: string[]; // keys written that chrome has no slot for
  // Index into .qwen/trajectory.jsonl -- the step-by-step record of how this
  // game got written. Absent means nothing was recorded for this run, which
  // for anything generated before 2026-08-27 is every run.
  // The checklist this game was generated against. Absent means no list
  // existed; n:0 means one existed and had nothing for this archetype.
  checklist?: { hash: string; n: number; ids: string[] };
  trajectory?: {
    file: string;
    bytes: number;
    steps: number; // lines in the jsonl, including session/end markers
    toolCalls: number;
    edits: number; // how many of those actually wrote something
  };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    instructions:
      get('--instructions') ||
      path.join(PROJECT_ROOT, 'instruction_gen', 'instructions.json'),
    outRoot: get('--out') || path.join(PROJECT_ROOT, 'output_batch'),
    limit: get('--limit') ? parseInt(get('--limit')!, 10) : Infinity,
    // Base for the smoke server's port. Workers running in parallel MUST
    // get disjoint ranges: runSmoke binds a real port, and two workers on
    // the same one produce a smoke FAIL that reads as the game failing to
    // boot -- which then spends repair attempts on a defect that is not in
    // the game. 40 ports per worker, matching the (i % 40) sweep below.
    portBase: get('--port-base') ? parseInt(get('--port-base')!, 10) : 5273,
    filter: get('--filter'),
    ids: get('--ids')?.split(','),
    resume: !a.includes('--no-resume'),
    dryRun: a.includes('--dry-run'),
    model:
      get('--model') ||
      process.env.GAME_AGENT_MODEL ||
      'anthropic/claude-opus-4.6',
  };
}

// Detect improvised placeholder art. When the image-API step is skipped/fails, the
// agent draws its own assets rather than retrying — two fingerprints, both of which
// still build + boot so nothing else catches them:
//   1. Hand-drawn inline SVG sprites in public/assets and NO generated raster.
//   2. An ad-hoc asset-generation SCRIPT (e.g. create_fallback_assets.py using PIL) —
//      this is the PIL/PNG variant that passes the raster check, so name+content
//      sniffing is the only signal.
// Flag either loudly so a degraded-art run isn't silently a clean success.
async function detectDegradedAssets(outputDir: string): Promise<boolean> {
  // (1) SVG-only asset dir
  const dir = path.join(outputDir, 'public', 'assets');
  let svg = 0;
  let raster = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const ext = path.extname(e.name).toLowerCase();
        if (ext === '.svg') svg++;
        else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') raster++;
      }
    }
  };
  await walk(dir);
  if (svg > 0 && raster === 0) return true;

  // (2) ad-hoc asset-generation script anywhere in the project (skip deps/build)
  const SKIP = new Set(['node_modules', 'dist', '.git', '.qwen']);
  const scan = async (d: string, depth: number): Promise<boolean> => {
    if (depth > 3) return false;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        if (await scan(path.join(d, e.name), depth + 1)) return true;
      } else {
        const name = e.name.toLowerCase();
        const isScript = /\.(py|mjs|cjs|js|ts)$/.test(name);
        const looksLikeFallback =
          /fallback|placeholder|make[_-]?asset|gen[_-]?asset/.test(name);
        if (isScript && (name.endsWith('.py') || looksLikeFallback)) {
          try {
            const src = await fs.readFile(path.join(d, e.name), 'utf-8');
            if (
              /\b(from\s+PIL|import\s+PIL|Pillow|ImageDraw)\b/.test(src) ||
              (looksLikeFallback && /public\/assets|asset-pack|\.png/.test(src))
            ) {
              return true;
            }
          } catch {
            /* unreadable — ignore */
          }
        }
      }
    }
    return false;
  };
  return await scan(outputDir, 0);
}

function repairPrompt(inst: Instruction, smokeError: string): string {
  return (
    `The game you built for "${inst.name}" compiles but FAILS to run in a headless ` +
    `browser. The boot-time error is:\n\n    ${smokeError}\n\n` +
    `Fix the running game so it boots cleanly. Common causes: a Scene registered ` +
    `with a duplicate key (registered both in the Phaser config scene list AND via ` +
    `scene.add/scene.start), a scene key typo, or an uncaught error in create(). ` +
    `After fixing, run \`npm run build\` again. Do NOT change the gameplay design or ` +
    `the difficultyConfig — only repair the runtime error. The game must reach an ` +
    `active gameplay scene (window.__rlenv.ready() === true) with no uncaught errors.`
  );
}

async function generateOne(
  inst: Instruction,
  outputDir: string,
  model: string,
  smokePort: number,
): Promise<RunRecord> {
  await fs.mkdir(outputDir, { recursive: true });
  await prepareEnvironment(outputDir);

  const start = Date.now();
  const maxRepairs = parseInt(process.env.SMOKE_REPAIR_ATTEMPTS || '1', 10);

  // 1) initial build
  // The initial build is the expensive one and had no retry at all:
  // one transport fault anywhere in a ~100-request session lost the
  // whole game. The later call sites are smaller and already bounded.
  //
  // NO CHECKLIST IN THIS PROMPT. It was wired in before the design was
  // settled and is withdrawn until it is: a list injected here changes every
  // game generated from now on, and comparing games built with an unfinished
  // list against games built without one answers nothing. `checklistFor` and
  // the stamp field stay in the file so re-enabling is one call site.
  let run = await runAgentWithRetry(inst.prompt, outputDir, model, inst.id);
  const messages = run.messages;
  let error = run.error;

  // 1b) Safety net: the agent must never touch build config (custom.md), but some
  // models clobber postcss.config.js to `{ plugins: {} }`, which silently drops ALL
  // Tailwind CSS — every DOM screen (title/menus) then renders unstyled. Restore it
  // from the template and rebuild so the corrected CSS actually ships.
  if (run.success) {
    const restored = await restoreBuildConfig(outputDir);
    if (restored) {
      process.stdout.write(
        `\r    [${inst.id}] restored clobbered postcss.config.js + rebuilt      \n`,
      );
    }
  }

  // 2) build/smoke -> repair loop (only if the agent itself succeeded)
  //
  // A GAME THAT DID NOT COMPILE USED TO GET NO REPAIR AT ALL. The loop below
  // only fired when `runSmoke` came back not-ok, and runSmoke needs a served
  // build -- so a tsc/vite failure skipped straight past it, was discovered
  // by the hard build gate a hundred lines further down, and the game was
  // abandoned. Measured on the 1500-instruction run: 4 of the first 16 games
  // died that way with `repairAttempts: 0`, roughly 3.6 hours of generation
  // thrown away without the agent ever being told its code does not compile.
  //
  // So `built` is now checked first and is a repairable condition like any
  // other. The agent gets the same one round it would have got for a boot
  // failure, and gets to see the actual compile error rather than nothing.
  const distIndex = path.join(outputDir, 'dist', 'index.html');
  const buildFailed = () => run.success && !existsSync(distIndex);

  let smoke =
    run.success && !buildFailed() ? await runSmoke(outputDir, smokePort) : null;
  let repairAttempts = 0;
  while (
    run.success &&
    (buildFailed() || (smoke && !smoke.ok)) &&
    repairAttempts < maxRepairs
  ) {
    repairAttempts++;
    // Name which failure it is. "It does not compile" and "it compiles but
    // does not boot" call for different work, and handing the agent the wrong
    // one wastes the round.
    const errStr = buildFailed()
      ? 'the project does not compile: `npm run build` produced no ' +
        'dist/index.html. Run it yourself and read the tsc/vite output.'
      : smoke?.error || 'unknown boot failure';
    const kind = buildFailed() ? 'BUILD FAIL' : 'smoke FAIL';
    process.stdout.write(
      `\r    [${inst.id}] ${kind} (${errStr.slice(0, 60)}) — repair ${repairAttempts}/${maxRepairs}...      \n`,
    );
    run = await runAgent(
      repairPrompt(inst, errStr),
      outputDir,
      model,
      `${inst.id}#fix${repairAttempts}`,
    );
    messages.push(...run.messages);
    if (run.error) error = run.error;
    smoke =
      run.success && !buildFailed()
        ? await runSmoke(outputDir, smokePort)
        : smoke;
  }

  // 2b) The palette gate. A game with no `uiPalette` renders the chrome's
  // factory defaults — #0f1420 navy, Arial, a cyan kicker — identical on every
  // game that skipped the step and unrelated to its own art direction. Nothing
  // else catches it: the D4 layout checks measure rendered geometry, and a
  // default card is laid out perfectly.
  //
  // It costs ONE agent turn and never fails the run. Thirty minutes of
  // generation is not worth discarding over a JSON field, so a palette that is
  // still missing after the repair is recorded and reported, not fatal. Set
  // PALETTE_STRICT=1 to make it a hard failure instead.
  //
  // The repair only runs on a game that already built AND booted. Sending an
  // agent at a broken project to ask for a colour is a wasted turn, and worse,
  // it makes a later build failure impossible to attribute.
  //
  // `existsSync` on dist/ is a weak test and is known to be: vite leaves the
  // previous dist in place when a build fails, so a game whose source stopped
  // compiling still looks built. Measured on platformer-projectile-D2-004,
  // whose generation died mid-run — it has a dist from an earlier build and
  // ~25 TS2339 errors. The smoke result is the stronger half of this
  // condition, and it is why both are required.
  const builtBeforePalette =
    existsSync(path.join(outputDir, 'dist', 'index.html')) &&
    (!smoke || smoke.ok);
  let palette: PaletteVerdict | null = run.success
    ? await checkPaletteAt(outputDir)
    : null;
  let paletteRepaired = false;
  const maxPaletteRepairs = parseInt(
    process.env.PALETTE_REPAIR_ATTEMPTS || '1',
    10,
  );
  if (
    run.success &&
    builtBeforePalette &&
    palette &&
    !palette.ok &&
    maxPaletteRepairs > 0
  ) {
    process.stdout.write(
      `\r    [${inst.id}] palette gate: ${palette.problems[0]?.slice(0, 60)} — repairing...      \n`,
    );
    const pr = await runAgent(
      paletteRepairPrompt(inst.name, palette),
      outputDir,
      model,
      `${inst.id}#palette`,
    );
    messages.push(...pr.messages);
    paletteRepaired = true;
    // The agent edits gameConfig.json and rebuilds; re-read either way, since
    // a run that reports failure may still have written the file.
    palette = await checkPaletteAt(outputDir);
    process.stdout.write(
      `\r    [${inst.id}] palette after repair: ${palette.ok ? 'ok' : 'STILL MISSING'}      \n`,
    );
  }
  if (palette && !palette.ok) {
    process.stdout.write(
      `\r    [${inst.id}] ⚠ NO UI PALETTE: ships the chrome's factory defaults      \n`,
    );
  }
  if (palette && palette.ignoredKeys.length) {
    process.stdout.write(
      `\r    [${inst.id}] note: uiPalette keys chrome has no slot for: ` +
        `${palette.ignoredKeys.slice(0, 6).join(', ')}      \n`,
    );
  }

  // Flag crude hand-drawn SVG fallback art (image-API asset step was skipped/failed).
  const degradedAssets = run.success
    ? await detectDegradedAssets(outputDir)
    : false;
  if (degradedAssets) {
    process.stdout.write(
      `\r    [${inst.id}] ⚠ DEGRADED ASSETS: shipped hand-drawn SVG placeholders, not generated art — regenerate for real sprites      \n`,
    );
  }

  // Hard build gate, independent of the smoke checker: a game with no built
  // dist/index.html never compiled, no matter what the agent self-reported.
  // This is the gate the smoke path CANNOT provide — runSmoke returns null
  // (env_ok undefined -> treated as pass) whenever the checker can't run
  // (ENABLE_SMOKE=0, missing rl_env/venv python, or non-JSON output), so on a
  // box without the smoke venv the agent's premature `success:true` used to
  // sail through. Qwen3.6 exposed this: it declares completion after writing
  // imports for scene files it never created -> tsc fails -> no dist, yet
  // success:true / env_ok:None. Gate on the artifact that must exist.
  const built = existsSync(path.join(outputDir, 'dist', 'index.html'));
  // A build that existed before the palette turn and is gone after it was
  // destroyed by that turn, not by generation. Saying so is the difference
  // between a diagnosable regression and a mystery filed under "tsc failed" —
  // and it is the one way this gate could make things worse, so it is named.
  const paletteBrokeBuild = paletteRepaired && builtBeforePalette && !built;
  if (paletteBrokeBuild && !error)
    error =
      'build: dist/index.html disappeared during the palette repair turn ' +
      '(the game built before it)';
  else if (run.success && !built && !error)
    error = 'build: no dist/index.html (tsc/vite failed)';

  // env_ok: true/false when smoke ran, undefined when disabled/unavailable
  const env_ok = smoke ? smoke.ok : undefined;
  // success now requires the game to actually BUILD (dist exists) AND, when the
  // smoke checker is available, to BOOT. The palette is deliberately NOT part
  // of that by default — a themeless game is a worse game, not a broken one,
  // and discarding a working build over it costs half an hour to save a JSON
  // field. PALETTE_STRICT=1 makes it a hard gate for runs that would rather
  // pay that.
  const paletteStrict = process.env.PALETTE_STRICT === '1';
  const palette_ok = palette ? palette.ok : undefined;
  const success =
    run.success &&
    built &&
    (env_ok === undefined ? true : env_ok) &&
    (!paletteStrict || palette_ok === true);
  if (env_ok === false && !error) error = `smoke: ${smoke?.error}`;
  if (paletteStrict && palette_ok === false && !error)
    error = `palette: ${palette?.problems[0]}`;

  const files = (await fs.readdir(outputDir)).filter((f) => !f.startsWith('.'));
  const rec: RunRecord = {
    id: inst.id,
    archetype: inst.archetype,
    success,
    durationSec: Math.round((Date.now() - start) / 1000),
    files: files.length,
    outputDir,
    error,
    env_ok,
    smokeError: smoke && !smoke.ok ? smoke.error || undefined : undefined,
    repairAttempts,
    degradedAssets: degradedAssets || undefined,
    model,
    resolvedModel: run.resolvedModel,
    palette_ok,
    paletteProblems: palette && !palette.ok ? palette.problems : undefined,
    paletteRepaired: paletteRepaired || undefined,
    paletteIgnoredKeys: palette?.ignoredKeys.length
      ? palette.ignoredKeys
      : undefined,
  };
  // The trajectory itself lives in .qwen/trajectory.jsonl, written as the
  // session streamed. result.json records that it is there and how big -- an
  // index, not a second copy. Inlining the tool inputs here would put every
  // written file's full contents into a document that is read whole, dozens of
  // times, by tooling that only wants the id and whether it built.
  //
  // `steps` is the count a later reader checks first: a game whose record says
  // it ran 30 tools but whose trajectory has 4 steps was killed mid-session,
  // and that is a different thing from a short session.
  let trajectory: RunRecord['trajectory'];
  try {
    const tf = path.join(outputDir, '.qwen', TRAJECTORY_FILE);
    const st = await fs.stat(tf);
    const lines = (await fs.readFile(tf, 'utf-8'))
      .split('\n')
      .filter((l) => l.trim());
    trajectory = {
      file: path.join('.qwen', TRAJECTORY_FILE),
      bytes: st.size,
      steps: lines.length,
      toolCalls: run.toolCalls.length,
      edits: run.toolCalls.filter((t) => EDIT_TOOL_RE.test(t.name)).length,
    };
  } catch {
    trajectory = undefined; // no recording -- the field's absence says so
  }
  await fs.writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(
      {
        ...rec,
        trajectory,
        // WHICH CHECKLIST THIS GAME WAS BUILT AGAINST, and therefore which
        // epoch it belongs to. Without it, "did the checklist help" cannot be
        // asked of this game later: a game generated before the checklist and
        // one generated after it look identical on disk. The same gap made
        // `resolvedModel` unrecoverable for every game written before it was
        // recorded.
        //
        // The hash, not the text: the list is rebuilt from the readings each
        // time it is extracted, so two games are comparable only if they saw
        // the same one, and only a hash says that cheaply.
        instruction: inst,
        assistantMessages: messages,
      },
      null,
      2,
    ),
  );
  return rec;
}

async function main() {
  const args = parseArgs();
  const all: Instruction[] = JSON.parse(
    await fs.readFile(args.instructions, 'utf-8'),
  );
  let todo = all;
  if (args.filter) todo = todo.filter((i) => i.archetype === args.filter);
  if (args.ids) todo = todo.filter((i) => args.ids!.includes(i.id));
  todo = todo.slice(0, args.limit);

  console.log('━'.repeat(50));
  console.log(`Batch generate: ${todo.length} games`);
  console.log(`  model:   ${args.model}`);
  console.log(
    `  endpoint:${process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1'}`,
  );
  console.log(`  assets:  ${process.env.OPENGAME_ASSET_MODE || 'generate'}`);
  console.log(`  out:     ${args.outRoot}`);
  console.log(`  ports:   ${args.portBase}-${args.portBase + 39}`);
  console.log(
    `  smoke:   ${
      process.env.ENABLE_SMOKE === '0'
        ? 'OFF'
        : `on (repair x${process.env.SMOKE_REPAIR_ATTEMPTS || '1'})`
    }`,
  );
  console.log('━'.repeat(50));

  if (args.dryRun) {
    const byArch: Record<string, number> = {};
    for (const i of todo) byArch[i.archetype] = (byArch[i.archetype] || 0) + 1;
    console.log('DRY RUN — would generate:');
    for (const i of todo)
      console.log(
        `  ${i.id}  (${i.archetype}, diff ${i.difficulty})  "${i.name}"`,
      );
    console.log('by archetype:', byArch);
    console.log('(no API calls made)');
    return;
  }

  await fs.mkdir(args.outRoot, { recursive: true });
  const manifestPath = path.join(args.outRoot, 'batch_manifest.json');
  // LOAD what is already there. The array used to start empty and every write
  // replaced the whole file, so a restart silently discarded that worker's
  // entire history the moment it finished its first game -- and `--resume`
  // guarantees restarts. Caught with 12 rows still on disk and about to be
  // overwritten by 1.
  //
  // The games themselves survive a restart (they are on disk), but `success`,
  // `error` and `durationSec` live ONLY here, and they are what separates a
  // model that wrote code which does not compile from a 403. Losing them
  // loses the dataset's labels while leaving the samples.
  //
  // Merge is by id, newest wins: a game re-run after a failure should be
  // recorded as it finally went, not twice.
  let manifest: RunRecord[] = [];
  if (args.resume && existsSync(manifestPath)) {
    try {
      const prior = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      if (Array.isArray(prior)) manifest = prior;
    } catch {
      /* unreadable prior manifest: start fresh rather than crash, and the
         backup the operator took is the recovery path */
    }
  }
  const putRecord = (rec: RunRecord) => {
    manifest = manifest.filter((m) => m.id !== rec.id);
    manifest.push(rec);
  };

  for (let i = 0; i < todo.length; i++) {
    const inst = todo[i];
    const outputDir = path.join(args.outRoot, inst.id);
    const done =
      args.resume &&
      existsSync(path.join(outputDir, 'result.json')) &&
      JSON.parse(
        await fs.readFile(path.join(outputDir, 'result.json'), 'utf-8'),
      ).success === true;

    if (done) {
      console.log(
        `[${i + 1}/${todo.length}] ${inst.id}  ⏭  skip (already done)`,
      );
      continue;
    }

    console.log(
      `[${i + 1}/${todo.length}] ${inst.id} (${inst.archetype})  ▶ generating...`,
    );
    const rec = await generateOne(
      inst,
      outputDir,
      args.model,
      args.portBase + (i % 40),
    );
    putRecord(rec);
    const smokeTag =
      rec.env_ok === undefined
        ? ''
        : rec.env_ok
          ? `  smoke:ok${rec.repairAttempts ? ` (fixed after ${rec.repairAttempts})` : ''}`
          : `  smoke:FAIL`;
    console.log(
      `\r[${i + 1}/${todo.length}] ${inst.id}  ${rec.success ? '✅' : '❌'} ` +
        `${rec.durationSec}s, ${rec.files} files${smokeTag}` +
        (rec.error ? `  err: ${rec.error.slice(0, 80)}` : ''),
    );
    // Persist manifest incrementally so a crash mid-batch keeps progress.
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  const ok = manifest.filter((m) => m.success).length;
  console.log('━'.repeat(50));
  console.log(`Done: ${ok}/${manifest.length} succeeded (this run)`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
