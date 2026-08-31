"""Rasterise the archive plugin logo.

No SVG rasteriser is installed, so the glyph is drawn straight from the Material
Design Icons "archive" geometry with PIL primitives. Rendered at 4x and
downsampled, which is what gives the curves and the black keyline clean edges.
"""

from PIL import Image, ImageDraw

SS = 4                      # supersampling factor
CANVAS = 512
BG = "#D97757"              # same clay as the display plugin
WHITE = "#FFFFFF"
BLACK = "#000000"

# Matches the display plugin: a 24-unit icon grid scaled by 12.9932, placed so
# unit (12,12) is the canvas centre.
SCALE = 12.9932
OFFSET = CANVAS / 2 - 12 * SCALE
STROKE_UNITS = 0.7


def u(value: float) -> float:
    """Icon-grid units to supersampled pixels."""
    return (OFFSET + value * SCALE) * SS


size = CANVAS * SS
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# Rounded-square plate, inset 16 of 512 with a 112 corner radius.
draw.rounded_rectangle(
    [16 * SS, 16 * SS, (CANVAS - 16) * SS - 1, (CANVAS - 16) * SS - 1],
    radius=112 * SS,
    fill=BG,
)

stroke = round(STROKE_UNITS * SCALE * SS)

# Lid: a detached bar above the body.
draw.rectangle([u(3), u(3), u(21), u(7)], fill=WHITE, outline=BLACK, width=stroke)

# Body of the box.
draw.rectangle([u(4), u(8), u(20), u(21)], fill=WHITE, outline=BLACK, width=stroke)

# Handle slot. In the source path this subpath runs counter-clockwise, so it is a
# hole rather than a shape: it is filled with the plate colour, not with white.
draw.rounded_rectangle(
    [u(9), u(11), u(15), u(13)],
    radius=u(0.5) - u(0),
    fill=BG,
    outline=BLACK,
    width=stroke,
    corners=(True, True, False, False),
)

full = image.resize((CANVAS, CANVAS), Image.LANCZOS)
full.save("assets/logo.png")

# Google's consent screen wants 120x120.
full.resize((120, 120), Image.LANCZOS).save("assets/logo-120.png")

print("wrote assets/logo.png (512) and assets/logo-120.png (120)")
