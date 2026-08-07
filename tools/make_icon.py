r"""Generate the application icon.

Kept as a script rather than a checked-in binary blob so the icon can be
re-tuned (colour, glyph, padding) by editing values instead of opening an
image editor.

Design: a rounded square in the Walnut palette carrying a white knight.

Windows renders the icon anywhere from 16px in the title bar to 256px in
large-icon view. Small sizes drop *effects* that turn to mud — the blurred
shadow, the hairline rim — but never change the colours: an icon that is a
white knight in the taskbar and an amber one in the title bar looks like two
different programs, which is exactly what it looked like before.

Run:  .venv\Scripts\python.exe tools\make_icon.py
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets"
ICO_PATH = OUT_DIR / "icon.ico"
PREVIEW_PATH = OUT_DIR / "icon-preview.png"

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\seguisym.ttf",
    r"C:\Windows\Fonts\SEGUISYM.TTF",
    r"C:\Windows\Fonts\DejaVuSans.ttf",
]

KNIGHT = "\u265e"  # ♞ black knight — a filled glyph, so it silhouettes cleanly

# Walnut palette, matching the app's default theme. The tile is lighter than
# the theme's own background on purpose: against a near-black taskbar a very
# dark tile disappears and only the knight reads, which makes the icon look
# smaller than its neighbours even though it fills the same box.
BG_TOP = (92, 68, 38)
BG_BOTTOM = (48, 35, 21)
ACCENT = (224, 163, 67)
KNIGHT_LIGHT = (250, 240, 220)

# How much of the tile the knight spans. Generous, because the icon sits next
# to neighbours whose logos are full-bleed and looked bigger for it. Past ~1.05
# the ears start to clip the rounded top edge, so this is the practical limit.
KNIGHT_SCALE = 0.96

SIZES = [16, 24, 32, 48, 64, 128, 256]

# Supersampling factor: draw big, downscale with a good filter, get clean edges.
SS = 8


def _font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                continue
    raise RuntimeError("No font with chess glyphs found")


def _vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return grad.resize((size, size), Image.NEAREST)


def _rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    return mask


def _draw_glyph(img: Image.Image, glyph: str, colour: tuple, scale: float,
                shift_y: float = 0.0) -> None:
    """Centre a glyph on the image using its true ink bounds, not its metrics.

    Font metrics include ascender/descender padding that differs per glyph, so
    centring by metrics leaves the knight visibly off-centre. Measuring the
    actual drawn pixels avoids that.
    """
    size = img.size[0]
    font = _font(int(size * scale))
    d = ImageDraw.Draw(img)
    left, top, right, bottom = d.textbbox((0, 0), glyph, font=font)
    w, h = right - left, bottom - top
    x = (size - w) / 2 - left
    y = (size - h) / 2 - top + size * shift_y
    d.text((x, y), glyph, font=font, fill=colour)


def _warm_glow(img: Image.Image) -> None:
    """A soft amber pool behind the knight, so the tile has depth without noise.

    An earlier version used a visible checkerboard here. At icon sizes it read
    as blotches competing with the knight rather than as a board, so the motif
    is gone and the warmth is carried by light instead.
    """
    size = img.size[0]
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    steps = 26
    for i in range(steps, 0, -1):
        t = i / steps
        r = size * 0.60 * t
        cx, cy = size * 0.5, size * 0.46
        d.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            fill=ACCENT + (int(11 * (1 - t) ** 1.5),),
        )
    img.alpha_composite(glow)


def render(size: int) -> Image.Image:
    """Render one icon size.

    Every size is the same design in the same colours. Small sizes only drop
    effects whose detail cannot survive the pixel count.
    """
    big = size * SS
    # Only 16px is too coarse for the rim and glow. 24px keeps them, so the
    # taskbar and title-bar icons look like the same artwork.
    small = size <= 16

    base = _vertical_gradient(big, BG_TOP, BG_BOTTOM).convert("RGBA")

    if not small:
        _warm_glow(base)

        # A restrained rim: enough to separate the tile from a dark taskbar,
        # not so much that it reads as a gold frame.
        d = ImageDraw.Draw(base)
        inset = big * 0.035
        d.rounded_rectangle(
            [inset, inset, big - inset, big - inset],
            radius=int(big * 0.20),
            outline=ACCENT + (38,),
            width=max(1, int(big * 0.007)),
        )

        # Drop shadow under the knight, for separation from the background.
        shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        _draw_glyph(shadow, KNIGHT, (0, 0, 0, 105), scale=KNIGHT_SCALE, shift_y=0.03)
        shadow = shadow.filter(ImageFilter.GaussianBlur(big * 0.018))
        base.alpha_composite(shadow)

    _draw_glyph(base, KNIGHT, KNIGHT_LIGHT, scale=KNIGHT_SCALE, shift_y=0.0)

    # Squarer than a phone-style app icon on purpose: at 32px a heavily rounded
    # tile reads noticeably smaller than the square and full-bleed logos it sits
    # beside in the taskbar, even at identical pixel dimensions.
    mask = _rounded_mask(big, 0.18)
    base.putalpha(mask)

    return base.resize((size, size), Image.LANCZOS)


def _dib_bytes(img: Image.Image) -> bytes:
    """Encode one icon image as a classic BMP/DIB entry.

    Windows Explorer only reliably decodes PNG-compressed icon entries at
    256x256; at smaller sizes it expects a DIB. Pillow's ICO writer produced
    PNG for every size, which is why Explorer fell back to a generic icon while
    the taskbar (which reads the entry differently) showed the right one.
    """
    w, h = img.size
    rgba = img.convert("RGBA")

    # biHeight is doubled: the XOR (colour) bitmap plus the AND (mask) bitmap.
    header = struct.pack(
        "<IiiHHIIiiII",
        40,      # biSize
        w,       # biWidth
        h * 2,   # biHeight
        1,       # biPlanes
        32,      # biBitCount
        0,       # biCompression = BI_RGB
        0,       # biSizeImage
        0, 0,    # pixels-per-metre
        0, 0,    # palette counts
    )

    # DIB rows are bottom-up and BGRA.
    px = rgba.load()
    rows = []
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    xor = b"".join(rows)

    # The AND mask is unused for 32-bit icons (alpha carries transparency) but
    # must still be present and padded to 4-byte rows.
    mask_stride = ((w + 31) // 32) * 4
    and_mask = b"\x00" * (mask_stride * h)

    return header + xor + and_mask


def _write_ico(images: list[Image.Image], path: Path) -> None:
    """Write a multi-size .ico: DIB below 256, PNG at 256."""
    blobs = []
    for img in images:
        if img.size[0] >= 256:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            blobs.append(buf.getvalue())
        else:
            blobs.append(_dib_bytes(img))

    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for img, blob in zip(images, blobs):
        w, h = img.size
        out += struct.pack(
            "<BBBBHHII",
            0 if w >= 256 else w,   # 0 means 256
            0 if h >= 256 else h,
            0,   # palette entries
            0,   # reserved
            1,   # colour planes
            32,  # bits per pixel
            len(blob),
            offset,
        )
        offset += len(blob)
    for blob in blobs:
        out += blob

    path.write_bytes(bytes(out))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    images = [render(s) for s in SIZES]

    _write_ico(images, ICO_PATH)
    print(f"wrote {ICO_PATH} ({ICO_PATH.stat().st_size} bytes)")

    # Contact sheet on both light and dark backgrounds, for eyeballing.
    pad, gap = 16, 14
    row_w = sum(s for s in SIZES) + gap * (len(SIZES) - 1) + pad * 2
    row_h = max(SIZES) + pad * 2
    sheet = Image.new("RGBA", (row_w, row_h * 2), (255, 255, 255, 255))
    ImageDraw.Draw(sheet).rectangle([0, row_h, row_w, row_h * 2], fill=(24, 24, 28, 255))

    for band, top in enumerate((0, row_h)):
        x = pad
        for img, s in zip(images, SIZES):
            sheet.alpha_composite(img, (x, top + pad + (max(SIZES) - s) // 2))
            x += s + gap
    sheet.save(PREVIEW_PATH)
    print(f"wrote {PREVIEW_PATH}")


if __name__ == "__main__":
    main()
