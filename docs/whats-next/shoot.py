"""Take a README screenshot of What's Next from a Terminal window.

Captures one Terminal window with macOS `screencapture`, cuts off the title
bar and the scroll bar, and saves it under docs/whats-next/images/.
With --pane it keeps the docked pane alone: the part right of the line that
divides it from the transcript, down to where that line ends.

Setup, once, from the repo root:

    python3 -m venv docs/whats-next/.venv
    docs/whats-next/.venv/bin/pip install Pillow

Use:

    docs/whats-next/.venv/bin/python docs/whats-next/shoot.py whats-next
    docs/whats-next/.venv/bin/python docs/whats-next/shoot.py epics --pane

The window is the one Terminal window of 120 columns by 40 rows, unless
--window names its id (`osascript -e 'tell application "Terminal" to get
id of every window'`).
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

IMAGES = Path(__file__).resolve().parent / "images"
COLUMNS, ROWS = 120, 40


def find_window() -> int:
    script = """
    tell application "Terminal"
      set out to {}
      repeat with w in windows
        set t to selected tab of w
        set end of out to {id of w, number of columns of t, number of rows of t}
      end repeat
      return out
    end tell
    """
    raw = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=True).stdout
    nums = [int(n) for n in raw.replace(",", " ").split()]
    found = [nums[i] for i in range(0, len(nums), 3) if nums[i + 1] == COLUMNS and nums[i + 2] == ROWS]
    if len(found) != 1:
        sys.exit(f"want one Terminal window of {COLUMNS}x{ROWS}, found {len(found)}: pass --window")
    return found[0]


def capture(window: int) -> Image.Image:
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "shot.png"
        subprocess.run(["screencapture", "-x", "-o", "-l", str(window), str(path)], check=True)
        return Image.open(path).copy()


def flatten(raw: Image.Image) -> Image.Image:
    # The window's rounded corners are transparent: fill them with the
    # terminal's background, not black.
    rgba = raw.convert("RGBA")
    solid = [(n, p) for n, p in rgba.getcolors(maxcolors=1 << 24) if p[3] == 255]
    under = Image.new("RGBA", rgba.size, max(solid)[1])
    return Image.alpha_composite(under, rgba).convert("RGB")


def light(p: tuple[int, int, int]) -> int:
    return sum(p) // 3


def background(img: Image.Image) -> int:
    # The colour most pixels have: the terminal's background.
    counts = img.getcolors(maxcolors=1 << 24)
    return light(max(counts)[1])


def content_top(img: Image.Image, bg: int) -> int:
    # The title bar ends in a one-pixel line lighter than both it and the
    # background: the content starts below it.
    w, h = img.size
    for y in range(1, h // 6):
        row = [light(img.getpixel((x, y))) for x in range(0, w, 4)]
        if sum(v > bg + 10 for v in row) > 0.9 * len(row):
            return y + 1
    sys.exit("no title bar found")


def content_right(img: Image.Image, top: int, bg: int) -> int:
    # The scroll bar's track is not the background: the content ends at the
    # rightmost column that is mostly background.
    w, h = img.size
    ys = range(top + 20, h - 20, 8)
    for x in range(w - 1, w // 2, -1):
        if sum(abs(light(img.getpixel((x, y))) - bg) <= 2 for y in ys) > 0.8 * len(ys):
            return x + 1
    sys.exit("no right edge found")


def pane_line(img: Image.Image, top: int, right: int, bg: int) -> tuple[int, int]:
    # The line between transcript and pane: a column lit along most of the
    # height, in the right part of the window. Returns its x and its last y.
    w, h = img.size
    ys = range(top + 10, h - 10, 6)
    best, score = None, 0
    for x in range(w // 3, right):
        lit = sum(light(img.getpixel((x, y))) > bg + 40 for y in ys)
        if lit > score:
            best, score = x, lit
    if best is None or score < 0.5 * len(ys):
        sys.exit("no pane found: is the pane docked?")
    bottom = top
    for y in range(top + 10, h):
        if light(img.getpixel((best, y))) > bg + 40:
            bottom = y
        elif y - bottom > 6:
            break
    return best, bottom


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("name", help="file name in docs/whats-next/images, without .png")
    ap.add_argument("--pane", action="store_true", help="keep the docked pane alone")
    ap.add_argument("--window", type=int, help="the Terminal window id")
    ap.add_argument("--source", type=Path, help="crop this capture instead of taking one")
    a = ap.parse_args()

    raw = Image.open(a.source) if a.source else capture(a.window or find_window())
    img = flatten(raw)
    bg = background(img)
    top = content_top(img, bg)
    right = content_right(img, top, bg)
    if a.pane:
        x, bottom = pane_line(img, top, right, bg)
        box = (x + 4, top, right, bottom + 8)
    else:
        box = (0, top, right, img.size[1])
    out = img.crop(box)
    IMAGES.mkdir(exist_ok=True)
    path = IMAGES / f"{a.name}.png"
    out.save(path, optimize=True)
    print(json.dumps({"file": str(path.relative_to(IMAGES.parent.parent.parent)), "size": out.size, "box": box}))


if __name__ == "__main__":
    main()
