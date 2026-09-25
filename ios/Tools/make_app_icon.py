#!/usr/bin/env python3
"""Generate the ParkAgent app icon from the design-system colors.

    uv run --with pillow ios/Tools/make_app_icon.py

Writes AppIcon.png (light/any), AppIcon-Dark.png, and AppIcon-Tinted.png
into ParkAgent/DesignSystem/Colors.xcassets/AppIcon.appiconset/. Xcode
derives every smaller size from the 1024s, so these three files are the
whole set.

The mark: a geometric coral "P" on ink — the same Ink and ActionCoral hex
values the app's color sets use, kept here as literals on purpose so this
script has no build dependency. Drawn with primitives rather than a font so
the result doesn't depend on what is installed.

Dark and tinted variants ship with a transparent background: iOS composites
them onto its own backdrop (and tinted gets desaturated), so baking in the
ink square would double the background.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
INK = (0x36, 0x45, 0x4F, 0xFF)
CORAL = (0xC2, 0x4A, 0x2E, 0xFF)
# Slightly lifted coral for the dark variant: the system backdrop is darker
# than our ink, and the mark needs to stay clear of it.
CORAL_DARK = (0xD8, 0x5C, 0x3E, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF, 0xFF)

OUT = (
    Path(__file__).resolve().parents[1]
    / "ParkAgent/DesignSystem/Colors.xcassets/AppIcon.appiconset"
)

# The P, in a 1024 box, optically centered (the glyph spans 202–822
# vertically, 300–740 horizontally). Chunky on purpose: a 106 px bowl ring
# and a 130 px stem still read at 40 px on a home screen.
STEM = (300, 202, 430, 822)          # left to right, top to bottom
BOWL_OUTER = (300, 202, 740, 554)    # the round of the P
BOWL_COUNTER = (430, 308, 610, 448)  # the hole inside it
STEM_RADIUS = 34


def draw_p(background, mark):
    """One 1024x1024 icon: `background` may be None for a transparent one."""
    image = Image.new("RGBA", (SIZE, SIZE), background or (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    # Bowl first, then punch its counter, then the stem over the seam.
    draw.ellipse(BOWL_OUTER, fill=mark)
    draw.ellipse(BOWL_COUNTER, fill=background or (0, 0, 0, 0))
    draw.rounded_rectangle(STEM, radius=STEM_RADIUS, fill=mark)
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # RGB, not RGBA: App Store Connect rejects an upload whose 1024 icon
    # carries an alpha channel, even a fully opaque one.
    draw_p(INK, CORAL).convert("RGB").save(OUT / "AppIcon.png")
    # Transparent ground; iOS supplies the dark backdrop.
    draw_p(None, CORAL_DARK).save(OUT / "AppIcon-Dark.png")
    # Tinted: iOS wants a grayscale mark it can recolor. White reads as full
    # intensity, so the P keeps its shape under any tint.
    draw_p(None, WHITE).save(OUT / "AppIcon-Tinted.png")

    for name in ("AppIcon.png", "AppIcon-Dark.png", "AppIcon-Tinted.png"):
        path = OUT / name
        print(f"{path.relative_to(OUT.parents[4])}  {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
