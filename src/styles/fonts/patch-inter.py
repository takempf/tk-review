# /// script
# dependencies = ["fonttools[woff]"]
# ///
"""
Builds this folder's Inter from an Inter release, keeping its tabular figures
(tnum) to the figures.

Inter's tnum also gives hyphens, spaces, brackets, punctuation and maths signs
a fixed width, for columns of figures; the hyphen grows by 40%. The app sets
tabular figures on everything (`body` in global.css), so `tk-review` and
`feature/diff-viewer` would read as `tk - review`. Geist's tnum, which the app
was set in before, touches only the figures, and so does this build's.

    uv run src/styles/fonts/patch-inter.py ~/Downloads/Inter-4.1

The argument is the unzipped release, with InterVariable.woff2 and
InterVariable-Italic.woff2 in its `web` folder.
"""

import sys
from pathlib import Path

from fontTools.ttLib import TTFont

FIGURES = {"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"}
FILES = ["InterVariable.woff2", "InterVariable-Italic.woff2"]


def figures_only(font: TTFont) -> None:
    gsub = font["GSUB"].table
    records = gsub.FeatureList.FeatureRecord
    tnum = {i for record in records if record.FeatureTag == "tnum" for i in record.Feature.LookupListIndex}
    others = {i for record in records if record.FeatureTag != "tnum" for i in record.Feature.LookupListIndex}
    # Inter 4.1's tnum has a lookup of its own; stop rather than edit one
    # another feature reads too.
    if not tnum or tnum & others or getattr(gsub, "FeatureVariations", None):
        sys.exit("tnum's lookups are not tnum's alone; check this release by hand")

    for index in tnum:
        for subtable in gsub.LookupList.Lookup[index].SubTable:
            subtable = getattr(subtable, "ExtSubTable", subtable)
            # Every figure's forms: `four`, `four.ss01`, `three.1` and so on.
            subtable.mapping = {
                glyph: tabular for glyph, tabular in subtable.mapping.items() if glyph.split(".")[0] in FIGURES
            }


def main() -> None:
    release = Path(sys.argv[1]).expanduser() / "web"
    here = Path(__file__).parent
    for name in FILES:
        font = TTFont(release / name)
        figures_only(font)
        font.flavor = "woff2"
        font.save(here / name)
        print(f"wrote {here / name}")


if __name__ == "__main__":
    main()
