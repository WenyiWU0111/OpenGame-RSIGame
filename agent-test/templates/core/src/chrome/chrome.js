/* ============================================================
   FIXED UI CHROME (DOM) — skeleton-owned, never rewritten by generation.
   The game supplies DATA + a THEME palette; the chrome owns ALL layout,
   sizing, alignment, contrast and juice, so the HUD / how-to / end card
   cannot be made ugly. Self-contained: injects its own CSS, exposes
   window.Chrome. Usable both in templates/core and in a standalone preview.

   API (the ONLY things game code should call):
     Chrome.mount()                         // idempotent; builds the chrome DOM
     Chrome.theme({bg,accent,ink,good,warn,danger,gold,panel,   // 8 colors from visual_mood
       cornerStyle:'sharp'|'soft'|'round',  // default 'soft' — shape language
       shadowDepth:'flat'|'soft'|'deep',    // default 'soft' — elevation/weight
       spacing:'compact'|'cozy'|'spacious', // default 'cozy' — density
       fontStyle:'default'|'serif-storybook'|'pixel-retro'|'geometric-modern'|
         'rounded-playful',                  // default 'default' — system-safe stacks only
       hudCSS:'raw CSS text',                 // optional — restyles the FIXED HUD DOM
                                              // (.pg-hud-stats/.pg-stat/.pg-ic/.lbl/.val/
                                              // .pg-hud-obj) freely; can't add elements
                                              // or change behavior. Auto-verified for
                                              // clipping regardless of what CSS is used
                                              // (see verifier D4's hud-overflow check).
       howtoCSS:'raw CSS text',               // optional — restyles the FIXED how-to
                                              // panel DOM (.pg-ov/.pg-panel/.pg-title/
                                              // .pg-kicker/.pg-rows/.pg-row/.pg-keys/
                                              // .pg-key/.pg-act/.pg-goal/.pg-start)
                                              // freely, including full repositioning
                                              // (drawer/toast/etc — chrome no longer
                                              // ships a dedicated preset for this, write
                                              // the CSS directly). Dismiss behavior is
                                              // untouched. Auto-verified for panel
                                              // content pushed off-screen (see verifier
                                              // D4's howto-overflow check).
       endcardCSS:'raw CSS text'})            // optional — same idea, for the win/lose
                                              // screen (.pg-panel/.pg-end-title/
                                              // .pg-end-sub/.pg-end-score/.pg-btn).
                                              // Auto-verified for panel content pushed
                                              // off-screen (see verifier D4's
                                              // endcard-overflow check).
     // cornerStyle/shadowDepth/spacing/fontStyle are BOUNDED presets, not free CSS/font
     // files — pick one keyword per axis, chrome maps it to tested values. hudCSS/
     // howtoCSS/endcardCSS are the exception: real CSS, no preset menu. See custom.md.
     Chrome.hud.setRenderer(function(container, fields, objective) {...})
     Chrome.howto.setRenderer(function(container, {title,controls,goal}) {...})
     Chrome.endcard.setRenderer(function(container, {win,title,score}, proceed) {...})
                                            // FULL freedom, not just CSS — write any DOM
                                            // into `container` yourself. Call ONCE from
                                            // your own scene code (NOT gameConfig.json —
                                            // a function isn't JSON), before your first
                                            // set()/show() call. That call (wrapped in
                                            // try/catch; a throw falls back to the
                                            // default rendering, never breaks the game)
                                            // uses your renderer instead of chrome's
                                            // built-in markup. Chrome still owns WHERE
                                            // each surface sits (top bar / centered
                                            // overlay), the how-to dismiss state
                                            // machine, and the endcard advance
                                            // mechanism either way — NOT the shape/
                                            // background/font (hudCSS/howtoCSS/
                                            // endcardCSS cover that; use them together
                                            // with setRenderer, see custom.md). The
                                            // endcard renderer gets a THIRD argument,
                                            // `proceed` — wire your own button/control
                                            // to call it; chrome ALSO listens for Enter
                                            // as a fallback so a renderer that forgets
                                            // to wire anything working still can't
                                            // soft-lock the player. Same hud/howto/
                                            // endcard-overflow checks apply regardless
                                            // of renderer origin.
     Chrome.hud.set([{icon,label,value,color}], objective)
     Chrome.howto.show({title,controls:[[keys],action],goal}, onStart)
     Chrome.endcard.show({win,title,score,onNext})
     Chrome.fx.flash() / fx.shake() / fx.pop(x,y,text,color)
     Chrome.fx.burst(x,y,color,count) / fx.ring(x,y,color) / fx.confetti(count)
   Icons: curated inline-SVG set (font-independent). A game-specific icon may be
   passed as {icon:'url:...'} — the chrome puts it in a FIXED slot (never freehand).
   ============================================================ */
(function () {
  if (window.Chrome) return;

  // curated drawn icons (inline SVG, 24x24, currentColor) — no emoji/font dep
  var ICONS = {
    hp: '<path d="M12 21s-7-4.5-9.5-8.5C1 9 3 5.5 6.5 5.5 8.7 5.5 10 7 12 9c2-2 3.3-3.5 5.5-3.5C21 5.5 23 9 21.5 12.5 19 16.5 12 21 12 21z"/>',
    time: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    score:
      '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.1 1.2 6L12 16.9 6.6 22.5l1.2-6-4.5-4.1 6.1-.7z"/>',
    key: '<circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 11l8 8m-3 0l3-3m-6 0l3-3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    coin: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v10M9.5 9.5c0-1.4 1.1-2 2.5-2s2.5.6 2.5 2-1.1 2-2.5 2-2.5.6-2.5 2 1.1 2 2.5 2 2.5-.6 2.5-2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    life: '<circle cx="7" cy="12" r="3"/><circle cx="14" cy="12" r="3"/><circle cx="21" cy="12" r="3"/>',
  };
  function iconSVG(name, color) {
    if (name && name.indexOf('url:') === 0)
      return (
        '<span class="pg-ic-img" style="background-image:url(' +
        name.slice(4) +
        ')"></span>'
      );
    var body = ICONS[name] || ICONS.score;
    return (
      '<svg class="pg-ic" viewBox="0 0 24 24" style="color:' +
      (color || 'currentColor') +
      '" fill="currentColor">' +
      body +
      '</svg>'
    );
  }

  var CSS = `
  :root{
    --pg-bg:#0f1420; --pg-accent:#6ee7ff; --pg-ink:#eef2fb; --pg-dim:#8fa0bd;
    --pg-good:#7cf29c; --pg-warn:#ffd54a; --pg-danger:#ff6b6b; --pg-gold:#ffe08a;
    --pg-panel:#161a26; --pg-line:rgba(255,255,255,.14);
    /* shape/depth tokens — defaults match the original hardcoded look exactly;
       theme() overrides these from cornerStyle/shadowDepth/spacing presets. */
    --pg-r-hud:13px; --pg-r-panel:20px; --pg-r-key:7px; --pg-r-btn:34px;
    --pg-shadow-y:24px; --pg-shadow-blur:60px; --pg-shadow-a:.5; --pg-shadow-thick:3px;
    --pg-pad:20px; --pg-gap:20px;
    --pg-font:Arial,Helvetica,sans-serif;
    /* hud density tokens — defaults match the original hardcoded look.
       Override via theme()'s hudCSS (free CSS, not a preset) if the
       visual_mood calls for something these defaults don't express. */
    --pg-hud-gap:22px; --pg-hud-icon:22px; --pg-hud-val-size:21px; --pg-hud-lbl-size:15px;
  }
  #pg-chrome,#pg-chrome *{box-sizing:border-box;font-family:var(--pg-font);-webkit-user-select:none;user-select:none}
  #pg-chrome{position:absolute;inset:0;pointer-events:none;z-index:1000}
  /* HUD bar */
  #pg-hud{position:absolute;left:2.2%;right:2.2%;top:12px;height:52px;display:none;align-items:center;gap:var(--pg-gap);
    padding:0 var(--pg-pad);border-radius:var(--pg-r-hud);
    background:linear-gradient(180deg,color-mix(in srgb,var(--pg-bg) 82%,white 6%),color-mix(in srgb,var(--pg-bg) 92%,black 4%));
    border:1px solid var(--pg-line);backdrop-filter:blur(3px);color:var(--pg-ink);overflow:hidden;
    box-shadow:0 6px 18px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.06)}
  .pg-hud-stats{display:flex;align-items:center;gap:var(--pg-hud-gap);min-width:0;flex:0 0 auto}
  .pg-stat{display:flex;align-items:center;gap:7px;white-space:nowrap}
  .pg-ic{width:var(--pg-hud-icon);height:var(--pg-hud-icon);flex:0 0 auto}
  .pg-ic-img{width:var(--pg-hud-icon);height:var(--pg-hud-icon);flex:0 0 auto;background-size:contain;background-repeat:no-repeat;background-position:center;display:inline-block}
  .pg-stat .lbl{font-size:var(--pg-hud-lbl-size);color:var(--pg-dim);font-weight:600}
  .pg-stat .val{font-size:var(--pg-hud-val-size);font-weight:800;text-shadow:0 2px 0 rgba(0,0,0,.5)}
  .pg-hud-obj{margin-left:auto;font-size:19px;font-weight:700;color:color-mix(in srgb,var(--pg-accent) 75%,var(--pg-ink));
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;text-align:right}
  /* full-freedom HUD renderer container — hidden by default (see hud.set()'s
     hudRenderer branch); intentionally minimal, the agent's renderer owns
     everything about its contents' look. flex:1 so it fills the bar like
     .pg-hud-stats/.pg-hud-obj normally would. */
  .pg-hud-custom{flex:1;min-width:0;height:100%;display:flex;align-items:center}
  /* overlays
     '.show' toggles opacity AND pointer-events together. Toggling only opacity
     (the behaviour before 2026-08-21) leaves #pg-howto and #pg-endcard laid out
     at inset:0 over the whole viewport, invisible but still capturing every
     pointer event, so nothing on the canvas can be clicked.

     Measured on towerdefense_field_commander: 'document.elementFromPoint' at
     30 sampled points across the viewport returned 'DIV#pg-endcard' at every
     single one, the gameplay scene's 'pointerdown' never fired, and tower
     placement was impossible. With '.pg-ov:not(.show){pointer-events:none}'
     injected into the same page, the topmost element became the CANVAS, the
     scene received pointerdown at worldX=603/worldY=178, gold went 170 -> 125
     and towersGroup went 0 -> 1. Same game, same seed, same clicks.

     Phaser-interactive objects (the build buttons) still responded before the
     fix because Phaser's InputManager receives pointer events at the window
     level, bypassing DOM hit-testing -- which is why the failure looked like
     "the buttons work but placement never does". */
  .pg-ov{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    pointer-events:none;
    background:rgba(8,11,18,.74);opacity:0;transition:opacity .2s}
  .pg-ov.show{opacity:1;pointer-events:auto}
  .pg-panel{width:min(560px,86%);
    background:linear-gradient(165deg,color-mix(in srgb,var(--pg-panel) 100%,white 5%),color-mix(in srgb,var(--pg-panel) 100%,black 12%));
    border:2px solid var(--pg-line);border-radius:var(--pg-r-panel);
    padding:calc(var(--pg-pad)*1.5) calc(var(--pg-pad)*1.7);color:var(--pg-ink);text-align:center;
    box-shadow:0 var(--pg-shadow-y) var(--pg-shadow-blur) rgba(0,0,0,var(--pg-shadow-a)),
      0 var(--pg-shadow-thick) 0 color-mix(in srgb,var(--pg-panel) 55%,black 30%),inset 0 1px 0 rgba(255,255,255,.07);
    transform:scale(.94);transition:transform .22s cubic-bezier(.18,1.1,.3,1)}
  .pg-ov.show .pg-panel{transform:scale(1)}
  .pg-title{font-size:30px;font-weight:900;margin:0 0 4px}
  .pg-kicker{font-size:14px;font-weight:700;letter-spacing:.14em;color:var(--pg-accent);margin-bottom:18px}
  .pg-rows{display:flex;flex-direction:column;gap:12px;align-items:center;margin:6px 0 18px}
  .pg-row{display:flex;align-items:center;gap:12px}
  .pg-keys{display:flex;gap:6px}
  .pg-key{min-width:34px;height:34px;padding:0 9px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(180deg,color-mix(in srgb,var(--pg-panel) 100%,white 14%),color-mix(in srgb,var(--pg-panel) 100%,white 2%));
    border:2px solid var(--pg-line);border-radius:var(--pg-r-key);font-size:17px;font-weight:700;color:var(--pg-ink);
    box-shadow:0 calc(var(--pg-shadow-thick)*.7) 0 color-mix(in srgb,var(--pg-panel) 50%,black 35%)}
  .pg-act{font-size:18px;color:#cbd5e8}
  .pg-goal{font-size:18px;font-weight:700;color:var(--pg-gold);margin:8px 20px 0;line-height:1.35}
  .pg-start{margin-top:18px;font-size:18px;font-weight:800;color:var(--pg-good);animation:pgPulse 1.1s ease-in-out infinite}
  /* end card */
  .pg-end-title{font-size:46px;font-weight:1000;margin:6px 0;text-shadow:0 4px 0 rgba(0,0,0,.35)}
  .pg-end-sub{font-size:19px;color:#c7d2e6;margin-bottom:8px}
  .pg-end-score{font-size:26px;font-weight:900;color:var(--pg-gold);text-shadow:0 0 12px rgba(255,220,120,.5)}
  .pg-btn{margin-top:22px;min-width:280px;height:62px;border:0;border-radius:var(--pg-r-btn);font-size:24px;font-weight:900;
    color:#fff;cursor:pointer;pointer-events:auto;animation:pgPulse 1.1s ease-in-out infinite;
    text-shadow:0 2px 0 rgba(0,0,0,.25);
    box-shadow:0 var(--pg-shadow-thick) 0 var(--pg-btn-shade,rgba(0,0,0,.3)),0 10px 20px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.25)}
  /* juice */
  #pg-fx{position:absolute;inset:0;pointer-events:none;z-index:1500;overflow:hidden}
  .pg-float{position:absolute;font-size:30px;font-weight:900;color:var(--pg-warn);
    text-shadow:0 0 12px rgba(255,212,80,.8),0 2px 2px #000;transform:translate(-50%,0);animation:pgFloat .8s ease-out forwards}
  .pg-flash{position:absolute;inset:0;background:#fff;opacity:0;animation:pgFlash .18s ease-out}
  .pg-shake{animation:pgShake .22s linear}
  /* juice: burst particles, shockwave ring, confetti */
  .pg-particle{position:absolute;width:9px;height:9px;border-radius:50%;margin:-4px 0 0 -4px;
    will-change:transform,opacity;animation:pgBurst var(--pg-life,.6s) cubic-bezier(.2,.6,.2,1) forwards}
  .pg-ring{position:absolute;border-radius:50%;border:3px solid var(--pg-accent,#6ee7ff);
    margin:-6px 0 0 -6px;width:12px;height:12px;opacity:.9;will-change:transform,opacity;
    animation:pgRing .5s ease-out forwards}
  .pg-confetto{position:absolute;top:-14px;width:9px;height:14px;border-radius:2px;
    will-change:transform,opacity;animation:pgConfetti var(--pg-life,1.5s) linear forwards}
  @keyframes pgPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
  @keyframes pgFloat{0%{transform:translate(-50%,0) scale(.7);opacity:0}18%{opacity:1}100%{transform:translate(-50%,-58px) scale(1.05);opacity:0}}
  @keyframes pgFlash{0%{opacity:.55}100%{opacity:0}}
  @keyframes pgBurst{0%{transform:translate(0,0) scale(1);opacity:1}
    100%{transform:translate(var(--dx),var(--dy)) scale(.3);opacity:0}}
  @keyframes pgRing{0%{transform:scale(1);opacity:.9}100%{transform:scale(9);opacity:0}}
  @keyframes pgConfetti{0%{transform:translateY(0) rotate(0);opacity:1}
    100%{transform:translateY(var(--fall,680px)) rotate(var(--spin,720deg));opacity:.9}}
  /* filter-based shake only — never transform (transform breaks canvas centering) */
  @keyframes pgShake{0%,100%{filter:brightness(1)}25%{filter:brightness(1.14)}50%{filter:brightness(.95)}75%{filter:brightness(1.08)}}
  `;

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  var root, hudEl, hudStats, hudObj, hudCustomEl, howtoEl, endEl, fxEl, host;

  var hudStyleEl; // agent-authored HUD CSS (theme()'s hudCSS) — see theme()
  var howtoStyleEl; // agent-authored how-to CSS (theme()'s howtoCSS) — see theme()
  var endcardStyleEl; // agent-authored endcard CSS (theme()'s endcardCSS) — see theme()

  // Full-freedom escape hatch: an agent-authored function that renders HUD/
  // how-to content into a dedicated container instead of chrome's default
  // markup. Set via Chrome.hud.setRenderer(fn) / Chrome.howto.setRenderer(fn)
  // — called from the agent's OWN scene code (same file/pattern as the
  // existing Chrome.hud.set()/Chrome.howto.show() calls), NOT through
  // gameConfig.json (a render function isn't JSON-representable). set()/
  // show() call it wrapped in try/catch; a throw falls back to the default
  // renderer rather than breaking the game. Chrome still owns WHERE each
  // surface sits (HUD: top bar; how-to: centered overlay) and the how-to
  // dismiss state machine either way — hudCSS/howtoCSS (shape/background/
  // font) and setRenderer (content) are independent and meant to be used
  // together, see custom.md.
  var hudRenderer = null;
  var howtoRenderer = null;
  // endcardRenderer's contract differs from the other two: it also receives a
  // `proceed` callback, because unlike HUD/how-to (pure display, or a dismiss
  // mechanism chrome keeps full control of), the endcard's ONE job is a
  // player ACTION (continue/retry) — the renderer must decide what triggers
  // it (a button click, any key, etc) and call `proceed` itself. See
  // endcard.show()'s Enter-key fallback for why a renderer that forgets to
  // wire anything working still can't soft-lock the player.
  var endcardRenderer = null;

  function mount(container) {
    if (root) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    // Appended AFTER the base stylesheet above, so same-specificity rules in
    // agent-authored hudCSS/howtoCSS/endcardCSS win via source order without
    // needing !important.
    hudStyleEl = document.createElement('style');
    document.head.appendChild(hudStyleEl);
    howtoStyleEl = document.createElement('style');
    document.head.appendChild(howtoStyleEl);
    endcardStyleEl = document.createElement('style');
    document.head.appendChild(endcardStyleEl);
    host =
      container || document.getElementById('game-container') || document.body;
    if (getComputedStyle(host).position === 'static')
      host.style.position = 'relative';
    root = el('<div id="pg-chrome"></div>');
    root.innerHTML =
      '<div id="pg-hud"><div class="pg-hud-stats"></div><div class="pg-hud-obj"></div>' +
      '<div class="pg-hud-custom" style="display:none"></div></div>' +
      '<div id="pg-howto" class="pg-ov"></div>' +
      '<div id="pg-endcard" class="pg-ov"></div>' +
      '<div id="pg-fx"></div>';
    host.appendChild(root);
    hudEl = root.querySelector('#pg-hud');
    hudStats = root.querySelector('.pg-hud-stats');
    hudObj = root.querySelector('.pg-hud-obj');
    hudCustomEl = root.querySelector('.pg-hud-custom');
    howtoEl = root.querySelector('#pg-howto');
    endEl = root.querySelector('#pg-endcard');
    fxEl = root.querySelector('#pg-fx');
  }

  // Shape/depth presets — bounded choices, not free-form CSS: agent picks a
  // keyword per axis (matched to visual_mood in custom.md's guidance), chrome
  // maps it to tested values. Each default entry (soft/soft/cozy) reproduces
  // the original hardcoded look exactly, so games that don't set these are
  // unaffected.
  var CORNER = {
    sharp: { hud: '6px', panel: '10px', key: '4px', btn: '10px' },
    soft: { hud: '13px', panel: '20px', key: '7px', btn: '34px' },
    round: { hud: '22px', panel: '30px', key: '12px', btn: '34px' },
  };
  var SHADOW = {
    flat: { y: '10px', blur: '24px', a: '.32', thick: '2px' },
    soft: { y: '24px', blur: '60px', a: '.5', thick: '3px' },
    deep: { y: '34px', blur: '86px', a: '.6', thick: '6px' },
  };
  var SPACING = {
    compact: { pad: '14px', gap: '14px' },
    cozy: { pad: '20px', gap: '20px' },
    spacious: { pad: '28px', gap: '26px' },
  };
  // System-safe stacks only — no @font-face/network fetch, so this can never
  // 404 or block render (a real ".../fronts/retro-pixel-arcade.otf.woff2 404"
  // was observed from agent-authored title-screen CSS elsewhere in this game;
  // chrome's own font choice must not carry that same risk).
  var FONT = {
    default: 'Arial,Helvetica,sans-serif',
    'serif-storybook': 'Georgia,"Palatino Linotype","Book Antiqua",serif',
    'pixel-retro': '"Courier New",Consolas,"Lucida Console",monospace',
    'geometric-modern': '"Century Gothic","Trebuchet MS",Futura,sans-serif',
    'rounded-playful':
      '"Segoe UI Rounded","SF Pro Rounded",-apple-system,sans-serif',
  };

  // gameConfig.json's OTHER top-level sections (playerConfig, difficultyConfig,
  // ...) all wrap values as {value,type,description} — agents pattern-match that
  // convention onto uiPalette too even though custom.md asks for flat hex
  // strings, so theme() must accept BOTH shapes or every color silently no-ops
  // (setProperty on a stringified object is invalid CSS and is dropped).
  // Confirmed on real output: 3/3 generated games used the wrapped form.
  function unwrap(v) {
    return v && typeof v === 'object' && 'value' in v ? v.value : v;
  }

  /* The WHOLE palette can arrive wrapped, not just its fields.

     `unwrap` above handles {"bg": {"value": "#111"}}. It cannot handle

         "uiPalette": {"value": {"bg": "#111", ...}, "type": "object",
                       "description": "..."}

     because `theme()` then reads p.bg on the wrapper, gets undefined for every
     key, and discards the entire palette without a word. Measured across the
     corpus on 2026-08-24: 22 of 83 games ship a complete palette in that shape
     -- fourteen keys including all three free-CSS fields, authored, saved, and
     unreachable. The symptom is indistinguishable from never having written a
     palette, which is how it survived 83 games unnoticed.

     The unwrap is deliberately narrow: it fires only when EVERY key is part of
     the wrapper signature and `value` is itself an object. A real palette that
     happens to contain a `value` key, or a half-wrapped one, is left alone --
     guessing at a mixed shape would be a different silent failure. */
  var WRAPPER_KEYS = { value: 1, type: 1, description: 1 };
  function unwrapPalette(p) {
    for (var depth = 0; depth < 4; depth++) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
      var onlyWrapper = true;
      for (var k in p) {
        if (!WRAPPER_KEYS[k]) {
          onlyWrapper = false;
          break;
        }
      }
      if (!onlyWrapper || !p.value || typeof p.value !== 'object') return p;
      p = p.value;
    }
    return p;
  }

  function theme(p) {
    mount();
    p = unwrapPalette(p || {}) || {};
    // Set on documentElement (real :root), not the #pg-chrome div — a sibling
    // DOM tree (e.g. TitleScreen.ts's own agent-authored createDOMUI(), which
    // is NOT a descendant of #pg-chrome) can then optionally reference
    // var(--pg-accent) etc. for cross-surface consistency if it chooses to;
    // #pg-chrome and everything inside it still inherits identically either
    // way since it's a documentElement descendant too.
    var t = document.documentElement;
    var map = {
      bg: '--pg-bg',
      accent: '--pg-accent',
      ink: '--pg-ink',
      good: '--pg-good',
      warn: '--pg-warn',
      danger: '--pg-danger',
      gold: '--pg-gold',
      panel: '--pg-panel',
      // --pg-dim drives the HUD's stat LABELS and had no map entry at all, so
      // a game naming a muted colour could not reach it however it spelled the
      // key. 16 of 83 games write `muted`; every one of them was discarded.
      dim: '--pg-dim',
      // 60 of 84 games declare a second accent and chrome had nowhere to put
      // it. Nothing in chrome's own CSS reads --pg-accent2, so exposing it
      // changes no existing game's rendering -- it only makes a value the
      // generator already writes reachable from hudCSS/howtoCSS/endcardCSS.
      accent2: '--pg-accent2',
    };
    for (var k in map) {
      var v = unwrap(p[k]);
      if (v) t.style.setProperty(map[k], v);
    }
    /* Names agents reach for that mean an existing slot. Each alias maps onto a
       token that already exists -- no new visual contract, just a spelling the
       generator actually uses. Measured: success 11/83, warning 10/83, muted
       16/83, all silently dropped before this.

       An alias never overrides the canonical key: a palette carrying both
       `good` and `success` keeps `good`, so adding an alias cannot change what
       an already-correct palette renders. */
    var ALIAS = {
      text: 'ink',
      muted: 'dim',
      success: 'good',
      warning: 'warn',
      error: 'danger',
    };
    for (var a in ALIAS) {
      var av = unwrap(p[a]);
      if (av && !unwrap(p[ALIAS[a]])) t.style.setProperty(map[ALIAS[a]], av);
    }

    var c = CORNER[unwrap(p.cornerStyle)] || CORNER.soft;
    t.style.setProperty('--pg-r-hud', c.hud);
    t.style.setProperty('--pg-r-panel', c.panel);
    t.style.setProperty('--pg-r-key', c.key);
    t.style.setProperty('--pg-r-btn', c.btn);

    var s = SHADOW[unwrap(p.shadowDepth)] || SHADOW.soft;
    t.style.setProperty('--pg-shadow-y', s.y);
    t.style.setProperty('--pg-shadow-blur', s.blur);
    t.style.setProperty('--pg-shadow-a', s.a);
    t.style.setProperty('--pg-shadow-thick', s.thick);

    t.style.setProperty('--pg-font', FONT[unwrap(p.fontStyle)] || FONT.default);

    var sp = SPACING[unwrap(p.spacing)] || SPACING.cozy;
    t.style.setProperty('--pg-pad', sp.pad);
    t.style.setProperty('--pg-gap', sp.gap);

    // HUD styling: real CSS, not a bounded preset — the density/size
    // defaults set in :root (--pg-hud-gap etc.) already reproduce the
    // original look; hudCSS only needs to override what the visual_mood
    // actually calls for. The DOM chrome generates (#pg-hud > .pg-hud-stats
    // > .pg-stat > .pg-ic/.lbl/.val, .pg-hud-obj) is fixed — hudCSS can
    // restyle it freely but can't add new elements/behavior/state. The D4
    // hud-overflow check (evidence/hud_layout.py) measures rendered geometry,
    // not CSS source, so it keeps catching clipping regardless of what CSS
    // produced the layout.
    if (hudStyleEl) hudStyleEl.textContent = unwrap(p.hudCSS) || '';

    // How-to panel styling: same deal — real CSS, not a modal/drawer preset
    // menu. Target .pg-panel/.pg-title/.pg-kicker/.pg-rows/.pg-row/.pg-keys/
    // .pg-key/.pg-act/.pg-goal/.pg-start, or .pg-ov for the overlay/backdrop
    // itself (position it as a drawer, a corner toast, whatever the mood
    // calls for — chrome no longer ships a dedicated drawer class; write the
    // equivalent CSS directly). The dismiss state machine (howtoSeen,
    // keydown/pointerdown handling, the 200ms fade-out) is untouched by this
    // — howtoCSS can only change how it looks, not how/when it dismisses.
    // The D4 howto-overflow check (evidence/howto_layout.py) measures
    // rendered geometry against the viewport, so it keeps catching "panel
    // content pushed off-screen" regardless of the CSS used.
    if (howtoStyleEl) howtoStyleEl.textContent = unwrap(p.howtoCSS) || '';

    // Endcard styling: same deal again. Target .pg-panel/.pg-end-title/
    // .pg-end-sub/.pg-end-score/.pg-btn, or .pg-ov. The advance-to-next
    // mechanism (button click -> onNext(), plus the Enter-key fallback — see
    // endcard.show()) is untouched by this. The D4 endcard-overflow check
    // (evidence/endcard_layout.py) measures rendered geometry, same as
    // above.
    if (endcardStyleEl) endcardStyleEl.textContent = unwrap(p.endcardCSS) || '';
  }

  var hud = {
    // Full-freedom escape hatch — see hudRenderer's declaration for the
    // contract. Call this once (e.g. in create()) before your first
    // Chrome.hud.set() call.
    setRenderer: function (fn) {
      hudRenderer = typeof fn === 'function' ? fn : null;
    },
    set: function (fields, objective) {
      mount();
      fields = fields || [];
      objective = objective || '';
      if (hudRenderer) {
        try {
          hudCustomEl.innerHTML = '';
          hudRenderer(hudCustomEl, fields, objective);
          hudCustomEl.style.display = '';
          hudStats.style.display = 'none';
          hudObj.style.display = 'none';
          hudEl.style.display = 'flex';
          return;
        } catch (e) {
          console.error(
            '[Chrome.hud] custom renderer threw, falling back to the default HUD:',
            e,
          );
          hudCustomEl.style.display = 'none';
          hudStats.style.display = '';
          hudObj.style.display = '';
          // fall through to the default renderer below
        }
      }
      hudStats.innerHTML = '';
      fields.forEach(function (f) {
        var s = el('<div class="pg-stat"></div>');
        s.innerHTML =
          iconSVG(f.icon || 'score', f.color) +
          (f.label ? '<span class="lbl">' + f.label + '</span>' : '') +
          '<span class="val" style="color:' +
          (f.color || 'var(--pg-ink)') +
          '">' +
          f.value +
          '</span>';
        hudStats.appendChild(s);
      });
      hudObj.textContent = objective;
      hudEl.style.display = 'flex'; // shown once the game supplies data
    },
    show: function () {
      mount();
      hudEl.style.display = 'flex';
    },
    hide: function () {
      mount();
      hudEl.style.display = 'none';
    },
  };

  // Default how-to panel content (title/kicker/control rows/goal/start-hint).
  // Extracted so both the default path and the custom-renderer fallback path
  // (setRenderer, below) can produce it — the DISMISS wiring after this is
  // identical either way and untouched by which content path ran.
  function _defaultHowtoHTML(d) {
    var rows = (d.controls || [])
      .map(function (c) {
        var keys = c[0]
          .map(function (k) {
            return '<span class="pg-key">' + k + '</span>';
          })
          .join('');
        return (
          '<div class="pg-row"><span class="pg-keys">' +
          keys +
          '</span><span class="pg-act">' +
          c[1] +
          '</span></div>'
        );
      })
      .join('');
    return (
      '<div class="pg-title">' +
      (d.title || '') +
      '</div>' +
      '<div class="pg-kicker">HOW TO PLAY</div>' +
      '<div class="pg-rows">' +
      rows +
      '</div>' +
      (d.goal ? '<div class="pg-goal">' + d.goal + '</div>' : '') +
      '<div class="pg-start">Press  ENTER  or click to start</div>'
    );
  }

  // Per-session record of how-to screens already dismissed (keyed by title), so a
  // death -> retry restart does NOT re-gate the player behind the tutorial.
  var howtoSeen = {};
  var howto = {
    // Full-freedom escape hatch — see hudRenderer's declaration for the
    // contract. Call this once (e.g. in create()) before your first
    // Chrome.howto.show() call. The renderer receives (container, d) where
    // `d` is the exact {title,controls,goal} object passed to show() — you
    // are responsible for communicating all of it, INCLUDING some hint that
    // the panel is dismissible (Enter/Space/click all still work no matter
    // what you render — chrome just no longer auto-adds the "Press ENTER"
    // text for you once a custom renderer is active).
    setRenderer: function (fn) {
      howtoRenderer = typeof fn === 'function' ? fn : null;
    },
    show: function (d, onStart) {
      mount();
      d = d || {};
      var key = d.title || '__howto__';
      // Already seen this session (e.g. after a restart): skip the gate, start now.
      if (howtoSeen[key]) {
        onStart && onStart();
        return;
      }
      howtoEl.innerHTML = '<div class="pg-panel"></div>';
      var panelEl = howtoEl.querySelector('.pg-panel');
      if (howtoRenderer) {
        try {
          howtoRenderer(panelEl, d);
        } catch (e) {
          console.error(
            '[Chrome.howto] custom renderer threw, falling back to the default how-to panel:',
            e,
          );
          panelEl.innerHTML = _defaultHowtoHTML(d);
        }
      } else {
        panelEl.innerHTML = _defaultHowtoHTML(d);
      }
      requestAnimationFrame(function () {
        howtoEl.classList.add('show');
      });
      var done = false;
      var go = function () {
        if (done) return;
        done = true;
        howtoSeen[key] = true;
        window.removeEventListener('keydown', onKey);
        howtoEl.removeEventListener('pointerdown', go);
        howtoEl.classList.remove('show');
        setTimeout(function () {
          howtoEl.innerHTML = '';
          onStart && onStart();
        }, 200);
      };
      // Dismiss on ENTER / SPACE / click or tap — do NOT trap mouse-driven players.
      var onKey = function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') go();
      };
      window.addEventListener('keydown', onKey);
      howtoEl.addEventListener('pointerdown', go);
    },
    hide: function () {
      if (howtoEl) {
        howtoEl.classList.remove('show');
        howtoEl.innerHTML = '';
      }
    },
  };

  // Gradient + "thickness" shadow for the win/lose button, derived from the
  // theme's good/danger tokens (was two hardcoded hex values that ignored theme()).
  function btnStyle(win) {
    var base = win ? 'var(--pg-good)' : 'var(--pg-danger)';
    return (
      'background:linear-gradient(180deg,color-mix(in srgb,' +
      base +
      ' 100%,white 18%),' +
      base +
      ');' +
      '--pg-btn-shade:color-mix(in srgb,' +
      base +
      ' 55%,black 40%)'
    );
  }

  // Default endcard content + its own button wiring — extracted so both the
  // default path and the custom-renderer fallback path (setRenderer, below)
  // can produce it identically.
  function _defaultEndcardHTML(d, accent) {
    return (
      '<div class="pg-end-title" style="color:' +
      accent +
      '">' +
      (d.title || (d.win ? 'LEVEL CLEAR' : 'GAME OVER')) +
      '</div>' +
      '<div class="pg-end-sub">' +
      (d.win ? 'well played' : 'try again') +
      '</div>' +
      '<div class="pg-end-score">SCORE ' +
      (d.score != null ? d.score : 0) +
      '</div>' +
      '<button class="pg-btn" style="' +
      btnStyle(d.win) +
      '">' +
      (d.win ? 'NEXT LEVEL' : 'RETRY') +
      '</button>'
    );
  }

  var endcard = {
    // Full-freedom escape hatch — see endcardRenderer's declaration above
    // for the contract (it gets a THIRD argument, `proceed`, unlike hud/
    // howto's renderers — you decide what triggers advancing, e.g. wire a
    // button's onclick to call it).
    setRenderer: function (fn) {
      endcardRenderer = typeof fn === 'function' ? fn : null;
    },
    show: function (d) {
      mount();
      d = d || {};
      var accent = d.win ? 'var(--pg-good)' : 'var(--pg-danger)';

      var done = false;
      var proceed = function () {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', onKey);
        endEl.classList.remove('show');
        endEl.innerHTML = '';
        d.onNext && d.onNext();
      };
      // Safety net unique to endcard: unlike hud/howto's renderers (pure
      // display, or a dismiss mechanism chrome keeps full control of), this
      // renderer is trusted to wire up its OWN trigger for a required
      // action. If it forgets to (a bug, not a thrown exception — nothing
      // to catch), the player must still be able to proceed, so Enter
      // always ALSO calls proceed(), independent of whatever the renderer
      // wired up itself.
      var onKey = function (e) {
        if (e.key === 'Enter') proceed();
      };
      window.addEventListener('keydown', onKey);

      endEl.innerHTML =
        '<div class="pg-panel" style="border-color:' + accent + '"></div>';
      var panelEl = endEl.querySelector('.pg-panel');
      var usedDefault = false;
      if (endcardRenderer) {
        try {
          endcardRenderer(panelEl, d, proceed);
        } catch (e) {
          console.error(
            '[Chrome.endcard] custom renderer threw, falling back to the default endcard:',
            e,
          );
          usedDefault = true;
        }
      } else {
        usedDefault = true;
      }
      if (usedDefault) {
        panelEl.innerHTML = _defaultEndcardHTML(d, accent);
        panelEl.querySelector('.pg-btn').onclick = proceed;
        if (d.win) fx.confetti(); // celebrate a win automatically — default look only;
        // a custom renderer decides its own celebration (or calls Chrome.fx.confetti()
        // itself if it wants this one).
      }

      requestAnimationFrame(function () {
        endEl.classList.add('show');
      });
    },
    hide: function () {
      if (endEl) {
        endEl.classList.remove('show');
        endEl.innerHTML = '';
      }
    },
  };

  // deterministic scatter (no Math.random — RL/replay safe): golden-angle spokes.
  var GOLDEN = 2.399963229728653;
  var fx = {
    flash: function () {
      mount();
      var f = el('<div class="pg-flash"></div>');
      fxEl.appendChild(f);
      setTimeout(function () {
        f.remove();
      }, 200);
    },
    shake: function () {
      mount();
      host.classList.add('pg-shake');
      setTimeout(function () {
        host.classList.remove('pg-shake');
      }, 240);
    },
    pop: function (x, y, text, color) {
      mount();
      if (fxEl.childElementCount > 48) return;
      var t = el('<div class="pg-float">' + text + '</div>');
      if (color) t.style.color = color;
      t.style.left = x + 'px';
      t.style.top = y + 'px';
      fxEl.appendChild(t);
      setTimeout(function () {
        t.remove();
      }, 820);
    },
    // Particle burst — the workhorse juice: N colored dots fly out radially + fade.
    // Call on impact/collect/kill. color defaults to the theme accent; count ~ punch.
    burst: function (x, y, color, count) {
      mount();
      if (fxEl.childElementCount > 120) return;
      var n = count || 12;
      var c = color || 'var(--pg-accent,#6ee7ff)';
      for (var i = 0; i < n; i++) {
        var ang = i * GOLDEN; // even, deterministic spread
        var dist = 34 + (i % 4) * 12; // a few speed rings
        var p = el('<div class="pg-particle"></div>');
        p.style.left = x + 'px';
        p.style.top = y + 'px';
        p.style.background = c;
        p.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
        p.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'px');
        p.style.setProperty(
          '--pg-life',
          (0.5 + (i % 3) * 0.12).toFixed(2) + 's',
        );
        fxEl.appendChild(p);
        (function (node) {
          setTimeout(function () {
            node.remove();
          }, 760);
        })(p);
      }
    },
    // Expanding shockwave ring — good for landings, explosions, big pickups.
    ring: function (x, y, color) {
      mount();
      var r = el('<div class="pg-ring"></div>');
      r.style.left = x + 'px';
      r.style.top = y + 'px';
      if (color) r.style.borderColor = color;
      fxEl.appendChild(r);
      setTimeout(function () {
        r.remove();
      }, 520);
    },
    // Celebration confetti (win / level clear). Falls across the top of the screen.
    confetti: function (count) {
      mount();
      var n = count || 40;
      var cols = [
        'var(--pg-gold,#ffe08a)',
        'var(--pg-good,#7cf29c)',
        'var(--pg-accent,#6ee7ff)',
        'var(--pg-danger,#ff6b6b)',
      ];
      var w = host.clientWidth || 960;
      for (var i = 0; i < n; i++) {
        var c = el('<div class="pg-confetto"></div>');
        c.style.left = ((i * 137) % 100) + '%';
        c.style.background = cols[i % cols.length];
        c.style.setProperty(
          '--fall',
          (w > 0 ? (host.clientHeight || 640) + 40 : 680) + 'px',
        );
        c.style.setProperty('--spin', ((i * 73) % 4) * 180 + 360 + 'deg');
        c.style.setProperty(
          '--pg-life',
          (1.3 + (i % 5) * 0.14).toFixed(2) + 's',
        );
        c.style.animationDelay = ((i % 8) * 0.06).toFixed(2) + 's';
        fxEl.appendChild(c);
        (function (node) {
          setTimeout(function () {
            node.remove();
          }, 2400);
        })(c);
      }
    },
  };

  /* Audio — chrome-owned. A curated SFX set ships in public/audio/*.ogg, so every
     game has sound with ZERO per-game audio work: game code calls Chrome.sfx('hit').
     Lazy-loaded, volume-capped, missing files fail silently (404 caught) so it's
     safe to call any event name. Events: hit / coin / pickup / jump / powerup /
     click / confirm / win / lose / error. bgm(url) optionally loops a track. */
  var _sfxPool = {},
    _sfxOn = true,
    _bgm = null;
  var sfx = function (name) {
    if (!_sfxOn || !name) return;
    var a = _sfxPool[name];
    if (!a) {
      a = new Audio('audio/' + name + '.ogg');
      a.preload = 'auto';
      a.volume = 0.55;
      _sfxPool[name] = a;
    }
    try {
      a.currentTime = 0;
      a.play().catch(function () {});
    } catch (e) {}
  };
  sfx.mute = function (m) {
    _sfxOn = !m;
    if (m && _bgm) {
      try {
        _bgm.pause();
      } catch (e) {}
    }
  };
  sfx.bgm = function (url, vol) {
    if (!url) return;
    if (!_bgm) {
      _bgm = new Audio(url);
      _bgm.loop = true;
    }
    _bgm.volume = vol == null ? 0.3 : vol;
    if (_sfxOn)
      try {
        _bgm.play().catch(function () {});
      } catch (e) {}
  };

  window.Chrome = {
    mount: mount,
    theme: theme,
    hud: hud,
    howto: howto,
    endcard: endcard,
    fx: fx,
    sfx: sfx,
  };
})();
