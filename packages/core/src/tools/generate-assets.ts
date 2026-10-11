/**
 * Generate Assets Tool
 * A complete rewrite inspired by PiXelDa architecture
 *
 * Features:
 * - Multi-model support (Tongyi / Doubao)
 * - Image generation with auto background removal
 * - Animation generation via I2V (Image-to-Video) or I2I fallback
 * - Audio generation via ABC Notation
 * - Background images (no bg removal)
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { ModelRouter } from '../services/assetModelRouter.js';
import { createModelRouter } from '../services/assetModelRouter.js';
import { MissingProviderConfigError } from '../services/providerConfig.js';
import { BackgroundRemovalService } from '../utils/backgroundRemoval.js';
import { FrameExtractionService } from '../services/assetVideoService.js';
import type {
  GenerateAssetsParams,
  AssetRequest,
  BackgroundRequest,
  ImageRequest,
  AnimationRequest,
  AudioRequest,
  TilesetRequest,
  AssetPack,
  AssetPackSection,
  LibraryAssetProvenance,
} from './generate-assets-types.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import {
  admit,
  balanceLine,
  budgetFromEnv,
  imagesWrittenSince,
  readLedger,
  writeLedger,
} from './asset-round-budget.js';
import {
  moderationBlock,
  moderationKeys,
  recordRefusals,
} from './moderation-refusals.js';
import { sheetPrompt, sheetSize, sliceSheet } from './sprite-sheet.js';

import {
  TILE_STRUCTURES,
  TILE_CAPS,
  PRESET_NAMES,
  findPreset,
  type TileStructure,
  type TileCap,
  type StylePreset,
} from '../data/style-presets.js';
import { TilesetProcessor } from '../services/tileset-processor.js';
import {
  generateProceduralTileset,
  FILL_VARIANT_SLOTS,
  MARKER_ROLES,
  type MarkerRole,
} from '../services/tileset-procedural.js';
import { restyleTilesetAtlas } from '../services/tileset-restyle.js';
import {
  resolveTileSize,
  recordTileSize,
  recordMarkerRoles,
} from '../services/tileGeometry.js';
import {
  checkPalette,
  PALETTE_CONFORMANCE_FLOOR,
  type PaletteReport,
} from '../services/paletteCheck.js';

// ============== Art style guide ==============
//
// `docs/art_style.md` is the game's second design document (written in Phase 2,
// before any asset exists — see prompts/custom.md step 4b). It is the colour and
// look contract every asset is generated against and then measured against.
// Absent or malformed => everything below degrades to prompt-only generation,
// exactly as before this existed.

export interface ArtStyle {
  palette: Array<{ hex: string; role: string }>;
  lineQuality?: string;
  lighting?: string;
  material?: string;
  silhouette?: string;
  forbidden?: string;
}

const _ART_STYLE_FIELDS: Array<[keyof ArtStyle, RegExp]> = [
  ['lineQuality', /^line_quality:\s*(.+)$/im],
  ['lighting', /^lighting:\s*(.+)$/im],
  ['material', /^material:\s*(.+)$/im],
  ['silhouette', /^silhouette:\s*(.+)$/im],
  ['forbidden', /^forbidden:\s*(.+)$/im],
];

/** Parse `docs/art_style.md`. Returns null when absent or when it declares no palette. */
export function parseArtStyle(text: string): ArtStyle | null {
  const palette: Array<{ hex: string; role: string }> = [];
  // Palette entries look like: `- #2B1B3D — deep background / night sky`
  // Accept em dash, en dash, hyphen or colon as the separator, and a bare hex.
  //
  // The block runs from the `palette:` header to the next `field:` line, or to
  // the true end of input — `$(?![\s\S])`, not `\Z`, which JavaScript does not
  // support: it is the literal letter Z, and under the `i` flag it matched any
  // lowercase z, silently truncating the palette at the first role word
  // containing one ("safe zones" cost us a colour before this was caught).
  const paletteBlock =
    /^palette:[^\n]*\n([\s\S]*?)(?=^[A-Za-z_][A-Za-z0-9_ ]*:|$(?![\s\S]))/im.exec(
      text,
    );
  const scope = paletteBlock ? paletteBlock[1] : text;
  const line = /^[-*]?\s*(#[0-9a-f]{6})\s*(?:[—–\-:]\s*(.*))?$/gim;
  let m: RegExpExecArray | null;
  while ((m = line.exec(scope)) !== null) {
    palette.push({ hex: m[1].toLowerCase(), role: (m[2] || '').trim() });
    if (palette.length >= 12) break;
  }
  if (palette.length === 0) return null;

  const style: ArtStyle = { palette };
  for (const [key, re] of _ART_STYLE_FIELDS) {
    const hit = re.exec(text);
    if (hit) (style as unknown as Record<string, unknown>)[key] = hit[1].trim();
  }
  return style;
}

/**
 * One compact block appended to every asset prompt.
 *
 * IT ASKS FOR TWO THINGS, NOT ONE. The palette line on its own is an
 * instruction to make everything match, and an image model follows it: the
 * asset comes back in the game's colours and also comes back unable to be
 * told apart from what it will sit on. Nothing else in this pipeline asked
 * for the other half -- a search of every prompt here for contrast, legible
 * or readable found a shape field and a code comment, against four separate
 * places pushing for unification.
 *
 * The graded rubric wants both and scores them separately: "a single
 * consistent visual language, no clashing bright colours" under art, and "all
 * elements are readable and non-overlapping at 1280x720" under the loop. A
 * contract that carries only the first trades one scored property for
 * another, which is not a style decision, it is an accident.
 *
 * Separation INSIDE the palette, not by adding hues: a palette wide enough to
 * be a palette has a light end and a dark end, and that is where the contrast
 * comes from. Otherwise this line would just be the drift the conformance
 * check exists to catch.
 */
export function artStylePromptBlock(style: ArtStyle | null): string {
  if (!style) return '';
  const swatches = style.palette
    .map((p) => (p.role ? `${p.hex} (${p.role})` : p.hex))
    .join(', ');
  const lines = [
    `STYLE CONTRACT — use this game's declared palette: ${swatches}.`,
    `Within that palette, keep the subject readable against what it will be ` +
      `drawn on: give it its own value (light/dark) separation, not just its ` +
      `own hue. Matching the palette and disappearing into the background are ` +
      `not the same success.`,
  ];
  if (style.lineQuality) lines.push(`Line quality: ${style.lineQuality}.`);
  if (style.lighting) lines.push(`Lighting: ${style.lighting}.`);
  if (style.material) lines.push(`Materials: ${style.material}.`);
  if (style.silhouette) lines.push(`Silhouette: ${style.silhouette}.`);
  if (style.forbidden) lines.push(`NEVER: ${style.forbidden}.`);
  return lines.join(' ');
}

// ============== Constants ==============

const MAX_CONCURRENCY = 2;
// Gap between serial slow-lane (image/animation) requests, to stay under the image
// gateway's rate limit and avoid the 429 pile-up that drops character sprites.
const SLOW_LANE_GAP_MS = 1500;

/**
 * Output size requested for the tileset surface repaint. The Ark gateway only
 * accepts image-CONDITIONED generations at >= ~3.79MP (see the note on
 * DoubaoImageService.I2I_MIN_SIZE), so anything smaller is silently promoted;
 * asking for it directly keeps the request honest. The restyle pass normalises
 * whatever comes back before cropping, so the exact number is not load-bearing.
 */
const TILESET_RESTYLE_SIZE = '2048x2048';

/**
 * Where this call is getting its assets from, as mutable state.
 *
 * It has to be mutable because the decision can change mid-call: the stall
 * watchdog flips `library` when the gateway goes quiet, and every asset that
 * has not started yet then takes the library path. A boolean argument copied
 * into each worker could not express that.
 *
 * `fellBack` is separate from `library` on purpose. A call that STARTED in
 * library mode did not stall, and must not count toward the streak that
 * decides generation is hopeless.
 */
interface AssetSourceMode {
  library: boolean;
  fellBack: boolean;
  lastProgress: number;
  /**
   * Whether the LIBRARY PATH PICKS THE FILE, or the agent does.
   *
   * `OPENGAME_ASSET_MODE=library` is a deliberate, whole-run choice and keeps
   * the keyword scorer. A STALL is not a choice, and the scorer is not good
   * enough to be handed a decision nobody asked it to make: measured on one
   * forced run it answered `coin_gold_side.png` for a mirrorball-headed enemy,
   * the same coin again for a tileset, one blonde character for all twelve
   * frames of an animation (so nothing animates), and a female voice clip
   * saying "final round" for level 3's background music. Those files load and
   * the game builds, which is exactly what makes them dangerous: the corpus
   * records a game whose art was never chosen by anyone.
   *
   * So on a stall we do what gamecraft-bench does -- mount the library, name
   * the packs, and let the agent browse and copy. It is the agent's call, and
   * the trajectory records it as one.
   */
  codePick: boolean;
  /**
   * Assets the stall handed back to the agent.
   *
   * Lane order, not request order: audio and the other fast types are drained
   * before the slow lane starts, so a run that stalls hands back whatever had
   * not started yet, in the order the lanes reached it.
   */
  handoff: AssetRequest[];
}

interface LibraryIndexEntry {
  p: string;
  k: string;
  s: string;
  fn: string[];
  dir: string[];
  tg: string[];
}

interface LibraryMatch {
  path: string;
  score: number;
  entry: LibraryIndexEntry;
}

// ============== Invocation Class ==============

class GenerateAssetsInvocation extends BaseToolInvocation<
  GenerateAssetsParams,
  ToolResult
> {
  private config: Config;
  /**
   * How many calls IN A ROW ended up falling back to the library because the
   * image gateway went silent.
   *
   * Static because the question is about the gateway, not about one asset
   * request: an invocation is constructed per call, and a counter living on it
   * would reset every time and never reach its limit. Process-scoped, so one
   * game's bad run does not condemn the next game -- a fresh process starts
   * hopeful again.
   */
  private static stallStreak = 0;
  /**
   * The router (and its underlying provider services) is built lazily so
   * a missing API key surfaces as an actionable execute-time error
   * instead of crashing tool registration / invocation construction.
   */
  private modelRouter!: ModelRouter;
  private bgRemovalService: BackgroundRemovalService;
  private frameExtractionService: FrameExtractionService;
  private tilesetProcessor: TilesetProcessor;
  /**
   * Per-game style-anchor image URL. Generated ONCE per tool run from the
   * textual style_anchor, then passed as the reference image for every
   * background / sprite / animation-base generation so all assets share
   * one concrete visual language instead of only sharing adjectives.
   * null = not generated (library mode, disabled via env, or the anchor
   * generation itself failed — all asset paths degrade to prompt-only).
   */
  private styleAnchorUrl: string | null = null;
  /** Parsed `docs/art_style.md`, or null when the game didn't write one. */
  private artStyle: ArtStyle | null = null;
  /** Per-asset audit rows, written out as `_asset_report.json` + contact sheet. */
  private assetReport: Array<{
    key: string;
    type: string;
    file: string;
    bytes: number;
    conformance: number | null;
    offPalette: string[];
    regenerated: boolean;
  }> = [];

  constructor(config: Config, params: GenerateAssetsParams) {
    super(params);
    this.config = config;

    // Initialize background removal service
    // Use BACKGROUND_REMOVAL_BACKEND env var to switch: 'imgly' (default) or 'rembg' (Python/PiXelDa)
    const bgBackend =
      (process.env.BACKGROUND_REMOVAL_BACKEND as 'imgly' | 'rembg') || 'imgly';
    this.bgRemovalService = new BackgroundRemovalService({
      projectRoot: config.getProjectRoot(),
      backend: bgBackend,
      pythonPath: process.env.PYTHON_PATH, // Optional: custom Python path
    });

    // Initialize frame extraction service
    this.frameExtractionService = new FrameExtractionService();

    // Initialize tileset processor
    this.tilesetProcessor = new TilesetProcessor();
  }

  getDescription(): string {
    return `Generating ${this.params.assets.length} assets...`;
  }

  /**
   * Build the model router on demand. Throws `MissingProviderConfigError`
   * (with an actionable message + docs link) when the user hasn't
   * configured an image provider; that error is caught at the top of
   * `execute()` and surfaced as a tool-result error rather than
   * propagated as an uncaught exception.
   */
  private ensureModelRouter(): ModelRouter {
    if (!this.modelRouter) {
      this.modelRouter = createModelRouter({
        modelType: this.params.model_type,
        providers: this.config.getOpenGameProviders(),
      });
    }
    return this.modelRouter;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    // Asset source switch: "generate" (default, call image/video/audio models)
    // or "library" (copy from a local CC0 asset library; no provider needed).
    // Flip with env OPENGAME_ASSET_MODE=library. The generation path below is
    // left fully intact so switching back is a one-env-var change.
    const forcedLibrary =
      (process.env.OPENGAME_ASSET_MODE || 'generate').trim().toLowerCase() ===
      'library';

    // AND A THIRD STATE: generate first, fall back to the library if the
    // gateway stops answering.
    //
    // Measured on the overnight run: three workers sat in this tool for 92, 61
    // and 19 minutes, each stopped at the same early point, while the image
    // backend queued. The session does not fail -- it waits, holding a worker
    // and (on this box) 265 threads, until something kills it.
    //
    // WHAT COUNTS AS STALLED is "no asset finished for N minutes", not "the
    // call took N minutes". A call generating ten sprites legitimately runs
    // past ten minutes: the slow lane is serial at ~40s each. Timing the whole
    // call would kill the healthy case and leave the hung one looking the
    // same. Progress is the thing that separates them.
    //
    // The fallback is for THIS CALL ONLY. Assets already in flight are left to
    // finish; queued ones switch. The next call tries generation again, because
    // a queue that cleared should be used.
    const stallMs = Number(process.env.OPENGAME_ASSET_STALL_MS || 600_000);
    const streakLimit = Number(process.env.OPENGAME_ASSET_STALL_STREAK || 3);
    const exhausted = GenerateAssetsInvocation.stallStreak >= streakLimit;
    if (exhausted && !forcedLibrary) {
      console.warn(
        `[GenerateAssets] ${GenerateAssetsInvocation.stallStreak} consecutive ` +
          `stalled calls: using the asset library from here on. ` +
          `Unset by restarting the process.`,
      );
    }
    const mode: AssetSourceMode = {
      library: forcedLibrary || exhausted,
      fellBack: false,
      lastProgress: Date.now(),
      // NOBODY GETS THE SCORER ANY MORE, including a deliberate library run.
      //
      // It was kept for `OPENGAME_ASSET_MODE=library` on the reasoning that a
      // whole-run choice is a human decision and the scorer was what that
      // decision had always meant. That held while library mode was a rare
      // experiment. It stops holding the moment library mode becomes how
      // every game is built -- and measured on one forced run, the scorer
      // answered `coin_gold_side.png` for a mirrorball enemy, the same coin
      // for a tileset, one blonde sprite for all twelve frames of an
      // animation, and a voice clip saying "final round" for level 3's music.
      //
      // A corpus built that way records games whose art nobody chose, and the
      // files load and the games build, which is what makes it dangerous.
      codePick: false,
      handoff: [],
    };
    const useLibrary = mode.library;

    if (!useLibrary) {
      try {
        this.ensureModelRouter();
      } catch (error) {
        if (error instanceof MissingProviderConfigError) {
          return {
            llmContent: error.message,
            returnDisplay: `**Asset generation cannot start**\n\n${error.message}`,
            error: { message: error.message, type: 'API_ERROR' as never },
          };
        }
        throw error;
      }
    }

    const workspaceDir = this.config.getWorkspaceContext().getDirectories()[0];
    const targetDirName =
      this.params.output_dir_name || path.join('public', 'assets');
    const absoluteAssetsDir = path.join(workspaceDir, targetDirName);
    const assetPackPath = path.join(absoluteAssetsDir, 'asset-pack.json');

    // Ensure output directory exists
    await fs.mkdir(absoluteAssetsDir, { recursive: true });

    // Load or initialize asset pack
    const assetPack = await this.loadAssetPack(assetPackPath);

    const results: string[] = [];
    const errors: string[] = [];

    // PER-ROUND IMAGE BUDGET (off unless OPENGAME_ASSET_ROUND_CAP and
    // OPENGAME_ASSET_LEDGER are set). See asset-round-budget.ts for why.
    const budget = budgetFromEnv();
    const callStart = Date.now();
    let requests: AssetRequest[] = this.params.assets;
    let budgetBefore = 0;
    let budgetRefused: AssetRequest[] = [];
    if (budget) {
      const ledger = await readLedger(budget);
      budgetBefore = ledger.used;
      const remaining = Math.max(0, budget.cap - ledger.used);
      const a = admit(requests, (r) => this.imageCost(r), remaining);
      requests = a.granted;
      budgetRefused = a.refused;
      if (
        budgetRefused.length &&
        !requests.some((r) => this.imageCost(r) > 0)
      ) {
        ledger.events.push({
          t: new Date().toISOString(),
          requested: this.params.assets.map((r) => r.key),
          refused: budgetRefused.map((r) => r.key),
          made: 0,
        });
        await writeLedger(budget, ledger);
        if (!requests.length) {
          const msg =
            `${balanceLine(budget.cap, budgetBefore, 0)}\n` +
            `NOTHING WAS GENERATED: this round's image budget cannot cover ` +
            `${budgetRefused.map((r) => r.key).join(', ')}. Asking again this ` +
            `round will be refused the same way. Use the images already in ` +
            `the project (see asset-pack.json) and spend the rest of the ` +
            `round wiring them into the game.`;
          return { llmContent: msg, returnDisplay: msg };
        }
      }
    }

    // Two-lane processing to keep the rate-limited image gateway stable:
    //  - SLOW lane (image / animation): each sprite goes through a 40s+ generate +
    //    background-removal step, and many of them pile up 429s under concurrency.
    //    Run them SERIALLY with a small gap so a batch of character sprites doesn't
    //    drop assets (a dropped asset is what pushes the agent into improvising).
    //  - FAST lane (background / tileset / audio): quick + few → up to MAX_CONCURRENCY.
    // The lanes run sequentially (fast first, then slow) so they never contend on the
    // gateway at the same time.
    const SLOW_TYPES = new Set(['image', 'animation']);
    const slow = requests.filter((a) => SLOW_TYPES.has(a.type));
    const fast = requests.filter((a) => !SLOW_TYPES.has(a.type));

    // Art style guide + style anchor image: the game's declared look, and one
    // concrete visual reference generated from it, both established before any
    // asset so every lane can use them. Best-effort — failure here degrades to
    // prompt-only generation, never blocks the run.
    if (!useLibrary) {
      this.artStyle = await this.loadArtStyle(workspaceDir);
      await this.ensureStyleAnchorImage(absoluteAssetsDir, signal);
    }

    // The watchdog only exists while assets are being generated. In library
    // mode nothing can stall, and a timer left running would hold the process
    // open after the tool returns.
    const watchdog = mode.library
      ? undefined
      : setInterval(() => {
          if (mode.library) return;
          const quiet = Date.now() - mode.lastProgress;
          if (quiet < stallMs) return;
          mode.library = true;
          mode.fellBack = true;
          console.warn(
            `[GenerateAssets] no asset completed in ${Math.round(
              quiet / 1000,
            )}s; the remaining assets will come from the library. ` +
              `Assets already generating are left to finish.`,
          );
        }, 15_000);

    try {
      await this.runLane(
        fast,
        MAX_CONCURRENCY,
        0,
        mode,
        assetPack,
        absoluteAssetsDir,
        signal,
        results,
        errors,
      );
      await this.runLane(
        slow,
        1,
        SLOW_LANE_GAP_MS,
        mode,
        assetPack,
        absoluteAssetsDir,
        signal,
        results,
        errors,
      );
    } finally {
      if (watchdog) clearInterval(watchdog);
    }

    // The streak counts CONSECUTIVE stalled calls, so a call that generated
    // its way through clears it. Without the reset a single bad afternoon
    // would send every later game to the library for the life of the process.
    if (!forcedLibrary) {
      if (mode.fellBack) {
        GenerateAssetsInvocation.stallStreak += 1;
        console.warn(
          `[GenerateAssets] stalled call ` +
            `${GenerateAssetsInvocation.stallStreak}/${streakLimit}`,
        );
      } else if (!exhausted) {
        GenerateAssetsInvocation.stallStreak = 0;
      }
    }

    // Save asset pack
    await fs.writeFile(assetPackPath, JSON.stringify(assetPack, null, 2));

    // Counted BEFORE the contact sheet is written, and from files on disk
    // rather than requests, so a failed asset spends nothing.
    let budgetBlock = '';
    if (budget) {
      const made = (await imagesWrittenSince(absoluteAssetsDir, callStart))
        .length;
      const ledger = await readLedger(budget);
      ledger.used += made;
      ledger.events.push({
        t: new Date().toISOString(),
        requested: this.params.assets.map((r) => r.key),
        granted: requests.map((r) => r.key),
        refused: budgetRefused.map((r) => r.key),
        made,
      });
      await writeLedger(budget, ledger);
      budgetBlock =
        `${balanceLine(budget.cap, ledger.used - made, made)}\n` +
        (budgetRefused.length
          ? `NOT GENERATED -- over this round's image budget: ` +
            `${budgetRefused.map((r) => r.key).join(', ')}. Reuse images ` +
            `already in the project or leave these out; asking again this ` +
            `round will be refused.\n`
          : '');
    }

    // Contact sheet + report: the artefact a human (or the vision judge)
    // actually looks at to answer "does this set read as one art direction?".
    // Best-effort — a rendering problem must never fail an otherwise good run.
    let sheetLine = '';
    try {
      sheetLine = await this.writeAssetReview(absoluteAssetsDir);
    } catch (e) {
      console.warn(
        `[GenerateAssets] contact sheet skipped: ${e instanceof Error ? e.message : e}`,
      );
    }

    // MODERATION REFUSALS ARE NOT RETRIED LIKE OTHER FAILURES. Split out of
    // `errors` so the "retry them, a retry usually succeeds" instruction below
    // is not given for them; see moderation-refusals.ts.
    const refusedKeys = moderationKeys(errors);
    let moderationText = '';
    if (refusedKeys.length) {
      const counts = await recordRefusals(
        path.join(workspaceDir, '.qwen', 'moderation_refusals.json'),
        refusedKeys,
      );
      moderationText = moderationBlock(
        counts,
        refusedKeys,
        this.libraryRootPath(),
      );
    }
    const retryable = errors.filter((e) => {
      const i = e.indexOf(':');
      return !(i > 0 && refusedKeys.includes(e.slice(0, i).trim()));
    });

    // Generate result message
    const sections = Object.keys(assetPack).filter((k) => k !== 'meta');
    // CRITICAL: failed assets MUST appear in llmContent (what the model reads), not
    // only in returnDisplay — otherwise the agent can't tell an asset is missing and
    // improvises crude placeholders (hand-drawn SVG / a PIL script) instead of retrying.
    const failureBlock =
      retryable.length > 0
        ? `
⚠️ ${retryable.length} ASSET(S) FAILED — you MUST handle these, do NOT ignore them:
${retryable.map((e) => `  - ${e}`).join('\n')}

REQUIRED next step for the failed assets (in this order):
  1. RETRY them in a SECOND generate_game_assets call with ONLY the failed keys.
     Character/prop sprites are slow + occasionally rate-limited; a retry usually
     succeeds. Do NOT re-request the ones that already succeeded.
  2. If a key still fails after a retry, draw it in code with Shapes.* from
     src/shapes.ts (Shapes.orb/chip/poly/star/...), themed from uiPalette.
  DO NOT hand-author inline <svg>, and DO NOT write a script (PIL/canvas/etc.) to
  generate placeholder art — that ships crude visuals. Retry, then Shapes.*.
`
        : '';
    // The handoff has to be in llmContent, for the same reason failures are:
    // the agent acts on what it reads, and an asset nobody told it about is
    // an asset it never supplies.
    const handoffBlock = mode.handoff.length
      ? `
🎨 IMAGE GENERATION STALLED — ${mode.handoff.length} ASSET(S) ARE NOW YOURS TO CHOOSE.

The image service stopped answering, so these were NOT generated. Instead of
guessing a file for you, the asset library is yours to browse:

  ${this.libraryRootPath()}
    2D/       137 art packs, one directory per pack, named for what is in it
    Audio/    sound and music packs (.ogg)
    Textures/

Browse it, choose packs that fit this game's art direction, and copy what you
need. Prefer taking a whole pack's look over mixing one sprite from each -- a
consistent set reads as art direction, a mixed one reads as an accident.

asset-pack.json ALREADY references the paths below, so each file you copy is
picked up with no further edit -- and each one you skip is a load error at
runtime. Copy a real file to every path:

${mode.handoff
  .map(
    (r) =>
      `  ${r.key} (${r.type}) — ${String(r.description || '').slice(0, 160)}\n` +
      this.handoffTargets(r)
        .map((t) => `      ${targetDirName}/${path.basename(t.url)}`)
        .join('\n'),
  )
  .join('\n')}

For an animation, copy a DIFFERENT frame to each numbered path where the pack
offers one; copying one file to all of them produces an animation that does
not move.

Use run_shell_command to copy. Do not re-request these keys from
generate_game_assets, and do not draw them in code -- the library has them.
`
      : '';
    const instruction = `${budgetBlock}${handoffBlock}
Assets generated in '${targetDirName}/asset-pack.json'.
Items: ${results.join(', ')}
Sections: ${sections.join(', ')}
${sheetLine}${failureBlock}${moderationText}
CODING INSTRUCTION (Phaser 3):
1. Preloader - load ALL sections:
   this.load.pack('assetPack', 'assets/asset-pack.json');

2. Or load SPECIFIC sections:
   this.load.pack('backgrounds', 'assets/asset-pack.json', 'backgrounds');
   this.load.pack('player_animations', 'assets/asset-pack.json', 'player_animations');

3. Use keys directly: this.add.image(0, 0, 'key_name');

4. For audio:
   this.load.audio('bgm', 'assets/bgm.wav');
   this.sound.play('bgm', { loop: true });
`;

    return {
      llmContent: instruction,
      returnDisplay:
        `✅ Generated ${results.length} assets.\nErrors: ${errors.length}` +
        (errors.length > 0 ? '\n' + errors.join('\n') : '') +
        (mode.handoff.length
          ? `\n🎨 ${mode.handoff.length} handed to the library (generation stalled): ` +
            mode.handoff.map((r) => r.key).join(', ')
          : ''),
    };
  }

  /** Image files one request is planned to produce; audio produces none. */
  private imageCost(req: AssetRequest): number {
    if (req.type === 'audio') return 0;
    return this.handoffTargets(req).length;
  }

  // ============== Lane runner ==============

  /**
   * Run one lane of assets with a concurrency cap and an optional inter-request gap.
   * gapMs > 0 (serial slow lane) spaces requests to ease the gateway rate limit.
   */
  private async runLane(
    assets: AssetRequest[],
    concurrency: number,
    gapMs: number,
    mode: AssetSourceMode,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
    results: string[],
    errors: string[],
  ): Promise<void> {
    const active = new Set<Promise<void>>();
    let first = true;
    for (const assetReq of assets) {
      if (signal.aborted) break;
      while (active.size >= concurrency) {
        await Promise.race(active);
      }
      if (gapMs > 0 && !first) await this.sleep(gapMs);
      first = false;
      const task = this.processAsset(
        assetReq,
        mode,
        assetPack,
        assetsDir,
        signal,
        results,
        errors,
      );
      active.add(task);
      task.finally(() => active.delete(task));
    }
    await Promise.all(active);
  }

  /** Process one asset; records success into `results` and swallows failure into
   *  `errors` so one bad asset never fails the whole batch. */
  private async processAsset(
    assetReq: AssetRequest,
    mode: AssetSourceMode,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
    results: string[],
    errors: string[],
  ): Promise<void> {
    // Read at the moment this asset STARTS, not when the lane was queued. That
    // is what makes the fallback apply to the rest of the call: an asset
    // already generating is left alone, and the next one off the queue takes
    // the library path.
    const useLibrary = mode.library;
    try {
      if (useLibrary && !mode.codePick) {
        // Hand it to the agent instead of guessing. The pack entries ARE
        // written, with the same keys and filenames the generate path would
        // have used, so the agent's only job is to put a file at each named
        // path -- and so a key it skips is a visible load error rather than a
        // quietly wrong picture.
        this.registerHandoff(assetReq, assetPack);
        mode.handoff.push(assetReq);
        return;
      }
      if (useLibrary) {
        await this.handleFromLibrary(assetReq, assetPack, assetsDir);
        results.push(`${assetReq.key} (${assetReq.type})`);
        return;
      }
      switch (assetReq.type) {
        case 'background':
          await this.handleBackground(assetReq, assetPack, assetsDir, signal);
          break;
        case 'image':
          await this.handleImage(assetReq, assetPack, assetsDir, signal);
          break;
        case 'animation':
          await this.handleAnimation(assetReq, assetPack, assetsDir, signal);
          break;
        case 'audio':
          await this.handleAudio(assetReq, assetPack, assetsDir, signal);
          break;
        case 'tileset':
          await this.handleTileset(assetReq, assetPack, assetsDir, signal);
          break;
        default:
          console.warn(
            `[GenerateAssets] Unknown asset type: ${(assetReq as { type: string }).type}`,
          );
          throw new Error(
            `Unsupported asset type: ${(assetReq as { type: string }).type}. Supported types: background, image, animation, audio, tileset`,
          );
      }
      results.push(`${assetReq.key} (${assetReq.type})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[GenerateAssets] Failed ${assetReq.key}:`, msg);
      errors.push(`${assetReq.key}: ${msg}`);
    } finally {
      // PROGRESS, for the stall watchdog. A failure counts: the gateway
      // answered, which is what the watchdog is asking about. What it is
      // watching for is silence -- nothing coming back either way.
      mode.lastProgress = Date.now();
    }
  }

  // ============== Asset Handlers ==============

  /** Transient-vs-permanent classification shared by every image retry loop. */
  private isTransientImageError(message: string): boolean {
    const msg = message.toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('rate') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('task failed') ||
      msg.includes('server') ||
      msg.includes('empty 200 body') ||
      msg.includes('unparsable body') ||
      /\b5\d\d\b/.test(msg)
    );
  }

  /**
   * Load the game's art style guide. Searches upward from the workspace the
   * same way the GDD tooling does, since the tool may run from a subdirectory.
   */
  private async loadArtStyle(workspaceDir: string): Promise<ArtStyle | null> {
    let dir = workspaceDir;
    for (let up = 0; up < 4; up++) {
      try {
        const text = await fs.readFile(
          path.join(dir, 'docs', 'art_style.md'),
          'utf-8',
        );
        const parsed = parseArtStyle(text);
        if (parsed) {
          console.log(
            `[GenerateAssets] Art style guide loaded: ${parsed.palette.length} palette colours`,
          );
          return parsed;
        }
        console.warn(
          '[GenerateAssets] docs/art_style.md found but declares no palette — ignoring',
        );
        return null;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    console.log(
      '[GenerateAssets] No docs/art_style.md — generating prompt-only',
    );
    return null;
  }

  /**
   * Generate the per-game style-anchor image. Disable with
   * OPENGAME_STYLE_ANCHOR_IMAGE=0. Saved to assets/ for auditability but
   * NOT registered in the asset pack (it is a working reference, not a
   * game asset). The remote URL — not the local file — is kept for i2i
   * conditioning, since the image API fetches the reference itself.
   */
  private async ensureStyleAnchorImage(
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if ((process.env.OPENGAME_STYLE_ANCHOR_IMAGE || '1').trim() === '0') return;
    if (this.styleAnchorUrl) return;
    // Drawn from the art style guide when the game wrote one, so the reference
    // every other asset inherits is the DECLARED look rather than one model's
    // reading of a single adjective string.
    const anchorPrompt = `
      Style reference sheet for a 2D game, ${this.params.style_anchor}.
      A small sample scene fragment establishing the palette, lighting, line
      quality, material rendering and overall mood of the game's art.
      ${artStylePromptBlock(this.artStyle)}
      ${this.params.composition_env || ''}
      IMPORTANT: No text, no UI, no watermark, no characters.
    `;
    try {
      const url = await this.generateImageWithRetry(
        anchorPrompt,
        '1024*1024',
        signal,
        'style anchor',
      );
      this.styleAnchorUrl = url;
      try {
        const buffer = await this.downloadImage(url);
        await this.saveAsset(buffer, 'style_anchor', assetsDir);
      } catch {
        // audit copy is best-effort; the remote URL is what matters
      }
      console.log('[GenerateAssets] Style anchor image ready');
    } catch (e) {
      console.warn(
        `[GenerateAssets] Style anchor generation failed (continuing prompt-only): ${e instanceof Error ? e.message : e}`,
      );
      this.styleAnchorUrl = null;
    }
  }

  /**
   * Generate an image with retry + exponential backoff. Character/prop sprites run
   * through a slow, rate-limited gateway (40s+ each) and 429 under concurrency is
   * common; a single blip otherwise drops the asset (empty pack → the agent improvises
   * crude PIL/SVG placeholders instead of retrying). Only transient errors retry.
   */
  private async generateImageWithRetry(
    prompt: string,
    size: string,
    signal: AbortSignal,
    label: string,
    referenceImageUrl?: string | null,
  ): Promise<string> {
    const MAX = 4;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < MAX; attempt++) {
      if (signal.aborted) throw new Error('Aborted');
      try {
        return await this.modelRouter.generateImage(
          prompt,
          size,
          referenceImageUrl,
        );
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const retriable = this.isTransientImageError(lastErr.message);
        if (!retriable || attempt === MAX - 1) throw lastErr;
        const delay = 4000 * Math.pow(2, attempt); // 4s, 8s, 16s
        console.warn(
          `[GenerateAssets] ${label} attempt ${attempt + 1}/${MAX} failed (${lastErr.message.slice(0, 80)}) — retry in ${delay / 1000}s`,
        );
        await this.sleep(delay);
      }
    }
    throw lastErr ?? new Error('generateImage failed');
  }

  private async handleBackground(
    req: BackgroundRequest,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('Aborted');

    console.log(`[GenerateAssets] Generating background: ${req.key}`);

    const basePrompt = (fix: string) => `
      Game background art, ${req.description}, ${this.params.style_anchor}.
      Full scene illustration, edge-to-edge, high detail, seamless composition.
      ${artStylePromptBlock(this.artStyle)}${fix}
      IMPORTANT: This is a BACKGROUND - must be fully opaque with rich colors.
      Fill entire canvas with scenery.

      ---FORBIDDEN (CRITICAL)---
      NO characters, NO people, NO figures, NO creatures, NO animals, NO NPCs.
      NO text, NO UI elements, NO transparency.
      PURE SCENERY ONLY - landscape, buildings, environment, sky, etc.
    `;

    const imageUrl = await this.generateImageWithRetry(
      basePrompt(''),
      req.resolution || '1024*1024',
      signal,
      `background ${req.key}`,
      this.styleAnchorUrl,
    );
    const buffer = await this.downloadImage(imageUrl);
    const cdnUrl = await this.saveWithPaletteCheck(
      buffer,
      req.key,
      'background',
      assetsDir,
      async (offenders) => {
        const retryUrl = await this.generateImageWithRetry(
          basePrompt(this.paletteFixHint(offenders)),
          req.resolution || '1024*1024',
          signal,
          `background ${req.key} (palette retry)`,
          this.styleAnchorUrl,
        );
        return this.downloadImage(retryUrl);
      },
      req.target_px,
    );

    this.updateAssetPack(assetPack, req.key, 'background', cdnUrl);
  }

  /**
   * Write `_asset_report.json` and `_contact_sheet.png` — every image this run
   * produced, laid out in one labelled grid. Phaser's game workbench shows the
   * same thing ("every sprite, background and logo the agent generated, in a
   * grid") and it is the fastest way for a person to see whether a game's art
   * hangs together. Returns a line for the tool result, or '' if nothing to show.
   */
  private async writeAssetReview(assetsDir: string): Promise<string> {
    if (this.assetReport.length === 0) return '';
    const sharp = (await import('sharp')).default;

    const scored = this.assetReport.filter((a) => a.conformance !== null);
    const avg =
      scored.length > 0
        ? scored.reduce((s, a) => s + (a.conformance as number), 0) /
          scored.length
        : null;

    await fs.writeFile(
      path.join(assetsDir, '_asset_report.json'),
      JSON.stringify(
        {
          generated: this.assetReport.length,
          palette: this.artStyle?.palette ?? null,
          mean_conformance: avg === null ? null : Number(avg.toFixed(3)),
          assets: this.assetReport,
        },
        null,
        2,
      ),
    );

    const CELL = 192;
    const PAD = 8;
    const LABEL = 16;
    const cols = Math.min(5, this.assetReport.length);
    const rows = Math.ceil(this.assetReport.length / cols);
    const cellH = CELL + LABEL;
    const width = cols * (CELL + PAD) + PAD;
    const height = rows * (cellH + PAD) + PAD;

    const composites: Array<{ input: Buffer; top: number; left: number }> = [];
    for (let i = 0; i < this.assetReport.length; i++) {
      const a = this.assetReport[i];
      const filePath = path.join(assetsDir, path.basename(a.file));
      const left = PAD + (i % cols) * (CELL + PAD);
      const top = PAD + Math.floor(i / cols) * (cellH + PAD);
      try {
        const thumb = await sharp(filePath)
          .resize(CELL, CELL, {
            fit: 'contain',
            background: { r: 24, g: 22, b: 30, alpha: 1 },
          })
          .png()
          .toBuffer();
        composites.push({ input: thumb, top, left });
      } catch {
        continue; // a non-image (audio) or unreadable file — just leave the cell empty
      }
      const conf =
        a.conformance === null ? '' : `  ${(a.conformance * 100).toFixed(0)}%`;
      const label = `${a.key}${conf}`.slice(0, 30).replace(/[<&>]/g, '');
      composites.push({
        input: Buffer.from(
          `<svg width="${CELL}" height="${LABEL}"><text x="0" y="12" ` +
            `font-family="monospace" font-size="11" fill="#b9b0c8">${label}</text></svg>`,
        ),
        top: top + CELL,
        left,
      });
    }
    if (composites.length === 0) return '';

    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 14, g: 11, b: 20 },
      },
    })
      .composite(composites)
      .png()
      .toFile(path.join(assetsDir, '_contact_sheet.png'));

    const avgTxt =
      avg === null
        ? ''
        : ` Mean palette conformance ${(avg * 100).toFixed(0)}%${avg < PALETTE_CONFORMANCE_FLOOR ? ' — the art drifted from docs/art_style.md; consider revising the palette or the descriptions.' : '.'}`;
    return `\nAsset review: _contact_sheet.png + _asset_report.json written.${avgTxt}\n`;
  }

  /** Names the colours that drifted, so the retry has something concrete to avoid. */
  /**
   * The correction that pulls a drifted asset back, WITHOUT flattening it.
   *
   * This used to end "Redraw using ONLY the declared palette above." Taken
   * literally -- and an image model does take it literally -- that is an
   * instruction to make every part of the picture the same handful of colours,
   * which is exactly how a sprite stops being separable from the ground it
   * stands on. Nothing anywhere else in this pipeline asks for legibility:
   * searching the prompts for contrast, legible or readable turns up a shape
   * field and one code comment, while four separate places push for
   * unification. The graded rubric asks for both -- "a single consistent
   * visual language, no clashing bright colours" AND "all elements are
   * readable and non-overlapping at 1280x720" -- so a correction that only
   * knows the first one is trading a scored property for another scored
   * property.
   */
  private paletteFixHint(offenders: string[]): string {
    if (offenders.length === 0) return '';
    return (
      ` CRITICAL COLOUR CORRECTION: the previous attempt drifted to ${offenders.join(', ')}, ` +
      `which are NOT in this game's palette. Redraw within the declared palette above. ` +
      `Keep the subject clearly separable from its background: use the palette's own ` +
      `light and dark ends for that separation rather than adding new hues. ` +
      `A picture in which everything is the same two or three tones has not been corrected.`
    );
  }

  private async handleImage(
    req: ImageRequest,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('Aborted');

    console.log(`[GenerateAssets] Generating image: ${req.key}`);

    const basePrompt = (fix: string) => `
      Game asset sprite, ${req.description}, ${this.params.style_anchor}.
      Single object only, isolated on white background, centered composition, consistent size.
      ${artStylePromptBlock(this.artStyle)}${fix}
      ${this.params.composition_env || ''}
      IMPORTANT: Pure white background, no text, no position offset, ONE object only.
    `;

    const imageUrl = await this.generateImageWithRetry(
      basePrompt(''),
      req.size || '1024*1024',
      signal,
      `image ${req.key}`,
      this.styleAnchorUrl,
    );

    // Remove background
    const buffer = await this.bgRemovalService.removeBackgroundSafe(imageUrl);
    const cdnUrl = await this.saveWithPaletteCheck(
      buffer,
      req.key,
      'image',
      assetsDir,
      async (offenders) => {
        const retryUrl = await this.generateImageWithRetry(
          basePrompt(this.paletteFixHint(offenders)),
          req.size || '1024*1024',
          signal,
          `image ${req.key} (palette retry)`,
          this.styleAnchorUrl,
        );
        return this.bgRemovalService.removeBackgroundSafe(retryUrl);
      },
      req.target_px,
    );

    this.updateAssetPack(assetPack, req.key, 'image', cdnUrl);
  }

  private async handleAnimation(
    req: AnimationRequest,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('Aborted');

    console.log(`[GenerateAssets] Generating animation: ${req.key}`);

    if (this.animationMode() === 'sheet') {
      await this.handleAnimationSheet(req, assetPack, assetsDir, signal);
      return;
    }

    // Step 1: Generate base image
    const basePrompt = `
      Game character sprite, ${req.description}, ${this.params.style_anchor}.
      SIDE VIEW (profile view, facing right), chibi style with big head.
      Single character only, neutral idle pose, centered composition.
      ${artStylePromptBlock(this.artStyle)}
      ${this.params.composition_env || ''}
      IMPORTANT: Pure white background, SIDE VIEW only, ONE character only.
    `;

    // Through the retry wrapper (a direct router call here used to bypass
    // it — one transient 429 killed the whole character), conditioned on
    // the style anchor so every character shares the game's visual language.
    const baseImageUrl = await this.generateImageWithRetry(
      basePrompt,
      '1024*1024',
      signal,
      `animation base ${req.key}`,
      this.styleAnchorUrl,
    );

    // Save base/idle frame. Palette-checked because every other frame is
    // generated FROM this one — drift here propagates through the animation.
    const baseKey = `${req.key}_idle_01`;
    const baseBuffer =
      await this.bgRemovalService.removeBackgroundSafe(baseImageUrl);
    const baseCdnUrl = await this.saveWithPaletteCheck(
      baseBuffer,
      baseKey,
      'animation',
      assetsDir,
      async (offenders) => {
        const retryUrl = await this.generateImageWithRetry(
          `${basePrompt}${this.paletteFixHint(offenders)}`,
          '1024*1024',
          signal,
          `animation base ${req.key} (palette retry)`,
          this.styleAnchorUrl,
        );
        return this.bgRemovalService.removeBackgroundSafe(retryUrl);
      },
      req.target_px,
    );
    this.updateAssetPack(assetPack, baseKey, 'animation', baseCdnUrl);

    // Step 2: Generate animation frames
    // Default to I2V (video) because I2I (wanx2.1-imageedit) may output to non-Beijing OSS
    // which is not accessible from some network environments (e.g., RunPod)
    const useI2V = req.useI2V !== false; // Default: true (use I2V unless explicitly disabled)

    if (useI2V) {
      // Use I2V (Image-to-Video) approach - outputs to Beijing OSS, always accessible
      await this.generateAnimationViaI2V(
        req,
        baseImageUrl,
        assetPack,
        assetsDir,
        signal,
      );
    } else {
      // Use I2I (Image-to-Image) approach - may have OSS accessibility issues
      console.warn(
        `[GenerateAssets] Using I2I mode - may have OSS network issues`,
      );
      await this.generateAnimationViaI2I(
        req,
        baseImageUrl,
        assetPack,
        assetsDir,
        signal,
      );
    }
  }

  /**
   * `sheet` unless OPENGAME_ANIM_MODE says otherwise, on the provider whose
   * image edit ignores its reference (see sprite-sheet.ts); the edit chain
   * everywhere else, where that call really is image-conditioned.
   */
  private animationMode(): 'sheet' | 'chain' {
    const forced = (process.env['OPENGAME_ANIM_MODE'] || '')
      .trim()
      .toLowerCase();
    if (forced === 'sheet' || forced === 'chain') return forced;
    return this.modelRouter?.imageConfig.provider === 'openai-compat'
      ? 'sheet'
      : 'chain';
  }

  /** One image per animation holding all its poses, cut into frames. */
  private async handleAnimationSheet(
    req: AnimationRequest,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    const anims =
      req.animations && req.animations.length
        ? req.animations
        : [{ name: 'idle', frameCount: 1, action_desc: 'neutral idle pose' }];
    const styleAnchor = this.params.style_anchor || '';
    const styleBlock = artStylePromptBlock(this.artStyle);
    let base: Buffer | null = null;
    for (const a of anims) {
      if (signal.aborted) throw new Error('Aborted');
      const n = Math.max(1, a.frameCount || 1);
      let frames: Buffer[];
      if (n === 1) {
        const prompt =
          `Game character sprite, ONE character, ${req.description}. ${styleAnchor ? `Style: ${styleAnchor}.` : ''} ${styleBlock} ` +
          `Pose: ${a.action_desc}. Full body, centred. Any hat, helmet, weapon or prop keeps its usual shape. ` +
          `Plain white background, no text.`;
        const url = await this.generateImageWithRetry(
          prompt,
          '1024*1024',
          signal,
          `animation ${req.key} ${a.name}`,
          null,
        );
        frames = [await this.downloadImage(url)];
      } else {
        const url = await this.generateImageWithRetry(
          sheetPrompt(req.description, styleAnchor, styleBlock, {
            ...a,
            frameCount: n,
          }),
          sheetSize(n),
          signal,
          `animation sheet ${req.key} ${a.name}`,
          null,
        );
        const sliced = await sliceSheet(await this.downloadImage(url), n);
        console.log(
          `[GenerateAssets] sheet ${req.key}/${a.name}: ${n} frames, cuts ${JSON.stringify(sliced.cuts)}` +
            (sliced.fallbacks
              ? `, ${sliced.fallbacks} cut(s) without a gap`
              : '') +
            (sliced.empty ? `, ${sliced.empty} empty panel(s)` : ''),
        );
        frames = sliced.frames;
      }
      for (let i = 0; i < frames.length; i++) {
        const key = `${req.key}_${a.name}_${String(i + 1).padStart(2, '0')}`;
        const cut = await this.bgRemovalService.removeBackgroundFromBuffer(
          frames[i],
        );
        const cdn = await this.saveWithPaletteCheck(
          cut,
          key,
          'animation',
          assetsDir,
          null,
          req.target_px,
        );
        this.updateAssetPack(assetPack, key, 'animation', cdn);
        if (!base && (a.name === 'idle' || anims.indexOf(a) === 0)) base = cut;
      }
    }
    // The templates fall back to `${key}_idle_01`; supply it when no idle was asked for.
    if (!anims.some((a) => a.name === 'idle') && base) {
      const key = `${req.key}_idle_01`;
      const cdn = await this.saveWithPaletteCheck(
        base,
        key,
        'animation',
        assetsDir,
        null,
        req.target_px,
      );
      this.updateAssetPack(assetPack, key, 'animation', cdn);
    }
  }

  private async generateAnimationViaI2V(
    req: AnimationRequest,
    baseImageUrl: string,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Check if ffmpeg is available for local frame extraction
    const ffmpegAvailable =
      await this.frameExtractionService.isFFmpegAvailable();

    if (!ffmpegAvailable) {
      console.warn(
        `[GenerateAssets] FFmpeg not available, falling back to I2I mode`,
      );
      await this.generateAnimationViaI2I(
        req,
        baseImageUrl,
        assetPack,
        assetsDir,
        signal,
      );
      return;
    }

    console.log(`[GenerateAssets] FFmpeg available: ${ffmpegAvailable}`);

    for (const animation of req.animations) {
      if (signal.aborted) break;
      if (animation.name === 'idle' && animation.frameCount <= 1) continue;

      console.log(
        `[GenerateAssets] Generating I2V animation: ${animation.name}`,
      );

      try {
        // Step 1: Generate video from base image using I2V
        const videoPrompt = `
          ${req.description}, ${animation.action_desc}.
          SIDE VIEW animation, single character only, smooth loop.
          IMPORTANT: Keep SIDE VIEW, character size MUST remain identical, stay at same position!
          ${this.params.style_anchor}
        `;

        console.log(`[GenerateAssets] Step 1: Generating video via I2V...`);
        const { videoUrl } = await this.modelRouter.generateVideo(
          baseImageUrl,
          videoPrompt,
          '480P',
        );
        console.log(
          `[GenerateAssets] Video generated: ${videoUrl.substring(0, 50)}...`,
        );

        // Step 2: Extract frames from video locally using ffmpeg
        // Use FIRST_LAST_FRAME_ONLY env var to enable first+last frame mode (for testing)
        const firstLastOnly = process.env.FIRST_LAST_FRAME_ONLY === 'true';
        console.log(
          `[GenerateAssets] Step 2: Extracting frames locally via ffmpeg (firstLastOnly=${firstLastOnly})...`,
        );
        const result = await this.frameExtractionService.extractFramesLocal(
          videoUrl,
          animation.frameCount,
          0, // fromTime
          4, // toTime (video is usually ~5s)
          assetsDir, // Output to assets dir
          firstLastOnly, // Only extract first and last frames when enabled
        );
        const framePaths = result.framePaths;
        const videoPath = result.videoPath;

        if (framePaths.length === 0) {
          throw new Error('Frame extraction failed - no frames extracted');
        }

        console.log(
          `[GenerateAssets] Extracted ${framePaths.length} frames locally (firstLastOnly=${firstLastOnly})`,
        );

        // Step 2.5: Save video file with proper name
        if (videoPath) {
          const videoKey = `${req.key}_${animation.name}_video`;
          const finalVideoPath = path.join(assetsDir, `${videoKey}.mp4`);

          // Move video to final location with proper name
          try {
            // If video is already in assetsDir, just rename it
            if (path.dirname(videoPath) === assetsDir) {
              await fs.rename(videoPath, finalVideoPath);
            } else {
              // Otherwise copy it
              await fs.copyFile(videoPath, finalVideoPath);
            }

            const videoCdnUrl = `assets/${videoKey}.mp4`;
            this.updateAssetPack(assetPack, videoKey, 'video', videoCdnUrl);
            console.log(`[GenerateAssets] Video saved: ${videoKey}.mp4`);
          } catch (error) {
            console.warn(`[GenerateAssets] Failed to save video: ${error}`);
          }
        }

        // Step 3: Process frames - remove background and save
        console.log(
          `[GenerateAssets] Step 3: Processing ${framePaths.length} frames...`,
        );
        for (let i = 0; i < framePaths.length; i++) {
          if (signal.aborted) break;

          const frameKey = `${req.key}_${animation.name}_${String(i + 1).padStart(2, '0')}`;

          // Read frame, remove background, and save
          const frameBuffer = await fs.readFile(framePaths[i]);
          const processedBuffer =
            await this.bgRemovalService.removeBackgroundFromBuffer(frameBuffer);
          const frameCdnUrl = await this.saveAsset(
            processedBuffer,
            frameKey,
            assetsDir,
            'png',
            req.target_px,
          );
          this.updateAssetPack(assetPack, frameKey, 'animation', frameCdnUrl);

          // Clean up temp frame file
          try {
            await fs.unlink(framePaths[i]);
          } catch {
            // best-effort temp cleanup
          }

          console.log(
            `[GenerateAssets] Saved frame ${i + 1}/${framePaths.length}: ${frameKey}`,
          );
        }

        // Step 4: Extract audio from animation video (optional)
        try {
          console.log(
            `[GenerateAssets] Step 4: Extracting audio from animation video (first 2s)...`,
          );
          const audioPath = await this.frameExtractionService.extractAudio(
            videoUrl,
            undefined,
            0,
            2,
          );
          const audioBuffer = await fs.readFile(audioPath);
          await fs.unlink(audioPath);
          try {
            await fs.rmdir(path.dirname(audioPath));
          } catch {
            // best-effort temp cleanup
          }

          const audioKey = `${req.key}_${animation.name}_sfx`;
          const audioCdnUrl = await this.saveAsset(
            audioBuffer,
            audioKey,
            assetsDir,
            'wav',
          );
          this.updateAssetPack(assetPack, audioKey, 'audio', audioCdnUrl);
          console.log(
            `[GenerateAssets] Extracted animation audio: ${audioKey}.wav`,
          );
        } catch (error) {
          console.log(
            `[GenerateAssets] No audio extracted from animation (might be silent video): ${error}`,
          );
        }

        console.log(
          `[GenerateAssets] I2V animation ${animation.name} completed!`,
        );
      } catch (error) {
        console.warn(
          `[GenerateAssets] I2V failed for ${animation.name}: ${error}`,
        );
        console.log(
          `[GenerateAssets] Falling back to I2I for ${animation.name}...`,
        );
        await this.generateSingleAnimationI2I(
          req,
          animation,
          baseImageUrl,
          assetPack,
          assetsDir,
          signal,
        );
      }
    }
  }

  private async generateAnimationViaI2I(
    req: AnimationRequest,
    baseImageUrl: string,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (const animation of req.animations) {
      if (signal.aborted) break;
      await this.generateSingleAnimationI2I(
        req,
        animation,
        baseImageUrl,
        assetPack,
        assetsDir,
        signal,
      );
    }
  }

  private async generateSingleAnimationI2I(
    req: AnimationRequest,
    animation: { name: string; frameCount: number; action_desc: string },
    baseImageUrl: string,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    let previousFrameUrl: string | null = null;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000; // 5 seconds
    const FRAME_DELAY = 2000; // 2 seconds between frames to avoid rate limiting

    for (let i = 1; i <= animation.frameCount; i++) {
      if (signal.aborted) break;
      if (animation.name === 'idle' && i === 1) continue;

      const frameKey = `${req.key}_${animation.name}_${String(i).padStart(2, '0')}`;

      const framePrompt = [
        `Same exact character as reference, ${animation.action_desc}.`,
        `SIDE VIEW animation, single character only, frame ${i} of ${animation.frameCount}.`,
        `IMPORTANT: Keep SIDE VIEW, same direction as reference.`,
        `IMPORTANT: Character size MUST be identical, stay at same position!`,
        `${this.params.style_anchor}, white background.`,
        artStylePromptBlock(this.artStyle),
      ]
        .filter(Boolean)
        .join(' ');

      // Retry logic for I2I API failures
      let frameUrl: string | null = null;
      let lastError: Error | null = null;

      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
          if (retry > 0) {
            console.log(
              `[GenerateAssets] Retry ${retry}/${MAX_RETRIES} for frame ${frameKey}...`,
            );
            await this.sleep(RETRY_DELAY * retry); // Exponential backoff
          }

          frameUrl = await this.modelRouter.editImage(
            baseImageUrl,
            framePrompt,
            previousFrameUrl,
          );
          break; // Success, exit retry loop
        } catch (error) {
          lastError = error as Error;
          console.warn(
            `[GenerateAssets] I2I failed (attempt ${retry + 1}/${MAX_RETRIES}): ${lastError.message}`,
          );

          // Retry transient failures; throw on permanent ones. The old
          // condition only matched two literal substrings, so gateway
          // empty-body responses (surfacing as JSON parse errors) aborted
          // the whole animation instead of retrying one frame.
          if (!this.isTransientImageError(lastError.message)) {
            throw error;
          }
        }
      }

      if (!frameUrl) {
        console.warn(
          `[GenerateAssets] Skipping frame ${frameKey} after ${MAX_RETRIES} retries`,
        );
        continue; // Skip this frame instead of failing entire animation
      }

      const frameBuffer =
        await this.bgRemovalService.removeBackgroundSafe(frameUrl);
      const frameCdnUrl = await this.saveWithPaletteCheck(
        frameBuffer,
        frameKey,
        'animation',
        assetsDir,
        null, // score only — see saveWithPaletteCheck's `regenerate` doc
        req.target_px,
      );
      this.updateAssetPack(assetPack, frameKey, 'animation', frameCdnUrl);

      previousFrameUrl = frameUrl;

      // Add delay between frames to avoid rate limiting
      if (i < animation.frameCount) {
        await this.sleep(FRAME_DELAY);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async handleAudio(
    req: AudioRequest,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('Aborted');

    console.log(
      `[GenerateAssets] Generating audio: ${req.key} (${req.audioType})`,
    );
    console.log(
      `[GenerateAssets] Audio request details: duration=${req.duration}, genre=${req.genre}, tempo=${req.tempo}`,
    );
    console.log(`[GenerateAssets] Output directory: ${assetsDir}`);

    const duration =
      req.audioType === 'sfx' ? req.duration || 1 : req.duration || 5;
    const audioType = req.audioType === 'bgm' ? 'bgm' : 'sfx';
    let buffer: Buffer | null = null;

    // Strategy 1: T2V → Extract audio (best quality, uses video model)
    const ffmpegAvailable =
      await this.frameExtractionService.isFFmpegAvailable();
    if (ffmpegAvailable) {
      try {
        console.log(
          `[GenerateAssets] Step 1: Generating video for audio extraction (T2V)...`,
        );
        const videoPrompt = `
          ${req.description}.
          Music visualization, abstract, ${req.genre || 'ambient'}, ${req.tempo || 'medium'} tempo.
          High quality audio, clear sound.
        `;
        const { videoUrl } = await this.modelRouter.generateVideoFromText(
          videoPrompt,
          '720P',
        );
        console.log(
          `[GenerateAssets] Video generated: ${videoUrl.substring(0, 50)}...`,
        );

        console.log(`[GenerateAssets] Step 2: Extracting audio from video...`);
        const audioPath = await this.frameExtractionService.extractAudio(
          videoUrl,
          undefined,
          0,
          7,
        );
        buffer = await fs.readFile(audioPath);
        await fs.unlink(audioPath);
        try {
          await fs.rmdir(path.dirname(audioPath));
        } catch {
          // best-effort temp cleanup
        }
        console.log(`[GenerateAssets] Audio extraction successful!`);
      } catch (error) {
        console.warn(
          `[GenerateAssets] Video-based audio generation failed: ${error}`,
        );
      }
    }

    // Strategy 2: ABC notation → WAV via symusic
    if (!buffer) {
      console.log(`[GenerateAssets] Trying ABC notation via LLM...`);
      let abcNotation: string | null = null;
      try {
        abcNotation = await this.modelRouter.generateABC(req);
        console.log(
          `[GenerateAssets] ABC notation generated (${abcNotation.length} chars)`,
        );
      } catch (error) {
        console.warn(`[GenerateAssets] ABC generation failed: ${error}`);
      }

      if (abcNotation) {
        try {
          buffer = await this.modelRouter.generateAudioFromABC(
            abcNotation,
            audioType,
            duration,
          );
          console.log(`[GenerateAssets] ABC → WAV conversion successful!`);
        } catch (error) {
          console.warn(`[GenerateAssets] ABC → WAV failed: ${error}`);
        }
      }
    }

    // Strategy 3: Procedural fallback
    if (!buffer) {
      console.log(
        `[GenerateAssets] Using procedural audio generation (duration=${duration}s, type=${audioType})...`,
      );
      try {
        buffer = await this.modelRouter.generatePlaceholderAudio(
          duration,
          audioType,
        );
        console.log(
          `[GenerateAssets] Procedural audio generated successfully (${buffer.length} bytes)`,
        );
      } catch (error) {
        console.error(`[GenerateAssets] Procedural audio FAILED: ${error}`);
        throw new Error(
          `Audio generation failed for ${req.key}: All methods failed. Error: ${error}`,
        );
      }
    }

    if (!buffer || buffer.length === 0) {
      throw new Error(`Audio generation failed for ${req.key}: Empty buffer`);
    }

    const cdnUrl = await this.saveAsset(buffer, req.key, assetsDir, 'wav');
    console.log(
      `[GenerateAssets] Audio file written: ${req.key}.wav (${buffer.length} bytes)`,
    );

    this.updateAssetPack(assetPack, req.key, 'audio', cdnUrl);
    console.log(
      `[GenerateAssets] Audio saved: ${req.key}.wav (${audioType}, ${duration}s)`,
    );
  }

  // ============== Tileset Generation ==============

  private async handleTileset(
    req: TilesetRequest,
    assetPack: AssetPack,
    assetsDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('Aborted');

    // Force 3x3 strategy, ignore any tileset_size=7 that might be passed in.
    // tile_size comes from the ONE source of truth (gameConfig.json) so the atlas
    // this produces and the tilewidth generate-tilemap writes cannot diverge —
    // see services/tileGeometry.ts for why that mattered.
    const gameRoot = path.resolve(assetsDir, '..', '..');
    const { tileSize: TILE_SIZE, source: tileSizeSource } =
      await resolveTileSize(gameRoot, req.tile_size);
    if (tileSizeSource !== 'gameConfig') {
      await recordTileSize(gameRoot, TILE_SIZE);
    }
    if (req.tile_size && req.tile_size !== TILE_SIZE) {
      console.warn(
        `[GenerateAssets] tile_size ${req.tile_size} from the asset registry ignored; ` +
          `using ${TILE_SIZE} declared in gameConfig.json (single source of truth).`,
      );
    }

    // Final output size fixed at 7x7 (448px)
    const OUTPUT_GRID = 7;

    console.log(
      `[GenerateAssets] Generating tileset: ${req.key} using 9-Slice (3x3 -> 7x7) Strategy`,
    );

    // Generated in code, with no image-model call at all. Four attempts to get a
    // tileable atlas out of the model each came back as a lit, three-dimensional
    // scene — see services/tileset-procedural.ts for what each one produced and
    // why prompt negation could not fix it. Tileability is decidable, so it is
    // code's job; the palette, which is not, still comes from the art direction.
    console.log(
      `[GenerateAssets] Generating ${OUTPUT_GRID}x${OUTPUT_GRID} tileset procedurally (no image API call)...`,
    );
    const seed = Array.from(req.key).reduce(
      (h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0,
      7,
    );

    // Resolve the tile look. Precedence, highest first:
    //   1. an explicit field on the request (a deliberate per-tileset override)
    //   2. the named style preset's value
    //   3. the built-in default
    // The preset table is the single source of truth for what the valid values
    // are; nothing here re-states them.
    const DEFAULT_STRUCTURE: TileStructure = 'grain';
    const DEFAULT_CAP: TileCap = 'none';
    const DEFAULT_WEAR = 0.4;

    const preset = req.style_preset ? findPreset(req.style_preset) : undefined;
    if (req.style_preset && !preset) {
      // A bad style choice must never stop an asset from being generated.
      console.warn(
        `[GenerateAssets] Unknown style_preset "${req.style_preset}" for tileset ` +
          `${req.key}; falling back to built-in tile defaults. Known presets: ` +
          `${PRESET_NAMES.join(', ')}.`,
      );
    }

    const structure: TileStructure =
      req.structure ?? preset?.structure ?? DEFAULT_STRUCTURE;
    const cap: TileCap = req.cap ?? preset?.cap ?? DEFAULT_CAP;
    const wear: number = req.wear ?? preset?.wear ?? DEFAULT_WEAR;

    const sourceOf = (explicit: unknown, fromPreset: unknown): string =>
      explicit !== undefined
        ? 'request'
        : fromPreset !== undefined
          ? `preset:${preset?.name}`
          : 'default';
    console.log(
      `[GenerateAssets] Tile look for ${req.key}: ` +
        `structure=${structure} (${sourceOf(req.structure, preset?.structure)}), ` +
        `cap=${cap} (${sourceOf(req.cap, preset?.cap)}), ` +
        `wear=${wear} (${sourceOf(req.wear, preset?.wear)})`,
    );

    // The renderer reads structure/cap/wear off these options; see
    // services/tileset-procedural.ts.
    // Markers are opt-in: only the roles this game's data actually uses. A
    // platformer with no tile-based hazards should not ship an atlas with a red
    // warning cell in it.
    const markers: MarkerRole[] = (req.markers ?? []).filter((r) =>
      MARKER_ROLES.includes(r),
    );
    // Tell generate-tilemap which markers exist, so it cannot place one the
    // atlas never drew.
    await recordMarkerRoles(gameRoot, markers);
    const tilesetOptions = {
      tileSize: TILE_SIZE,
      gridSize: OUTPUT_GRID,
      seed,
      structure,
      cap,
      wear,
      markers,
    };
    const proceduralBuffer = await generateProceduralTileset(
      gameRoot,
      tilesetOptions,
    );

    // The one thing the image model is reliably good at — surface material — is
    // applied on top of the structure code just drew. Best-effort by
    // construction: this returns the procedural atlas unchanged whenever the
    // style forbids a repaint, no provider is configured, the call fails, or the
    // repaint came back tiling worse than the base. See services/tileset-restyle.ts.
    const finalBuffer = await this.restyleTilesetSurface(
      req,
      proceduralBuffer,
      TILE_SIZE,
      OUTPUT_GRID,
      preset,
      signal,
    );

    // 4. Save (scored, not retried — the 3x3->7x7 expansion is expensive and
    //    the slicer's geometry assumptions make a re-roll risky)
    const cdnUrl = await this.saveWithPaletteCheck(
      finalBuffer,
      req.key,
      'tileset',
      assetsDir,
      null,
      req.target_px,
    );

    // 5. Update Asset Pack
    // Note: We still mark it as "tileset" in JSON, but Phaser will load it as 7x7
    this.updateAssetPack(assetPack, req.key, 'tileset', cdnUrl);

    console.log(
      `[GenerateAssets] Tileset saved: ${req.key}.png (${OUTPUT_GRID}x${OUTPUT_GRID} grid, ${TILE_SIZE}px tiles)`,
    );
  }

  /**
   * Send the atlas's fill cell through the i2i repaint pass and return the
   * atlas to save. NEVER throws and never returns nothing: every way this can
   * go wrong ends with the procedural atlas, which is already a shippable
   * asset. A tileset must not be lost to an image-API problem.
   */
  private async restyleTilesetSurface(
    req: TilesetRequest,
    proceduralAtlas: Buffer,
    tileSize: number,
    gridSize: number,
    preset: StylePreset | undefined,
    signal: AbortSignal,
  ): Promise<Buffer> {
    // Hardware-palette styles opt out. Their look IS the colour-count limit, and
    // the repaint measurably destroys it: a 4-colour Gameboy base came back from
    // the pass with 3367 colours. The flag lives on the preset record so the
    // decision sits next to the style it belongs to.
    if (preset && preset.restyle === false) {
      console.log(
        `[GenerateAssets] Tileset ${req.key}: surface restyle skipped — preset ` +
          `"${preset.name}" declares restyle:false (its look depends on a limited ` +
          `colour count, which an i2i repaint destroys).`,
      );
      return proceduralAtlas;
    }

    try {
      // Only a configuration probe: generateImageWithRetry below routes through
      // the same lazily-built router.
      this.ensureModelRouter();
    } catch (error) {
      console.log(
        `[GenerateAssets] Tileset ${req.key}: surface restyle skipped — no image ` +
          `provider configured (${error instanceof Error ? error.message.split('\n')[0] : error}).`,
      );
      return proceduralAtlas;
    }

    try {
      const outcome = await restyleTilesetAtlas(proceduralAtlas, {
        tileSize,
        gridSize,
        // The blob layout's CENTER cell: the plain fill, with none of the edge
        // treatment on it, which is exactly what the repaint should see.
        fillIndex: FILL_VARIANT_SLOTS[0],
        description: req.description,
        styleFragment: preset?.fragment,
        // The preset names the material. Without one the restyle falls back to
        // generic nouns that read identically for stone, metal, ice and candy.
        ...(preset?.material ? { textureNouns: preset.material } : {}),
        repaint: async (prompt, referenceDataUri) => {
          const url = await this.generateImageWithRetry(
            prompt,
            TILESET_RESTYLE_SIZE,
            signal,
            `tileset ${req.key} restyle`,
            referenceDataUri,
          );
          return this.downloadImage(url);
        },
      });
      console.log(`[GenerateAssets] Tileset ${req.key}: ${outcome.reason}`);
      return outcome.atlas;
    } catch (error) {
      console.warn(
        `[GenerateAssets] Tileset ${req.key}: surface restyle failed, keeping the ` +
          `procedural atlas — ${error instanceof Error ? error.message : error}`,
      );
      return proceduralAtlas;
    }
  }

  // ============== Helper Methods ==============

  private async loadAssetPack(packPath: string): Promise<AssetPack> {
    try {
      const data = await fs.readFile(packPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * An asset a game engine will not have to guess the scale of.
   *
   * `targetPx` is the longest side the caller says the thing is drawn at. The
   * file is written at that size. Godot multiplies `scale` by the NATIVE size,
   * so when native and intended differ by fifty times, so does the cost of an
   * ordinary mistake: shooter-sky-duel drew a 3840px projectile sheet at
   * `Vector2(bsc * 1.25, ...)` and put a single bullet across a 1280x720
   * screen, then shipped.
   *
   * Undeclared is allowed and unchanged -- but an oversized file is said out
   * loud, because a tool nobody passes the right argument to looks exactly
   * like a tool that works. `generate_game_assets` itself went forty rounds
   * without being called once, and nothing in the record said so.
   */
  private static readonly OVERSIZED_PX = 1024;

  private async saveAsset(
    buffer: Buffer,
    key: string,
    assetsDir: string,
    extension: string = 'png',
    targetPx?: number,
  ): Promise<string> {
    const filename = `${key}.${extension}`;
    const filePath = path.join(assetsDir, filename);
    let out = buffer;

    if (extension !== 'wav' && extension !== 'mp3') {
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(buffer).metadata();
        const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (targetPx && targetPx > 0 && longest > targetPx) {
          out = await sharp(buffer)
            .resize({
              width:
                (meta.width ?? 0) >= (meta.height ?? 0) ? targetPx : undefined,
              height:
                (meta.height ?? 0) > (meta.width ?? 0) ? targetPx : undefined,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer();
          console.log(
            `[GenerateAssets] ${key}: ${meta.width}x${meta.height} -> ` +
              `${targetPx}px (declared target_px)`,
          );
        } else if (
          !targetPx &&
          longest > GenerateAssetsInvocation.OVERSIZED_PX
        ) {
          console.warn(
            `[GenerateAssets] ${key} is ${meta.width}x${meta.height} and no ` +
              `target_px was declared. Engine scale is a multiplier on this ` +
              `size, so a small scale error here is a large one on screen.`,
          );
        }
      } catch (e) {
        // Never lose an asset to the normaliser. An unresized file is a
        // scale hazard; a missing file is a missing feature.
        console.warn(
          `[GenerateAssets] ${key}: could not normalise size (${e}); ` +
            `writing as generated`,
        );
        out = buffer;
      }
    }

    await fs.writeFile(filePath, out);
    return `assets/${filename}`;
  }

  /**
   * Score a finished image against the declared palette and, if it has drifted
   * badly, regenerate it ONCE with the offending colours named — then keep
   * whichever attempt scored better. This is the "validity by construction"
   * half of the style contract: the art style guide states the palette, and
   * this is what makes that statement mean something.
   *
   * Deliberately not a hard gate. Shading and gradients legitimately wander,
   * the vision judge (D4) is the real arbiter of whether art looks right, and
   * an asset that fails twice is still far better than no asset at all.
   */
  private async saveWithPaletteCheck(
    buffer: Buffer,
    key: string,
    type: string,
    assetsDir: string,
    /** null = score only, never retry (animation frames: a retry from a
     *  different attempt would break the very consistency the chain protects). */
    regenerate: ((offenders: string[]) => Promise<Buffer>) | null,
    targetPx?: number,
  ): Promise<string> {
    let best = buffer;
    let report: PaletteReport | null = null;
    let regenerated = false;

    if (this.artStyle) {
      try {
        report = await checkPalette(
          buffer,
          this.artStyle.palette.map((p) => p.hex),
        );
        if (
          regenerate &&
          report.measured &&
          report.conformance < PALETTE_CONFORMANCE_FLOOR
        ) {
          console.warn(
            `[GenerateAssets] ${key} palette conformance ${report.conformance.toFixed(2)} ` +
              `(off-palette: ${report.offPalette.slice(0, 3).join(', ')}) — regenerating once`,
          );
          try {
            const retryBuffer = await regenerate(report.offPalette.slice(0, 3));
            const retryReport = await checkPalette(
              retryBuffer,
              this.artStyle.palette.map((p) => p.hex),
            );
            regenerated = true;
            if (retryReport.conformance > report.conformance) {
              best = retryBuffer;
              report = retryReport;
            }
            console.log(
              `[GenerateAssets] ${key} conformance after retry: ${report.conformance.toFixed(2)}`,
            );
          } catch (e) {
            console.warn(
              `[GenerateAssets] ${key} palette retry failed, keeping original: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
      } catch (e) {
        // Never let a measurement problem cost us a generated asset.
        console.warn(
          `[GenerateAssets] ${key} palette check skipped: ${e instanceof Error ? e.message : e}`,
        );
        report = null;
      }
    }

    const cdnUrl = await this.saveAsset(best, key, assetsDir, 'png', targetPx);
    this.assetReport.push({
      key,
      type,
      file: cdnUrl,
      bytes: best.length,
      conformance: report?.measured
        ? Number(report.conformance.toFixed(3))
        : null,
      offPalette: report?.offPalette.slice(0, 4) ?? [],
      regenerated,
    });
    return cdnUrl;
  }

  // ============== Local Asset Library (OPENGAME_ASSET_MODE=library) ==============

  private libraryIndex?: LibraryIndexEntry[];
  private libraryRoot?: string;

  private async loadLibraryIndex(): Promise<
    NonNullable<typeof this.libraryIndex>
  > {
    if (this.libraryIndex) return this.libraryIndex;
    const idxPath =
      process.env.OPENGAME_ASSET_LIBRARY_INDEX ||
      path.join(process.cwd(), 'assets', 'library_index.json');
    const raw = await fs.readFile(idxPath, 'utf-8');
    this.libraryRoot = path.join(path.dirname(idxPath), 'library');
    this.libraryIndex = JSON.parse(raw);
    return this.libraryIndex!;
  }

  private static tokenize(s: string): Set<string> {
    return new Set(
      (s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !/^\d+$/.test(t)),
    );
  }

  private async detectArchetype(): Promise<string> {
    try {
      const ws = this.config.getWorkspaceContext().getDirectories()[0];
      const dirs = await fs.readdir(path.join(ws, 'docs', 'modules'), {
        withFileTypes: true,
      });
      const d = dirs.find((e) => e.isDirectory());
      return d ? d.name.toLowerCase() : '';
    } catch {
      return '';
    }
  }

  // Per-asset-type category hints: files whose path tokens hit these get a
  // strong boost, so e.g. a character ("animation") asset lands on a real
  // character sprite instead of a same-color coin, and a "background" lands
  // on a bg image instead of a random prop.
  // Per-asset-type category words. Files whose path tokens hit these are the
  // ONLY candidates considered (hard filter, with fallback to all if none),
  // so a character ("animation") asset lands on a real character sprite and a
  // "background" lands on a bg image — not a same-color coin. Generic words
  // like "sprite" are deliberately excluded (Kenney nests everything under
  // .../Sprites/).
  private static readonly CATEGORY_HINTS: Record<string, string[]> = {
    background: ['background', 'backdrop', 'parallax'],
    animation: [
      'character',
      'characters',
      'player',
      'enemy',
      'enemies',
      'hero',
      'zombie',
      'robot',
      'soldier',
      'monster',
      'knight',
      'alien',
      'people',
    ],
    tileset: ['tile', 'tiles', 'tileset', 'terrain', 'ground'],
    image: [],
  };

  /** Score every library entry of the requested kind, preserving the audit data. */
  private async matchLibraryFile(
    query: string,
    kind: 'image' | 'audio',
    archetype: string,
    assetType: string,
  ): Promise<LibraryMatch | null> {
    const index = await this.loadLibraryIndex();
    const qt = GenerateAssetsInvocation.tokenize(query);
    const archTok = archetype.replace(/_/g, '');
    const hints = new Set(
      GenerateAssetsInvocation.CATEGORY_HINTS[assetType] || [],
    );
    const inter = (toks: string[]) => {
      let n = 0;
      for (const t of toks) if (qt.has(t)) n++;
      return n;
    };
    const hasHint = (toks: string[]) => {
      for (const t of toks) if (hints.has(t)) return true;
      return false;
    };
    const score = (e: {
      fn: string[];
      dir: string[];
      tg: string[];
      s: string;
    }) => {
      let sc = 3 * inter(e.fn) + 1 * inter(e.dir) + 1 * inter(e.tg);
      if (archTok && (e.s.includes(archTok) || e.s.includes(archetype)))
        sc += 2;
      return sc;
    };

    let pool = index.filter((e) => e.k === kind);
    // Hard category filter (fall back to the full pool if it empties out).
    if (hints.size) {
      const sub = pool.filter((e) => hasHint(e.fn) || hasHint(e.dir));
      if (sub.length) pool = sub;
    }
    let best: LibraryIndexEntry | null = null;
    let bestScore = -1;
    for (const e of pool) {
      const sc = score(e);
      if (sc > bestScore) {
        bestScore = sc;
        best = e;
      }
    }
    return best ? { path: best.p, score: bestScore, entry: best } : null;
  }

  private librarySourceFile(srcPath: string): string {
    if (!this.libraryRoot) return path.basename(srcPath);
    const relative = path.relative(this.libraryRoot, srcPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
    return path.basename(srcPath);
  }

  /** Add or replace one audit row without allowing observability to fail a copy. */
  private async recordLibraryProvenance(
    req: AssetRequest,
    assetPack: AssetPack,
    match: LibraryMatch,
    target: string,
    frames?: number,
  ): Promise<void> {
    let width: number | null = null;
    let height: number | null = null;
    let hasAlpha: boolean | null = null;
    if (req.type !== 'audio') {
      try {
        const sharp = (await import('sharp')).default;
        const metadata = await sharp(match.path).metadata();
        width = metadata.width ?? null;
        height = metadata.height ?? null;
        hasAlpha = metadata.hasAlpha ?? false;
      } catch (e) {
        console.warn(
          `[GenerateAssets] Could not inspect library source ${match.path}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    const row: LibraryAssetProvenance = {
      key: req.key,
      target,
      source_mode: 'library',
      source_pack: match.entry.s,
      source_file: this.librarySourceFile(match.path),
      requested_description: req.description,
      intended_role: req.type,
      match_score: match.score,
      width,
      height,
      has_alpha: hasAlpha,
      static_animation: req.type === 'animation',
      ...(frames === undefined ? {} : { frames }),
    };
    const meta = assetPack.meta ?? {};
    const provenance = Array.isArray(meta.provenance) ? meta.provenance : [];
    const existing = provenance.findIndex((item) => item.key === req.key);
    if (existing >= 0) provenance[existing] = row;
    else provenance.push(row);
    meta.provenance = provenance;
    assetPack.meta = meta;
  }

  private async copyLibraryFile(
    srcPath: string,
    key: string,
    assetsDir: string,
    ext: string,
  ): Promise<string> {
    const filename = `${key}.${ext}`;
    await fs.copyFile(srcPath, path.join(assetsDir, filename));
    return `assets/${filename}`;
  }

  /** Library counterpart of handleX: pick a real file and copy it in. */
  /**
   * Where the library lives, without reading the index.
   *
   * A handoff never loads the index -- that is the point, the agent browses
   * instead -- so `this.libraryRoot` is unset on this path and the root has to
   * come from the same env var the index does.
   */
  private libraryRootPath(): string {
    const idxPath =
      process.env.OPENGAME_ASSET_LIBRARY_INDEX ||
      path.join(process.cwd(), 'assets', 'library_index.json');
    return path.join(path.dirname(idxPath), 'library');
  }

  /**
   * Every file the agent must produce for one handed-back asset.
   *
   * Deliberately the SAME keys and filenames `handleFromLibrary` would have
   * written. The templates, `animations.json` and the game's own code all
   * expect `key_anim_NN`; a handoff that renamed things would build a game
   * that cannot find its own frames.
   */
  private handoffTargets(req: AssetRequest): Array<{
    key: string;
    url: string;
  }> {
    if (req.type === 'animation') {
      const anims =
        req.animations && req.animations.length
          ? req.animations
          : [{ name: 'idle', frameCount: 1, action_desc: '' }];
      const out = new Map<string, string>();
      for (const a of anims) {
        for (let i = 1; i <= Math.max(1, a.frameCount || 1); i++) {
          const k = `${req.key}_${a.name}_${String(i).padStart(2, '0')}`;
          out.set(k, `assets/${k}.png`);
        }
      }
      // The base frame the templates fall back to, present either way.
      const base = `${req.key}_idle_01`;
      out.set(base, `assets/${base}.png`);
      return [...out].map(([key, url]) => ({ key, url }));
    }
    const ext = req.type === 'audio' ? 'ogg' : 'png';
    return [{ key: req.key, url: `assets/${req.key}.${ext}` }];
  }

  /** Reserve the pack entries for an asset the agent is going to supply. */
  private registerHandoff(req: AssetRequest, assetPack: AssetPack): void {
    for (const t of this.handoffTargets(req)) {
      this.updateAssetPack(assetPack, t.key, req.type, t.url);
    }
    const meta = assetPack.meta ?? {};
    const pending = Array.isArray(meta.library_handoff)
      ? (meta.library_handoff as unknown[])
      : [];
    pending.push({
      key: req.key,
      type: req.type,
      description: req.description,
      targets: this.handoffTargets(req).map((t) => t.url),
      source_mode: 'library_handoff',
    });
    (meta as Record<string, unknown>)['library_handoff'] = pending;
    assetPack.meta = meta;
  }

  private async handleFromLibrary(
    req: import('./generate-assets-types.js').AssetRequest,
    assetPack: AssetPack,
    assetsDir: string,
  ): Promise<void> {
    const archetype = await this.detectArchetype();
    const kind: 'image' | 'audio' = req.type === 'audio' ? 'audio' : 'image';
    const match = await this.matchLibraryFile(
      req.description,
      kind,
      archetype,
      req.type,
    );
    if (!match) {
      throw new Error(
        `no library match for ${req.key} (${req.type}); is the index built?`,
      );
    }
    const src = match.path;

    if (req.type === 'animation') {
      // Replicate the generate-path frame keys (key_anim_NN) so the game's
      // animations.json finds every referenced frame. All frames reuse the
      // matched sprite (static animation is fine for headless / WM use).
      const targets = new Set<string>();
      const anims =
        req.animations && req.animations.length
          ? req.animations
          : [{ name: 'idle', frameCount: 1, action_desc: '' }];
      let frameCount = 0;
      for (const a of anims) {
        const frames = Math.max(1, a.frameCount || 1);
        frameCount += frames;
        for (let i = 1; i <= frames; i++) {
          const frameKey = `${req.key}_${a.name}_${String(i).padStart(2, '0')}`;
          const url = await this.copyLibraryFile(
            src,
            frameKey,
            assetsDir,
            'png',
          );
          this.updateAssetPack(assetPack, frameKey, 'animation', url);
          targets.add(url);
        }
      }
      // Always provide the base idle frame the templates fall back to.
      const baseKey = `${req.key}_idle_01`;
      const images = assetPack['images'] as AssetPackSection | undefined;
      if (!images?.files.some((f) => f.key === baseKey)) {
        const url = await this.copyLibraryFile(src, baseKey, assetsDir, 'png');
        this.updateAssetPack(assetPack, baseKey, 'animation', url);
        targets.add(url);
      }
      const outputTargets = [...targets];
      await this.recordLibraryProvenance(
        req,
        assetPack,
        match,
        outputTargets[0],
        frameCount,
      );
      return;
    }

    const ext =
      req.type === 'audio' ? path.extname(src).slice(1) || 'wav' : 'png';
    const url = await this.copyLibraryFile(src, req.key, assetsDir, ext);
    this.updateAssetPack(assetPack, req.key, req.type, url);
    await this.recordLibraryProvenance(req, assetPack, match, url);
  }

  private getSectionName(assetType: string, key: string): string {
    switch (assetType) {
      case 'background':
        return 'backgrounds';
      case 'animation': {
        const entityName = key.split('_')[0];
        return `${entityName}_animations`;
      }
      case 'audio':
        return 'audio';
      case 'video': {
        const videoEntityName = key.split('_')[0];
        return `${videoEntityName}_videos`;
      }
      case 'tileset':
        return 'tilesets';
      case 'image':
      default:
        return 'images';
    }
  }

  private updateAssetPack(
    pack: AssetPack,
    key: string,
    assetType: string,
    url: string,
  ): void {
    const section = this.getSectionName(assetType, key);

    let packSection = pack[section] as AssetPackSection | undefined;
    if (!packSection?.files) {
      packSection = { files: [] };
      pack[section] = packSection;
    }

    const list = packSection.files;
    const existing = list.find((f) => f.key === key);

    // Determine file type for asset pack (Phaser compatible)
    let fileType: 'image' | 'audio' | 'video' | 'tileset' = 'image';
    if (assetType === 'audio') {
      fileType = 'audio';
    } else if (assetType === 'video') {
      fileType = 'video';
    } else if (assetType === 'tileset') {
      fileType = 'image'; // Phaser loads tilesets as images
    }

    if (existing) {
      existing.url = url;
    } else {
      list.push({ type: fileType, key, url });
    }
  }
}

// ============== Tool Class ==============

export class GenerateAssetsTool extends BaseDeclarativeTool<
  GenerateAssetsParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.GENERATE_ASSETS;

  constructor(private config: Config) {
    super(
      ToolNames.GENERATE_ASSETS,
      ToolDisplayNames.GENERATE_ASSETS,
      `Generates game assets (images, animations, audio) using AI models.
       Provider (Tongyi / Doubao / any OpenAI-compatible API) and model names
       are configured per-modality via env vars or ~/.qwen/settings.json
       (see docs/users/configuration/api-keys.md). Features auto background
       removal, I2V animation generation, and ABC-based music generation.`,
      Kind.Fetch,
      {
        type: 'object',
        properties: {
          style_anchor: {
            type: 'string',
            description:
              'Global visual style (e.g., "16-bit pixel art, vibrant colors")',
          },
          composition_env: {
            type: 'string',
            description:
              'Composition hints (e.g., "white background, centered, same size, no offset")',
          },
          output_dir_name: {
            type: 'string',
            description: 'Output directory (default: "public/assets")',
          },
          model_type: {
            type: 'string',
            enum: ['tongyi', 'doubao', 'openai-compat'],
            description:
              'Optional hint for the asset-generation provider family. ' +
              'Most users should configure providers via env vars or settings.json instead — ' +
              'see docs/users/configuration/api-keys.md.',
          },
          assets: {
            type: 'array',
            description: 'List of assets to generate',
            items: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    type: { const: 'background' },
                    key: { type: 'string' },
                    description: { type: 'string' },
                    resolution: {
                      type: 'string',
                      enum: ['1024*1024', '1536*1024', '2048*2048'],
                    },
                    target_px: {
                      type: 'number',
                      description:
                        'The size this asset is actually DRAWN at, in pixels ' +
                        'along its longest side. The file is written at this ' +
                        'size. Give it whenever you know: the engine scales ' +
                        'by a MULTIPLIER on the native size, so a 3840px ' +
                        'sheet at a 2.5x scale covers the whole screen. ' +
                        'Rough guide: a bullet or pickup 16-48, a character ' +
                        'or enemy 64-160, a prop 96-256, a full-screen ' +
                        'background 1280.',
                    },
                  },
                  required: ['type', 'key', 'description'],
                },
                {
                  type: 'object',
                  properties: {
                    type: { const: 'image' },
                    key: { type: 'string' },
                    description: { type: 'string' },
                    size: { type: 'string' },
                    target_px: {
                      type: 'number',
                      description:
                        'The size this asset is actually DRAWN at, in pixels ' +
                        'along its longest side. The file is written at this ' +
                        'size. Give it whenever you know: the engine scales ' +
                        'by a MULTIPLIER on the native size, so a 3840px ' +
                        'sheet at a 2.5x scale covers the whole screen. ' +
                        'Rough guide: a bullet or pickup 16-48, a character ' +
                        'or enemy 64-160, a prop 96-256, a full-screen ' +
                        'background 1280.',
                    },
                  },
                  required: ['type', 'key', 'description'],
                },
                {
                  type: 'object',
                  properties: {
                    type: { const: 'animation' },
                    key: { type: 'string' },
                    description: { type: 'string' },
                    useI2V: {
                      type: 'boolean',
                      description: 'Use I2V for animation (faster, smoother)',
                    },
                    animations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          frameCount: { type: 'number' },
                          action_desc: { type: 'string' },
                        },
                        required: ['name', 'frameCount', 'action_desc'],
                      },
                    },
                    target_px: {
                      type: 'number',
                      description:
                        'The size this asset is actually DRAWN at, in pixels ' +
                        'along its longest side. The file is written at this ' +
                        'size. Give it whenever you know: the engine scales ' +
                        'by a MULTIPLIER on the native size, so a 3840px ' +
                        'sheet at a 2.5x scale covers the whole screen. ' +
                        'Rough guide: a bullet or pickup 16-48, a character ' +
                        'or enemy 64-160, a prop 96-256, a full-screen ' +
                        'background 1280.',
                    },
                  },
                  required: ['type', 'key', 'description', 'animations'],
                },
                {
                  type: 'object',
                  properties: {
                    type: { const: 'audio' },
                    key: { type: 'string' },
                    description: { type: 'string' },
                    audioType: { type: 'string', enum: ['bgm', 'sfx'] },
                    duration: { type: 'number' },
                    genre: { type: 'string' },
                    tempo: { type: 'string', enum: ['slow', 'medium', 'fast'] },
                    target_px: {
                      type: 'number',
                      description:
                        'The size this asset is actually DRAWN at, in pixels ' +
                        'along its longest side. The file is written at this ' +
                        'size. Give it whenever you know: the engine scales ' +
                        'by a MULTIPLIER on the native size, so a 3840px ' +
                        'sheet at a 2.5x scale covers the whole screen. ' +
                        'Rough guide: a bullet or pickup 16-48, a character ' +
                        'or enemy 64-160, a prop 96-256, a full-screen ' +
                        'background 1280.',
                    },
                  },
                  required: ['type', 'key', 'description', 'audioType'],
                },
                {
                  type: 'object',
                  properties: {
                    type: { const: 'tileset' },
                    key: { type: 'string' },
                    description: {
                      type: 'string',
                      description:
                        'Tileset theme/style (e.g., "jungle terrain", "dungeon walls")',
                    },
                    tileset_size: {
                      type: 'number',
                      description: 'Grid size (default 7 = 7x7 = 49 tiles)',
                    },
                    tile_size: {
                      type: 'number',
                      description: 'Pixel size per tile (default 64)',
                    },
                    markers: {
                      type: 'array',
                      items: { type: 'string', enum: [...MARKER_ROLES] },
                      description:
                        'Role markers to paint into the atlas, e.g. ["hazard"]. ' +
                        'Leave unset unless this game places hazards or pickups ' +
                        'on tiles: an unrequested marker is a warning painted on ' +
                        'a floor with nothing to warn about.',
                    },
                    style_preset: {
                      type: 'string',
                      enum: [...PRESET_NAMES],
                      description:
                        'The normal way to choose how this tileset looks: name ' +
                        'one art-style preset and it supplies the structure, cap ' +
                        'and wear below. Set this and leave the other three unset ' +
                        'unless the preset default does not suit this tileset.',
                    },
                    structure: {
                      type: 'string',
                      enum: [...TILE_STRUCTURES],
                      description:
                        'Override: the structural pattern drawn into the tile ' +
                        'base. Only set it when the preset pattern is wrong for ' +
                        'this particular tileset.',
                    },
                    cap: {
                      type: 'string',
                      enum: [...TILE_CAPS],
                      description:
                        'Override: the material band along the top edge of ' +
                        'terrain tiles ("none" runs the tile body to the top ' +
                        'edge). Only set it when the preset band is wrong for ' +
                        'this particular tileset.',
                    },
                    wear: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                      description:
                        'Override: 0..1 surface wear, how much scuffing and ' +
                        'staining the tile surface gets. Only set it when the ' +
                        'preset amount is wrong for this particular tileset.',
                    },
                    target_px: {
                      type: 'number',
                      description:
                        'The size this asset is actually DRAWN at, in pixels ' +
                        'along its longest side. The file is written at this ' +
                        'size. Give it whenever you know: the engine scales ' +
                        'by a MULTIPLIER on the native size, so a 3840px ' +
                        'sheet at a 2.5x scale covers the whole screen. ' +
                        'Rough guide: a bullet or pickup 16-48, a character ' +
                        'or enemy 64-160, a prop 96-256, a full-screen ' +
                        'background 1280.',
                    },
                  },
                  required: ['type', 'key', 'description'],
                },
              ],
            },
          },
        },
        required: ['style_anchor', 'assets'],
      },
      false,
      true,
    );
  }

  protected createInvocation(
    params: GenerateAssetsParams,
  ): ToolInvocation<GenerateAssetsParams, ToolResult> {
    return new GenerateAssetsInvocation(this.config, params);
  }
}
