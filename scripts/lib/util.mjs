import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.join(ROOT, 'public', 'data');
export const STATE_DIR = path.join(ROOT, 'state');
export const CONFIG_DIR = path.join(ROOT, 'config');

const UA = 'RadarIA/1.0 (+https://github.com/; automated news & model index)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token de Hugging Face (opcional, de solo lectura): más cuota de peticiones y acceso a las fichas
// de modelos restringidos cuyas condiciones haya aceptado la cuenta. Solo se envía a dominios de HF.
const HF_HOST = /^https:\/\/([a-z-]+\.)?huggingface\.co\//;
const hfAuth = (url) => (process.env.HF_TOKEN && HF_HOST.test(url) ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {});

export async function fetchText(url, { timeout = 20000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...hfAuth(url), ...headers } });
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  console.warn(`  ! fetch falló: ${url} (${lastErr?.message})`);
  return undefined; // fallo transitorio (red, 429, 5xx); null = no existe
}

export async function fetchJSON(url, opts) {
  const txt = await fetchText(url, opts);
  if (txt == null) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function writeJSON(file, data, pretty = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, pretty ? 2 : 0));
}

export async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripHtml(html = '') {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(script|style|nav|footer|header|noscript|svg|form)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Extrae el texto principal de una página (article/main si existen) y su og:image. */
export function extractPage(html = '') {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const main = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
  const dateStr = html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|date|pubdate|publish-date)["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1]
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr).toISOString() : null;
  return { text: stripHtml(main), image: og ? decodeEntities(og[1]) : null, date };
}

/** Limpia markdown de un README a texto plano razonable. */
export function stripMarkdown(md = '') {
  return md
    .replace(/^---[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[#*_>`]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function slugify(s = '') {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function normalizeText(s = '') {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function firstSentences(text = '', max = 320) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const dot = cut.lastIndexOf('. ');
  return (dot > 80 ? cut.slice(0, dot + 1) : cut + '…');
}

export function daysAgo(iso) {
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

/** Ejecuta fn sobre items con concurrencia limitada. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { console.warn('  ! ', e.message); out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}
