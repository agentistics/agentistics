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
def lum(c):
    c = np.asarray(c, float) / 255
    c = np.where(c <= 0.03928, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]
def contrast(img):
    # Estimated: background = median colour of the crop, text = the pixel farthest from it in luminance.
    px = img.reshape(-1, 3); bg = np.median(px, axis=0); lb = lum(bg); lp = lum(px)
    i = np.argmax(np.abs(lp - lb)); hi, lo = max(lp[i], lb), min(lp[i], lb)
    return round(float((hi + .05) / (lo + .05)), 1)
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
            if r:  # the criterion is the difference INSIDE the surface itself, without the visual margin
                crop = diff[max(0, int(r['y'])):min(H, int(r['y'] + r['h'])), max(0, int(r['x'])):min(W, int(r['x'] + r['w']))]
            else:
                crop = diff[y0:y1, x0:x1]
            pct = round(100 * crop.mean(), 2) if crop.size else 0.0
            full = round(100 * diff.mean(), 2)
            res[b] = {'contrast_on': contrast(B[y0:y1, x0:x1]), 'crop_pct': pct, 'full_pct': full, 'crop_src': src, 'crop': [int(x0), int(y0), int(x1), int(y1)]}
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


# README: pixel difference, estimated contrast, CPU medians.
import statistics as st
from collections import defaultdict
rows = '\n'.join(f"| {k} | {v['crop_pct']}% | {v['full_pct']}% | {v['contrast_on']}:1 {'AA' if v['contrast_on'] >= 4.5 else 'ABAIXO DE AA'} | {v['crop_src']} | {'OK' if v['crop_pct'] >= 3 else 'LACUNA'} |" for k, v in res.items())
cpu = ''
if os.path.exists('metrics.json'):
    g = defaultdict(list)
    for x in json.load(open('metrics.json')): g[(x['screen'], x['theme'], x['glass'])].append((x['averageMs'], x['p95Ms']))
    lines = []
    for scr in 'ab':
        for th in ('dark', 'light'):
            off, on = g.get((scr, th, 'off')), g.get((scr, th, 'on'))
            if not off or not on: continue
            po, pn = st.median(b for _, b in off), st.median(b for _, b in on)
            lines.append(f"| {scr} | {th} | {st.median(a for a, _ in off):.1f} / {po:.1f} | {st.median(a for a, _ in on):.1f} / {pn:.1f} | {pn / po:.2f}x | {'OK' if pn <= 1.5 * po else 'ACIMA DE 1,5x'} |")
    cpu = '\n'.join(lines)
open('README.md', 'w').write(f"""# VIDRO.REAL — telas reais do app, antes e depois

Imagens do app Agentistics real (mesmo build, fonte, cores, ícones), HOME descartável com seed de demonstração. "antes" = `data-glass="off"`;
"depois" = `data-glass="on"` (um interruptor no `<html>`). Abra `index.html`: cada par tem a tela inteira e o recorte 2× da superfície.

Material: fundo translúcido (alpha ~60% escuro / ~66% claro), blur 20px (10px no celular) com saturate 150–170%, borda interna de 1px com highlight e sombra suave.

## Diferença de pixels e contraste (recorte = só a superfície de vidro; critério do líder: ≥3%, ≥8% em b/e/f)
O contraste é ESTIMADO no recorte "depois": fundo = cor mediana, texto = pixel mais distante em luminância (WCAG).

| par | recorte | tela | contraste | recorte vem de | |
|---|---|---|---|---|---|
{rows}

## Notas
- **(e) no celular (390)**: no toque, o app abre o MODAL de uso dos planos, não o popover (o popover é só hover/foco no desktop). A foto 390 mostra esse modal;
  o recorte vem da diferença geral da tela e o contraste ali refere-se ao modal inteiro.
- (d) a barra de baixo só existe no celular; o 1440 não tem barra.

## CPU no celular (390 px, 4× mais lenta, mediana de 3 rodadas; média / p95 em ms; alvo p95 ≤ 1,5× do sem vidro)
| tela | tema | sem vidro | com vidro | p95 com/sem | |
|---|---|---|---|---|---|
{cpu}
""")
