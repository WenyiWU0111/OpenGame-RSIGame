/**
 * Shared coding-agent invocation primitives — the ONE place that calls the
 * @opengame/sdk `query()` loop. Used by both batch_generate.ts (initial build)
 * and agent_repair.ts (repair rounds, both the legacy eval/quality/repair_loop
 * AND gamedoctor's Generator.repair()) so a fix here (e.g. the success-
 * detection override below) covers every call site instead of drifting across
 * independent copies.
 */
import 'dotenv/config';
import {
  query,
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKUserMessage,
} from '@opengame/sdk';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SHELL_RESULT_CHARS = 8000;
const OTHER_RESULT_CHARS = 400;

// The trajectory file has different economics from the in-memory summary above.
// That summary is read by humans and by code that only needs to know WHAT the
// agent touched; 400 chars of a read_file reply is plenty for that.
//
// A trajectory is training data, and there the two halves are not alike:
//
//   the tool INPUT is the model's own output -- the thing a student model
//   would have to emit -- so it is never truncated in practice. An `edit`
//   call's input IS the code that got written; a cap that clipped it would
//   silently produce examples whose target is half a patch.
//
//   the tool RESULT is context the next turn is conditioned on. Clip a
//   read_file reply to 400 chars and the recorded episode shows a model
//   editing a file it was never shown, which is not a trajectory anyone can
//   learn the right lesson from.
//
// Both are still bounded, because one runaway `find /` should not write a
// gigabyte, and truncation is always FLAGGED rather than silent.
const TRAJECTORY_INPUT_CHARS = 400_000;
const TRAJECTORY_RESULT_CHARS = 200_000;
export const TRAJECTORY_FILE = 'trajectory.jsonl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(__dirname, '..', '..');

export interface ToolCall {
  name: string;
  target: string;
  /**
   * The tool's full input, as the model emitted it. `target` is a single
   * string picked out of this object for display; it is not a substitute.
   *
   * For every editing tool the input CONTAINS THE CODE -- `write_file.content`,
   * `edit.new_string`. Keeping only `{name, target}` recorded that a file was
   * written and threw away what was written into it, which left the corpus
   * with prompt -> final tree and no way to recover the steps between.
   */
  input?: unknown;
  /**
   * What the tool returned, truncated. Recorded because the command alone is
   * not the evidence: `play_cli ... read_state` tells you the agent looked,
   * and only the reply tells you what it saw. Without this the episode can
   * say an agent drove the game but never what the game answered, which is
   * the half a later reader -- or a training set -- actually needs.
   */
  result?: string;
  resultTruncated?: boolean;
}

/**
 * What one session actually cost, taken from the SDK's own result message.
 *
 * ABSENT IS NOT ZERO. Every field is optional and stays `undefined` unless a
 * result message carried it. A session whose usage never arrived and a session
 * that genuinely spent nothing are different facts, and the budget arithmetic
 * downstream must not be able to confuse them -- `repair.py` already learned
 * this the expensive way with `r.get('n_tools') or 0`, which turned ABSENT into
 * ZERO and made a dead session read as a cheap one.
 *
 * `numTurns` is the SDK's own count of model calls. It is NOT `toolCalls.length`:
 * a turn that answers without asking for a tool is not counted by the latter,
 * and a turn carrying two tool_use blocks is counted twice. When two methods are
 * being compared at equal model calls, that difference is the whole measurement.
 *
 * Cache reads are kept separate from `inputTokens` because the SDK reports them
 * separately, and folding them together overstates the uncached cost of a
 * session by whatever the cache absorbed -- measured at 42% of input across the
 * 141-game baseline corpus.
 */
export interface SessionCost {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  numTurns?: number;
  durationApiMs?: number;
  /** Per-model breakdown, keyed by the name the router resolved to. */
  byModel?: Record<string, unknown>;
}

export interface AgentRunResult {
  success: boolean;
  error?: string;
  messages: string[];
  toolCalls: ToolCall[];
  /**
   * Absent when no result message carried usage -- see `SessionCost`. Do not
   * default it to zeros at any layer that reads it.
   */
  cost?: SessionCost;
  /**
   * The model name the API actually answered with, which is NOT the one we
   * asked for. Measured against the router on 2026-08-26:
   *
   *     asked gpt-5.5        -> got gpt-5.5-2026-04-24
   *     asked seed-2.0-code  -> got seed-2-0-code-preview-260328
   *     asked minimax-m2.7   -> got MiniMax-M2.7
   *
   * Aliases, not fallbacks -- this key gets no automatic downgrade. But for a
   * corpus that becomes a dataset the consequence is the same: `gpt-5.5` will
   * point at a different snapshot next month, and 1500 games labelled with the
   * alias cannot afterwards be sorted by what actually wrote them.
   *
   * MEASURED CAVEAT: through the SDK this currently comes back EQUAL to the
   * alias -- `gpt-5.5` in, `gpt-5.5` out -- while a direct call to the same
   * base URL returns `gpt-5.5-2026-04-24`. The SDK reports its configured
   * model rather than passing the API's through. So this field is honest but
   * so far uninformative on this path, and the snapshot has to come from a
   * direct probe recorded once per batch. Kept because it costs nothing and
   * becomes correct the day the SDK passes the value through; NOT to be read
   * as "the snapshot that produced this" until it differs from `model`.
   */
  resolvedModel?: string;
  // Set when a cap ended the session rather than the agent finishing. An
  // agent that ran out of budget and one that decided it was done look
  // identical downstream unless this says which happened -- and the second
  // is a result while the first is a truncation.
  // 'silent' is a session ABANDONED because nothing arrived for its budget --
  // distinct from a failure, and the only one of the three the retry re-runs.
  stoppedBy?: 'tool_budget' | 'silent';
}

export interface SmokeResult {
  ok: boolean;
  built: boolean;
  error: string | null;
  warnings?: string[];
}

// The SDK can report `subtype: 'success'` even when the whole turn was just a
// synthetic error message it injected in place of a real response (e.g.
// sustained upstream 403s) — the query loop completed without throwing, but
// no real work happened. A run whose entire transcript is error-shaped text
// is not a success. (Found via a reproduced 403: SDK said success:true with
// 0 real files and assistantMessages == ["[API Error: 403 status code (no
// body)]"] — re-running the same scenario after this fix correctly reports
// success:false.)
// Anchored at the START only, and `[\s\S]` so it spans lines. The `$` version
// missed every error that carries an advisory after the bracket, which is what
// the platform actually sends:
//
//   [API Error: 429 qpm limit, you can apply for expansion on the platform ...]
//   Possible quota limitations in place or slow response times detected.
//
// That session reported success:true with n_tools:0, and the repair loop read
// it as an agent that looked at the game and chose to change nothing.
const ERROR_ONLY_MESSAGE_RE = /^\s*\[[\s\S]*\berror\b[\s\S]*?\]/i;

/**
 * A tool result is a string, or a list of content blocks. An image block has
 * no text to keep, and rendering it as `{}` or `[object Object]` would read
 * like an empty reply -- which is the opposite of what happened -- so it says
 * what it was instead.
 */
/**
 * Blank any secret that came back inside a tool result.
 *
 * The agent runs with API keys in its environment, and tool results are now
 * kept in the trace, which is copied into the episode and archived to a
 * SHARED group volume. One `env` or a script that echoes its config would put
 * a live credential somewhere it can never be taken back from.
 *
 * Matches on the actual values rather than on key-shaped patterns: a pattern
 * both misses formats it does not know and mangles innocent long strings,
 * while the real values are right here and cannot be wrong. Short values are
 * skipped -- redacting a 4-character variable would blank ordinary text.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 12) continue;
    if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    if (!out.includes(v)) continue;
    out = out.split(v).join(`[redacted:${k}]`);
  }
  return out;
}

function flattenResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const bl = b as { type?: string; text?: string };
        if (bl.type === 'text' && typeof bl.text === 'string') return bl.text;
        if (bl.type === 'image') return '[image]';
        return JSON.stringify(b);
      })
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function toolTarget(input: unknown): string {
  const o = (input || {}) as Record<string, unknown>;
  for (const k of [
    'absolute_path',
    'file_path',
    'path',
    'command',
    'url',
    'pattern',
  ]) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return '';
}

function clip(
  text: string,
  cap: number,
): { text: string; truncated?: boolean } {
  if (text.length <= cap) return { text };
  return { text: text.slice(0, cap), truncated: true };
}

/**
 * Append-as-you-go record of one agent session: the prompt, every assistant
 * turn, every tool call WITH ITS INPUT, and every reply.
 *
 * WHY APPEND PER EVENT rather than buffer and write at the end. These sessions
 * are killed -- by the tool budget, by a watchdog, by the 3h utilisation rule,
 * by an OOM. A buffered writer loses the entire trajectory of exactly the
 * sessions whose behaviour is most worth having recorded. Each line is
 * self-contained JSON, so a file cut off mid-session is still readable up to
 * its last complete line.
 *
 * WHY .qwen/. It sits beside system.md, which is the other half of what the
 * agent was working from, and it is already in the skip list of every routine
 * that diffs a game tree -- so a trajectory can never leak into a patch the
 * way `_trace/exploration.json` once did.
 *
 * A writer that throws must never take the session down with it: losing the
 * record is bad, losing the game because recording failed is worse. Every
 * write is guarded and the first failure is reported once.
 */
class Trajectory {
  private path: string;
  private ready: Promise<void>;
  private broken = false;

  constructor(outputDir: string) {
    this.path = path.join(outputDir, '.qwen', TRAJECTORY_FILE);
    this.ready = fs
      .mkdir(path.join(outputDir, '.qwen'), { recursive: true })
      .then(() => undefined);
  }

  async write(event: Record<string, unknown>): Promise<void> {
    if (this.broken) return;
    try {
      await this.ready;
      await fs.appendFile(
        this.path,
        JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n',
        'utf-8',
      );
    } catch (e) {
      this.broken = true;
      process.stderr.write(
        `\n    [trajectory] recording OFF for this session: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }
}

/**
 * Redact secrets anywhere inside a tool input, not just at the top level.
 * A `run_shell_command` whose command exports an API key would otherwise put
 * that key in the corpus verbatim, and the corpus is meant to be shareable.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

// Write the .qwen/system.md the agent's system prompt is sourced from (custom.md
// + template/docs dir substitution). Idempotent — safe to call again before a
// repair round so it always reflects the current custom.md, not a stale copy
// from whenever the game was first built.
export async function prepareEnvironment(
  outputDir: string,
  engine: string = 'web',
): Promise<void> {
  await fs.mkdir(path.join(outputDir, '.qwen'), { recursive: true });
  // `custom.md` teaches an agent to BUILD a Phaser game from templates. A
  // Godot repair needs none of that and would be actively misled by it --
  // it names tools and directories that do not exist in that project.
  const promptFile = engine === 'godot' ? 'custom_godot.md' : 'custom.md';
  const customPrompt = await fs.readFile(
    path.join(PROJECT_ROOT, 'prompts', promptFile),
    'utf-8',
  );
  const filled = customPrompt
    .replace(/\{TEMPLATES_DIR\}/g, path.join(PROJECT_ROOT, 'templates'))
    .replace(/\{DOCS_DIR\}/g, path.join(PROJECT_ROOT, 'docs'))
    .replace(
      /\{NODE_MODULES_CACHE_DIR\}/g,
      path.join(PROJECT_ROOT, '.node_modules_cache'),
    );
  await fs.writeFile(
    path.join(outputDir, '.qwen', 'system.md'),
    filled,
    'utf-8',
  );
}

// LEAN REPAIR (EVOGAME_LEAN_REPAIR=1, repair sessions only; unset = unchanged).
//
// Measured on the GPT/Qwen EvoGame runs: a repair call carried 40k prompt
// tokens on average, and three things in it did no work.
//   - Tool schemas were 56% of the first request: the build-from-scratch set
//     (todo_write alone is 10k characters). A repair uses six of the sixteen.
//   - The system prompt appended ~/.qwen/QWEN.md, 12.5k characters of notes
//     `save_memory` had written during OTHER games and runs. That is also a
//     leak between games and arms, and it differs from machine to machine.
//   - Tool output was capped at 25k characters; one grep returned 20k and was
//     then resent with every later call of the session.
// The workspace settings below point the context file at a name that does not
// exist, so no QWEN.md is loaded.
//
// NO OUTPUT CAPS. `tools.truncateToolOutputLines/Threshold` were set to 100
// lines / 6000 chars here until 2026-09-15, which also capped read_file
// (fileUtils.ts uses the same two settings as its default read window): a
// 700-line script took a dozen reads. Measured on the outer-guidance pilot,
// median reads per repair session went 6 -> 12-16, first edit call 9 -> 15-17,
// and sessions that edited nothing 15% -> 33-70%. Do not reintroduce them.
export const LEAN_REPAIR_EXCLUDED_TOOLS = [
  'todo_write',
  'task',
  'read_many_files',
  'generate_tilemap',
  'save_memory',
  'web_fetch',
  'web_search',
  'generate_gdd',
  'classify_game_type',
  'list_directory',
  'glob',
];

export async function prepareLeanRepair(outputDir: string): Promise<void> {
  await fs.mkdir(path.join(outputDir, '.qwen'), { recursive: true });
  await fs.writeFile(
    path.join(outputDir, '.qwen', 'settings.json'),
    JSON.stringify(
      {
        context: { fileName: 'EVOGAME_NO_MEMORY.md' },
      },
      null,
      2,
    ),
    'utf-8',
  );
}

// A tree that went through a lean session keeps that settings file; a later
// session without the flag must not inherit it. Only our own file is removed.
async function dropLeanRepairSettings(outputDir: string): Promise<void> {
  const f = path.join(outputDir, '.qwen', 'settings.json');
  try {
    if ((await fs.readFile(f, 'utf-8')).includes('EVOGAME_NO_MEMORY.md')) {
      await fs.unlink(f);
    }
  } catch {
    // no settings file: nothing to undo
  }
}

// Run the coding agent once with the given prompt. Streams progress to stderr
// (stdout is reserved for callers like agent_repair.ts that parse a final JSON
// line from it). Reused for the initial build, batch_generate's smoke-driven
// repair rounds, AND gamedoctor's Generator.repair().
export async function runAgent(
  prompt: string,
  outputDir: string,
  model: string,
  label: string,
  // A ceiling on tool calls for ONE session. The SDK exposes no maxTurns, so
  // it is enforced where the messages are consumed: breaking the async
  // iterator ends the generator and the run with it. Infinity keeps every
  // existing caller -- generation, palette, smoke repair -- exactly as it was.
  maxTools: number = Infinity,
): Promise<AgentRunResult> {
  const messages: string[] = [];
  const toolCalls: ToolCall[] = [];
  // tool_use id -> index in toolCalls. Results come back on a LATER message,
  // so the two halves have to be stitched by id; matching on name would
  // attach the wrong reply the moment an agent runs the same tool twice.
  const awaitingResult = new Map<string, number>();
  // tool_use id -> {name} for the result half, which arrives with only the id.
  const toolById = new Map<string, string>();
  let resolvedModel: string | undefined;
  // Stays undefined until a result message actually carries usage. See
  // `SessionCost`: absent and zero are different answers.
  let cost: SessionCost | undefined;
  let success = false;
  let error: string | undefined;
  let stoppedBy: AgentRunResult['stoppedBy'];
  // Hoisted out of the try: `finally` has to clear the timer, and the
  // post-loop check has to read the flag.
  let lastMessageAt = Date.now();
  let silentFor: number | undefined;
  let hangWatch: ReturnType<typeof setInterval> | undefined;
  const traj = new Trajectory(outputDir);
  const startedAt = Date.now();
  await traj.write({
    t: 'session',
    label,
    model,
    cwd: outputDir,
    maxTools: maxTools === Infinity ? null : maxTools,
    prompt: redactSecrets(prompt),
  });
  const lean = label === 'repair' && process.env['EVOGAME_LEAN_REPAIR'] === '1';
  if (lean) await prepareLeanRepair(outputDir);
  else await dropLeanRepairSettings(outputDir);
  try {
    const result = query({
      prompt,
      options: {
        cwd: outputDir,
        model,
        authType: 'openai',
        ...(lean ? { excludeTools: LEAN_REPAIR_EXCLUDED_TOOLS } : {}),
        env: {
          ...process.env,
          OPENAI_BASE_URL:
            process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',
          OPENAI_API_KEY:
            process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || '',
          QWEN_SYSTEM_MD: '1',
          HOME: process.env.HOME || process.env.USERPROFILE || '',
          USERPROFILE: process.env.USERPROFILE || process.env.HOME || '',
          GAME_TEMPLATES_DIR: path.join(PROJECT_ROOT, 'templates'),
          GAME_DOCS_DIR: path.join(PROJECT_ROOT, 'docs'),
          PATH: `${process.env.CUSTOM_BIN_DIR || ''}${
            process.env.CUSTOM_BIN_DIR ? ':' : ''
          }${process.env.PATH || '/usr/bin:/bin'}`,
          MODEL_REQUEST_TIMEOUT: '1200000',
        },
        permissionMode: 'yolo',
      },
    });

    // The hang detector. `awaitingResult` is already the record of whether a
    // tool is in flight, so which budget applies needs no new state: non-empty
    // means we are waiting on a tool, empty means we are waiting on the model.
    //
    // A RACE THAT HAD TO BE CLOSED: the loop below cannot notice the timer
    // while it is blocked on `for await`, so the timer aborts the query and
    // the loop finds out when the iterator ends. Without the abort the flag
    // would only be read after the next message -- which in a hang never
    // comes, and the timeout would do nothing at all.
    lastMessageAt = Date.now();
    hangWatch = setInterval(() => {
      const limit = awaitingResult.size ? TOOL_SILENCE_MS : MODEL_SILENCE_MS;
      const quiet = Date.now() - lastMessageAt;
      if (quiet < limit) return;
      silentFor = quiet;
      if (hangWatch) clearInterval(hangWatch);
      process.stderr.write(
        `\n    [${label}] went silent for ${Math.round(quiet / 1000)}s with ${
          awaitingResult.size ? 'a tool in flight' : 'nothing in flight'
        } — abandoning the session so it can be retried\n`,
      );
      try {
        (result as { interrupt?: () => void }).interrupt?.();
      } catch {
        /* the iterator is ending anyway; the flag is what stops the loop */
      }
    }, 15_000);

    for await (const message of result) {
      lastMessageAt = Date.now();
      if (silentFor !== undefined) break;
      if (isSDKAssistantMessage(message)) {
        // The first assistant message carries what the API resolved the model
        // alias to. Taken once: a session that somehow spanned two would be a
        // fact worth seeing rather than one to average away, and the first is
        // the one that produced the work.
        resolvedModel =
          resolvedModel ||
          (message.message as { model?: string }).model ||
          undefined;
        const text = message.message.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('');
        if (text.trim()) {
          messages.push(text);
          await traj.write({ t: 'text', text: redactSecrets(text) });
        }
        const tools = message.message.content.filter(
          (b) => b.type === 'tool_use',
        );
        for (const t of tools) {
          const tu = t as { id?: string; name: string; input: unknown };
          if (tu.id) {
            awaitingResult.set(tu.id, toolCalls.length);
            toolById.set(tu.id, tu.name);
          }
          const input = redactDeep(tu.input);
          toolCalls.push({
            name: tu.name,
            target: toolTarget(tu.input),
            input,
          });
          const { text: inputJson, truncated } = clip(
            JSON.stringify(input ?? null),
            TRAJECTORY_INPUT_CHARS,
          );
          await traj.write({
            t: 'tool_use',
            id: tu.id,
            name: tu.name,
            // Re-parsed so the line stays one JSON object; on the rare
            // truncation the raw string is kept instead of a parse error.
            input: truncated ? inputJson : input,
            inputTruncated: truncated,
          });
        }
        if (tools.length) {
          process.stderr.write(
            `\r    [${label}] tools: ${messages.length} msgs, last: ${tools
              .map((t) => (t as { name: string }).name)
              .join(',')}      `,
          );
        }
        if (toolCalls.length >= maxTools) {
          stoppedBy = 'tool_budget';
          process.stderr.write(
            `\n    [${label}] tool budget reached (${toolCalls.length}/${maxTools}) — ending session\n`,
          );
          break;
        }
      } else if (isSDKUserMessage(message)) {
        // Tool results arrive as user-role messages. Nothing here changes what
        // the agent does; it only stops the reply being dropped on the floor.
        const content = (message as { message?: { content?: unknown } }).message
          ?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            const br = b as {
              type?: string;
              tool_use_id?: string;
              content?: unknown;
            };
            if (br.type !== 'tool_result' || !br.tool_use_id) continue;
            const text = redactSecrets(flattenResult(br.content));
            // The trajectory keeps the reply at its own, far larger cap, and
            // it does so even for a result whose tool_use was never seen --
            // an unmatched id means the summary cannot place it, not that the
            // model did not read it.
            const full = clip(text, TRAJECTORY_RESULT_CHARS);
            await traj.write({
              t: 'tool_result',
              id: br.tool_use_id,
              name: toolById.get(br.tool_use_id),
              text: full.text,
              truncated: full.truncated,
            });
            const idx = awaitingResult.get(br.tool_use_id);
            if (idx === undefined) continue;
            const call = toolCalls[idx];
            const cap = /shell|bash|run/i.test(call.name)
              ? SHELL_RESULT_CHARS
              : OTHER_RESULT_CHARS;
            call.result = text.slice(0, cap);
            if (text.length > cap) call.resultTruncated = true;
            awaitingResult.delete(br.tool_use_id);
          }
        }
      } else if (isSDKResultMessage(message)) {
        success = message.subtype === 'success';
        // WHAT THIS SESSION COST, read from the message we were already
        // receiving. Before this, the branch took `subtype` and dropped the
        // rest, so the loop had no cost figure of any kind for its own work --
        // only wall time -- while the baseline corpus it is compared against
        // records usage per game. Both result subtypes carry it, so a FAILED
        // session is measured too: a run that burned its budget and produced
        // nothing is exactly the one worth seeing in the ledger.
        const m = message as unknown as {
          usage?: Record<string, number>;
          num_turns?: number;
          duration_api_ms?: number;
          modelUsage?: Record<string, unknown>;
        };
        const u = m.usage;
        if (u || m.num_turns !== undefined) {
          cost = {
            ...(cost ?? {}),
            inputTokens: u?.input_tokens,
            outputTokens: u?.output_tokens,
            cacheReadInputTokens: u?.cache_read_input_tokens,
            cacheCreationInputTokens: u?.cache_creation_input_tokens,
            numTurns: m.num_turns,
            durationApiMs: m.duration_api_ms,
            byModel: m.modelUsage,
          };
        }
        if (!success)
          error =
            (message as { error?: { message?: string } }).error?.message ||
            'query failed';
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    success = false;
  } finally {
    if (hangWatch) clearInterval(hangWatch);
  }
  // A hang wins over whatever the dying iterator said on its way out. It
  // reports it as an ABANDONED session, not a failed one: the difference
  // matters to the retry, which re-runs a transport fault and gives up on a
  // genuine failure, and `went silent for` is in TRANSPORT_FAULT_RE so this
  // takes the retry.
  if (silentFor !== undefined) {
    success = false;
    stoppedBy = 'silent';
    error = `the session went silent for ${Math.round(
      silentFor / 1000,
    )}s and was abandoned`;
  }
  // EVERY message being an error catches a session that never started. It does
  // NOT catch a session that DIED, which is the far commoner case: the agent
  // works for forty minutes, the platform returns one error, and the run ends
  // there with a transcript that is almost entirely real work.
  //
  // Measured on grid-toggle-D3-066: killed by a 400 after 74 tool calls, and
  // `end` said success:true, because 73 of its messages were fine. Those
  // labels are already in the corpus and in the a2f archive.
  //
  // So the test is on the LAST message. A session whose final word from the
  // platform is an error did not finish, whatever came before it.
  const lastMessage = messages.length
    ? messages[messages.length - 1].trim()
    : '';
  if (success && lastMessage && ERROR_ONLY_MESSAGE_RE.test(lastMessage)) {
    success = false;
    error = lastMessage;
  }
  // A session cut short by its budget is REPORTED AS SUCCESSFUL, and that is
  // deliberate: `success` here means the harness ran, not that the repair
  // worked -- nothing downstream reads it as a verdict, and the independent
  // verifier decides that. What matters is that `stoppedBy` says the agent did
  // not choose to stop, so a truncated session is never mistaken for a
  // finished one when the trace is read back.
  // A SESSION THAT CALLED NO TOOL DID NOT RUN. `success` here means the
  // harness worked, not that the repair did -- but an agent asked to change a
  // game, which inspected nothing and edited nothing, was never given a
  // working session. Independent of the message text, because the next
  // platform error will be shaped differently from the last one, and the
  // difference between "declined to act" and "never got to act" is the whole
  // question when the record is read later.
  if (!toolCalls.length && stoppedBy !== 'tool_budget') {
    success = false;
    error =
      error ||
      (messages.length
        ? messages[messages.length - 1]
        : 'the session made no tool calls and produced no text');
  }
  if (stoppedBy === 'tool_budget' && !error) success = true;
  // Closes the record with the same three facts a reader needs to decide
  // whether the episode is usable: did the harness finish, was it cut off, and
  // did the agent ever edit anything. A trajectory with no `end` line was
  // killed outright -- which is itself worth being able to tell.
  await traj.write({
    t: 'end',
    success,
    error,
    stoppedBy: stoppedBy ?? null,
    resolvedModel: resolvedModel ?? null,
    nTools: toolCalls.length,
    wallMs: Date.now() - startedAt,
  });
  return {
    success,
    error,
    messages,
    toolCalls,
    stoppedBy,
    resolvedModel,
    cost,
  };
}

/**
 * Errors that are the transport failing, not the agent or the request.
 *
 * `400 Request body must be valid JSON` is the one that matters. It looks like
 * a client bug and is not: the bytes leaving this process are valid JSON, and
 * which requests fail is conditioned on how long the connection sat idle
 * (0.12% under a second, 4.75% in the 6-15s band, back down above that -- the
 * shape of a race, not a threshold), on a plain-HTTP path that crosses a TLB,
 * an IDC boundary and a gateway that self-declares it modifies traffic.
 *
 * Neither retry layer below us covers it: the openai SDK retries 408/409/429
 * and 5xx, the CLI retries 429 and 5xx. So a two-second glitch discards a
 * whole session.
 */
const TRANSPORT_FAULT_RE =
  /request body must be valid json|invalid_json|socket hang up|ECONNRESET|EPIPE|premature close|went silent for/i;

/**
 * How long a session may say nothing before it is treated as hung.
 *
 * `runAgent` had no timeout of any kind. When the stream stops yielding -- what
 * a dead socket looks like from inside the iterator -- it waited forever, the
 * worker blocked, and only an external watchdog freed it half an hour later.
 * Measured over one four-hour run of three workers: five transport faults,
 * each costing about thirty minutes, roughly 21% of the fleet's time.
 *
 * TWO LIMITS, BECAUSE ONE CANNOT SERVE BOTH CASES. Over 13,204 real gaps
 * between trajectory records:
 *
 *   a tool is running   p99 16 min, longest 102 min -- and 81 of the 87 gaps
 *                       over five minutes were `generate_game_assets`, which
 *                       is slow on purpose
 *   waiting on a model  p99 1.1 min; only 13 gaps of 6,839 passed five
 *                       minutes, and four of those were the hang itself
 *
 * So silence while nothing is in flight is nearly always a fault, and silence
 * while a tool runs is nearly always work. A single limit would have to sit
 * above the tool tail, which is where the 30-minute stall already sits.
 */
const MODEL_SILENCE_MS = 5 * 60_000;
const TOOL_SILENCE_MS = 25 * 60_000;

/**
 * runAgent, plus retries for a session the transport killed.
 *
 * WHY THIS EXISTS AT THE SESSION LEVEL AND NOT THE REQUEST LEVEL. The right
 * place to retry a bad response is where the request is made, inside the SDK
 * -- two seconds instead of a whole session. That code is a built artifact
 * outside this worktree, and rebuilding it while a fleet is running is not a
 * change to make unattended. This is the coarse version: it re-runs the
 * session, which is expensive, and still far better than losing the game.
 *
 * Generation had NO retry at all. `repair.py` has had four attempts with
 * backoff for a while; the initial build had none, so one glitch anywhere in a
 * ~100-request session lost it outright.
 *
 * A retried attempt starts in the SAME directory, so it sees whatever the dead
 * attempt had already written. That is deliberate -- the work is not thrown
 * away, and the agent orients from its own partial output.
 */
export async function runAgentWithRetry(
  prompt: string,
  outputDir: string,
  model: string,
  label: string,
  maxTools: number = Infinity,
  attempts: number = 3,
): Promise<AgentRunResult & { transportRetries?: number }> {
  let last: AgentRunResult | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      // Long enough for a pooled socket to be discarded rather than reused,
      // since reuse is what correlates with the fault.
      const wait = 15_000 * i;
      process.stderr.write(
        `\n    [${label}] transport fault, attempt ${i + 1}/${attempts} in ${
          wait / 1000
        }s: ${String(last?.error).slice(0, 90)}\n`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
    last = await runAgent(prompt, outputDir, model, label, maxTools);
    if (last.success || !TRANSPORT_FAULT_RE.test(String(last.error ?? ''))) {
      return { ...last, transportRetries: i };
    }
  }
  return { ...(last as AgentRunResult), transportRetries: attempts - 1 };
}

// Safety net: the agent must never touch build config (custom.md), but some
// models clobber postcss.config.js to `{ plugins: {} }`, which silently drops
// ALL Tailwind CSS — every DOM screen (title/menus) then renders unstyled.
// Restore it from the template and rebuild so the corrected CSS actually
// ships. Returns true only when a restore + rebuild actually happened.
export async function restoreBuildConfig(outputDir: string): Promise<boolean> {
  const good = await fs.readFile(
    path.join(PROJECT_ROOT, 'templates', 'core', 'postcss.config.js'),
    'utf-8',
  );
  const dst = path.join(outputDir, 'postcss.config.js');
  let cur = '';
  try {
    cur = await fs.readFile(dst, 'utf-8');
  } catch {
    return false; // no config to restore (unexpected) — leave as-is
  }
  if (cur.replace(/\s/g, '') === good.replace(/\s/g, '')) return false; // already correct
  await fs.writeFile(dst, good, 'utf-8');
  await new Promise<void>((resolve) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: outputDir,
      stdio: 'ignore',
    });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
  return true;
}

// Headless runtime smoke: boots the built dist and reports whether it actually
// runs (no uncaught boot error, __rlenv present, a gameplay scene reachable).
// Returns null when smoke is disabled or the checker itself can't run (never
// blocks on tooling problems — only on real game failures).
export async function runSmoke(
  outputDir: string,
  port: number,
): Promise<SmokeResult | null> {
  if (process.env.ENABLE_SMOKE === '0') return null;
  const py =
    process.env.SMOKE_PYTHON ||
    path.join(PROJECT_ROOT, 'rl_env', 'venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'smoke_check.py');
  return await new Promise<SmokeResult | null>((resolve) => {
    let out = '';
    const child = spawn(
      py,
      ['-u', script, '--game-dir', outputDir, '--port', String(port)],
      { cwd: PROJECT_ROOT },
    );
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null)); // checker couldn't start -> don't gate
    child.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      try {
        resolve(JSON.parse(line) as SmokeResult);
      } catch {
        resolve(null);
      }
    });
  });
}
