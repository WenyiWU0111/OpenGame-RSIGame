# OpenGame-RSIGame

The fork of [OpenGame](https://github.com/leigest519/OpenGame) that
[RSIGame](https://github.com/WenyiWU0111/RSIGame) uses as its **repair agent**.
RSIGame's development loop calls `agent-test/scripts/agent_repair.ts` once per
round. That script, and the OpenGame changes it depends on, are not in upstream
OpenGame, so RSIGame needs this checkout for both engines (Godot and Phaser).

The original OpenGame README is kept as [README.upstream.md](README.upstream.md).

## What this fork adds

- `agent-test/scripts/agent_repair.ts`: runs one coding-agent repair round on
  an existing game directory and prints one JSON line (`success`, `n_tools`,
  `files_edited`, `cost`, …). It takes `--game-dir`, `--prompt-file`,
  `--log-file`, `--engine web|godot`, `--max-tools` and `--model`.
- `agent-test/scripts/lib/agent_run.ts`: the shared `runAgent()` used by both
  `agent_repair.ts` and `batch_generate.ts`, with a tool-call cap per session
  and success detection that does not count a transcript of only error
  messages as a success.
- `agent-test/prompts/custom_godot.md`: the system prompt for Godot repairs
  (`--engine godot`).
- Changes under `packages/core` that the agent relies on:
  - shell guards that refuse broad `pkill -f` patterns and whole-filesystem scans;
  - asset generation: style presets, palettes, tileset processing and a
    per-round image budget;
  - fixes in the OpenAI-compatible content generator.

## Install

Requires Linux or macOS and Node.js 20 or newer.

```bash
git clone https://github.com/WenyiWU0111/OpenGame-RSIGame.git
cd OpenGame-RSIGame
npm install
npm run build          # builds packages/ and dist/cli.js, which the SDK spawns
```

Then point RSIGame at `agent-test/` of this checkout, in `configs/default.toml`:

```toml
[paths]
opengame_agent_test = "/path/to/OpenGame-RSIGame/agent-test"
```

or with `export RSIGAME_PATHS_OPENGAME_AGENT_TEST=/path/to/OpenGame-RSIGame/agent-test`.
`rsigame check` verifies that `scripts/agent_repair.ts`, `node_modules/` and
`dist/cli.js` are present.

## Running the repair agent by hand

```bash
cd agent-test
OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENAI_API_KEY=<key> \
npx tsx scripts/agent_repair.ts --game-dir <game> --prompt-file <prompt.txt> \
    --log-file <log.json> --engine godot --max-tools 26 --model z-ai/glm-5.3-flash
```

Without `--model`, the model is `GAME_AGENT_MODEL` from the environment, or
`anthropic/claude-opus-4.6` if that is unset.

## License

Apache-2.0, as upstream OpenGame. See [LICENSE](LICENSE).
