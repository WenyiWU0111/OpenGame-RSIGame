"""Build the flat asset search index used by generate-assets.ts library mode.

Walks the downloaded Kenney library and writes library_index.json: one entry per
image/audio file with ABSOLUTE path + tokenized filename/dir/pack-tags, which the
type-aware matcher scores against each requested asset's description.

Usage:
    python build_index.py        # lib=../assets/library  out=../assets/library_index.json
"""
from __future__ import annotations
import json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIB = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "assets" / "library"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE.parent / "assets" / "library_index.json"
CAT = HERE / "kenney_catalog.json"

JUNK = re.compile(r"preview|sample|spritesheet|sheet|thumb|license|readme|backdrop", re.I)
tags_by_slug = {p["slug"]: " ".join(p.get("tags", []) + [p.get("title", "")])
                for p in json.load(open(CAT))}


def toks(s: str):
    return sorted(set(t for t in re.split(r"[^a-z0-9]+", s.lower())
                      if len(t) > 1 and not t.isdigit()))


def main():
    out = []
    for f in LIB.rglob("*"):
        if f.suffix.lower() not in (".png", ".jpg", ".jpeg", ".wav", ".ogg", ".mp3"):
            continue
        rel = f.relative_to(LIB)
        if JUNK.search(str(rel)):
            continue
        parts = rel.parts
        slug = parts[1] if len(parts) > 1 else ""
        kind = "audio" if f.suffix.lower() in (".wav", ".ogg", ".mp3") else "image"
        out.append({"p": str(f.resolve()), "k": kind, "s": slug,
                    "fn": toks(f.stem),
                    "dir": toks(" ".join(parts[1:-1])),
                    "tg": toks(tags_by_slug.get(slug, ""))})
    json.dump(out, open(OUT, "w"))
    n_img = sum(1 for e in out if e["k"] == "image")
    print(f"wrote {len(out)} entries ({n_img} image, {len(out)-n_img} audio) -> {OUT}")
    print(f"set OPENGAME_ASSET_LIBRARY_INDEX={OUT}")


if __name__ == "__main__":
    main()
