"""Maakt synthetische 'gescande' toetsen met verzonnen namen om de detectie op andere
formulieren te testen. Gebruik: python test/make-synthetic.py <uitvoermap>"""
import io, os, random, sys
import numpy as np
import pymupdf as fitz
from PIL import Image, ImageFilter

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
random.seed(4)
FONTS = ['Times-Italic', 'Courier-Oblique', 'Helvetica-Oblique']
layouts = [
    ('form1', [('Naam:', 60, 60), ('Klas:', 330, 60), ('Leerlingnummer:', 420, 60)], 'A4'),
    ('form2', [('Naam leerling', 60, 50), ('Groep', 60, 80)], 'A4'),
    ('form3', [('Name:', 60, 60), ('Class:', 300, 60), ('Student number:', 60, 90)], 'A4'),
    ('form4', [('NAAM', 60, 60), ('KLAS', 360, 60)], 'A4'),
]
names = ['Jan de Vries', 'Fatima El Amrani', 'Pieter Bakker', 'Lotte Jansen']
for (tag, fields, _), name in zip(layouts, names):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for label, x, y in fields:
        page.insert_text((x, y), label, fontsize=10, fontname='helv', color=(0.15, 0.15, 0.15))
        lw = fitz.get_text_length(label, 'helv', 10)
        page.draw_line((x + lw + 4, y + 2), (x + lw + 120, y + 2), color=(0.5, 0.5, 0.5), width=0.5)
        ll = label.lower()
        val = name if ('naam' in ll or 'name' in ll) else ('4B' if ('klas' in ll or 'class' in ll or 'groep' in ll) else '123456')
        page.insert_text((x + lw + 10, y - 1), val, fontsize=14, fontname=random.choice(FONTS), color=(0.1, 0.15, 0.6))
    page.insert_text((60, 140), 'Vraag 1. Geef de naam van de stof die ontstaat bij deze reactie.', fontsize=10, fontname='helv')
    page.insert_text((60, 170), 'Antwoord: natriumchloride, want het zout ontstaat.', fontsize=13, fontname='Times-Italic', color=(0.1, 0.15, 0.6))
    for gy in range(200, 800, 18):
        page.draw_line((50, gy), (545, gy), color=(0.85, 0.85, 0.85), width=0.4)
    pix = page.get_pixmap(dpi=200)
    im = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB').rotate(random.uniform(-0.8, 0.8), fillcolor='white', resample=Image.BICUBIC)
    a = np.asarray(im).astype(float) + np.random.normal(0, 8, (im.height, im.width, 3))
    im = Image.fromarray(np.clip(a, 0, 255).astype('uint8'))
    im.save(os.path.join(out, f'{tag}-0.png'))
    g = im.convert('L').filter(ImageFilter.GaussianBlur(1.5))
    e = np.clip((np.asarray(g).astype(float) - 120) * 255 / 120, 0, 255).astype('uint8')
    Image.fromarray(e).save(os.path.join(out, f'{tag}-0.enh.png'))
print('klaar')
