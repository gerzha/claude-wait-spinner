"""Render frames captured by tools/capture.mts into a GIF of the band above a Claude Code prompt.

    uv run --with pillow python tools/render_gif.py frames.json docs/<name>.gif [label]

Blocks, half blocks and braille are drawn as shapes; other glyphs with a monospace font
(macOS paths below; katakana from Hiragino).
"""
from __future__ import annotations

import base64
import json
import os
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CW, CH = 10, 20  # cell size, px
PAD = 18
BG = (24, 24, 27)
DEFAULT = 0x01000000
PROMPT_BORDER = (88, 88, 96)
PROMPT_TEXT = (140, 140, 150)
FRAME_MS = 60

TEXT_FONT = os.environ.get("TEXT_FONT", str(Path.home() / "Library/Fonts/JetBrainsMonoNerdFontMono-Regular.ttf"))
KANA_FONT = os.environ.get("KANA_FONT", "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc")


def rgb(color: int, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    if color == DEFAULT:
        return fallback
    return (color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF


def cells(b64: str, columns: int, rows: int):
    raw = base64.b64decode(b64)
    words = struct.unpack(f"<{columns * rows * 3}I", raw)
    return [words[i : i + 3] for i in range(0, len(words), 3)]


def draw_band(draw: ImageDraw.ImageDraw, frame, columns: int, rows: int, fonts) -> None:
    text_font, kana_font = fonts
    for idx, (cp, fg, bg) in enumerate(frame):
        cx, cy = idx % columns, idx // columns
        x0, y0 = PAD + cx * CW, PAD + cy * CH
        back = rgb(bg, BG)
        fore = rgb(fg, (220, 220, 220))
        if bg != DEFAULT:
            draw.rectangle([x0, y0, x0 + CW - 1, y0 + CH - 1], fill=back)
        if cp == 0x20:
            continue
        if cp == 0x2580:  # upper half block
            draw.rectangle([x0, y0, x0 + CW - 1, y0 + CH // 2 - 1], fill=fore)
        elif cp == 0x2584:  # lower half block
            draw.rectangle([x0, y0 + CH // 2, x0 + CW - 1, y0 + CH - 1], fill=fore)
        elif 0x2800 <= cp <= 0x28FF:  # braille: 2 x 4 dots
            bits = cp - 0x2800
            order = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08), (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]
            for col, row, bit in order:
                if bits & bit:
                    dx = x0 + (2.5 if col == 0 else 6.5)
                    dy = y0 + 2.5 + row * 5
                    draw.ellipse([dx - 1.6, dy - 1.6, dx + 1.6, dy + 1.6], fill=fore)
        else:
            ch = chr(cp)
            font = kana_font if 0xFF61 <= cp <= 0xFF9F else text_font
            draw.text((x0 + CW / 2, y0 + CH / 2), ch, font=font, fill=fore, anchor="mm")


def draw_prompt(draw: ImageDraw.ImageDraw, top: int, width: int, font, cursor_on: bool, label: str) -> None:
    draw.rounded_rectangle([PAD - 4, top, width - PAD + 4, top + 2 * CH + 4], radius=6, outline=PROMPT_BORDER, width=1)
    draw.text((PAD + 6, top + CH + 2), ">", font=font, fill=PROMPT_TEXT, anchor="lm")
    if cursor_on:
        draw.rectangle([PAD + 22, top + CH / 2 + 4, PAD + 22 + CW - 2, top + CH * 1.5], fill=(200, 200, 205))
    draw.text((width - PAD - 4, top + 2 * CH + 18), label, font=font, fill=(110, 110, 118), anchor="rm")


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    label = sys.argv[3] if len(sys.argv) > 3 else ""
    data = json.loads(src.read_text())
    columns, rows = data["columns"], data["rows"]
    text_font = ImageFont.truetype(TEXT_FONT, 15)
    kana_font = ImageFont.truetype(KANA_FONT, 15)
    width = PAD * 2 + columns * CW
    prompt_top = PAD + rows * CH + 14
    height = prompt_top + 2 * CH + 32

    images = []
    for n, b64 in enumerate(data["frames"]):
        img = Image.new("RGB", (width, height), BG)
        draw = ImageDraw.Draw(img)
        draw_band(draw, cells(b64, columns, rows), columns, rows, (text_font, kana_font))
        draw_prompt(draw, prompt_top, width, text_font, (n // 8) % 2 == 0, label)
        images.append(img)

    # One shared palette keeps colours steady from frame to frame.
    strip = Image.new("RGB", (width, height * 4))
    for k, i in enumerate(images[:: max(1, len(images) // 4)][:4]):
        strip.paste(i, (0, k * height))
    palette = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    frames = [i.quantize(palette=palette, dither=Image.Dither.NONE) for i in images]
    dst.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(dst, save_all=True, append_images=frames[1:], duration=FRAME_MS, loop=0, optimize=True, disposal=1)
    print(f"{dst}: {len(frames)} frames, {width}x{height}, {dst.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
