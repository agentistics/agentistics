"""Crops each before/after pair to the glass surface (rects.json, else the diff bounding box),
measures the pixel difference INSIDE the crop and writes index.html + diffs.json."""
import json, os, sys, glob
import numpy as np
from PIL import Image

d = sys.argv[1]
os.chdir(d)
rects = json.load(open('rects.json')) if os.path.exists('rects.json') else {}
NAMES = {'a-sessions-menu': 'Lista de sessões com o menu de áreas', 'b-session-composer-menu': 'Conversa com o compositor',
         'c-agentask-modal': 'Agentask com modal "Nova tarefa"', 'd-mobile-bottom-bar': 'Barra de baixo do celular',
         'e-plan-usage-popover': 'Popover "Uso dos planos"', 'f-nay-notice': 'Card de notificação da Nay'}
res = {}
html = ['<!doctype html><meta charset=utf-8><title>VIDRO.REAL</title><style>body{font:14px system-ui;background:#111;color:#eee;margin:20px}h2{margin-top:36px}.r{display:flex;gap:10px;margin:6px 0}figure{margin:0;flex:1;min-width:0}img{max-width:100%;border:1px solid #444}figcaption{color:#aaa;margin:3px 0}</style><h1>VIDRO.REAL — antes | depois, com recorte 2× da superfície de vidro</h1>']
for k, t in NAMES.items():
    html.append(f'<h2>{k[0]}) {t}</h2>')
    for th in ('dark', 'light'):
        for w in (1440, 390):
            b = f'{k}-{th}-{w}'
            if not os.path.exists(f'{b}-off.png'): continue
            A = np.asarray(Image.open(f'{b}-off.png').convert('RGB')).astype(int)
            B = np.asarray(Image.open(f'{b}-on.png').convert('RGB')).astype(int)
            diff = np.abs(A - B).sum(2) > 12
            H, W = diff.shape
            r = rects.get(b); src = 'elemento'
            if r:
                pad = 24
                x0, y0 = max(0, int(r['x']) - pad), max(0, int(r['y']) - pad)
                x1, y1 = min(W, int(r['x'] + r['w']) + pad), min(H, int(r['y'] + r['h']) + pad)
            elif diff.any():
                ys, xs = np.where(diff); src = 'bbox da diferença'
                x0, y0, x1, y1 = max(0, xs.min() - 24), max(0, ys.min() - 24), min(W, xs.max() + 24), min(H, ys.max() + 24)
            else:
                x0, y0, x1, y1 = 0, 0, W, H; src = 'tela inteira'
            crop = diff[y0:y1, x0:x1]
            pct = round(100 * crop.mean(), 2) if crop.size else 0.0
            full = round(100 * diff.mean(), 2)
            res[b] = {'crop_pct': pct, 'full_pct': full, 'crop_src': src, 'crop': [int(x0), int(y0), int(x1), int(y1)]}
            for g in ('off', 'on'):
                im = Image.open(f'{b}-{g}.png').convert('RGB').crop((x0, y0, x1, y1))
                im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
                im.save(f'zoom-{b}-{g}.png')
            flag = '' if pct >= 3 else ' — ABAIXO DE 3% (lacuna)'
            html.append(f'<h3>{th} {w} — diferença no recorte: {pct}% (tela inteira {full}%){flag}</h3>'
                        f'<div class=r><figure><figcaption>antes</figcaption><img src="{b}-off.png"></figure><figure><figcaption>depois</figcaption><img src="{b}-on.png"></figure></div>'
                        f'<div class=r><figure><figcaption>recorte 2× antes</figcaption><img src="zoom-{b}-off.png"></figure><figure><figcaption>recorte 2× depois</figcaption><img src="zoom-{b}-on.png"></figure></div>')
open('index.html', 'w').write(''.join(html))
json.dump(res, open('diffs.json', 'w'), indent=1)
for b, v in res.items(): print(f"{v['crop_pct']:6.2f}% crop ({v['crop_src']}) / {v['full_pct']:5.2f}% full  {b}")
