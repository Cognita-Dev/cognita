// Embeds real, open-licence (OFL) web fonts directly into the HTML so PDFs/PNGs
// render with proper typography on any machine, offline, with no Google Fonts call.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const FAMILIES = {
  'Fraunces': 'fraunces',
  'Inter': 'inter',
  'IBM Plex Mono': 'ibm-plex-mono',
  'Space Grotesk': 'space-grotesk',
  'DM Sans': 'dm-sans',
  'DM Serif Display': 'dm-serif-display',
  'Playfair Display': 'playfair-display',
  'Lora': 'lora',
  'Manrope': 'manrope',
  'Syne': 'syne',
};

const WEIGHTS = [400, 500, 600, 700, 800];
const cache = new Map();

function faces(family, withItalic) {
  const id = FAMILIES[family];
  if (!id) return '';
  const key = family + (withItalic ? '+i' : '');
  if (cache.has(key)) return cache.get(key);
  let dir;
  try {
    dir = path.join(path.dirname(require.resolve(`@fontsource/${id}/package.json`)), 'files');
  } catch {
    return '';
  }
  let css = '';
  for (const style of withItalic ? ['normal', 'italic'] : ['normal']) {
    for (const w of WEIGHTS) {
      const file = path.join(dir, `${id}-latin-${w}-${style}.woff2`);
      if (!fs.existsSync(file)) continue;
      const b64 = fs.readFileSync(file).toString('base64');
      css += `@font-face{font-family:'${family}';font-style:${style};font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
    }
  }
  cache.set(key, css);
  return css;
}

export function fontCss(head, body, mono) {
  return faces(head, true) + (body !== head ? faces(body, true) : '') + (mono !== head && mono !== body ? faces(mono, false) : '');
}

export const FONT_FAMILIES = Object.keys(FAMILIES);
