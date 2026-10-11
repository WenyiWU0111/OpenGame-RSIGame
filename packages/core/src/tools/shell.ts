/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os, { EOL } from 'node:os';
import crypto from 'node:crypto';
import type { Config } from '../config/config.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolResultDisplay,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationPayload,
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolConfirmationOutcome,
  Kind,
} from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { summarizeToolOutput } from '../utils/summarizer.js';
import type {
  ShellExecutionConfig,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import {
  getCommandRoots,
  isCommandAllowed,
  isCommandNeedsPermission,
  stripShellWrapper,
} from '../utils/shell-utils.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;

export interface ShellToolParams {
  command: string;
  is_background: boolean;
  description?: string;
  directory?: string;
}

/**
 * The command that never returns, if this is one.
 *
 * MEASURED, not guessed at. Across three generation workers, eight shell calls
 * ran past twenty minutes and seven of them were `npm run dev` -- a dev server
 * started in the FOREGROUND, so the tool sat waiting for a process designed
 * never to exit until a timeout or a reaper killed it. Each cost 25-35
 * minutes of a worker. One agent even added `CHOKIDAR_USEPOLLING=1`, trying to
 * fix a file-watching problem it had inferred from the silence; it had no
 * such problem, it had simply blocked itself.
 *
 * A REFUSAL AND NOT A WARNING, on the evidence of this repo: the same day, an
 * asset rule that refused a bad call held all day while two rules that only
 * documented themselves were broken ten times.
 *
 * WHAT MUST STILL PASS, because a rule that blocks real work is worse than
 * the problem:
 *   `npm run dev &` and any other backgrounded form -- it returns immediately
 *   `npm run build`, `npm test`, `npm ci` -- these exit on their own
 *   anything with the server name only inside a quoted string or a comment
 */
function longRunningServer(command: string): string | null {
  // Backgrounded, so it returns. `&&` is not backgrounding.
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
  for (const [re, label] of SERVERS) {
    if (re.test(command)) return label;
  }
  return null;
}

/**
 * A scan of the whole filesystem, if this is one.
 *
 * MEASURED, not guessed at. On 2026-08-30 this host carried 21 abandoned
 * `find /` processes, each pinned to a core. The oldest had run 39 hours; 13
 * had outlived their session by over a day and been reparented to init, so
 * nothing was left to read their output. Together: 628 core-hours, finding
 * nothing.
 *
 * All the same shape -- an agent looking for where something is installed:
 *
 *   find / -maxdepth 6 -name "playwright*" -path "*node_modules*" -type d
 *   find / -name frame01.jpg -newermt '-5 minutes'
 *   find / -name zone_debug.txt
 *
 * `-maxdepth` does not save it: the 39-hour one had `-maxdepth 6`. Nor does
 * `| head -3`, which is how these were written -- head exits after three
 * lines, but when the scan never finds three matches head keeps waiting, find
 * keeps scanning, and the call never returns. One session sat blocked on a
 * single such call for 9.4 hours, its model idle, waiting on a result that was
 * never coming.
 *
 * A REFUSAL AND NOT A WARNING, for the same reason as the server rule above.
 *
 * WHAT MUST STILL PASS, because a rule that blocks real work is worse than the
 * problem:
 *   `find . -name '*.tscn'`, `find src -type f` -- scoped, and the common case
 *   `find /workspace/game -name '*.gd'` -- absolute, but not root
 */
function wholeFilesystemScan(command: string): string | null {
  // Quoted spans are data, not the command: `echo "find / -name x"` runs no
  // scan. Dropping them first also leaves the real calls intact, because in
  // those the quotes are around the pattern (`-name "playwright*"`), never
  // around `find /` itself.
  const bare = command.replace(/'[^']*'|"[^"]*"/g, ' ');
  if (/\bfind\s+\/(\s|$)/.test(bare)) return 'find /';
  if (/\bgrep\b[^|;]*\s-\w*r\w*\b[^|;]*\s\/(\s|$)/.test(bare)) {
    return 'grep -r /';
  }
  return null;
}

/**
 * The refusal that stops an agent killing the run it belongs to.
 *
 * On 2026-09-01 a repair session tidying up after itself ran
 * `pkill -f gamedoctor; pkill -f godot`. Every process in this project has
 * `gamedoctor_run` in its path, so that one line took the other four games
 * running beside it, both batch drivers, and the supervising units -- six
 * systemd services inside 24 milliseconds. It happened three times before the
 * pattern was traced, and the wasted rounds are gone.
 *
 * The mistake is structural, not careless: a pattern matched against the
 * process table cannot distinguish the thing you started from everything that
 * merely shares a word with it. Killing by pgid has the same shape, and is
 * worse, because a whole batch is one group.
 *
 * WHAT MUST STILL PASS. Stopping your own process is ordinary and necessary:
 * `kill 12345`, `kill -9 12345`, `kill -TERM $pid` all go through. So does
 * `pgrep -f godot` -- looking is not killing, and it is how you find the pid to
 * use.
 */
function patternKill(command: string): string | null {
  // THE RAW COMMAND, NOT A DE-QUOTED ONE.
  //
  // This used to blank quoted spans first -- `command.replace(/'[^']*'|"[^"]*"/g,
  // ' ')` -- so that a mention of pkill inside an echo would not trip the guard.
  // That reasoning is wrong for the shapes that matter, because in every one of
  // them the quoted span IS the thing that executes:
  //
  //     sh -c "pkill -f godot"
  //     bash -c 'killall godot'
  //     python3 -c 'subprocess.run(["pkill", "-f", "godot"])'
  //
  // All four went straight through. Reported 2026-09-05 by the session running
  // the Godot case-study batch, after a wide pkill wiped its runs three times in
  // one night; ftrace on signal_generate pinned the sender as comm=pkill, and
  // the victim list matched "argv contains godot" exactly.
  //
  // So the check runs against the command as written. The cost is a false
  // positive when an agent merely talks about pkill in an echo, and it can
  // rephrase; the cost of the false negative is other people's batches.
  if (/\bpkill\b/.test(command)) return 'pkill';
  if (/\bkillall\b/.test(command)) return 'killall';
  // A NEGATIVE ARGUMENT TO kill IS A PROCESS GROUP, and killing a group takes
  // every line of a batch that shares it. `kill 123` is a pid and is fine.
  //
  // The previous pattern -- `\bkill\b[^|;&]*\s-{1,2}\s*-\d+` -- only caught
  // `kill -- -1234`, because it required a lone `-` or `--` immediately before
  // the number. The two spellings people actually write both slipped past:
  //
  //     kill -9 -1234        the -9 consumed the dash the pattern was looking for
  //     kill -TERM -1234     same
  //
  // Measured cost of missing this: on 2026-08-31 three epoch-4 lines died to the
  // same second three times over (02:09:04, 03:33:21, 05:44:25) because they
  // shared one pgid. Match any `-<digits>` argument instead of guessing at the
  // shape of the flags before it.
  // Strip the SIGNAL arguments first, then look at what is left. `-9` and
  // `-TERM` and `-s TERM` all name a signal; a `-<digits>` that survives that
  // is a target, and a negative target is a process group. Matching
  // `-\d+` directly would refuse the entirely ordinary `kill -9 12345`.
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

export class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ShellToolParams,
    private readonly allowlist: Set<string>,
  ) {
    super(params);
  }

  getDescription(): string {
    let description = `${this.params.command}`;
    // append optional [in directory]
    // note description is needed even if validation fails due to absolute path
    if (this.params.directory) {
      description += ` [in ${this.params.directory}]`;
    }
    // append background indicator
    if (this.params.is_background) {
      description += ` [background]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      description += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    return description;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const command = stripShellWrapper(this.params.command);
    const rootCommands = [...new Set(getCommandRoots(command))];
    const commandsToConfirm = rootCommands.filter(
      (command) => !this.allowlist.has(command),
    );

    if (commandsToConfirm.length === 0) {
      return false; // already approved and allowlisted
    }

    const permissionCheck = isCommandNeedsPermission(command);
    if (!permissionCheck.requiresPermission) {
      return false;
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: commandsToConfirm.join(', '),
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          commandsToConfirm.forEach((command) => this.allowlist.add(command));
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
    shellExecutionConfig?: ShellExecutionConfig,
    setPidCallback?: (pid: number) => void,
  ): Promise<ToolResult> {
    const strippedCommand = stripShellWrapper(this.params.command);

    if (signal.aborted) {
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    const isWindows = os.platform() === 'win32';
    const tempFileName = `shell_pgrep_${crypto
      .randomBytes(6)
      .toString('hex')}.tmp`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    try {
      // Add co-author to git commit commands
      const processedCommand = this.addCoAuthorToGitCommit(strippedCommand);

      const shouldRunInBackground = this.params.is_background;
      let finalCommand = processedCommand;

      // If explicitly marked as background and doesn't already end with &, add it
      if (shouldRunInBackground && !finalCommand.trim().endsWith('&')) {
        finalCommand = finalCommand.trim() + ' &';
      }

      // pgrep is not available on Windows, so we can't get background PIDs
      const commandToExecute = isWindows
        ? finalCommand
        : (() => {
            // wrap command to append subprocess pids (via pgrep) to temporary file
            let command = finalCommand.trim();
            if (!command.endsWith('&')) command += ';';
            return `{ ${command} }; __code=$?; pgrep -g 0 >${tempFilePath} 2>&1; exit $__code;`;
          })();

      const cwd = this.params.directory || this.config.getTargetDir();

      let cumulativeOutput: string | AnsiOutput = '';
      let lastUpdateTime = Date.now();
      let isBinaryStream = false;

      const { result: resultPromise, pid } =
        await ShellExecutionService.execute(
          commandToExecute,
          cwd,
          (event: ShellOutputEvent) => {
            if (!updateOutput) {
              return;
            }

            let shouldUpdate = false;

            switch (event.type) {
              case 'data':
                if (isBinaryStream) break;
                cumulativeOutput = event.chunk;
                shouldUpdate = true;
                break;
              case 'binary_detected':
                isBinaryStream = true;
                cumulativeOutput =
                  '[Binary output detected. Halting stream...]';
                shouldUpdate = true;
                break;
              case 'binary_progress':
                isBinaryStream = true;
                cumulativeOutput = `[Receiving binary output... ${formatMemoryUsage(
                  event.bytesReceived,
                )} received]`;
                if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
                  shouldUpdate = true;
                }
                break;
              default: {
                throw new Error('An unhandled ShellOutputEvent was found.');
              }
            }

            if (shouldUpdate) {
              updateOutput(
                typeof cumulativeOutput === 'string'
                  ? cumulativeOutput
                  : { ansiOutput: cumulativeOutput },
              );
              lastUpdateTime = Date.now();
            }
          },
          signal,
          this.config.getShouldUseNodePtyShell(),
          shellExecutionConfig ?? {},
        );

      if (pid && setPidCallback) {
        setPidCallback(pid);
      }

      const result = await resultPromise;

      const backgroundPIDs: number[] = [];
      if (os.platform() !== 'win32') {
        if (fs.existsSync(tempFilePath)) {
          const pgrepLines = fs
            .readFileSync(tempFilePath, 'utf8')
            .split(EOL)
            .filter(Boolean);
          for (const line of pgrepLines) {
            if (!/^\d+$/.test(line)) {
              console.error(`pgrep: ${line}`);
            }
            const pid = Number(line);
            if (pid !== result.pid) {
              backgroundPIDs.push(pid);
            }
          }
        } else {
          if (!signal.aborted) {
            console.error('missing pgrep output');
          }
        }
      }

      let llmContent = '';
      if (result.aborted) {
        llmContent = 'Command was cancelled by user before it could complete.';
        if (result.output.trim()) {
          llmContent += ` Below is the output before it was cancelled:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it was cancelled.';
        }
      } else {
        // Create a formatted error string for display, replacing the wrapper command
        // with the user-facing command.
        const finalError = result.error
          ? result.error.message.replace(commandToExecute, this.params.command)
          : '(none)';

        llmContent = [
          `Command: ${this.params.command}`,
          `Directory: ${this.params.directory || '(root)'}`,
          `Output: ${result.output || '(empty)'}`,
          `Error: ${finalError}`, // Use the cleaned error string.
          `Exit Code: ${result.exitCode ?? '(none)'}`,
          `Signal: ${result.signal ?? '(none)'}`,
          `Background PIDs: ${
            backgroundPIDs.length ? backgroundPIDs.join(', ') : '(none)'
          }`,
          `Process Group PGID: ${result.pid ?? '(none)'}`,
        ].join('\n');
      }

      let returnDisplayMessage = '';
      if (this.config.getDebugMode()) {
        returnDisplayMessage = llmContent;
      } else {
        if (result.output.trim()) {
          returnDisplayMessage = result.output;
        } else {
          if (result.aborted) {
            returnDisplayMessage = 'Command cancelled by user.';
          } else if (result.signal) {
            returnDisplayMessage = `Command terminated by signal: ${result.signal}`;
          } else if (result.error) {
            returnDisplayMessage = `Command failed: ${getErrorMessage(
              result.error,
            )}`;
          } else if (result.exitCode !== null && result.exitCode !== 0) {
            returnDisplayMessage = `Command exited with code: ${result.exitCode}`;
          }
          // If output is empty and command succeeded (code 0, no error/signal/abort),
          // returnDisplayMessage will remain empty, which is fine.
        }
      }

      const summarizeConfig = this.config.getSummarizeToolOutputConfig();
      const executionError = result.error
        ? {
            error: {
              message: result.error.message,
              type: ToolErrorType.SHELL_EXECUTE_ERROR,
            },
          }
        : {};
      if (summarizeConfig && summarizeConfig[ShellTool.Name]) {
        const summary = await summarizeToolOutput(
          llmContent,
          this.config.getGeminiClient(),
          signal,
          summarizeConfig[ShellTool.Name].tokenBudget,
        );
        return {
          llmContent: summary,
          returnDisplay: returnDisplayMessage,
          ...executionError,
        };
      }

      return {
        llmContent,
        returnDisplay: returnDisplayMessage,
        ...executionError,
      };
    } finally {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }

  private addCoAuthorToGitCommit(command: string): string {
    // Check if co-author feature is enabled
    const gitCoAuthorSettings = this.config.getGitCoAuthor();

    if (!gitCoAuthorSettings.enabled) {
      return command;
    }

    // Check if this is a git commit command (anywhere in the command, e.g., after "cd /path &&")
    const gitCommitPattern = /\bgit\s+commit\b/;
    if (!gitCommitPattern.test(command)) {
      return command;
    }

    // Define the co-author line using configuration
    const coAuthor = `

Co-authored-by: ${gitCoAuthorSettings.name} <${gitCoAuthorSettings.email}>`;

    // Handle different git commit patterns:
    // Match -m "message" or -m 'message', including combined flags like -am
    // Use separate patterns to avoid ReDoS (catastrophic backtracking)
    //
    // Pattern breakdown:
    //   -[a-zA-Z]*m  matches -m, -am, -nm, etc. (combined short flags)
    //   \s+          matches whitespace after the flag
    //   [^"\\]       matches any char except double-quote and backslash
    //   \\.          matches escape sequences like \" or \\
    //   (?:...|...)* matches normal chars or escapes, repeated
    const doubleQuotePattern = /(-[a-zA-Z]*m\s+)"((?:[^"\\]|\\.)*)"/;
    const singleQuotePattern = /(-[a-zA-Z]*m\s+)'((?:[^'\\]|\\.)*)'/;
    const doubleMatch = command.match(doubleQuotePattern);
    const singleMatch = command.match(singleQuotePattern);
    const match = doubleMatch ?? singleMatch;
    const quote = doubleMatch ? '"' : "'";

    if (match) {
      const [fullMatch, prefix, existingMessage] = match;
      const newMessage = existingMessage + coAuthor;
      const replacement = prefix + quote + newMessage + quote;

      return command.replace(fullMatch, replacement);
    }

    // If no -m flag found, the command might open an editor
    // In this case, we can't easily modify it, so return as-is
    return command;
  }
}

function getShellToolDescription(): string {
  const toolDescription = `

      **Background vs Foreground Execution:**
      You should decide whether commands should run in background or foreground based on their nature:
      
      This is ENFORCED for servers, not merely advised: a foreground
      \`npm run dev\` is refused, because it never returns and the call would
      hold this tool until something kills it.

      **Use background execution (is_background: true) for:**
      - Long-running development servers: \`npm run start\`, \`npm run dev\`, \`yarn dev\`, \`bun run start\`
      - Build watchers: \`npm run watch\`, \`webpack --watch\`
      - Database servers: \`mongod\`, \`mysql\`, \`redis-server\`
      - Web servers: \`python -m http.server\`, \`php -S localhost:8000\`
      - Any command expected to run indefinitely until manually stopped
      
      **Use foreground execution (is_background: false) for:**
      - One-time commands: \`ls\`, \`cat\`, \`grep\`
      - Build commands: \`npm run build\`, \`make\`
      - Installation commands: \`npm install\`, \`pip install\`
      - Git operations: \`git commit\`, \`git push\`
      - Test runs: \`npm test\`, \`pytest\`
      
      The following information is returned:

      Command: Executed command.
      Directory: Directory where command was executed, or \`(root)\`.
      Stdout: Output on stdout stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.
      Stderr: Output on stderr stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.
      Error: Error or \`(none)\` if no error was reported for the subprocess.
      Exit Code: Exit code or \`(none)\` if terminated by signal.
      Signal: Signal number or \`(none)\` if no signal was received.
      Background PIDs: List of background processes started or \`(none)\`.
      Process Group PGID: Process group started or \`(none)\``;

  if (os.platform() === 'win32') {
    return `This tool executes a given shell command as \`cmd.exe /c <command>\`. Command can start background processes using \`start /b\`.${toolDescription}`;
  } else {
    return `This tool executes a given shell command as \`bash -c <command>\`. Command can start background processes using \`&\`. Command is executed as a subprocess that leads its own process group. Command process group can be terminated as \`kill -- -PGID\` or signaled as \`kill -s SIGNAL -- -PGID\`.${toolDescription}`;
  }
}

function getCommandDescription(): string {
  const cmd_substitution_warning =
    '\n*** WARNING: Command substitution using $(), `` ` ``, <(), or >() is not allowed for security reasons.';
  if (os.platform() === 'win32') {
    return (
      'Exact command to execute as `cmd.exe /c <command>`' +
      cmd_substitution_warning
    );
  } else {
    return (
      'Exact bash command to execute as `bash -c <command>`' +
      cmd_substitution_warning
    );
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static Name: string = ToolNames.SHELL;
  private allowlist: Set<string> = new Set();

  constructor(private readonly config: Config) {
    super(
      ShellTool.Name,
      ToolDisplayNames.SHELL,
      getShellToolDescription(),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: getCommandDescription(),
          },
          is_background: {
            type: 'boolean',
            description:
              'Whether to run the command in background. Default is false. Set to true for long-running processes like development servers, watchers, or daemons that should continue running without blocking further commands.',
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) The absolute path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist.',
          },
        },
        required: ['command', 'is_background'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    // (see longRunningServer below)
    const commandCheck = isCommandAllowed(params.command, this.config);
    if (!commandCheck.allowed) {
      if (!commandCheck.reason) {
        console.error(
          'Unexpected: isCommandAllowed returned false without a reason',
        );
        return `Command is not allowed: ${params.command}`;
      }
      return commandCheck.reason;
    }
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }
    // `is_background: true` appends `&` at execute time, so the tool already
    // returns -- refusing it would block the ONE correct way to do this.
    const server = params.is_background
      ? null
      : longRunningServer(params.command);
    const killer = patternKill(params.command);
    if (killer) {
      return (
        `\`${killer}\` matches the process table, and everything in this ` +
        `project shares a path -- so it does not stop your process, it stops ` +
        `every game running beside yours, both batch drivers and the units ` +
        `supervising them. Measured here: one \`pkill -f gamedoctor\` took ` +
        `six services inside 24 milliseconds, and the rounds they were in the ` +
        `middle of were lost.\n\n` +
        `Kill by pid. Record the pid when you start something ` +
        `(\`cmd & echo $!\`), or find it with \`pgrep -f <pattern>\` -- which ` +
        `is allowed, because looking is not killing -- and then \`kill <pid>\`. ` +
        `If you did not start it, do not stop it.`
      );
    }
    const scan = params.is_background
      ? null
      : wholeFilesystemScan(params.command);
    if (scan) {
      return (
        `\`${scan}\` walks every file on this machine, which is shared. ` +
        `Twenty-one of these were found abandoned here, the oldest running ` +
        `39 hours, together burning 628 core-hours and finding nothing. ` +
        `\`-maxdepth\` does not bound it, and \`| head -3\` does not end it: ` +
        `head waits for matches that never come, so the call never returns -- ` +
        `one session blocked on exactly this for 9.4 hours.\n\n` +
        `Search where the thing would actually be. For an installed package ` +
        `ask whatever installed it -- \`npm ls <pkg>\`, \`npm root -g\`, ` +
        `\`which <bin>\` -- and for your own output, search the directory you ` +
        `wrote it to.\n\n` +
        `If you must scan, give it a root and a bound: ` +
        `\`timeout 30 find /workspace -maxdepth 4 -name '<pattern>'\`.`
      );
    }
    if (server) {
      return (
        `\`${server}\` starts a server that never exits, so this call would ` +
        `block until something kills it. Seven sessions were lost to exactly ` +
        `this, each holding the tool for 25-35 minutes.\n\n` +
        `You do not need to start one. The harness serves the build and ` +
        `drives it for you -- use \`play_cli\` to open the game and act on ` +
        `it.\n\n` +
        `If you truly need a server of your own, pass ` +
        `\`is_background: true\` on this tool -- that is what it is for -- ` +
        `or background it yourself with a trailing \`&\`.`
      );
    }
    if (getCommandRoots(params.command).length === 0) {
      return 'Could not identify command root to obtain permission from user.';
    }
    if (params.directory) {
      if (!path.isAbsolute(params.directory)) {
        return 'Directory must be an absolute path.';
      }
      const workspaceDirs = this.config.getWorkspaceContext().getDirectories();
      const isWithinWorkspace = workspaceDirs.some((wsDir) =>
        params.directory!.startsWith(wsDir),
      );

      if (!isWithinWorkspace) {
        return `Directory '${params.directory}' is not within any of the registered workspace directories.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    return new ShellToolInvocation(this.config, params, this.allowlist);
  }
}
