// Datos objetivos de cada modelo para poder compararlos:
//  - benchmarks: resultados de evaluación de Hugging Face (.eval_results), model-index de la ficha,
//    tablas de resultados del README y puntuaciones Elo de LMArena (votos humanos a ciegas)
//  - tamaño real de los pesos publicados (para modelos sin metadatos de parámetros)
//  - velocidad y requisitos de memoria cuando la ficha los declara
import path from 'node:path';
import { fetchJSON, readJSON, writeJSON, STATE_DIR } from './util.mjs';

// ---------- nombres de benchmark ----------

const ALIAS = {
  gpqadiamond: 'gpqa', humanityslastexam: 'hle', aime2024: 'aime24', aime2025: 'aime25', aime2026: 'aime26',
  mmluprox: 'mmluprox', swebenchverifiedresolved: 'swebenchverified', livecodebenchv6: 'livecodebench',
  mathbench500: 'math500', math500: 'math500', ifevalprompt: 'ifeval', bfclv3: 'bfcl', bfclv4: 'bfcl',
  terminalbench21: 'terminalbench2', terminalbench20: 'terminalbench2', taubench2: 'tau2bench', tau2: 'tau2bench',
};
// Métricas en las que menos es mejor
const LOWER_RE = /(^|[^a-z])(wer|cer|fid|fvd|kid|mase|crps|lpips|rmse|mae|mse|chamfer|error|latency|rtf|ter|der|eer|perplexity|ppl|loss)([^a-z]|$)/i;
// Columnas o filas que no son benchmarks (tamaño, contexto, medias de conjuntos distintos…)
const NOT_BENCH = /(param|size|context|licen|release|date|price|cost|vram|memory|speed|throughput|latency|token|steps?$|batch|epoch|average|avg|overall|mean|total|model|method|#|type|arch|resolution|fps|time|year|link|download|url|organi)/i;

const norm = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

export function benchKey(name) {
  let k = norm(String(name).split('/').pop());
  return ALIAS[k] || k;
}
export const lowerIsBetter = (name) => LOWER_RE.test(String(name));

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v ?? '').replace(/\*|_|`/g, '').match(/^\s*[~≈]?\s*(-?\d+(?:[.,]\d+)?)\s*(%|pts?)?(\s|$|±|\/|\(|\[|†|‡|\*)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// ---------- benchmarks estructurados de la API de Hugging Face ----------

export function structuredEvals(hf) {
  const out = [];
  const evals = (hf.evalResults || []).map((r) => r.data || {});
  const perDataset = {};
  for (const d of evals) { const k = d.dataset?.id || d.dataset?.name; perDataset[k] = (perDataset[k] || 0) + 1; }
  for (const d of evals) {
    const ds = d.dataset?.name || d.dataset?.id;
    const value = num(d.value);
    if (!ds || value == null) continue;
    // Un mismo dataset con varias subtareas (p. ej. Open ASR: un WER por corpus) se distingue por task_id
    const name = perDataset[d.dataset?.id || d.dataset?.name] > 1 && d.dataset?.task_id ? `${prettyDataset(ds)} · ${prettyDataset(d.dataset.task_id)}` : prettyDataset(ds);
    out.push({ name, value, source: 'hf', note: d.source?.name || null });
  }
  for (const entry of [].concat(hf.cardData?.['model-index'] || [])) {
    for (const res of entry?.results || []) {
      const ds = res.dataset?.name || res.dataset?.type;
      for (const met of res.metrics || []) {
        const value = num(met.value);
        if (!ds || value == null) continue;
        const generic = /^(accuracy|acc|score|exact[_ ]match|pass@1|f1)$/i.test(met.name || met.type || '');
        out.push({ name: generic ? prettyDataset(ds) : `${prettyDataset(ds)} ${met.name || met.type}`, value, source: 'model-index' });
      }
    }
  }
  return out;
}

const prettyDataset = (s) => String(s).split('/').pop().replace(/^open-asr-leaderboard$/i, 'Open ASR').replace(/_/g, ' ')
  .replace(/(wer|cer|fid|mase|crps)/gi, (x) => x.toUpperCase());

// ---------- tablas de resultados del README ----------

const SUFFIX = /[-_](instruct|it|chat|base|hf|diffusers|preview|fp8|bf16|fp16|thinking|reasoning|release|official|v\d+(\.\d+)?|\d{4})$/i;

function nameVariants(repoName) {
  const v = [norm(repoName)];
  let n = repoName;
  for (let i = 0; i < 3 && SUFFIX.test(n); i++) { n = n.replace(SUFFIX, ''); v.push(norm(n)); }
  return [...new Set(v)].filter((x) => x.length >= 3);
}

function matchScore(cell, variants) {
  const c = norm(cell.replace(/\(.*?\)|\[.*?\]/g, ''));
  if (!c) return 0;
  if (c === variants[0]) return 3;
  if (variants.includes(c)) return 2;
  if (/\b(ours|this model|nuestro)\b/i.test(cell)) return 1.5;
  return 0;
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/<[^>]+>/g, '').replace(/\*\*|__/g, '').trim());
}

function tables(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length - 2; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const rows = [cells(lines[i])];
    let j = i + 2;
    while (j < lines.length && /^\s*\|/.test(lines[j])) rows.push(cells(lines[j++]));
    out.push(rows);
    i = j;
  }
  return out;
}

// HTML <table> (algunas fichas lo usan en vez de markdown)
function htmlTables(md) {
  const out = [];
  for (const t of md.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((r) => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()));
    if (rows.length > 1) out.push(rows);
  }
  return out;
}

const okBench = (s) => s && s.length >= 2 && s.length <= 48 && /[a-z]/i.test(s) && !NOT_BENCH.test(s);

export function readmeBenchmarks(readme, repoName) {
  const variants = nameVariants(repoName);
  const found = new Map();
  for (const rows of [...tables(readme), ...htmlTables(readme)]) {
    const head = rows[0];
    // Caso A: modelos en columnas, benchmarks en filas
    let best = -1, bestScore = 0;
    head.forEach((h, i) => { const s = i > 0 ? matchScore(h, variants) : 0; if (s > bestScore) { bestScore = s; best = i; } });
    if (best > 0) {
      for (const r of rows.slice(1)) {
        const name = r[0]?.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
        const value = num(r[best]);
        if (okBench(name) && value != null && !found.has(benchKey(name))) found.set(benchKey(name), { name, value, source: 'ficha' });
      }
      continue;
    }
    // Caso B: modelos en filas, benchmarks en columnas
    let row = null, rowScore = 0;
    for (const r of rows.slice(1)) { const s = matchScore(r[0] || '', variants); if (s > rowScore) { rowScore = s; row = r; } }
    if (row) {
      head.forEach((h, i) => {
        if (i === 0) return;
        const value = num(row[i]);
        if (okBench(h) && value != null && !found.has(benchKey(h))) found.set(benchKey(h), { name: h, value, source: 'ficha' });
      });
    }
  }
  return [...found.values()].slice(0, 30);
}

// ---------- velocidad / memoria / evidencia de IA en el README ----------

export function readmeFacts(readme) {
  const t = readme.replace(/\s+/g, ' ');
  const facts = {};
  // Solo cifras concretas; frases vagas ("fast", "real-time out of the box") no sirven para comparar
  // (los fps solo cuentan si hablan de inferencia: "24 fps" en un generador de vídeo es la cadencia de salida)
  const speed = t.match(/\b(runs?|running|inference|processing|speed|achieves?|real[- ]time|throughput)\b[^.|]{0,25}?\d+(?:\.\d+)?\s*(fps|it\/s|tokens?\/s|tok\/s)\b[^.|,;(]{0,30}/i)
    || t.match(/\b(RTF|real[- ]time factor)\s*(of|=|:)?\s*(0?\.\d+)[^.|,;(]{0,30}/i)
    || t.match(/(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms)\s*(per|\/)\s*(image|step|clip|second of audio|sample)\b[^.|,;(]{0,30}/i);
  if (speed) facts.speedStated = speed[0].replace(/[*_`]/g, '').trim().slice(0, 90);
  // Solo frases de requisitos ("requires 24 GB VRAM", "runs on 8GB GPU"), no de entrenamiento ("trained on 8× 80GB")
  const vram = t.match(/\b(requires?|needs?|minimum|at least|fits?( in| on)?|runs? on|less than|under|only)\b[^.|]{0,30}?(\d{1,3}(?:\.\d)?)\s*GB\s*(of\s*)?(GPU\s*|V)?(RAM|VRAM|GPU memory|GPU|memory)/i);
  if (vram && +vram[3] >= 1 && +vram[3] <= 640 && !/train/i.test(vram[0])) facts.vramStated = +vram[3];
  // Evidencia de que es un sistema de aprendizaje automático (y no una utilidad o un juego)
  const ai = ['pretrained', 'pre-trained', 'checkpoint', 'model weights', 'trained on', 'training', 'fine-tun', 'diffusion', 'neural', 'transformer', 'inference', 'dataset', 'gaussian splatting', 'nerf', 'deep learning', 'reinforcement learning', 'lora', 'vae', 'gan', 'huggingface.co/', 'arxiv.org/'];
  const low = t.toLowerCase();
  facts.aiEvidence = ai.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`).test(low)).length;
  return facts;
}

// ---------- tamaño real de los pesos (repos sin metadatos safetensors) ----------

const WEIGHT_RE = /\.(safetensors|bin|pth|pt|ckpt)$/i;
const SKIP_RE = /(optimizer|scheduler|training_args|rng_state|ema[-_.]?only|\.fp16\.|non[-_]ema|onnx|gguf|\/(onnx|openvino|coreml|mlx|gguf|tflite)\/)/i;

export async function weightsSize(id) {
  const files = await fetchJSON(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`, { retries: 1 });
  if (!Array.isArray(files)) return undefined; // fallo de red o límite de peticiones: se reintenta en otra ejecución
  let w = files.filter((f) => f.type === 'file' && WEIGHT_RE.test(f.path) && !SKIP_RE.test('/' + f.path));
  if (w.some((f) => f.path.endsWith('.safetensors'))) w = w.filter((f) => f.path.endsWith('.safetensors'));
  if (!w.length) return null;
  const size = (l) => l.reduce((s, f) => s + (f.lfs?.size || f.size || 0), 0);
  const isDiffusers = files.some((f) => f.path === 'model_index.json');
  const byDir = {};
  for (const f of w) (byDir[f.path.includes('/') ? f.path.split('/')[0] : '.'] ||= []).push(f);
  let bytes;
  if (isDiffusers) bytes = size(w.filter((f) => f.path.includes('/')));
  else {
    // Sin estructura diffusers: varias variantes pueden convivir; se toma el conjunto más grande coherente
    const groupSize = (l) => (l.some((f) => /-\d{5}-of-\d{5}/.test(f.path)) ? size(l.filter((f) => /-\d{5}-of-\d{5}/.test(f.path))) : Math.max(...l.map((f) => f.lfs?.size || f.size || 0)));
    bytes = Math.max(...Object.values(byDir).map(groupSize));
  }
  return bytes > 1e6 ? +(bytes / 1e9).toFixed(2) : null;
}

// ---------- LMArena (votaciones humanas a ciegas) ----------

const ARENA_BOARDS = {
  text: { key: 'arena-text', label: 'LMArena texto', tasks: ['text-generation', 'image-text-to-text', 'any-to-any'] },
  webdev: { key: 'arena-webdev', label: 'LMArena WebDev', tasks: ['text-generation', 'image-text-to-text', 'any-to-any'] },
  vision: { key: 'arena-vision', label: 'LMArena visión', tasks: ['image-text-to-text', 'any-to-any', 'video-text-to-text'] },
  text_to_image: { key: 'arena-t2i', label: 'LMArena texto→imagen', tasks: ['text-to-image'] },
  image_edit: { key: 'arena-edit', label: 'LMArena edición', tasks: ['image-to-image', 'text-to-image'] },
  text_to_video: { key: 'arena-t2v', label: 'LMArena texto→vídeo', tasks: ['text-to-video'] },
  image_to_video: { key: 'arena-i2v', label: 'LMArena imagen→vídeo', tasks: ['image-to-video', 'text-to-video'] },
};
const ARENA_FILE = path.join(STATE_DIR, 'arena.json');
const DS = 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset';

export async function loadArena() {
  const today = new Date().toISOString().slice(0, 10);
  const cached = await readJSON(ARENA_FILE, null);
  if (cached?.date === today && Object.keys(cached.boards || {}).length) return cached;
  const boards = {};
  for (const config of Object.keys(ARENA_BOARDS)) {
    const rows = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await fetchJSON(`${DS}&config=${config}&split=latest&offset=${offset}&length=100`, { retries: 2 });
      const r = (page?.rows || []).map((x) => x.row);
      const overall = r.filter((x) => x.category === 'overall');
      rows.push(...overall);
      if (r.length < 100 || !overall.length) break;
    }
    if (rows.length) boards[config] = rows.filter((x) => !/proprietary/i.test(x.license || ''))
      .map((x) => ({ name: x.model_name, org: x.organization, rating: Math.round(x.rating), ci: Math.round((x.rating_upper - x.rating_lower) / 2), votes: x.vote_count }));
  }
  if (!Object.keys(boards).length) return cached || { date: null, boards: {} };
  const out = { date: today, boards };
  await writeJSON(ARENA_FILE, out, true);
  console.log(`· LMArena: ${Object.entries(boards).map(([k, v]) => `${k} ${v.length}`).join(', ')} modelos abiertos`);
  return out;
}

/** Índice nombre normalizado → entradas de arena, para casar con repos de Hugging Face */
export function arenaIndex(arena) {
  const idx = new Map();
  for (const [config, rows] of Object.entries(arena.boards || {})) {
    const b = ARENA_BOARDS[config];
    if (!b) continue;
    for (const r of rows) {
      const plain = r.name.replace(/\((max|high|low|medium|thinking|non-thinking|reasoning|instruct|agentic|quality|fast)\)/gi, '').replace(/-?20\d{6}/g, '');
      const keys = new Set([norm(plain), norm(plain.replace(/\(.*?\)/g, ''))]);
      for (const k of keys) {
        if (k.length < 4) continue;
        const list = idx.get(k) || [];
        const prev = list.find((e) => e.key === b.key);
        if (!prev) list.push({ key: b.key, label: b.label, tasks: b.tasks, rating: r.rating, ci: r.ci, votes: r.votes, arenaName: r.name });
        else if (r.rating > prev.rating) Object.assign(prev, { rating: r.rating, ci: r.ci, arenaName: r.name });
        idx.set(k, list);
      }
    }
  }
  return idx;
}

// Reempaquetadores (ComfyUI, conversiones): no son el modelo original evaluado en la arena
const REPACK = /^(comfy-org|unsloth|lmstudio-community|mlx-community|bartowski|city96|kijai|second-state|gaianet)$/i;

export function arenaFor(m, idx) {
  if (REPACK.test(m.author || '')) return [];
  for (const v of nameVariants(m.name)) {
    const hits = idx.get(v);
    if (hits) return hits.filter((h) => h.tasks.includes(m.task))
      .map((h) => ({ name: h.label, value: h.rating, source: 'arena', ci: h.ci, note: `${h.arenaName} · ${Math.round(h.votes)} votos` }));
  }
  return [];
}

/** Une benchmarks de varias fuentes sin duplicar (prioridad: arena > HF > model-index > ficha > LLM) */
export function mergeBenchmarks(...lists) {
  const out = new Map();
  for (const list of lists) for (const b of list || []) {
    const key = b.source === 'arena' ? norm(b.name) : benchKey(b.name);
    if (!key || out.has(key) || b.value == null) continue;
    out.set(key, { key, name: b.name, value: b.value, source: b.source, ...(b.ci ? { ci: b.ci } : {}), ...(b.note ? { note: b.note } : {}), ...(lowerIsBetter(b.name) ? { lower: true } : {}) });
  }
  return [...out.values()].slice(0, 30);
}
