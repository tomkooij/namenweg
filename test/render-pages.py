"""Rendert de lokale voorbeeldscans (map scans/, NIET in git) naar PNG voor de detectietest.

Gebruik: python test/render-pages.py <uitvoermap>
Per pagina: <naam>-<i>.png (origineel, 200 dpi) en <naam>-<i>.enh.png (voorbewerkt voor OCR).
"""
import glob, io, os, sys
import pymupdf as fitz
import numpy as np
from PIL import Image, ImageFilter

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for f in sorted(glob.glob('scans/*.pdf')):
    d = fitz.open(f)
    tag = os.path.basename(f)[:5]
    for i, p in enumerate(d):
        pix = p.get_pixmap(dpi=200)
        im = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
        im.save(os.path.join(out, f'{tag}-{i}.png'))
        g = im.convert('L').filter(ImageFilter.GaussianBlur(1.5))
        a = np.clip((np.asarray(g).astype(float) - 120) * 255 / 120, 0, 255).astype('uint8')
        Image.fromarray(a).save(os.path.join(out, f'{tag}-{i}.enh.png'))
print('klaar')
