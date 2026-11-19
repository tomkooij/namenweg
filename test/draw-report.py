"""Tekent de gevonden vakken uit report.json op de pagina's (voor visuele controle)."""
import json, os, sys
from PIL import Image, ImageDraw

d = sys.argv[1]
rep = json.load(open(os.path.join(d, 'report.json')))
col = {'naam': (31, 79, 209), 'nummer': (180, 83, 9), 'klas': (124, 58, 237)}
for f, r in rep.items():
    if not r['regions']:
        continue
    im = Image.open(os.path.join(d, f)).convert('RGB')
    dr = ImageDraw.Draw(im)
    for g in r['regions']:
        dr.rectangle([g['x0'], g['y0'], g['x1'], g['y1']], outline=(0, 160, 60) if g.get('derived') else col.get(g['kind'], (0, 0, 0)), width=5)
    xs = [g['x0'] for g in r['regions']] + [g['x1'] for g in r['regions']]
    ys = [g['y0'] for g in r['regions']] + [g['y1'] for g in r['regions']]
    box = (max(0, min(xs) - 150), max(0, min(ys) - 120), min(im.width, max(xs) + 150), min(im.height, max(ys) + 200))
    im.crop(box).save(os.path.join(d, 'vis-' + f))
print('klaar')

# Overzicht: alle uitsneden onder elkaar
import glob
ims = [Image.open(f) for f in sorted(glob.glob(os.path.join(d, 'vis-*.png')))]
if ims:
    W = 900
    ims = [im.resize((W, int(im.height * W / im.width))) for im in ims]
    sheet = Image.new('RGB', (W * 2, sum(im.height for im in ims[::2]) + 10), 'white')
    y = [0, 0]
    for i, im in enumerate(ims):
        c = i % 2
        sheet.paste(im, (c * W, y[c]))
        y[c] += im.height
    sheet = sheet.crop((0, 0, W * 2, max(y)))
    sheet.save(os.path.join(d, 'overzicht.jpg'), quality=80)
