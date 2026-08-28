#!/usr/bin/env python3
"""Generate OrgLite app icons (Windows .ico + PNGs) with Pillow."""
from PIL import Image, ImageDraw
import os

SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded-square background
bg = (9, 105, 218, 255)      # accent blue
r = 110
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=r, fill=bg)

# org-style motif: white ring (like an "O") + filled dot + small star
cx, cy = SIZE // 2, SIZE // 2
R1, R2 = 150, 92
d.ellipse([cx - R1, cy - R1, cx + R1, cy + R1], fill=(255, 255, 255, 255))
d.ellipse([cx - R2, cy - R2, cx + R2, cy + R2], fill=bg)
# inner dot
d.ellipse([cx - 46, cy - 46, cx + 46, cy + 46], fill=(255, 255, 255, 255))
# small asterisk star at top right (org's * vibe)
star_cx, star_cy = cx + 150, cy - 150
s = 40
d.line([(star_cx - s, star_cy), (star_cx + s, star_cy)], fill=(255, 255, 255, 255), width=16)
d.line([(star_cx, star_cy - s), (star_cx, star_cy + s)], fill=(255, 255, 255, 255), width=16)
d.line([(star_cx - s * 0.7, star_cy - s * 0.7), (star_cx + s * 0.7, star_cy + s * 0.7)], fill=(255, 255, 255, 255), width=16)
d.line([(star_cx - s * 0.7, star_cy + s * 0.7), (star_cx + s * 0.7, star_cy - s * 0.7)], fill=(255, 255, 255, 255), width=16)

out = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(out, exist_ok=True)

img.save(os.path.join(out, "icon.png"))
img.save(os.path.join(out, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((32, 32), Image.LANCZOS).save(os.path.join(out, "32x32.png"))
img.resize((128, 128), Image.LANCZOS).save(os.path.join(out, "128x128.png"))
print("icons written to", out)
