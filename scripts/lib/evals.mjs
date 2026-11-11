// Datos objetivos de cada modelo para poder compararlos:
//  - benchmarks: resultados de evaluación de Hugging Face (.eval_results), model-index de la ficha,
//    tablas de resultados del README y clasificaciones independientes (LMArena, Epoch AI, Artificial Analysis)
//  - tamaño real de los pesos publicados (para modelos sin metadatos de parámetros)
//  - velocidad y requisitos de memoria cuando la ficha los declara
import path from 'node:path';
import zlib from 'node:zlib';
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

export function nameVariants(repoName) {
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

// ---------- Clasificaciones independientes ----------
// A diferencia de los benchmarks que declara cada autor, aquí un tercero evalúa a todos los modelos
// con el mismo método, así que son comparables entre sí:
//  - LMArena: Elo por votos humanos a ciegas (CC BY 4.0, sin clave)
//  - Epoch AI: Epoch Capabilities Index, que combina decenas de benchmarks de LLM (CC BY 4.0, sin clave)
//  - Artificial Analysis: índice de inteligencia de LLM y arenas de imagen, vídeo, voz y música
//    (plan gratuito con clave AA_API_KEY, 100 peticiones/día; exige citar la fuente)
// Las claves de estas clasificaciones empiezan por "x-" para distinguirlas de las declaradas.

const LLM_TASKS = ['text-generation', 'image-text-to-text', 'any-to-any'];
const BOARDS = {
  // LMArena
  'arena:text': { key: 'x-arena-text', label: 'LMArena texto', tasks: LLM_TASKS, tol: 12 },
  'arena:webdev': { key: 'x-arena-webdev', label: 'LMArena WebDev', tasks: LLM_TASKS, tol: 12 },
  'arena:vision': { key: 'x-arena-vision', label: 'LMArena visión', tasks: ['image-text-to-text', 'any-to-any', 'video-text-to-text'], tol: 12 },
  'arena:text_to_image': { key: 'x-arena-t2i', label: 'LMArena texto→imagen', tasks: ['text-to-image'], tol: 12 },
  'arena:image_edit': { key: 'x-arena-edit', label: 'LMArena edición', tasks: ['image-to-image', 'text-to-image'], tol: 12 },
  'arena:text_to_video': { key: 'x-arena-t2v', label: 'LMArena texto→vídeo', tasks: ['text-to-video'], tol: 12 },
  'arena:image_to_video': { key: 'x-arena-i2v', label: 'LMArena imagen→vídeo', tasks: ['image-to-video', 'text-to-video'], tol: 12 },
  // Epoch AI
  'epoch:eci': { key: 'x-epoch-eci', label: 'Epoch Capabilities Index', tasks: LLM_TASKS, tol: 2 },
  // Artificial Analysis (solo con AA_API_KEY)
  'aa:language': { key: 'x-aa-intel', label: 'AA Intelligence Index', tasks: LLM_TASKS, tol: 1.5 },
  'aa:text-to-image': { key: 'x-aa-t2i', label: 'AA texto→imagen', tasks: ['text-to-image'], tol: 12 },
  'aa:image-editing': { key: 'x-aa-edit', label: 'AA edición de imagen', tasks: ['image-to-image', 'text-to-image'], tol: 12 },
  'aa:text-to-video': { key: 'x-aa-t2v', label: 'AA texto→vídeo', tasks: ['text-to-video'], tol: 12 },
  'aa:image-to-video': { key: 'x-aa-i2v', label: 'AA imagen→vídeo', tasks: ['image-to-video', 'text-to-video'], tol: 12 },
  'aa:text-to-speech': { key: 'x-aa-tts', label: 'AA texto a voz', tasks: ['text-to-speech'], tol: 12 },
  'aa:speech-to-text': { key: 'x-aa-wer', label: 'AA WER (error de transcripción)', tasks: ['automatic-speech-recognition'], tol: 0.004, lower: true },
  'aa:music/instrumental': { key: 'x-aa-music', label: 'AA música', tasks: ['text-to-audio'], tol: 12 },
};
export const BOARD_SOURCES = {
  arena: { name: 'LMArena', url: 'https://lmarena.ai/leaderboard' },
  epoch: { name: 'Epoch AI', url: 'https://epoch.ai/benchmarks' },
  aa: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai/' },
};

const BOARDS_FILE = path.join(STATE_DIR, 'leaderboards.json');
const BOARDS_VERSION = 2; // 2: incluye modelos cerrados (open: false)
const DS = 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset';

async function loadLMArena() {
  const out = {};
  for (const config of ['text', 'webdev', 'vision', 'text_to_image', 'image_edit', 'text_to_video', 'image_to_video']) {
    const rows = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await fetchJSON(`${DS}&config=${config}&split=latest&offset=${offset}&length=100`, { retries: 2 });
      const r = (page?.rows || []).map((x) => x.row);
      const overall = r.filter((x) => x.category === 'overall');
      rows.push(...overall);
      if (r.length < 100 || !overall.length) break;
    }
    // Se guardan también los cerrados: no entran en el catálogo, pero sirven de referencia
    if (rows.length) out['arena:' + config] = rows
      .map((x) => ({ open: !/proprietary/i.test(x.license || ''), org: x.organization, name: x.model_name, value: Math.round(x.rating), ci: Math.round((x.rating_upper - x.rating_lower) / 2), note: `${Math.round(x.vote_count)} votos` }));
  }
  return out;
}

async function loadEpoch() {
  const res = await fetch('https://epoch.ai/data/benchmark_data.zip', { signal: AbortSignal.timeout(60000) }).catch(() => null);
  if (!res?.ok) return {};
  const csv = unzipFile(Buffer.from(await res.arrayBuffer()), /eci_scores\.csv$/);
  if (!csv) return {};
  const rows = parseCSV(csv);
  return {
    'epoch:eci': rows.filter((r) => r.eci)
      .map((r) => ({ open: /open/i.test(r['Accessibility group'] || ''), org: r.Organization, name: r.Model, alt: r['Display name'], value: +(+r.eci).toFixed(1), ci: +((+r.eci_ci_high - +r.eci_ci_low) / 2).toFixed(1), note: r.Organization })),
  };
}

async function loadArtificialAnalysis() {
  const key = process.env.AA_API_KEY;
  if (!key) return {};
  const out = {};
  for (const id of Object.keys(BOARDS).filter((k) => k.startsWith('aa:'))) {
    const ep = id.slice(3);
    const base = ep === 'language' ? 'language' : `media/${ep}`;
    const data = [];
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`https://artificialanalysis.ai/api/v2/${base}/models/free?page=${page}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(30000) }).catch(() => null);
      if (!res?.ok) { if (res) console.warn(`  ! Artificial Analysis ${ep}: HTTP ${res.status}`); break; }
      const j = await res.json();
      data.push(...(j.data || []));
      if (!j.pagination?.has_more) break;
    }
    const rows = data.map((d) => {
      const value = ep === 'language' ? d.evaluations?.artificial_analysis_intelligence_index : ep === 'speech-to-text' ? d.aa_wer_index : d.elo;
      return value == null ? null : { name: d.name, alt: d.slug, value: ep === 'speech-to-text' ? value : +(+value).toFixed(1), ci: d.ci_95 || null, note: d.model_creator?.name || null };
    }).filter(Boolean);
    if (rows.length) out[id] = rows;
  }
  return out;
}

/** Descarga (una vez al día) todas las clasificaciones independientes */
export async function loadLeaderboards() {
  const today = new Date().toISOString().slice(0, 10);
  const cached = await readJSON(BOARDS_FILE, null);
  if (cached?.date === today && cached.v === BOARDS_VERSION && Object.keys(cached.boards || {}).length) return cached;
  const fresh = { ...(await loadLMArena()), ...(await loadEpoch()), ...(await loadArtificialAnalysis()) };
  // Si una fuente falla hoy se conserva la última versión buena
  const boards = { ...(cached?.v === BOARDS_VERSION ? cached.boards : {}), ...fresh };
  const out = { date: today, v: BOARDS_VERSION, boards };
  await writeJSON(BOARDS_FILE, out, true);
  console.log(`· Clasificaciones independientes: ${Object.entries(boards).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
  return out;
}

const VARIANT_RE = /\((max|high|low|medium|minimal|xhigh|thinking|non-thinking|reasoning|non-reasoning|instruct|agentic|quality|fast|preview|beta)\)/gi;

/** Mejores modelos cerrados de cada clasificación, como referencia frente a los abiertos */
export function closedReferences(lb, perBoard = 3) {
  const out = {};
  for (const [id, rows] of Object.entries(lb.boards || {})) {
    const b = BOARDS[id];
    if (!b) continue;
    const top = rows.filter((r) => r.open === false && r.value != null)
      .sort((x, y) => (b.lower ? x.value - y.value : y.value - x.value)).slice(0, perBoard);
    for (const r of top) (out[b.tasks[0]] ||= []).push({ name: r.name, org: r.org || null, key: b.key, label: b.label, value: r.value, lower: Boolean(b.lower), source: id.split(':')[0] });
  }
  return out;
}

/** Formas normalizadas de un nombre de clasificación ("GLM-5.3 (Max)" → glm53) */
export function boardVariants(n) {
  const plain = n.replace(VARIANT_RE, '').replace(/-?20d{6}/g, '').replace(/,.*$/, '');
  return [...new Set([norm(plain), norm(plain.replace(/(.*?)/g, ''))])].filter((k) => k.length >= 4);
}

/** Índice nombre normalizado → entradas, para casar con repos de Hugging Face */
export function leaderboardIndex(lb) {
  const idx = new Map();
  for (const [id, rows] of Object.entries(lb.boards || {})) {
    const b = BOARDS[id];
    if (!b) continue;
    for (const r of rows) {
      if (r.open === false) continue; // los cerrados no se casan con repos del Hub
      const keys = new Set([r.name, r.alt].filter(Boolean).flatMap(boardVariants));
      for (const k of keys) {
        const list = idx.get(k) || [];
        const prev = list.find((e) => e.key === b.key);
        const better = (x, y) => (b.lower ? x < y : x > y);
        const entry = { key: b.key, label: b.label, tasks: b.tasks, tol: b.tol, lower: Boolean(b.lower), source: id.split(':')[0], value: r.value, ci: r.ci, note: [r.name, r.note].filter(Boolean).join(' · ') };
        if (!prev) list.push(entry);
        else if (better(r.value, prev.value)) Object.assign(prev, entry); // variantes (Max, Thinking…): la mejor
        idx.set(k, list);
      }
    }
  }
  return idx;
}

// Reempaquetadores (ComfyUI, conversiones): no son el modelo original evaluado
export const REPACK = /^(comfy-org|unsloth|lmstudio-community|mlx-community|bartowski|city96|kijai|second-state|gaianet)$/i;

export function leaderboardsFor(m, idx) {
  if (REPACK.test(m.author || '')) return [];
  for (const v of nameVariants(m.name)) {
    const hits = idx.get(v);
    if (hits) return hits.filter((h) => h.tasks.includes(m.task))
      .map((h) => ({ key: h.key, name: h.label, value: h.value, source: h.source, ci: h.ci, tol: h.tol, lower: h.lower, note: h.note }));
  }
  return [];
}

// ---------- utilidades: ZIP y CSV sin dependencias ----------

function unzipFile(buf, nameRe) {
  // Directorio central: firma 0x06054b50 al final del archivo
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (nameRe.test(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** Une benchmarks de varias fuentes sin duplicar (prioridad: clasificaciones independientes > HF > model-index > ficha > LLM) */
export function mergeBenchmarks(...lists) {
  const out = new Map();
  for (const list of lists) for (const b of list || []) {
    const key = b.key || benchKey(b.name);
    if (!key || out.has(key) || b.value == null) continue;
    out.set(key, { key, name: b.name, value: b.value, source: b.source, ...(b.ci ? { ci: b.ci } : {}), ...(b.tol ? { tol: b.tol } : {}), ...(b.note ? { note: b.note } : {}), ...((b.lower ?? lowerIsBetter(b.name)) ? { lower: true } : {}) });
  }
  return [...out.values()].slice(0, 30);
}
