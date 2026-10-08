'use strict';
/**
 * CSS colour → hex, for the handful of colour syntaxes a theme file actually
 * uses. Figma variables store sRGB floats, so every token is resolved to
 * `#rrggbb` (or `#rrggbbaa` when it carries alpha) before it leaves the repo.
 *
 * oklch → sRGB uses Björn Ottosson's OKLab matrices; out-of-gamut channels are
 * clamped, which is what a browser does when it paints the same value.
 */

const hex2 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');

function encode(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function oklchToRgb(L, C, h) {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** `10%` → 0.1, `0.1` → 0.1, undefined → 1. */
function alphaOf(raw) {
  if (raw == null || raw === '') return 1;
  const t = raw.trim();
  return t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
}

function toHex(rgb, alpha = 1) {
  const base = '#' + rgb.map(hex2).join('');
  return alpha >= 1 ? base : base + hex2(alpha);
}

/**
 * Resolve one CSS colour value to hex, or return null when it is not a colour
 * this understands (a `var()`, a gradient, a keyword) — the caller decides
 * whether that is an error.
 */
function cssColorToHex(value) {
  const v = String(value).trim().toLowerCase();
  let m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const L = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    return toHex(oklchToRgb(L, parseFloat(m[2]), parseFloat(m[3])), alphaOf(m[4]));
  }
  m = /^#((?:[0-9a-f]{3}){1,2}|[0-9a-f]{4}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length === 8 && h.endsWith('ff')) h = h.slice(0, 6);
    return '#' + h;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    return toHex([m[1], m[2], m[3]].map((n) => parseFloat(n) / 255), alphaOf(m[4]));
  }
  return null;
}

module.exports = { cssColorToHex, oklchToRgb };
