#!/usr/bin/env python3
"""Generate the canonical GoodBase browser and install icons."""

from pathlib import Path

from PIL import Image, ImageDraw


PUBLIC_DIR = Path(__file__).resolve().parents[1] / "src" / "public"
ICON_DIR = PUBLIC_DIR / "icons"
SOURCE_SIZE = 1024
RESAMPLE = Image.Resampling.LANCZOS


def render_icon(*, opaque: bool) -> Image.Image:
    background = (247, 249, 255, 255) if opaque else (0, 0, 0, 0)
    image = Image.new("RGBA", (SOURCE_SIZE, SOURCE_SIZE), background)
    draw = ImageDraw.Draw(image)

    if not opaque:
        draw.rounded_rectangle(
            (32, 32, 992, 992),
            radius=240,
            fill=(247, 249, 255, 255),
            outline=(199, 205, 232, 255),
            width=24,
        )

    ink = (11, 18, 32, 255)
    stroke = 56
    cylinder_left = 260
    cylinder_right = 764
    top_center = 295

    draw.ellipse(
        (cylinder_left, 195, cylinder_right, 395),
        outline=ink,
        width=stroke,
    )
    draw.line(
        (cylinder_left, top_center, cylinder_left, 710),
        fill=ink,
        width=stroke,
    )
    draw.line(
        (cylinder_right, top_center, cylinder_right, 710),
        fill=ink,
        width=stroke,
    )
    for bounds in (
        (cylinder_left, 315, cylinder_right, 515),
        (cylinder_left, 460, cylinder_right, 660),
        (cylinder_left, 610, cylinder_right, 810),
    ):
        draw.arc(bounds, start=0, end=180, fill=ink, width=stroke)

    return image


def save_png(source: Image.Image, filename: Path, size: int) -> None:
    source.resize((size, size), RESAMPLE).save(
        filename,
        format="PNG",
        optimize=True,
    )


def main() -> None:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    transparent = render_icon(opaque=False)
    install_icon = render_icon(opaque=True)

    save_png(transparent, PUBLIC_DIR / "favicon-16x16.png", 16)
    save_png(transparent, PUBLIC_DIR / "favicon-32x32.png", 32)
    save_png(install_icon, PUBLIC_DIR / "apple-touch-icon.png", 180)
    save_png(install_icon, ICON_DIR / "goodbase-192.png", 192)
    save_png(install_icon, ICON_DIR / "goodbase-512.png", 512)

    transparent.save(
        PUBLIC_DIR / "favicon.ico",
        format="ICO",
        sizes=((16, 16), (32, 32), (48, 48), (64, 64)),
    )


if __name__ == "__main__":
    main()
