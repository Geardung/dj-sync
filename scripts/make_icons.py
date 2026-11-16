from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (18, 8, 16, 255))
d = ImageDraw.Draw(img)

# radial glows: orange top-left, violet bottom-right
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for r, a, cx, cy, col in [
    (320, 70, 150, 150, (255, 122, 24)),
    (300, 80, 380, 380, (124, 45, 146)),
]:
    for i in range(r, 0, -8):
        alpha = int(a * (i / r) ** 1.6)
        gd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(*col, alpha))
img = Image.alpha_composite(img, glow)
d = ImageDraw.Draw(img)

cx = cy = S // 2
# vinyl record
d.ellipse([cx - 190, cy - 190, cx + 190, cy + 190], fill=(28, 12, 34, 255), outline=(255, 154, 61, 220), width=8)
# grooves
for r in range(160, 60, -22):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(90, 50, 110, 130), width=3)
# label
d.ellipse([cx - 58, cy - 58, cx + 58, cy + 58], fill=(255, 122, 24, 255))
d.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=(18, 8, 16, 255))

# pulse arcs
for i, r in enumerate((230, 262, 294)):
    alpha = 150 - i * 40
    d.arc([cx - r, cy - r, cx + r, cy + r], start=35, end=145, fill=(255, 154, 61, alpha), width=7)

import os
out = os.path.join(os.path.dirname(__file__), "..", "packages", "web", "public")
os.makedirs(out, exist_ok=True)
img.save(os.path.join(out, "icon-512.png"))
img.resize((192, 192), Image.LANCZOS).save(os.path.join(out, "icon-192.png"))
print("ok", img.size)
