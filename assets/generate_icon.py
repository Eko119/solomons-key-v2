#!/usr/bin/env python3
"""
Solomon's Key — icon generator.

Produces a 256x256 flat-minimalist gold skeleton key on black background.
Writes icon.ico (ICO with several Windows-friendly embedded sizes) next to
this file.

Usage:
    python3 assets/generate_icon.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "icon.ico"

SIZE = 256
BG = (0, 0, 0, 255)
GOLD = (212, 167, 58, 255)

CX = SIZE // 2
SHAFT_TOP = 72
SHAFT_BOTTOM = 206
SHAFT_W = 10

BOW_CENTER_Y = SHAFT_TOP - 8
BOW_OUTER_R = 42
BOW_INNER_R = 20

# Teeth on the lower shaft
TEETH = [
    (SHAFT_BOTTOM - 46, 22, 8),
    (SHAFT_BOTTOM - 30, 16, 6),
    (SHAFT_BOTTOM - 14, 26, 10),
]


def draw_key(img: Image.Image) -> None:
    d = ImageDraw.Draw(img)
    # Shaft
    d.rectangle(
        [CX - SHAFT_W // 2, SHAFT_TOP, CX + SHAFT_W // 2, SHAFT_BOTTOM],
        fill=GOLD,
    )
    # Bow — filled circle with a concentric hole
    d.ellipse(
        [CX - BOW_OUTER_R, BOW_CENTER_Y - BOW_OUTER_R,
         CX + BOW_OUTER_R, BOW_CENTER_Y + BOW_OUTER_R],
        fill=GOLD,
    )
    d.ellipse(
        [CX - BOW_INNER_R, BOW_CENTER_Y - BOW_INNER_R,
         CX + BOW_INNER_R, BOW_CENTER_Y + BOW_INNER_R],
        fill=BG,
    )
    # Teeth — rectangles jutting right from the shaft
    for y, width, height in TEETH:
        d.rectangle(
            [CX + SHAFT_W // 2, y, CX + SHAFT_W // 2 + width, y + height],
            fill=GOLD,
        )
    # Tip
    d.rectangle(
        [CX - SHAFT_W // 2 - 2, SHAFT_BOTTOM - 4,
         CX + SHAFT_W // 2 + 2, SHAFT_BOTTOM + 8],
        fill=GOLD,
    )


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), BG)
    draw_key(img)
    # Write multi-resolution ICO — Windows picks the right size.
    img.save(
        OUTPUT,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
