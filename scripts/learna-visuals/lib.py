# Tiny drawing kit for Learna's course visuals. Everything is plain SVG on a 1200x675 canvas.
# Brand tokens match css/shared.css.
from html import escape
W, H = 1200, 675
BG, CARD, INK, MUTED = '#f7f7f5', '#ffffff', '#171717', '#6f6f6a'
ACC, ACC2, ACCSUB, OK, WARN, LINE = '#a8471f', '#cf7b4a', '#f5e6da', '#3f6b5b', '#a06a1f', '#d9d6cf'
OKSUB = '#e3eee9'
FONT = "'Liberation Sans','DejaVu Sans',Arial,sans-serif"
MONO = "'DejaVu Sans Mono','Liberation Mono',monospace"

class Canvas:
    def __init__(self, title, subtitle=''):
        self.parts, self.hot = [], []
        self.parts.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
        self.parts.append(f'<rect x="0" y="0" width="14" height="{H}" fill="{ACC}"/>')
        self.text(56, 74, title, 38, ACC, 'bold')
        if subtitle: self.text(56, 112, subtitle, 22, MUTED)
    def add(self, s): self.parts.append(s)
    def text(self, x, y, s, size=24, fill=INK, weight='normal', anchor='start', mono=False):
        lines = str(s).split('\n')
        fam = MONO if mono else FONT
        out = []
        for i, ln in enumerate(lines):
            out.append(f'<text x="{x}" y="{y + i * size * 1.28:.0f}" font-family="{fam}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" style="white-space:pre">{escape(ln)}</text>')
        self.add(''.join(out))
    def box(self, x, y, w, h, fill=CARD, stroke=LINE, r=18, sw=2, dash=False):
        d = ' stroke-dasharray="8 6"' if dash else ''
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
    def card(self, x, y, w, h, head, body='', fill=CARD, headfill=ACC, size=24, bsize=22, mono=False):
        self.box(x, y, w, h, fill)
        self.text(x + w / 2, y + 44, head, size, headfill, 'bold', 'middle')
        if body: self.text(x + w / 2, y + 44 + size + 14, body, bsize, INK, 'normal', 'middle', mono)
    def line(self, x1, y1, x2, y2, color=INK, sw=3, dash=False):
        d = ' stroke-dasharray="8 6"' if dash else ''
        self.add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{sw}"{d}/>')
    def arrow(self, x1, y1, x2, y2, color=ACC, sw=4):
        import math
        a = math.atan2(y2 - y1, x2 - x1); L = 16
        p1 = (x2 - L * math.cos(a - 0.45), y2 - L * math.sin(a - 0.45)); p2 = (x2 - L * math.cos(a + 0.45), y2 - L * math.sin(a + 0.45))
        self.line(x1, y1, x2 - 6 * math.cos(a), y2 - 6 * math.sin(a), color, sw)
        self.add(f'<polygon points="{x2},{y2} {p1[0]:.0f},{p1[1]:.0f} {p2[0]:.0f},{p2[1]:.0f}" fill="{color}"/>')
    def circle(self, cx, cy, r, fill=ACCSUB, stroke=ACC, sw=3):
        self.add(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    def pill(self, x, y, w, h, text, fill=ACCSUB, color=ACC, size=22):
        self.box(x, y, w, h, fill, fill, r=h // 2, sw=0)
        self.text(x + w / 2, y + h / 2 + size * 0.34, text, size, color, 'bold', 'middle')
    def badge(self, n, cx, cy, label, text):
        # A numbered marker that is both drawn in the picture and registered as a tappable hotspot.
        self.circle(cx, cy, 20, ACC, CARD, 3)
        self.text(cx, cy + 8, str(n), 22, CARD, 'bold', 'middle')
        self.hot.append({'x': round(cx / W * 100, 1), 'y': round(cy / H * 100, 1), 'label': label, 'text': text})
    def svg(self):
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">' + ''.join(self.parts) + '</svg>'
