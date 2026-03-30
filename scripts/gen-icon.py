#!/usr/bin/env python3
"""Generate Loupe app icon — magnifying glass on Cool Slate background."""

from PIL import Image, ImageDraw, ImageFont
import math, os

SIZE = 1024
PAD = int(SIZE * 0.1)  # macOS icon inset

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Background: rounded rectangle in Cool Slate dark
bg_color = (15, 23, 42)  # #0f172a
radius = int(SIZE * 0.22)  # macOS Big Sur style radius
draw.rounded_rectangle(
    [PAD, PAD, SIZE - PAD, SIZE - PAD],
    radius=radius,
    fill=bg_color,
)

# Subtle inner border
border_color = (30, 41, 59)  # #1e293b (surface)
draw.rounded_rectangle(
    [PAD, PAD, SIZE - PAD, SIZE - PAD],
    radius=radius,
    outline=border_color,
    width=3,
)

# Magnifying glass
cx, cy = SIZE // 2, SIZE // 2 - 20  # Center, shifted up slightly
lens_r = int(SIZE * 0.2)  # Lens radius
handle_len = int(SIZE * 0.18)

# Lens ring (purple accent)
accent = (139, 92, 246)  # #8b5cf6
accent_glow = (139, 92, 246, 60)
ring_width = int(SIZE * 0.035)

# Glow behind lens
for i in range(20, 0, -1):
    alpha = int(15 * (20 - i) / 20)
    glow_col = (139, 92, 246, alpha)
    glow_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    glow_draw.ellipse(
        [cx - lens_r - i, cy - lens_r - i, cx + lens_r + i, cy + lens_r + i],
        fill=glow_col,
    )
    img = Image.alpha_composite(img, glow_img)
    draw = ImageDraw.Draw(img)

# Lens fill (slightly lighter slate)
lens_fill = (30, 41, 59)  # #1e293b
draw.ellipse(
    [cx - lens_r, cy - lens_r, cx + lens_r, cy + lens_r],
    fill=lens_fill,
)

# Lens ring
draw.ellipse(
    [cx - lens_r, cy - lens_r, cx + lens_r, cy + lens_r],
    outline=accent,
    width=ring_width,
)

# Lens reflection (subtle arc highlight)
highlight = (148, 163, 184, 40)  # slate-400 with low alpha
highlight_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
highlight_draw = ImageDraw.Draw(highlight_img)
ref_r = int(lens_r * 0.75)
highlight_draw.arc(
    [cx - ref_r, cy - ref_r - 10, cx + ref_r, cy + ref_r - 10],
    start=200, end=340,
    fill=(200, 210, 230, 50),
    width=int(SIZE * 0.015),
)
img = Image.alpha_composite(img, highlight_img)
draw = ImageDraw.Draw(img)

# Handle (bottom-right diagonal)
angle = math.radians(45)
hx1 = cx + int(lens_r * math.cos(angle)) - 5
hy1 = cy + int(lens_r * math.sin(angle)) - 5
hx2 = hx1 + int(handle_len * math.cos(angle))
hy2 = hy1 + int(handle_len * math.sin(angle))

handle_width = int(SIZE * 0.045)
# Handle shadow
draw.line(
    [(hx1 + 4, hy1 + 4), (hx2 + 4, hy2 + 4)],
    fill=(0, 0, 0, 80),
    width=handle_width + 4,
)
# Handle body (slate-400)
handle_color = (148, 163, 184)  # #94a3b8
draw.line(
    [(hx1, hy1), (hx2, hy2)],
    fill=handle_color,
    width=handle_width,
)
# Handle cap
cap_r = int(handle_width * 0.6)
draw.ellipse(
    [hx2 - cap_r, hy2 - cap_r, hx2 + cap_r, hy2 + cap_r],
    fill=handle_color,
)

# "loupe_" text inside the lens
try:
    font = ImageFont.truetype("/System/Library/Fonts/SFMono-Bold.otf", int(SIZE * 0.055))
except:
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", int(SIZE * 0.055))
    except:
        font = ImageFont.load_default()

text = "loupe"
text_color = (148, 163, 184)  # slate-400
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
draw.text(
    (cx - tw // 2, cy - th // 2),
    text,
    fill=text_color,
    font=font,
)

# Cursor underscore in accent
cursor = "_"
cursor_bbox = draw.textbbox((0, 0), cursor, font=font)
cw = cursor_bbox[2] - cursor_bbox[0]
draw.text(
    (cx + tw // 2, cy - th // 2),
    cursor,
    fill=accent,
    font=font,
)

# Save full-size
out_dir = os.path.dirname(os.path.abspath(__file__))
project_dir = os.path.dirname(out_dir)
icon_path = os.path.join(project_dir, "native", "icon_1024.png")
img.save(icon_path, "PNG")
print(f"Saved: {icon_path}")

# Generate .iconset
iconset_dir = os.path.join(project_dir, "native", "Loupe.iconset")
os.makedirs(iconset_dir, exist_ok=True)

sizes = [16, 32, 64, 128, 256, 512, 1024]
for s in sizes:
    resized = img.resize((s, s), Image.LANCZOS)
    resized.save(os.path.join(iconset_dir, f"icon_{s}x{s}.png"))
    if s <= 512:
        resized2x = img.resize((s * 2, s * 2), Image.LANCZOS)
        resized2x.save(os.path.join(iconset_dir, f"icon_{s}x{s}@2x.png"))

print(f"Iconset: {iconset_dir}")
