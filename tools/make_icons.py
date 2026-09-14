"""Generate extension icons (16/32/48/128 px PNG) with Pillow.

Run inside Docker:
  docker run --rm -v "$PWD":/work -w /work python:3.12-slim \
    sh -c "pip install -q pillow && python tools/make_icons.py"
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
SS = 1024  # supersampled canvas edge
OUT_DIR = Path(__file__).resolve().parent.parent / "icons"


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient_background(size: int, c0: tuple[int, int, int], c1: tuple[int, int, int]) -> Image.Image:
    """Diagonal gradient, clipped to a rounded square."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = (lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t), 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=size * 0.22, fill=255)
    img.putalpha(mask)
    return img


def draw_glyph(img: Image.Image) -> None:
    """Browser viewport on the left, three stacked tab cards (with thumbnails) on the right."""
    d = ImageDraw.Draw(img)
    s = img.size[0]
    pad = s * 0.16
    gap = s * 0.045
    inner_w = s - 2 * pad
    inner_h = s - 2 * pad
    view_w = inner_w * 0.56
    col_x = pad + view_w + gap
    col_w = s - pad - col_x
    r = s * 0.035

    # viewport
    d.rounded_rectangle((pad, pad, pad + view_w, pad + inner_h), radius=r, fill=(255, 255, 255, 235))
    # a faint "page" line inside the viewport
    d.rounded_rectangle((pad + view_w * 0.14, pad + inner_h * 0.14, pad + view_w * 0.86, pad + inner_h * 0.22),
                        radius=r * 0.6, fill=(99, 102, 241, 120))
    d.rounded_rectangle((pad + view_w * 0.14, pad + inner_h * 0.30, pad + view_w * 0.70, pad + inner_h * 0.36),
                        radius=r * 0.6, fill=(99, 102, 241, 80))

    # three tab cards on the right: title bar + thumbnail
    n = 3
    card_h = (inner_h - gap * (n - 1)) / n
    for i in range(n):
        y0 = pad + i * (card_h + gap)
        y1 = y0 + card_h
        active = i == 1
        alpha = 255 if active else 150
        d.rounded_rectangle((col_x, y0, col_x + col_w, y1), radius=r, fill=(255, 255, 255, alpha))
        # thumbnail band inside the card
        th_pad = col_w * 0.12
        d.rounded_rectangle((col_x + th_pad, y0 + card_h * 0.42, col_x + col_w - th_pad, y1 - th_pad),
                            radius=r * 0.6, fill=(79, 70, 229, 200 if active else 110))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    base = gradient_background(SS, (79, 70, 229), (124, 58, 237))  # indigo -> violet
    draw_glyph(base)
    for size in SIZES:
        out = base.resize((size, size), Image.LANCZOS)
        out.save(OUT_DIR / f"icon{size}.png", optimize=True)
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
