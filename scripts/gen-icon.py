#!/usr/bin/env python3
"""Generate Loupe app icon — 'Loupe_' rendered in ASCII art style.

The text 'Loupe_' drawn using small ASCII characters as pixels,
on a light background. Monospaced, dev-tool aesthetic.
"""

from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
PAD = int(SIZE * 0.1)

# --- Palette ---
bg = (250, 249, 247)
ink = (35, 30, 58)          # deep indigo
accent = (175, 75, 95)      # dusty rose for the underscore
border = (232, 230, 226)
mid = (120, 115, 140)       # for shadow/secondary

# ASCII art letters — each char is 5 wide x 7 tall grid
# Using block characters to build up each letter
LETTERS = {
    'L': [
        "█    ",
        "█    ",
        "█    ",
        "█    ",
        "█    ",
        "█    ",
        "█████",
    ],
    'o': [
        "     ",
        "     ",
        " ███ ",
        "█   █",
        "█   █",
        "█   █",
        " ███ ",
    ],
    'u': [
        "     ",
        "     ",
        "█   █",
        "█   █",
        "█   █",
        "█   █",
        " ████",
    ],
    'p': [
        "     ",
        "     ",
        "████ ",
        "█   █",
        "█   █",
        "████ ",
        "█    ",
    ],
    'e': [
        "     ",
        "     ",
        " ███ ",
        "█   █",
        "█████",
        "█    ",
        " ███ ",
    ],
    '_': [
        "     ",
        "     ",
        "     ",
        "     ",
        "     ",
        "     ",
        "█████",
    ],
}

def render_ascii_text(text, cell_size, ink_color, accent_char='_'):
    """Render text using ASCII art letter definitions."""
    # Calculate total dimensions
    char_w = 5  # grid cells per character
    char_h = 7
    spacing = 1  # cells between characters
    total_cells_w = len(text) * (char_w + spacing) - spacing
    total_cells_h = char_h

    img_w = total_cells_w * cell_size
    img_h = total_cells_h * cell_size

    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    x_offset = 0
    for ch in text:
        grid = LETTERS.get(ch, LETTERS['_'])
        color = accent if ch == accent_char else ink_color
        for row_idx, row in enumerate(grid):
            for col_idx, pixel in enumerate(row):
                if pixel == '█':
                    x = (x_offset + col_idx) * cell_size
                    y = row_idx * cell_size
                    # Rounded mini-blocks
                    margin = max(1, cell_size // 8)
                    draw.rounded_rectangle(
                        [x + margin, y + margin,
                         x + cell_size - margin, y + cell_size - margin],
                        radius=max(1, cell_size // 6),
                        fill=(*color, 255),
                    )
        x_offset += char_w + spacing

    return img


img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# --- Background squircle ---
radius = int(SIZE * 0.22)
draw.rounded_rectangle(
    [PAD, PAD, SIZE - PAD, SIZE - PAD],
    radius=radius,
    fill=bg,
)
draw.rounded_rectangle(
    [PAD, PAD, SIZE - PAD, SIZE - PAD],
    radius=radius,
    outline=border,
    width=2,
)

# --- Render "Loupe_" ---
cell = 18
text_img = render_ascii_text("Loupe_", cell, ink, accent_char='_')

# Center it
tx = (SIZE - text_img.width) // 2
ty = (SIZE - text_img.height) // 2
img.paste(text_img, (tx, ty), text_img)

# ==========================================================================
# Save outputs
# ==========================================================================

out_dir = os.path.dirname(os.path.abspath(__file__))
project_dir = os.path.dirname(out_dir)

icon_path = os.path.join(project_dir, "native", "icon_1024.png")
img.save(icon_path, "PNG")
print(f"Saved: {icon_path}")

iconset_dir = os.path.join(project_dir, "native", "Loupe.iconset")
os.makedirs(iconset_dir, exist_ok=True)
for s in [16, 32, 64, 128, 256, 512, 1024]:
    img.resize((s, s), Image.LANCZOS).save(os.path.join(iconset_dir, f"icon_{s}x{s}.png"))
    if s <= 512:
        img.resize((s*2, s*2), Image.LANCZOS).save(os.path.join(iconset_dir, f"icon_{s}x{s}@2x.png"))
print(f"Iconset: {iconset_dir}")

images_dir = os.path.join(project_dir, "docs", "images")
os.makedirs(images_dir, exist_ok=True)
img.resize((16, 16), Image.LANCZOS).save(os.path.join(images_dir, "favicon.png"))
img.resize((128, 128), Image.LANCZOS).save(os.path.join(images_dir, "logo.png"))
print(f"Favicon + Logo: {images_dir}")

# Social preview
preview_bg = (22, 18, 35)
preview = Image.new("RGBA", (1280, 640), (*preview_bg, 255))
pi = img.resize((300, 300), Image.LANCZOS)
ix, iy = (1280 - 300) // 2, (640 - 300) // 2 - 40
preview.paste(pi, (ix, iy), pi)
pd = ImageDraw.Draw(preview)
try: tf = ImageFont.truetype("/System/Library/Fonts/SFMono-Regular.otf", 22)
except:
    try: tf = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 22)
    except: tf = ImageFont.load_default()

tag = "Real-time log viewer for Claude Code sessions"
bb = pd.textbbox((0, 0), tag, font=tf)
pd.text(((1280 - bb[2] + bb[0]) // 2, iy + 320), tag, fill=(130, 125, 140, 255), font=tf)
preview.save(os.path.join(images_dir, "social-preview.png"))
print(f"Social preview: {os.path.join(images_dir, 'social-preview.png')}")
