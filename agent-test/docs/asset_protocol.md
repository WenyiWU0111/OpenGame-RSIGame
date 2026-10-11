# Asset Generation Protocol

> **Scope**: generate_game_assets parameters, generate_tilemap ASCII rules, asset-pack.json / animations.json structure, key consistency rules.
> **NOT in scope**: Phaser implementation code (tilemap loading, collision setup) — see module-specific docs (`top_down.md`, `platformer.md`).

---

## 0. Draw-with-code vs generate-as-image (DECIDE THIS FIRST, per asset)

Do NOT generate an image for everything, and NEVER hand-author SVG sprites. For each
asset in the registry, first decide which of two paths it takes:

**A) Draw with code** — `src/shapes.ts` (`Shapes.*`, skeleton-owned) — for **geometric
infrastructure**: the shape carries no brand identity, its job is to be a crisp,
recolorable, instantiable primitive. These are CHEAPER, sharper, and recolor from the
theme palette — and they NEVER depend on the (fallible) image backend:

| Infrastructure                                         | Use                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Projectiles / bullets / orbs / energy pickups          | `Shapes.orb(scene, key, { radius, color, glow })`                |
| Portals / target rings / auras / shockwaves            | `Shapes.ring(scene, key, { radius, thickness, color })`          |
| Grid cells / buttons / plain blocks / simple platforms | `Shapes.chip(scene, key, { width, height, radius, color })`      |
| Gems / diamonds / triangles / hex tokens               | `Shapes.poly(scene, key, { radius, sides, rotationDeg, color })` |
| Stars / reward pips / collectibles                     | `Shapes.star(scene, key, { radius, color })`                     |
| HUD fills / energy bars / tokens                       | `Shapes.bar(scene, key, { width, height, color })`               |
| Particles / sparks (burst textures)                    | `Shapes.spark(scene, key, { size, color })`                      |

Each call registers a Phaser texture under `key` (idempotent); then
`scene.add.image(x, y, key)` or use it as a projectile/particle texture. Pick colors
from the game's `uiPalette`, which is itself taken from `docs/art_style.md` (§0.5) —
so code-drawn infrastructure, generated art and the UI chrome all name the SAME
colours. A hex literal that appears nowhere in the art style guide is the single
most reliable sign that a game's look has started to drift. Pair with the chrome juice
(`window.Chrome.fx.burst / ring / pop`) for impact feedback — do NOT generate "an
explosion PNG".

**B) Generate as image** — `generate_game_assets` (below) — ONLY for
**brand-identifiable content** the player must recognize as _this game's_: the hero,
named enemies/bosses, NPCs, the full-bleed background, textured tilesets, and
distinctive thematic pickups. One character per image (see §1.2.1).

**Never** satisfy an asset by hand-drawing an inline `<svg>` — if the image backend is
unavailable, a code-drawn `Shapes.*` primitive is the sanctioned fallback, not SVG.

**Switching an asset FROM code-drawn TO a generated image (fallback -> real art, or a
repair replacing a mismatched asset) — you MUST remove the old `Shapes.*` call for that
SAME key, not just add the image load.** Real, verified failure: `Shapes.*` registers
its texture under `key` unconditionally every time that code path runs (that's what
"idempotent" in §0 means — it always (re)writes that key). If `this.load.image(key, ...)`
loads a real PNG under a key that an existing `Shapes.orb(this, key, ...)`-style call
ALSO still runs for, whichever one executes later in `create()`/`preload()` silently
wins — usually the `Shapes.*` call, since it's typically still sitting in its original
place in the scene's init code. The result: a real, correctly-generated image sits
unused in `public/assets/`, registered in `asset-pack.json`, doing nothing, while the
game keeps rendering the old procedural placeholder — with no error, no warning, and a
diff that looks like the fix was made. **After adding a real image load for a key,
search the scene/shapes-setup code for any `Shapes.*(..., 'that-key', ...)` call and
DELETE it** — the two cannot coexist for the same key.

---

## 0.5 The art style guide (`docs/art_style.md`) — written BEFORE any asset

Two design documents precede asset generation: the GDD, and `docs/art_style.md`. The
style guide is what makes a game's art look like ONE game rather than N independently
imagined pictures. `custom.md` Phase 2 step 4b defines the exact schema; the fields are
parsed, so keep the names:

| field           | meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| `palette:`      | 4-8 lines of `#RRGGBB — role`. The game's real colour contract. |
| `line_quality:` | edge treatment (soft painterly / hard inked / pixel-crisp …)    |
| `lighting:`     | key + fill direction and temperature                            |
| `material:`     | what surfaces are made of, and their finish                     |
| `silhouette:`   | proportion and readability rules                                |
| `forbidden:`    | looks this game must never drift into                           |

`generate_game_assets` uses it in three places, all automatic:

1. **One style-reference image per game** is generated from the style guide plus
   `style_anchor`, and saved as `assets/style_anchor.png` (a working reference, not a
   game asset — it is deliberately NOT registered in `asset-pack.json`).
2. **Every background / sprite / animation base frame is conditioned on that image**
   (true image-to-image where the provider supports it), so assets inherit one concrete
   visual language instead of only sharing adjectives.
3. **Every finished asset is scored against the declared palette.** The score lands in
   `asset-pack.json` under `meta.conformance`, and an asset that drifts badly is
   regenerated once with the offending colours named. A missing or malformed
   `art_style.md` degrades cleanly: generation proceeds prompt-only, unscored.

Practical consequence: spend real thought on the palette. Every downstream check, and
the visual-quality judge's "does the art match the intended mood" question, is measured
against what you write there.

---

## 1. Asset Generation (Union-Type Interface)

### 1.1 Tool Call Template

**`style_anchor` comes from the preset, not from free writing.** GDD Section 1 already
picked one preset by name; that preset's **style fragment** (§1.2.2) IS the
`style_anchor`, copied verbatim, optionally followed by one clause of your own for what
is specific to this game. Do NOT reword the fragment, and do NOT copy the
`"16-bit pixel art, vibrant colors, retro arcade style"` string below as-is; it is one
illustrative example, not a default. The fragments are proven style vocabulary, and
reusing them verbatim is what makes a run reproducible — a freshly invented sentence
changes the art every time, so no difference in the output can be attributed to a
pipeline change rather than to a luckier sentence that run.

```json
generate_game_assets({
  "style_anchor": "16-bit pixel art, vibrant colors, retro arcade style", // EXAMPLE ONLY — replace with wording derived from this game's visual_mood
  "composition_env": "pure white background, centered, same size across frames, no position offset",
  "output_dir_name": "public/assets",
  "assets": [
    // See asset type examples below
  ]
})
```

### 1.1.1 Batch Generation (IMPORTANT)

If generating \*too many assets**, split into **2 separate tool calls\*\* to avoid timeout:

- **Call 1**: First half of animations + Backgrounds, tilesets, static images (type: background, tileset, image)
- \*_Call 2_: Remaining animations + audio

### 1.2 Asset Type Reference

| Type         | Parameters                                                         | Output Format              | Background Removal |
| ------------ | ------------------------------------------------------------------ | -------------------------- | ------------------ |
| `background` | `key`, `description`, `resolution`                                 | PNG 1536\*1024 (landscape) | No                 |
| `tileset`    | `key`, `description`, `tileset_size?` (default 7)                  | PNG 7*7 grid = 448*448px   | Yes                |
| `animation`  | `key`, `description`, `animations[]`                               | PNG 386\*560 (portrait)    | Yes                |
| `image`      | `key`, `description`                                               | PNG 386\*560 (portrait)    | Yes                |
| `audio`      | `key`, `description`, `audioType`, `duration?`, `genre?`, `tempo?` | WAV (8-bit chiptune)       | N/A                |

**CRITICAL — Parameter restrictions:**

- `type: "image"` accepts ONLY `key` and `description`. **Do NOT pass `size`, `resolution`, or any other parameter** — the output is always 386\*560 PNG. Game code scales the image via `setScale()` or `setDisplaySize()`. Icons, projectiles, and small sprites all use the same output size; scale in code.
- `type: "background"` is the ONLY type that accepts `resolution`. Format: `"1536*1024"` (use `*` asterisk, NOT `x`).
- **Dimension format**: Always use `*` (asterisk) between width and height: `"1536*1024"`, `"1024*1024"`, `"18*18"`. **Using `x` causes API errors.** This applies to `resolution`, `size`, or any dimension string.

### 1.2.1 Character Image Rules (CRITICAL)

**Rules vary by archetype:**

| Rule              | platformer                    | top_down                                        | tower_defense                                                                   | ui_heavy                    |
| ----------------- | ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| **One Per Image** | **ONE character per image**   | **ONE character per image**                     | **ONE entity per image**                                                        | **ONE character per image** |
| **View Angle**    | **SIDE VIEW** (profile)       | **TOP-DOWN / OVERHEAD**                         | **TOP-DOWN / OVERHEAD**                                                         | **FRONT VIEW** or 3/4 view  |
| **Direction**     | Face RIGHT by default         | **3 directions**: front, back, side             | Single direction (top-down)                                                     | Face FORWARD                |
| **Framing**       | Full body, action-ready       | Full body, overhead perspective                 | Full body, clear silhouette                                                     | **Bust shot** (chest up)    |
| **Asset Type**    | `type: "animation"` (2-frame) | `type: "animation"` (**1-frame per direction**) | `type: "image"` (towers/projectiles) or `type: "animation"` (enemies, optional) | `type: "image"` (static)    |

**CRITICAL**: Each character image must contain **exactly one character** — no groups, no multiple figures, no background characters.

**top_down characters**: Generate **3 directional images** per action:

- `{name}_{action}_front` (facing camera/down), `{name}_{action}_back` (facing away/up), `{name}_{action}_side` (right-facing profile)
- Each with `frameCount: 1`. Side sprites always face RIGHT; engine uses `flipX` for left.
- Prioritize directional coverage over frame count — 3 views × 1 frame >> 1 view × 2 frames.

**ui_heavy characters**: Generate SEPARATE images for each expression:

- `hero_neutral.png`, `hero_happy.png`, `hero_angry.png`
- Use `type: "image"` (NOT `type: "animation"`) for each

**tower_defense entities**: Towers, enemies, and projectiles are all top-down view:

- Towers: `type: "image"`, name `tower_{type}`. Clear silhouette, centered. Optional upgrade variants: `tower_{type}_lv2`, `tower_{type}_lv3`.
- Tower slots: `type: "image"`, name `tower_slot`. Visual placeholder for buildable cells that blends with the game theme (e.g., cushion, mat, stone platform, glowing circle). Slots are hidden by default and shown only during placement mode. If omitted, `drawTowerSlots()` falls back to a subtle graphic.
- Enemies: `type: "image"` (static) or `type: "animation"` (walk cycle). Name `enemy_{type}`. For animation: 2-frame walk cycle or 1-frame directional images.
- Projectiles: `type: "image"`, name `proj_{type}`. Small items (arrows, bullets, orbs). Code scales via `setScale()`. Use `projectileKey` in tower config; code uses 20px display for custom textures. Each tower type MUST have a distinct projectile image.
- Obstacles: `type: "image"`, name `obstacle_{type}`. Destructible objects placed on BLOCKED cells. Click-to-damage mechanic.
- Defense target: `type: "image"`, name `defense_target`. The object being defended at the exit point (optional but recommended for thematic games).
- **NO tilesets needed**: Tower defense maps use code-defined grids with a background image. Do NOT generate tileset assets for tower_defense.

### 1.2.2 Tileset Rules (CRITICAL)

| Rule                                      | Requirement                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Canvas Fill**                           | Tiles MUST fill the ENTIRE canvas, NO blank space, NO margins                                                                                                                                                                                                                |
| **Grid Layout**                           | Perfect 7\*7 grid (49 cells, `tile_size * 7` px per side — 448\*448px at the default 64px tile) with NO gaps between tiles                                                                                                                                                   |
| **Tile Edges**                            | Each tile should have clean, seamless edges                                                                                                                                                                                                                                  |
| **Top-Down Dual Tilesets (tilemap mode)** | Top-down tilemap games require **TWO** tileset images per theme: `{theme}_floor` (ground/surface) and `{theme}_walls` (wall/barrier). Both are emitted as 7\*7 atlases by the tileset generator. **Arena mode games do NOT need tilesets** — use a background image instead. |
| **Floor Tileset Art**                     | Floor tiles should be **solid/simple color** with minimal detail (at most subtle lines). Floor is background — busy patterns clutter the scene and compete with characters                                                                                                   |
| **Walls Tileset Art**                     | Walls should have **clear contrast** from floor (darker, thicker, raised appearance). More detail than floor is acceptable but keep it readable at small tile sizes                                                                                                          |

#### Tileset Style Presets

<!-- BEGIN GENERATED: style-presets -->

Pick exactly one preset by name and put it in the tileset asset's `style_preset` field.
The **style fragment** is handed to the image model verbatim as the style anchor for every
model-generated asset in the game, so the whole game reads as one art direction.
**Structure**, **cap** and **wear** are the procedural tile defaults the preset carries; they
are only defaults and may be overridden per tileset when one surface needs to differ.
**Restyle: no** means that preset's tiles skip the image-model repaint pass — its look depends
on a hard colour-count limit, and a repaint destroys that limit, so the procedural output is
kept as-is.
A preset may also bind a **fixed palette** published outside this repo; when it does, its
colours are listed under the table and the `palette:` block of `docs/art_style.md` MUST use
exactly those hex values. Presets with no fixed palette leave the colours to that document,
as before.

| Preset              | Style fragment                                                                                      | Structure  | Cap   | Wear | Material                                                                                     | Restyle |
| ------------------- | --------------------------------------------------------------------------------------------------- | ---------- | ----- | ---- | -------------------------------------------------------------------------------------------- | ------- |
| Cute & Fluffy       | adorable, pink and pastel — soft round characters, fluffy guinea-pig energy                         | grain      | none  | 0.15 | soft brushed fur, downy pile, gentle colour drift, no hard edges                             | yes     |
| Candy Land          | a candy wonderland — lollipop swirls, jelly blobs, liquorice ropes and sugar-bright colors          | checker    | none  | 0.1  | glossy boiled-sugar sheen, swirled stripes, sprinkle flecks, sticky highlights               | yes     |
| Rainbow Pop         | sugar-rush rainbow pop — bold stripes, smiley stickers, bubble letters and confetti                 | plate      | none  | 0.05 | flat saturated colour fields, glossy plastic sheen, crisp bands, no grain                    | yes     |
| Sticker Book        | glossy sticker-book art — die-cut shapes, thick white borders and shiny laminate shine              | grain      | none  | 0.1  | matte paper stock, die-cut white borders, slight peel curl, print dot texture                | yes     |
| Candy Glass         | a glossy candy-glass look — translucent jellies, glassy highlights and bubbly 3D buttons            | slab       | none  | 0.05 | translucent boiled sugar, internal bubbles, refracted colour, wet glassy highlights          | yes     |
| Pastel Goth         | pastel goth — soft lavenders and blacks, cute skulls, little bats and dreamy melancholy             | brick      | none  | 0.35 | chalky pastel wash over dark stone, faint lace shadow, powdery bloom                         | yes     |
| Toy Box             | a plastic toy-box world — shiny action figures, toy cars and bright moulded playsets                | plate      | none  | 0.15 | injection-moulded plastic, mould seam lines, scuffed gloss, primary colour blocks            | yes     |
| Lego Bricks         | a chunky plastic-brick world — studded bricks, minifig hands and glossy primary colors              | brick      | none  | 0.05 | ABS plastic sheen, crisp stud shadow, mould flow marks, flat saturated colour                | yes     |
| Felt & Pom-Pom      | a handmade felt and pom-pom world — fuzzy textures, stitched edges and craft-table charm            | grain      | none  | 0.25 | fuzzy felt nap, loose fibres, hand-stitched edge, soft matte dye                             | yes     |
| Honey Hive          | inside a honey hive — hexagon combs, amber glow, busy bees and dripping gold                        | hex        | none  | 0.25 | waxy comb sheen, translucent amber pooling, drip trails, warm glow                           | yes     |
| Ninja Dojo          | feudal-Japan ninja style — ink-wash skies, paper lanterns, cherry blossom and swift shadows         | plank      | none  | 0.3  | woven tatami rush, dark cloth binding, worn footpaths, matte lacquer                         | yes     |
| Ukiyo-e             | a japanese woodblock ukiyo-e print — flat color, great waves, distant peaks and elegant linework    | grain      | none  | 0.3  | woodblock ink grain, visible paper fibre, flat colour blocks, faint registration offset      | yes     |
| Wild West           | a dusty wild-west frontier — cacti, tumbleweed, saloon fonts and high-noon standoffs                | plank      | none  | 0.7  | sun-bleached timber, deep splits, dust in the grain, iron nail stains                        | yes     |
| Ancient Egypt       | ancient Egypt — golden sands, hieroglyphs, scarabs and torch-lit pyramid chambers                   | slab       | none  | 0.6  | wind-scoured sandstone, carved hieroglyph relief, ochre dust, chipped edges                  | yes     |
| Greek Myth          | greek mythology — marble columns, olive wreaths, thunderbolts and heroic friezes                    | slab       | none  | 0.35 | veined marble, polished then weathered, chipped fluting, cool white sheen                    | yes     |
| Pirate Seas         | high-seas piracy — treasure maps, galleons, parrots and cannon smoke over turquoise water           | plank      | moss  | 0.6  | salt-bleached deck planks, tar-filled seams, rope scuff, damp sheen                          | yes     |
| Skeleton Fiesta     | a day-of-the-dead fiesta — sugar skulls, marigolds, papel picado and joyful skeletons               | checker    | none  | 0.2  | cut tissue paper, punched patterns, layered colour, marigold dust                            | yes     |
| Lantern Festival    | a lantern festival night — red and gold lanterns, fireworks and paper dragons                       | grain      | none  | 0.25 | red rice paper, bamboo rib shadow, gold leaf flecks, warm backlight                          | yes     |
| Night Market        | a neon night market — steaming noodle stalls, paper lanterns and rain-wet streets                   | cracked    | none  | 0.55 | wet asphalt sheen, neon spill in puddles, scattered grit, oil rainbow                        | yes     |
| Aztec Empire        | the aztec empire — stepped temples, jade masks, carved sun-stones and feathered serpents            | brick      | moss  | 0.65 | carved volcanic stone, deep glyph relief, moss in the cuts, sun-bleached faces               | yes     |
| High Fantasy        | storybook high fantasy — castles, potions, runes and a touch of friendly magic                      | brick      | moss  | 0.45 | cut castle stone, mortar bloom, lichen patches, torch soot                                   | yes     |
| Dragon’s Hoard      | a dragon’s treasure lair — mountains of gold, glittering scales and firelit caverns                 | grain      | none  | 0.3  | heaped gold coins, scratched relief, warm reflected glow, dark gaps between                  | yes     |
| Elven Forest        | an elven woodland realm — silver leaves, glowing runes and moonlight through ancient trees          | grain      | moss  | 0.3  | living bark, silver lichen, carved leaf relief, soft moss in the grooves                     | yes     |
| Fairy Glade         | a tiny fairy glade — toadstool rings, drifting sparkles, dewdrops and soft golden light             | grain      | moss  | 0.25 | deep moss pile, tiny toadstools, dew beads, dappled light                                    | yes     |
| Knight’s Quest      | a heroic medieval quest — banners, stone castles, shining armour and noble crests                   | plate      | none  | 0.5  | hammered steel plate, rivet heads, oil sheen, battle scoring                                 | yes     |
| Wizard’s Tower      | a wizard’s study — towering spellbooks, crystal balls, bubbling potions and arcane glow             | slab       | moss  | 0.45 | old arcane stone, faintly glowing rune cuts, candle wax runs, dust                           | yes     |
| Jade Dynasty        | an eastern fantasy — jade dragons, misty mountains, temple roofs and floating lanterns              | slab       | none  | 0.2  | polished jade, cloudy internal veining, silk sheen, carved cloud relief                      | yes     |
| Dark Fantasy        | grim dark fantasy — ashen ruins, broken cathedrals, cursed knights and looming bosses               | cracked    | moss  | 0.7  | blackened stone, ash dust, deep cracks, dried blood in the seams                             | yes     |
| Unicorn Meadow      | a pastel unicorn meadow — rainbow manes, flower fields, butterflies and sparkle trails              | grain      | grass | 0.15 | soft meadow grass, tiny wildflowers, iridescent dew, pastel light                            | yes     |
| Fairy Tale          | a classic fairy-tale world — enchanted forests, magic lamps, talking animals and storybook charm    | brick      | grass | 0.3  | storybook brick, painted mortar, ivy tendrils, warm cottage glow                             | yes     |
| Space Opera         | an epic space opera — starfields, nebulae, sleek ships and dramatic cosmic scale                    | plate      | none  | 0.35 | brushed hull alloy, panel rivets, scorch streaks, cool rim light                             | yes     |
| Cyberpunk           | rain-slicked cyberpunk — holographic ads, towering neon signs, chrome and endless neon-lit megacity | cracked    | none  | 0.6  | wet cracked concrete, neon reflection, spray tags, oil sheen                                 | yes     |
| Space Station       | a clean sci-fi station — white corridors, holo-panels, airlocks and a big blue planet               | plate      | none  | 0.25 | clean composite panel, recessed seams, status decals, matte white                            | yes     |
| Area 51             | retro UFO conspiracy — little green men, radar dishes, redacted files and saucer beams              | plate      | none  | 0.5  | poured concrete, stencilled warnings, tyre scuff, desert dust                                | yes     |
| Alien Jungle        | an alien jungle — impossible flora, two moons, bioluminescent vines and strange birdsong            | grain      | moss  | 0.35 | pulsing organic membrane, bioluminescent veins, wet chitin, spore dust                       | yes     |
| Hologram            | a translucent blue hologram — flickering scanlines, edge glow and projected-light shimmer           | dot-matrix | none  | 0.1  | scanline shimmer, additive glow, chromatic fringe, translucent falloff                       | yes     |
| Robot Factory       | a clanking robot factory — conveyor belts, warning stripes, sparks and hydraulic pistons            | plate      | none  | 0.55 | oiled steel plate, hex bolts, swarf and shavings, warning-yellow scuff                       | yes     |
| Mad Science         | a mad scientist’s lab — bubbling test tubes, tesla coils, blueprints and green goo                  | checker    | none  | 0.35 | glazed lab tile, chemical stains, hairline crazing, cold fluorescent sheen                   | yes     |
| Neon Wireframe City | a neon wireframe metropolis — glowing skyscraper outlines against a black grid sky                  | checker    | none  | 0.05 | black void, glowing vector lines, additive bloom, no surface at all                          | yes     |
| Solar Punk          | bright solarpunk — lush greenery, white architecture, stained glass and hopeful sunlight            | hex        | grass | 0.2  | woven plant fibre over pale ceramic, solar cell sheen, fresh green shoots                    | yes     |
| Gothic Vampire      | dark gothic horror — crimson and black, candlelight, bats, cathedral arches and shadows             | brick      | moss  | 0.6  | cold cathedral stone, candle soot, cobweb, damp bloom                                        | yes     |
| Spooky Halloween    | playful halloween — pumpkins, cobwebs, friendly ghosts and a big harvest moon                       | cracked    | grass | 0.6  | cracked graveyard earth, dead leaves, pumpkin pulp, cold mist                                | yes     |
| Noir Detective      | black-and-white film noir — rain, fedoras, venetian-blind shadows and one red accent                | slab       | none  | 0.5  | rain-slick pavement, streetlight glare, cigarette ash, deep shadow                           | yes     |
| Foggy Harbor        | a misty harbor town — lighthouses, fog horns, lanterns and weathered wooden piers                   | plank      | moss  | 0.65 | waterlogged dock timber, barnacle crust, green algae, salt bloom                             | yes     |
| Tarot Card          | ornate tarot-card art — gilded borders, mystic symbols and rich jewel tones                         | grain      | none  | 0.25 | gilt card stock, embossed line work, foil flecks, aged varnish                               | yes     |
| Inkblot Mono        | high-contrast inkblot — pure black shapes on white, Rorschach symmetry and bold negative space      | grain      | none  | 0.4  | wet india ink on paper, bleeding edges, brush texture, pure black and white                  | yes     |
| Mad Desert          | a post-apocalyptic desert — rust, chrome, dust storms and jury-rigged machines                      | cracked    | none  | 0.75 | cracked desert hardpan, curling plates, bleached bone dust, heat shimmer                     | yes     |
| Glitch Art          | digital glitch art — datamosh tearing, RGB split, scanline corruption and pixel sorting             | dot-matrix | none  | 0.3  | corrupted colour blocks, datamosh smear, scanline tear, chromatic split                      | yes     |
| X-Ray               | x-ray vision — glowing white skeletons and silhouettes on deep blue-black film                      | grain      | none  | 0.2  | radiographic film grain, bone density gradients, blue-black falloff, no colour               | yes     |
| Thermal Vision      | a thermal-camera heatmap — blazing reds, cool blues and an infrared glow                            | grain      | none  | 0.15 | false-colour heat gradient, soft blooming edges, sensor noise, no detail lines               | yes     |
| Deep Ocean          | a glowing underwater world — bubbles, coral, bioluminescent fish in deep blue water                 | slab       | moss  | 0.35 | waterlogged stone, coral crust, bioluminescent spots, drifting silt                          | yes     |
| Lava Caverns        | a molten underworld — glowing lava flows, obsidian rock and embers drifting through heat            | ridged     | none  | 0.6  | black obsidian crust, glowing molten fissures, ash dust, heat glow                           | yes     |
| Frozen Tundra       | a glittering frozen world — ice crystals, auroras, snow drifts and frosty blues                     | cracked    | snow  | 0.4  | translucent ice, hairline internal cracks, frosted seams, bright specular edge on each block | yes     |
| Tropical Island     | a sunny tropical island — palm trees, coconuts, steel drums and postcard sunsets                    | grain      | grass | 0.3  | warm dry sand, shell fragments, salt crust, sun glare                                        | yes     |
| Dino Jungle         | a prehistoric jungle — giant ferns, volcanoes, friendly dinosaurs and amber light                   | grain      | moss  | 0.45 | trampled leaf litter, wet mud, thick roots, humid sheen                                      | yes     |
| Autumn Woods        | a cosy autumn forest — falling leaves, mushrooms, lanterns and golden afternoon light               | grain      | moss  | 0.5  | weathered wood grain, fallen leaves, moss in the cracks, golden light                        | yes     |
| Mushroom Hollow     | a glowing mushroom forest — giant toadstools, spores drifting like fireflies, mossy light           | grain      | moss  | 0.3  | damp fungal flesh, gill ridges, spore dust, soft glow                                        | yes     |
| Neon Aquarium       | a glowing neon aquarium — black water, electric jellyfish and bioluminescent trails                 | slab       | none  | 0.15 | wet tank glass, algae film, refracted light caustics, deep blue                              | yes     |
| Moonlit Dream       | a dreamy moonlit night — soft stars, sleepy clouds, lullaby purples and a gentle glow               | grain      | none  | 0.2  | soft silvered surface, faint star dust, cool haze, no hard edge                              | yes     |
| Stained Glass       | luminous stained-glass cathedral art — bold lead lines, jewel-bright glass panels and god-rays      | checker    | none  | 0.15 | coloured glass panes, dark lead came, light bleeding through, glossy                         | yes     |
| Neon Synthwave      | 1980s synthwave — neon grids, magenta sunsets, chrome text and an endless retro horizon             | plate      | none  | 0.1  | chrome sheen, magenta and cyan gradient, glow bloom, mirror-flat                             | yes     |
| Vaporwave Plaza     | vaporwave — marble busts, checkerboard floors and palm sunsets in teal and pink                     | checker    | none  | 0.2  | polished marble tile, pastel wash, dust motes, soft mall lighting                            | yes     |
| Synth Grid          | an endless synth grid — a glowing wireframe floor, a distant sun and a chrome horizon               | checker    | none  | 0.05 | black void, glowing grid lines, horizon bloom, perfect flatness                              | yes     |
| Neon Outline        | glowing neon-tube outlines on pure black — electric wireframes humming in the dark                  | slab       | none  | 0.1  | dark ground, single bright outline stroke, additive glow, no interior detail                 | yes     |
| 90s VHS             | fuzzy 90s VHS — tracking lines, timestamp overlays, camcorder grain and radical neon spandex        | grain      | none  | 0.5  | tape noise, chroma bleed, tracking lines, soft analogue blur                                 | yes     |
| Disco Fever         | 70s disco — mirrorballs, gold glitter, funky gradients and dance-floor tiles                        | checker    | none  | 0.2  | mirrored tile, reflected coloured light, smudged fingerprints, glossy                        | yes     |
| Steampunk Brass     | victorian steampunk — brass gears, copper pipes, steam gauges and airship silhouettes               | plate      | rust  | 0.65 | aged brass, rivet lines, verdigris in crevices, oil sheen                                    | yes     |
| Clockwork World     | inside a giant clock — ticking gears, pendulums, roman numerals and warm brass light                | hex        | rust  | 0.5  | machined gear teeth, brass filings, oil film, worn contact faces                             | yes     |
| Neon Graffiti       | spray-can graffiti — drippy throw-ups, brick walls and fat fluorescent tags                         | cracked    | none  | 0.6  | rough concrete, layered spray paint, drips, faded tags underneath                            | yes     |
| Art Deco            | roaring-twenties art deco — gold geometric fans, symmetrical sunbursts, chevrons                    | hex        | none  | 0.15 | inlaid brass on black lacquer, sunburst lines, polished sheen, crisp geometry                | yes     |
| 8-Bit Retro         | pure 8-bit arcade nostalgia — chunky pixels, primary colors, bleeps and bloops                      | dot-matrix | none  | 0.2  | hard pixel clusters, limited palette dithering, no gradients                                 | no      |
| Pixel Noir          | moody pixel-art noir — a tight palette, dithered shadows and one lonely neon sign                   | dot-matrix | none  | 0.4  | hard pixel clusters, heavy dithered shadow, two-tone limited palette                         | no      |
| Gameboy Green       | four-shade Gameboy green — dot-matrix screen, chunky sprites and that handheld glow                 | dot-matrix | none  | 0.2  | four-shade dot matrix, ordered dithering, LCD grid, no colour                                | no      |
| CGA Retro           | a garish CGA palette — cyan, magenta, black and white in proud early-PC colors                      | dot-matrix | none  | 0.15 | four-colour hard dithering, chunky pixel blocks, harsh contrast                              | no      |
| Voxel Cube          | a blocky voxel world — tiny cubes stacked into characters, soft shadows and Minecraft soul          | brick      | grass | 0.2  | flat-shaded cube faces, hard facet edges, no texture, blocky colour steps                    | yes     |
| PS1 Lo-Fi           | gritty early-3D PlayStation look — low-poly models, warping textures, dithered fog                  | grain      | none  | 0.5  | low-resolution texture, affine warping, colour banding, dithered gradient                    | yes     |
| Terminal Green      | retro hacker terminal — green phosphor text, CRT glow, ASCII art and blinking cursors               | dot-matrix | none  | 0.1  | phosphor glow on black, scanlines, single-hue monochrome, slight bloom                       | no      |
| Wireframe           | pure wireframe vector — glowing green vector lines on black, trench-run energy                      | checker    | none  | 0.05 | black ground, thin bright vector lines, no fill, no shading                                  | yes     |
| Low-Poly Pastel     | a calm low-poly world — faceted shapes in soft pastel gradients and flat shadows                    | plate      | grass | 0.15 | flat-shaded facets, soft pastel colour steps, hard polygon edges, no texture                 | yes     |
| Isometric City      | a clean isometric diorama — tidy cubes, soft ambient occlusion and toy-like buildings               | slab       | none  | 0.3  | poured concrete slab, expansion joints, tyre marks, urban grime                              | yes     |
| Halftone Print      | vintage halftone print — dotted newsprint shading, bold headlines and inky black-and-white          | dot-matrix | none  | 0.25 | CMYK halftone dots, visible rosette, slight misregistration, paper white                     | yes     |
| Skate Deck          | skateboard-deck graphics — bold screen-print art, grip-tape texture and street-brand swagger        | plank      | none  | 0.7  | worn maple ply, griptape scuff, deck chipping, sticker residue                               | yes     |
| Sneaker Hype        | sneaker-drop hype art — punchy colorways, swooshing shapes, hype tags and box-fresh gloss           | grain      | none  | 0.3  | rubber tread, mesh weave, suede nap, stitched panel seams                                    | yes     |
| Risograph           | riso-print art — grainy duotone spot colors, slightly misregistered layers and warm indie-zine feel | grain      | none  | 0.4  | grainy soy ink, limited spot colours, misregistration, paper tooth                           | yes     |
| Memphis Design      | 80s Memphis design — bold squiggles, confetti shapes, pastel blocks and playful geometry            | checker    | none  | 0.15 | flat bold colour blocks, squiggle and dot confetti, no shading                               | yes     |
| Stencil Street      | Banksy-style stencil street art — sharp spray-paint cut-outs, paint drips and bold shapes           | cracked    | none  | 0.6  | rough concrete, stencil overspray, layered paint, weathered edges                            | yes     |
| Paper Cut-Out       | layered paper cut-out art — stacked construction-paper shapes, soft drop shadows                    | slab       | none  | 0.15 | layered matte cardstock, cut edge shadow, slight fibre fray, flat colour                     | yes     |
| Magazine Collage    | cut-and-paste magazine collage — torn paper edges, mixed-up typography, photo scraps                | grain      | none  | 0.55 | torn magazine paper, halftone fragments, glue wrinkle, mixed print stock                     | yes     |
| Blueprint           | a technical blueprint — crisp white line art on cyan, dashed guides, callouts and grids             | checker    | none  | 0.1  | cyanotype blue, white technical linework, paper fold creases, faint grid                     | yes     |
| Coach’s Playbook    | a coach’s chalk playbook — Xs and Os, dotted run routes, whistles and clipboard                     | grain      | none  | 0.3  | green chalkboard, chalk dust, wiped smears, dashed white lines                               | yes     |
| Pop-Art Comic       | pop-art comic book — halftone dots, bold outlines, BAM! POW! panels and primary colors              | dot-matrix | none  | 0.2  | benday dots, bold black outline, flat primary fill, print misregistration                    | yes     |
| Manga Screentone    | black-and-white manga — screentone shading, speed lines and big expressive eyes                     | dot-matrix | none  | 0.3  | adhesive screentone dots, hatched shadow, pure black and white, paper grain                  | yes     |
| Saturday Cartoon    | a saturday-morning cartoon — thick outlines, squash-and-stretch and zany sound-effect text          | plate      | grass | 0.2  | flat cel fill, thick black outline, simple shadow shape, no texture                          | yes     |
| Superhero Comic     | a blockbuster superhero comic — caped heroes, city skylines, dynamic action poses                   | slab       | none  | 0.35 | inked city concrete, cross-hatched shadow, flat colour fill, print dot                       | yes     |
| Mecha Anime         | giant mecha anime — panel-lined robots, glowing thrusters, cockpit HUDs and missiles                | plate      | none  | 0.4  | panel-lined armour plate, decal stencils, scorch, hard specular edge                         | yes     |
| Cel-Shaded Anime    | crisp cel-shaded anime — bold clean linework, flat color fills, hard-edged shadows                  | plate      | grass | 0.2  | flat colour fill, hard-edged shadow band, crisp linework, no grain                           | yes     |
| Claymation          | handmade claymation — soft modelling-clay characters, visible thumbprints, squishy shapes           | grain      | none  | 0.35 | soft modelling clay, visible thumbprints, uneven surface, matte finish                       | yes     |
| Tabletop RPG        | hand-inked tabletop-RPG art — parchment maps, monster-manual ink drawings, dice                     | grain      | none  | 0.45 | aged parchment, ink hatching, foxing stains, torn fibre edge                                 | yes     |
| Arcade              | classic arcade illustration — airbrushed cabinet side-art, bold marquee lettering, neon glow        | plate      | none  | 0.25 | airbrushed gradient, bold outline, cabinet vinyl sheen, halftone shading                     | yes     |
| Kaiju Movie         | a rubber-suit kaiju movie — a towering monster, toppling models, smoke and fleeing crowds           | cracked    | none  | 0.7  | crushed concrete rubble, dust, rebar, model-set paint texture                                | yes     |

**Fixed palettes.**

- **Steampunk Brass** — Steam Lords by Slynyrd (`steam-lords`): `#213b25`, `#4f7754`, `#77744f`, `#603b3a`, `#2f213b`, `#4f5277`, `#7c94a1`, `#c0d1cc`
- **Gameboy Green** — Nintendo Gameboy (bgb) (`nintendo-gameboy-bgb`): `#081820`, `#346856`, `#88c070`, `#e0f8d0`

<!-- END GENERATED: style-presets -->

### 1.2.3 Animation Guidelines

| Guideline                 | platformer / grid_logic | top_down                                            |
| ------------------------- | ----------------------- | --------------------------------------------------- |
| Characters with animation | **4-6**                 | **4-6**                                             |
| Frame count               | **2 frames** per action | **1 frame per direction** (3 directions per action) |
| Priority                  | Frame fluidity          | **Directional coverage**                            |

**Standard Animation Set (platformer / grid_logic):**

| Character Type  | Required Animations                   |
| --------------- | ------------------------------------- |
| **Player/Hero** | `idle`, `run`, `jump`, `punch`, `die` |
| **Enemy**       | `idle`, `walk`, `attack`, `die`       |

**Frame Count Rule:**

- platformer / grid_logic: ALL animations use **frameCount: 2**.

Use `type: "image"` for items that don't need animation (coins, powerups, etc.).

**ui_heavy exception**: UI Heavy games typically use `type: "image"` for ALL characters (portraits with expressions). Only use `type: "animation"` for visual effects (sparkles, explosions) if needed. See `docs/modules/ui_heavy/design_rules.md` for asset guidelines.

### 1.2.4 Animation Prompt Guidelines (CRITICAL)

**action_desc** is the most important parameter for animation quality. Write clear, specific descriptions:

| Animation | Good action_desc                                                         | Bad action_desc  |
| --------- | ------------------------------------------------------------------------ | ---------------- |
| idle      | "standing still, relaxed pose, holding weapon at side"                   | "idle"           |
| run       | "running forward, legs in full stride, arms pumping"                     | "running"        |
| jump      | "mid-air jump, crouched position, arms raised"                           | "jumping"        |
| punch     | "swinging fist/weapon in powerful horizontal arc, follow-through motion" | "punching"       |
| kick      | "kicking forward with extended leg, arms held for balance"               | "kicking"        |
| ultimate  | "raising weapon to sky, magical energy swirling around body"             | "special attack" |
| die       | "falling backward defeated, weapon dropping, body going limp"            | "dying"          |

**Key Principles for action_desc:**

1. **Be specific about body position**: Describe limb positions, body angle
2. **Include motion direction**: "forward", "overhead", "downward arc"
3. **Mention key visual elements**: "sword extended", "shield raised", "cape flowing"
4. **Keep consistency**: Same character description across all animations
5. **Include character-specific props**: "hammer raised", "armor glowing", "cape wrapping"

### 1.2.5 Audio Generation Guidelines

**Output Format**: All audio outputs as `.wav` files (8-bit chiptune style via ABC notation)

**Audio Types:**

| audioType | Purpose          | Default Duration | Typical Use               |
| --------- | ---------------- | ---------------- | ------------------------- |
| `sfx`     | Sound effects    | 1 second         | jump, hit, collect, click |
| `bgm`     | Background music | 5 seconds        | level theme, menu music   |

**Audio Parameters:**

| Parameter   | Values                                                                           | Description                                                 |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `audioType` | `"sfx"` / `"bgm"`                                                                | **Required**                                                |
| `duration`  | Number (seconds)                                                                 | Optional. sfx: 0.5-2s, bgm: 10-30s recommended              |
| `genre`     | `"chiptune"`, `"electronic"`, `"orchestral"`, `"rock"`, `"ambient"`, `"fantasy"` | Optional. Music style                                       |
| `tempo`     | `"slow"`, `"medium"`, `"fast"`                                                   | Optional. slow=60-90 BPM, medium=100-130 BPM, fast=140+ BPM |

**Recommended Durations:**

- Jump/Hit SFX: 0.3-0.5s
- Collect/Click SFX: 0.5-1s
- Level BGM: 15-30s (for looping)
- Menu BGM: 10-20s (calm, loopable)

**Audio Prompt Guidelines:**

| Audio Type  | Good description                                            | Bad description    |
| ----------- | ----------------------------------------------------------- | ------------------ |
| Jump SFX    | "8-bit style upward rising pitch, quick bouncy sound"       | "jump sound"       |
| Collect SFX | "magical sparkle chime, ascending notes, positive feedback" | "coin sound"       |
| Hit SFX     | "punchy impact, short bass thump with crack"                | "hit"              |
| Level BGM   | "adventurous orchestral theme, heroic brass, steady rhythm" | "background music" |
| Menu BGM    | "calm ambient melody, soft synth pads, relaxing atmosphere" | "menu music"       |

**Key Principles for Audio:**

1. **Describe the sound quality**: "8-bit", "orchestral", "electronic", "chiptune"
2. **Mention emotional tone**: "heroic", "mysterious", "urgent", "peaceful"
3. **Include instrument hints**: "brass", "strings", "synth", "piano"
4. **For SFX, describe the shape**: "rising pitch", "sharp attack", "quick decay"

### 1.3 Asset Type Examples (one per type)

```json
// Background — landscape, NO background removal
{ "type": "background", "key": "city_bg",
  "description": "New York City skyline at night, retro 16-bit pixel art", "resolution": "1536*1024" }

// Tileset — 7*7 blob atlas (49 cells), tile_size * 7 px per side
{ "type": "tileset", "key": "ruins_tiles",
  "description": "Ancient ruins stone blocks with platforms", "tileset_size": 7 }

// Animation — platformer style (2-frame per action, SIDE VIEW)
{ "type": "animation", "key": "thor",
  "description": "Thor with red cape, silver armor, hammer, chibi style, SIDE VIEW facing RIGHT",
  "animations": [
    { "name": "idle", "frameCount": 2,
      "action_desc": "standing still, relaxed pose, holding hammer at side, cape flowing gently" },
    { "name": "run", "frameCount": 2,
      "action_desc": "running forward, legs in full stride, hammer held ready, cape flowing backward" },
    { "name": "die", "frameCount": 2,
      "action_desc": "falling backward defeated, hammer dropping, cape wrapping around body" }
  ]
}
// (Add more actions following the same pattern: jump, punch, kick, ultimate, etc.)

// Image — ONLY key and description. Output always 386*560; game code scales.
{ "type": "image", "key": "coin", "description": "golden coin collectible item, shiny" }
{ "type": "image", "key": "tower_spitfire", "description": "Top-down view of orange tabby cat on cushion, alert pose, clear silhouette" }
{ "type": "image", "key": "proj_tapioca", "description": "Black tapioca pearl with sticky glistening texture" }
{ "type": "image", "key": "icon_tower_tabby", "description": "Small icon of tabby cat for tower selection UI" }

// Audio SFX
{ "type": "audio", "key": "jump_sfx", "audioType": "sfx", "duration": 0.3,
  "description": "8-bit style upward rising pitch, quick bouncy arcade sound" }

// Audio BGM
{ "type": "audio", "key": "level1_bgm", "audioType": "bgm", "duration": 20,
  "description": "adventurous fantasy theme, heroic melody, steady rhythm, loopable",
  "genre": "fantasy", "tempo": "medium" }
```

### 1.4 Output File Naming Convention

```
public/assets/
  jungle_bg.png               <- type: "background" (1536*1024)
  jungle_tiles.png            <- type: "tileset" (7*7 = 448*448px)
  player_idle_01.png          <- type: "animation"
  player_run_01.png
  player_run_02.png
  player_run_03.png
  player_run_video.mp4        <- I2V source video (if useI2V: true)
  enemy_soldier.png           <- type: "image"
  coin.png                    <- type: "image"
  jump_sfx.wav                <- type: "audio" (sfx)
  level_bgm.wav               <- type: "audio" (bgm)
  asset-pack.json             <- auto-generated manifest
```

---

## 2. Tilemap Generation (ASCII Art to Tiled JSON)

**IMPORTANT**: Use predefined ASCII templates from the module's `design_rules.md`. Do NOT design maps from scratch.

### 2.1 Platformer Example (single tileset)

```json
generate_tilemap({
  "map_key": "level1_map",
  "tileset_key": "city_tiles",
  "tile_size": 64,
  "tileset_grid_size": 7,
  "layout_ascii": ["..P.........E..", "###############"],
  "legend": { ".": 0, "#": 1, "P": 0, "E": 0 },
  "object_markers": { "P": "player_spawn", "E": "enemy_spawn" },
  "output_dir_name": "public/assets"
})
```

### 2.2 Top-Down Example (dual tilesets — call TWICE per level)

```json
// Call 1: Floor (walkable, with spawn points)
generate_tilemap({
  "map_key": "base_floor", "tileset_key": "imperial_floor",
  "tile_size": 64, "mode": "floor",
  "layout_ascii": ["##########", "#..P...E.#", "#........#", "##########"],
  "object_markers": { "P": "player_spawn", "E": "enemy_spawn", "O": "obstacle" },
  "output_dir_name": "public/assets"
})

// Call 2: Walls (barriers, NO object_markers needed)
generate_tilemap({
  "map_key": "base_walls", "tileset_key": "imperial_walls",
  "tile_size": 64, "mode": "walls",
  "layout_ascii": ["##########", "#........#", "#........#", "##########"],
  "output_dir_name": "public/assets"
})
```

### 2.3 Parameter Reference

| Parameter           | Description                                                   | Example                   |
| ------------------- | ------------------------------------------------------------- | ------------------------- |
| `map_key`           | Unique Phaser key for the output JSON                         | `"level1_map"`            |
| `tileset_key`       | MUST match the asset key from `generate_game_assets`          | `"jungle_tiles"`          |
| `tile_size`         | Pixel size per tile                                           | `64`                      |
| `tileset_grid_size` | Tileset grid dimension (default 7)                            | `7`                       |
| `layout_ascii`      | ASCII map from GDD Section 4                                  | Array of strings          |
| `legend`            | Char → Tile ID mapping (`0` = air). Platformer only           | `{ ".": 0, "#": 1 }`      |
| `mode`              | Top-down only: `"floor"` or `"walls"` (auto-tiles internally) | `"floor"`                 |
| `object_markers`    | Char → spawn type                                             | `{ "P": "player_spawn" }` |

### 2.3.1 Floor markings (hazards and pickups)

A hazard is a promise. If the floor is painted with warning stripes, something
there must hurt the player — and if something hurts the player and the floor is
blank, the game has hidden it. Both mistakes are the same mistake: the tilemap
and the scene stating separately where the hazards are.

So the tool derives its markings from `object_markers`, which is already the
channel the scene reads. A marker char whose **type name** reads as a hazard
(`hazard`, `danger`, `damage`, `spike`, `trap`) or as a pickup (`pickup`,
`health`, `collect`, `reward`, `coin`) gets a painted floor marking on the
Ground layer at that tile, in the colour `docs/art_style.md` reserved for that
role, **and** the usual entry in the Objects layer:

```json
generate_tilemap({
  "map_key": "level1_floor", "tileset_key": "warehouse_floor", "mode": "floor",
  "layout_ascii": ["##########", "#..P..XX.#", "#...H....#", "##########"],
  "object_markers": { "P": "player_spawn", "X": "hazard", "H": "health_pickup" }
})
```

**The scene MUST then read those coordinates back from the Objects layer** —
`objectLayer.objects.filter(o => o.type === 'hazard')` — and must NOT re-declare
them as a hardcoded array in code. Declaring them twice is what lets the paint
and the damage drift apart; `agent-test/eval/contracts/asset_contract_check.py`
asserts that the two sets are equal and fails the game if they are not.

If a marker coordinate has no floor tile under it, the tool refuses to paint it
and says so in its output. That is not a tool problem to work around: the layout
and the marker list disagree, and one of them is wrong.

### 2.4 Legend (Platformer 9-Slice)

- `0` = Air (no tile), `1` = Solid tile (ground/platforms/walls)
- `2` = Floating platform (optional)
- Characters in `object_markers` map to `0` in legend (they stand on air)
- Top-down `mode: "floor"/"walls"` uses auto-tiling — `legend` is NOT needed

---

## 3. Asset Pack JSON Structure

### 3.1 Correct Format (Phaser load.pack())

```json
{
  "section_name": {
    "files": [
      { "type": "image", "key": "unique_key", "url": "path/to/asset.png" }
    ]
  }
}
```

### 3.2 Structure Example

```json
{
  "assetPack": {
    "files": [
      {
        "type": "animation",
        "key": "animations",
        "url": "assets/animations.json"
      }
    ]
  },
  "backgrounds": {
    "files": [
      { "type": "image", "key": "city_bg", "url": "assets/city_bg.png" }
    ]
  },
  "tilesets": {
    "files": [
      { "type": "image", "key": "city_tiles", "url": "assets/city_tiles.png" }
    ]
  },
  "tilemaps": {
    "files": [
      {
        "type": "tilemapTiledJSON",
        "key": "level1_map",
        "url": "assets/level1_map.json"
      }
    ]
  },
  "hero_frames": {
    "files": [
      {
        "type": "image",
        "key": "hero_idle_01",
        "url": "assets/hero_idle_01.png"
      },
      {
        "type": "image",
        "key": "hero_idle_02",
        "url": "assets/hero_idle_02.png"
      }
    ]
  },
  "audio": {
    "files": [
      { "type": "audio", "key": "jump_sfx", "url": "assets/jump_sfx.wav" }
    ]
  }
}
```

**Section naming**: Group by purpose (`backgrounds`, `tilesets`, `tilemaps`, `{char}_frames`, `audio`). Each section has a `files` array.

**Frame naming**: `{character}_{action}_{frame}.png` (platformer) or `{character}_{action}_{direction}.png` (top_down)

**CRITICAL**: animations.json entry MUST use `type: "animation"` (NOT `type: "json"`)

- `type: "json"` only loads JSON to cache — does NOT create Phaser animations
- `type: "animation"` auto-creates Phaser animations from the JSON

**WARNING**: animations.json must be loaded with `type: "animation"` ONLY. Do NOT also add a `type: "json"` entry for the same file — this causes double-loading and runtime errors. Example of CORRECT:

```json
{
  "type": "animation",
  "key": "animations_auto",
  "url": "assets/animations.json"
}
```

---

## 3.3 animations.json Format (CRITICAL - COMMON BUG SOURCE)

**Phaser 3 REQUIRES this exact format - any other format will cause "Missing animation" errors!**

```json
{
  "anims": [
    {
      "key": "thor_idle_anim",
      "type": "frame",
      "frames": [
        { "key": "thor_idle_01", "duration": 400 },
        { "key": "thor_idle_02", "duration": 400 }
      ],
      "repeat": -1
    }
  ]
}
```

| Field    | Required | Description                                         |
| -------- | -------- | --------------------------------------------------- |
| `anims`  | YES      | Root array containing all animations                |
| `key`    | YES      | Animation key (matches animKeys in code)            |
| `type`   | YES      | Always `"frame"`                                    |
| `frames` | YES      | Array of `{ "key": "texture_key", "duration": ms }` |
| `repeat` | YES      | `-1` = loop forever, `0` = play once                |

**Frame key naming (platformer)**: `{character}_{action}_{frame}` → `thor_idle_01`, `thor_idle_02`
**Frame key naming (top_down)**: `{character}_{action}_{direction}` → `mando_idle_front`, `mando_idle_back`, `mando_idle_side`
**Animation key naming**: `{character}_{action}_anim` → `thor_idle_anim` (base key used by FSM)
**Directional animation key (top_down)**: `{character}_{action}_{direction}_anim` → `mando_idle_front_anim`

**Pre-flight check**: Before running, verify EVERY frame key in animations.json exists in asset-pack.json!

### 3.4 Common Errors

| Error                                          | Consequence                        | Solution                                                                                |
| ---------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| Missing `"type"` field                         | Asset not loaded                   | Always include type                                                                     |
| `type: "json"` for animations                  | Animations not created             | Use `type: "animation"`                                                                 |
| All frames same URL                            | Animation static                   | Each frame unique file                                                                  |
| Wrong JSON structure                           | Parse error                        | Use `{ section: { files: [...] } }`                                                     |
| Leading slash in URL                           | 404 error                          | Use relative paths                                                                      |
| Animation key mismatch                         | Animation not found                | Configure animKeys in Player.ts                                                         |
| `Tongyi wanx edit API failed: 400 - url error` | I2I mode fails, 0 assets generated | Remove `useI2V: false` from animation assets; use default I2V. Ensure FFmpeg installed. |

---

## 4. Key Consistency Rule

**CRITICAL: These keys must ALL match across files!**

### Platformer (single tileset)

```
generate_game_assets: { type: "tileset", key: "jungle_tiles" }
                                              |
generate_tilemap: { tileset_key: "jungle_tiles" }
                                 |
asset-pack.json: { "key": "jungle_tiles", "url": "assets/jungle_tiles.png" }
                           |
Scene code: this.map.addTilesetImage('jungle_tiles', 'jungle_tiles')
```

### Top-Down (dual tilesets)

```
generate_game_assets: { key: "dungeon_floor" }  AND  { key: "dungeon_walls" }
                              |                               |
generate_tilemap (call 1): { tileset_key: "dungeon_floor", mode: "floor" }
generate_tilemap (call 2): { tileset_key: "dungeon_walls", mode: "walls" }
                                    |                               |
asset-pack.json: { "key": "dungeon_floor" }  AND  { "key": "dungeon_walls" }
                          |                                 |
Scene code: floorMap.addTilesetImage('dungeon_floor', 'dungeon_floor')
            wallsMap.addTilesetImage('dungeon_walls', 'dungeon_walls')
```

---

## 5. Verification Checklist

### 5.1 Common AI Mistakes (CHECK BEFORE CALLING)

| Mistake                           | Wrong                                                                         | Correct                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Passing `size` for type `"image"` | `{ "type": "image", "key": "icon_x", "description": "...", "size": "32x32" }` | `{ "type": "image", "key": "icon_x", "description": "..." }` — **no size param** |
| Using `x` in dimension strings    | `"18x18"`, `"1536x1024"`                                                      | `"18*18"`, `"1536*1024"` — **use asterisk `*`**                                  |

### 5.2 Before calling `generate_game_assets`

- [ ] `resolution` / `size` use `*` not `x` (e.g. `"1536*1024"`)
- [ ] `background` resolution is one of: `"1024*1024"`, `"1536*1024"`, `"2048*2048"`
- [ ] **`type: "image"` has NO `size` parameter** — remove if present
- [ ] Every `animations[]` item has `name`, `frameCount`, `action_desc`
- [ ] No `useI2V: false` unless FFmpeg unavailable (I2I may cause OSS errors)

### 5.3 Before proceeding to code implementation

- [ ] All asset files exist at specified URLs
- [ ] asset-pack.json keys match generated file names
- [ ] Tileset key matches across all files
- [ ] Animation frame keys use format `{key}_{anim}_{frame}`
- [ ] Tilemap tile layer name is 'Ground', object layer is 'Objects'
- [ ] Top-down **tilemap** games have TWO tileset images (`{theme}_floor` + `{theme}_walls`) and TWO tilemap JSONs per level
- [ ] Top-down **arena** games have NO tilesets, NO tilemap JSONs — use background image instead
