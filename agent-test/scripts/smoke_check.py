"""
smoke_check.py — headless RUNTIME verification for one generated game.

`npm run build` passing only proves the TypeScript compiled; it does NOT prove the
game actually boots (e.g. Phaser throws "Cannot add Scene with duplicate key" at
runtime -> black screen). This boots the built dist in headless Chromium and checks:
  - the page raised NO uncaught error on boot (the #1 black-screen cause),
  - window.__rlenv installed,
  - a gameplay scene becomes reachable (ready()) after starting.
Resource 404s (a missing sprite/font) are warnings, not failures.

Output: a single JSON line on stdout so the batch runner can parse it:
  {"ok": bool, "built": bool, "rlenv": bool, "ready": bool, "error": str|null,
   "warnings": [..]}

Usage:
  python smoke_check.py --game-dir <dir> [--port 5273] [--build] [--timeout-ms 20000]
Exit code 0 if ok, 1 if smoke failed (so it can gate a shell step too).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def ensure_build(game_dir: Path, do_build: bool) -> tuple[bool, str | None]:
    dist = game_dir / "dist"
    if dist.exists() and (dist / "index.html").exists() and not do_build:
        return True, None
    # try to build
    try:
        r = subprocess.run(["npm", "run", "build"], cwd=str(game_dir),
                           capture_output=True, text=True, timeout=300)
    except Exception as e:
        return False, f"build spawn failed: {e}"
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "")[-500:]
        return False, f"npm run build failed: {tail}"
    return (dist / "index.html").exists(), (None if (dist / "index.html").exists()
                                            else "build produced no dist/index.html")


def smoke(url: str, timeout_ms: int) -> dict:
    errs: list[str] = []
    warns: list[str] = []
    rlenv = ready = False
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 1280, "height": 720})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: warns.append(m.text)
              if m.type in ("error", "warning") else None)
        try:
            pg.goto(url, wait_until="load", timeout=timeout_ms)
            pg.wait_for_function("() => !!window.__rlenv", timeout=timeout_ms)
            rlenv = True
            pg.evaluate("() => window.__rlenv.seed(0)")
            # advance past title -> gameplay: click + Enter/Space a few times
            pg.mouse.click(640, 360)
            for _ in range(12):
                try:
                    if pg.evaluate("() => window.__rlenv.ready()"):
                        ready = True
                        break
                except Exception:
                    pass
                pg.keyboard.press("Enter")
                pg.wait_for_timeout(250)
                pg.keyboard.press("Space")
                pg.wait_for_timeout(150)
            if not ready:
                try:
                    ready = bool(pg.evaluate("() => window.__rlenv.ready()"))
                except Exception:
                    pass
            pg.wait_for_timeout(400)  # let any deferred boot error surface
        except Exception as e:
            errs.append(f"boot: {type(e).__name__}: {e}")
        finally:
            b.close()
    # a resource 404 shows up as a console error but not a pageerror; keep it a warning
    resource_warns = [w for w in warns if "404" in w or "Failed to load" in w
                      or "net::ERR" in w]
    fatal = errs  # uncaught page errors are fatal
    ok = (not fatal) and rlenv and ready
    return {
        "ok": ok, "rlenv": rlenv, "ready": ready,
        "error": ("; ".join(fatal)[:400] if fatal
                  else (None if ok else
                        ("__rlenv not installed" if not rlenv
                         else "no gameplay scene became active (ready() never true)"))),
        "warnings": resource_warns[:5],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-dir", required=True, type=Path)
    ap.add_argument("--port", type=int, default=5273)
    ap.add_argument("--build", action="store_true", help="force npm run build first")
    ap.add_argument("--timeout-ms", type=int, default=20000)
    args = ap.parse_args()

    built, berr = ensure_build(args.game_dir, args.build)
    if not built:
        print(json.dumps({"ok": False, "built": False, "rlenv": False,
                          "ready": False, "error": berr, "warnings": []}))
        sys.exit(1)

    dist = args.game_dir / "dist"
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(args.port), "--bind", "127.0.0.1"],
        cwd=str(dist), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        res = smoke(f"http://127.0.0.1:{args.port}/", args.timeout_ms)
    finally:
        srv.terminate()

    res["built"] = True
    print(json.dumps(res))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()
