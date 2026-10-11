/**
 * Run ONE coding-agent repair round on an existing game directory.
 *
 * Used by the quality-repair loop (eval/quality/repair_loop): the Python side
 * evaluates a game, writes a repair prompt (feedback + screenshot references),
 * and calls this to have the agent edit the game in place and rebuild. Mirrors
 * batch_generate.ts's agent invocation so the environment/model is identical.
 *
 * Usage:
 *   npx tsx scripts/agent_repair.ts --game-dir <dir> --prompt-file <file> [--model <id>] [--engine web|godot]
 * Prints a JSON line: {"success": bool, "error": <str|null>}.
 */
import 'dotenv/config';
import * as fs from 'fs/promises';
import {
  prepareEnvironment,
  restoreBuildConfig,
  runAgent,
  redactSecrets,
} from './lib/agent_run.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const gameDir = arg('--game-dir');
  const promptFile = arg('--prompt-file');
  const logFile = arg('--log-file');
  // NO DEFAULT MODEL. This used to fall back to `anthropic/claude-opus-4.6`,
  // which is the most expensive thing this pipeline can reach and reaches it
  // without saying so: `layer.py` passes `--model` only when REPAIR_MODEL is
  // set, so one missing line in `.env` turns every repair session in a batch
  // into an opus session that finishes normally and bills like nothing else.
  // The key is shared with the rest of the lab, so guessing is not ours to do.
  const model = arg('--model') || process.env.GAME_AGENT_MODEL;
  if (!model) {
    console.log(
      JSON.stringify({
        success: false,
        error:
          'no model: pass --model or set GAME_AGENT_MODEL. There is no ' +
          'default, on purpose -- the old one was anthropic/claude-opus-4.6.',
      }),
    );
    process.exit(1);
  }
  // Which kind of project this is. Selects the system prompt and how a
  // build is recognised; `web` is the default and is unchanged.
  const engine = arg('--engine') || 'web';
  if (!gameDir || !promptFile) {
    console.log(
      JSON.stringify({
        success: false,
        error: 'need --game-dir and --prompt-file',
      }),
    );
    process.exit(1);
  }
  const prompt = await fs.readFile(promptFile, 'utf-8');

  // Refresh .qwen/system.md before every repair round so it reflects the
  // current custom.md, not a stale copy from whenever the game was first built.
  await prepareEnvironment(gameDir, engine);

  // ONE autonomous session, bounded. 30 is roughly twice the median of 17
  // measured over the corpus run, which leaves room for a hard repair without
  // letting one edge spend half an hour. `--max-tools 0` lifts it, for a
  // deliberate unbounded run.
  const maxToolsArg = arg('--max-tools');
  const maxTools =
    maxToolsArg === undefined ? 30 : parseInt(maxToolsArg, 10) || Infinity;

  const {
    success,
    error,
    messages,
    toolCalls,
    stoppedBy,
    resolvedModel,
    cost,
  } = await runAgent(prompt, gameDir, model, 'repair', maxTools);

  // Same safety net the initial build gets: some models clobber
  // postcss.config.js, silently dropping all Tailwind CSS. Restore + rebuild.
  // Web only -- a Godot project has no postcss.config.js and restoring one
  // into it would be writing a file the engine will never read.
  if (success && engine !== 'godot') {
    await restoreBuildConfig(gameDir);
  }

  // observability: what did the agent actually do this round?
  const isImg = (t: string) => /\.(jpg|jpeg|png)$/i.test(t);
  const edited = [
    ...new Set(
      toolCalls
        .filter((t) => /write|edit|replace/i.test(t.name) && t.target)
        .map((t) => t.target),
    ),
  ];
  const imagesRead = [
    ...new Set(
      toolCalls
        .filter((t) => /read/i.test(t.name) && isImg(t.target))
        .map((t) => t.target),
    ),
  ];
  // What counts as "it checked its own work". On Godot that is loading the
  // project headless -- and note the prompt tells the agent to read that
  // command's OUTPUT rather than its exit code, because Godot exits 0 on a
  // script that fails to parse.
  const buildPattern =
    engine === 'godot'
      ? /godot .*--headless|godot .*--quit|--import/
      : /npm run build|vite build|tsc/;
  const ranBuild = toolCalls.some(
    (t) => /shell|bash|run/i.test(t.name) && buildPattern.test(t.target),
  );
  // How often it drove the game. Only the COUNT is available here -- the SDK
  // does not report per-tool duration -- so the seconds are measured by
  // `play_cli` itself, which appends its own elapsed time to a log the Python
  // caller sums. That matters because the budget is meant to bound reasoning
  // iteration, not to tax the agent for using the debugging tools it was just
  // given: ten minutes of which six went to booting a browser leaves four to
  // think in, which is the opposite of the intent.
  const nPlayCalls = toolCalls.filter(
    (t) => /shell|bash|run/i.test(t.name) && /play_cli/.test(t.target),
  ).length;

  const summary = {
    success,
    engine,
    // The alias we asked for, and what the API resolved it to. Measured:
    // `gpt-5.5` answers as `gpt-5.5-2026-04-24`. An episode labelled with the
    // alias cannot afterwards be sorted by what actually produced the repair.
    model_requested: model,
    model_resolved: resolvedModel || null,
    error: error || null,
    n_tools: toolCalls.length,
    max_tools: maxTools === Infinity ? null : maxTools,
    stopped_by: stoppedBy || null,
    // WHAT THIS REPAIR COST. `null` when the session produced no result
    // message to read it from -- never zeros, because a repair that cost
    // nothing and a repair whose cost was never reported are different facts,
    // and the budget arithmetic that reads this must be able to tell them
    // apart. `n_tools` above is NOT a substitute for `cost.numTurns`: it counts
    // tool calls, which over-counts a turn carrying two and misses a turn that
    // answers with none.
    cost: cost ?? null,
    n_play_calls: nPlayCalls,
    images_read: imagesRead,
    files_edited: edited,
    ran_build: ranBuild,
    // WHAT THE AGENT SAID, between its tool calls and at the end.
    //
    // Dropped until now, and it is the reasoning trace -- for a training set
    // built out of these episodes, the half that is not observable anywhere
    // else. It is also the only evidence for why a session ended: an edge
    // that stopped after six tools with `no_change` had used 52 of its 600
    // seconds and 6 of its 30 tools, so no cap explains it, and the record
    // held nothing that could.
    //
    // Kept as a record, NOT as a measurement. An agent's account of its own
    // work is a claim; the diff and the verifier are what check it. Anything
    // downstream that reads this has to keep that distinction -- which is why
    // `distill_realized_plan` is not shown these.
    messages: messages.map(redactSecrets),
    tools: toolCalls,
  };
  if (logFile) {
    try {
      await fs.writeFile(logFile, JSON.stringify(summary, null, 2));
    } catch {
      /* non-fatal */
    }
  }
  // stdout: compact line the Python loop parses (drop the big tools array)
  const { tools: _t, messages: _m, ...compact } = summary;
  const line = '\n' + JSON.stringify(compact) + '\n';
  // EXIT ONCE THE RESULT IS OUT. Without this the process outlived its own
  // session -- some handle stayed open -- until repair.py's watchdog killed it
  // at the 30-minute budget, and that kill was then recorded as the session
  // dying: measured at least 13 finished art sessions retried from scratch.
  // Written through the callback so the line is flushed to the pipe first.
  if (process.env.REPAIR_EXIT_WHEN_DONE === '1') {
    process.stdout.write(line, () => process.exit(success ? 0 : 1));
    return;
  }
  console.log(line.slice(0, -1));
}

main().catch((e) => {
  console.log(JSON.stringify({ success: false, error: String(e) }));
  process.exit(1);
});
