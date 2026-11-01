// Recolecta modelos open source de Hugging Face, estima hardware/velocidad/calidad
// y los enriquece (una sola vez por modelo) con un resumen en español generado por LLM.
import path from 'node:path';
import { fetchJSON, fetchText, readJSON, writeJSON, pool, stripMarkdown, firstSentences, DATA_DIR, CONFIG_DIR } from './util.mjs';
import { llmJSON, llmEnabled, llmBudgetLeft } from './llm.mjs';
import { classify } from './research.mjs';

const HF = 'https://huggingface.co/api/models';
const EXPAND = ['safetensors', 'pipeline_tag', 'likes', 'downloads', 'createdAt', 'lastModified', 'tags', 'trendingScore', 'cardData']
  .map((e) => `expand[]=${e}`).join('&');

const PER_TASK_LIMIT = 60;
const PER_TASK_CAP = 90;
const MAX_ENRICH_PER_RUN = Number(process.env.MAX_ENRICH_PER_RUN || 40);

const QUANT_RE = /(gguf|[-_.]awq|gptq|[-_]mlx|mlx[-_]|exl2|exl3|[-_]int[48]\b|bnb|[-_][2-8]bit|onnx|fp8[-_]dynamic|nvfp4|[-_]q[2-8]_)/i;
const PERMISSIVE = /^(apache-2\.0|mit|bsd.*|cc-by-4\.0|cc0-1\.0|openrail.*|creativeml-openrail-m|unlicense|isc|mpl-2\.0|artistic-2\.0)$/i;

export async function updateModels(research = []) {
  const tasks = await readJSON(path.join(CONFIG_DIR, 'tasks.json'), []);
  const rcfg = (await readJSON(path.join(CONFIG_DIR, 'sources.json'), {})).research || {};
  const customTasks = tasks.filter((t) => t.custom);
  const taskMap = Object.fromEntries(tasks.map((t) => [t.tag, t]));
  const watch = (await readJSON(path.join(CONFIG_DIR, 'watchlist.json'), { searches: [] })).searches;
  const prev = await readJSON(path.join(DATA_DIR, 'models.json'), { models: [] });
  const byId = new Map(prev.models.map((m) => [m.id, m]));
  const now = new Date().toISOString();

  // 1) Descarga: trending global + trending por tarea + recientes con likes + watchlist
  const urls = [
    `${HF}?sort=trendingScore&limit=300&${EXPAND}`,
    `${HF}?sort=createdAt&limit=500&${EXPAND}`,
    ...tasks.filter((t) => !t.custom).map((t) => `${HF}?pipeline_tag=${t.tag}&sort=trendingScore&limit=${PER_TASK_LIMIT}&${EXPAND}`),
    ...tasks.filter((t) => !t.custom).map((t) => `${HF}?pipeline_tag=${t.tag}&sort=likes30d&limit=25&${EXPAND}`),
  ];
  // Dominios sin pipeline tag propio (animación, mundos, terreno…): se buscan por etiquetas del Hub
  const domainQueries = tasks.flatMap((t) => (t.hfTags || []).map((tag) => ({ task: t.tag, url: `${HF}?filter=${encodeURIComponent(tag)}&sort=trendingScore&limit=30&${EXPAND}` })));
  urls.push(...domainQueries.map((q) => q.url));
  const domainStart = urls.length - domainQueries.length;
  // Pesos publicados por papers/proyectos que sigue el módulo de investigación
  const researchByWeight = new Map();
  for (const r of research) for (const w of r.weights || []) if (r.score >= (rcfg.minScoreToolbox ?? 14) || r.mentions?.length) researchByWeight.set(w, r);
  const watchUrls = watch.map((q) => `${HF}?search=${encodeURIComponent(q)}&sort=likes&limit=4&${EXPAND}`);
  console.log(`· Hugging Face: ${urls.length + watchUrls.length} consultas`);
  const lists = await pool([...urls, ...watchUrls], 6, (u) => fetchJSON(u));
  const domainHint = new Map();
  lists.slice(domainStart, urls.length).forEach((list, n) => (list || []).forEach((m) => domainHint.set(m.id, [...(domainHint.get(m.id) || []), domainQueries[n].task])));
  const singles = await pool([...researchByWeight.keys()], 6, (id) => fetchJSON(`${HF}/${id}`, { retries: 1 }));
  lists.push(singles.filter((m) => m && m.id));
  // Solo cuenta como coincidencia si el término aparece como palabra en el nombre (evita "IDOL" → "idolsankaku")
  const watchIds = new Set(lists.slice(urls.length, urls.length + watchUrls.length).flatMap((list, n) => {
    const q = watch[n].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[-_./])${q}($|[-_.\\d])`, 'i');
    return (list || []).filter((m) => re.test(m.id.split('/')[1])).map((m) => m.id);
  }));

  const raw = new Map();
  const quantBases = new Set();
  for (const list of lists) for (const m of list || []) {
    const tags = m.tags || [];
    const quantOf = tags.filter((t) => t.startsWith('base_model:quantized:')).map((t) => t.split(':').slice(2).join(':'));
    quantOf.forEach((b) => quantBases.add(b));
    if (quantOf.length || tags.includes('gguf') || QUANT_RE.test(m.id)) continue;
    if (tags.includes('not-for-all-audiences')) continue;
    if (tags.some((t) => t.startsWith('base_model:adapter:')) && (m.likes || 0) < 50) continue;
    if ((m.likes || 0) < 5 && !watchIds.has(m.id) && !researchByWeight.has(m.id)) continue;
    raw.set(m.id, m);
  }
  console.log(`· ${raw.size} modelos candidatos (${quantBases.size} con cuantizaciones detectadas)`);

  // 2) Normaliza y fusiona con el catálogo previo
  for (const m of raw.values()) {
    const old = byId.get(m.id) || {};
    const task = m.pipeline_tag || m.cardData?.pipeline_tag || old.task || 'other';
    const total = m.safetensors?.total || paramsFromName(m.id) || old.params || null;
    const rec = {
      ...old,
      id: m.id,
      name: m.id.split('/')[1],
      author: m.id.split('/')[0],
      url: `https://huggingface.co/${m.id}`,
      task,
      params: total,
      activeParams: old.activeParams || activeFromName(m.id) || null,
      license: m.cardData?.license || tagValue(m.tags, 'license') || old.license || null,
      languages: [].concat(m.cardData?.language || []).slice(0, 12),
      library: m.cardData?.library_name || m.library_name || null,
      likes: m.likes || 0,
      downloads: m.downloads || 0,
      trending: m.trendingScore || 0,
      createdAt: m.createdAt,
      lastModified: m.lastModified,
      hasQuant: quantBases.has(m.id) || old.hasQuant || false,
      watch: watchIds.has(m.id) || old.watch || false,
      kind: 'model',
      domainHint: [...new Set([...(old.domainHint || []), ...(domainHint.get(m.id) || []), ...(researchByWeight.get(m.id)?.tasks || [])])],
      paper: researchByWeight.get(m.id)?.arxivId ? `https://arxiv.org/abs/${researchByWeight.get(m.id).arxivId}` : old.paper || null,
      code: researchByWeight.get(m.id)?.repo ? `https://github.com/${researchByWeight.get(m.id).repo}` : old.code || null,
      mentions: researchByWeight.get(m.id)?.mentions || old.mentions || [],
      firstSeen: old.firstSeen || now,
      lastSeen: now,
      tags: (m.tags || []).filter((t) => !/^(region:|endpoints_|base_model:|deploy:|arxiv:|dataset:|license:|doi:)/.test(t)).slice(0, 15),
    };
    byId.set(m.id, rec);
  }

  // 2b) Proyectos de investigación con código pero sin pesos en el Hub (repos de GitHub)
  const weightIds = new Set(byId.keys());
  for (const r of research) {
    if (!r.repo || (r.weights || []).some((w) => weightIds.has(w))) continue;
    if (!(r.score >= (rcfg.minScoreToolbox ?? 14) || r.stars >= 30 || r.mentions?.length)) continue;
    const id = 'gh:' + r.repo;
    const old = byId.get(id) || {};
    byId.set(id, {
      ...old,
      id,
      kind: 'project',
      name: r.name && r.name.length <= 40 ? r.name : r.repo.split('/')[1],
      author: r.repo.split('/')[0],
      url: 'https://github.com/' + r.repo,
      code: 'https://github.com/' + r.repo,
      paper: r.arxivId ? 'https://arxiv.org/abs/' + r.arxivId : null,
      project: r.project || r.homepage || null,
      task: r.tasks?.[0] || old.task || 'other',
      domainHint: r.tasks || [],
      params: old.params || null,
      license: old.license || null,
      likes: r.stars || 0,
      downloads: 0,
      trending: Math.round(r.score || 0),
      researchScore: r.llmScore ?? null,
      mentions: r.mentions || [],
      summary: old.summary || r.summaryEs || firstSentences(r.summary || r.description || '', 280),
      createdAt: r.repoCreated || r.published || r.firstSeen,
      firstSeen: old.firstSeen || now,
      lastSeen: now,
      tags: r.topics || [],
    });
  }

  // 3) Enriquecimiento (resumen en español, casos de uso, benchmarks) solo para modelos nuevos
  const pending = [...byId.values()]
    .filter((m) => m.lastSeen === now && m.enriched !== 'llm' && (!m.enriched || llmEnabled))
    .sort((a, b) => (b.watch - a.watch) || ((b.kind === 'project') - (a.kind === 'project')) || (b.trending - a.trending) || (b.likes - a.likes))
    .slice(0, MAX_ENRICH_PER_RUN);
  console.log(`· Enriqueciendo ${pending.length} modelos (LLM ${llmEnabled ? 'activado' : 'desactivado'})`);
  // El LLM (cuota gratuita limitada) se reserva para los más relevantes; el resto recibe resumen básico
  const llmSlots = await llmBudgetLeft('enrich');
  const work = [...pending.slice(0, llmSlots), ...pending.slice(llmSlots).filter((m) => !m.enriched)];
  await pool(work, 4, async (m, i) => enrich(m, taskMap[m.task], i < llmSlots));

  // 4) Estimaciones derivadas
  const all = [...byId.values()];
  // Multi-etiqueta: tarea principal + dominios detectados (un modelo de robótica puede ser también de animación)
  for (const m of all) {
    const fromText = classify(`${m.name.replace(/[-_]/g, ' ')} ${(m.tags || []).join(' ')} ${m.summary || ''} ${(m.keywords || []).join(' ')}`, customTasks).map((x) => x.tag);
    m.tasks = [...new Set([m.task, ...(m.domainHint || []), ...fromText])].slice(0, 4);
    if (m.task === 'other' && m.tasks.length > 1) { m.tasks = m.tasks.filter((t) => t !== 'other'); m.task = m.tasks[0]; }
  }
  const maxByTask = {};
  for (const m of all) {
    const k = m.task;
    maxByTask[k] ??= { likes: 1, trending: 1, downloads: 1 };
    maxByTask[k].likes = Math.max(maxByTask[k].likes, m.likes);
    maxByTask[k].trending = Math.max(maxByTask[k].trending, m.trending);
    maxByTask[k].downloads = Math.max(maxByTask[k].downloads, m.downloads);
  }
  for (const m of all) Object.assign(m, estimate(m, taskMap[m.task], maxByTask[m.task]));

  // 5) Poda: limita por tarea, conserva watchlist y modelos vistos recientemente
  const grouped = {};
  for (const m of all) {
    const stale = (Date.now() - new Date(m.lastSeen)) / 86400000 > 120;
    if (stale && !m.watch && m.likes < 1000) continue;
    (grouped[m.kind === 'project' ? 'project:' + m.task : m.task] ||= []).push(m);
  }
  const final = [];
  for (const [task, list] of Object.entries(grouped)) {
    list.sort((a, b) => (b.watch - a.watch) || (b.relevance - a.relevance));
    final.push(...list.slice(0, task === 'other' ? 40 : PER_TASK_CAP));
  }
  final.sort((a, b) => b.relevance - a.relevance);

  await writeJSON(path.join(DATA_DIR, 'models.json'), { updatedAt: now, count: final.length, models: final });
  await writeJSON(path.join(DATA_DIR, 'tasks.json'), tasks.map(({ tag, label, icon, keywords }) => ({ tag, label, icon, keywords })));
  console.log(`✓ ${final.length} modelos en el toolbox`);
  return final;
}

async function enrich(m, task, useLLM = true) {
  const readmeUrl = m.kind === 'project' ? `https://raw.githubusercontent.com/${m.id.slice(3)}/HEAD/README.md` : `https://huggingface.co/${m.id}/raw/main/README.md`;
  const readme = (await fetchText(readmeUrl, { retries: 1 })) || '';
  const plain = stripMarkdown(readme);
  // Primer párrafo con aspecto de prosa (evita badges, enlaces de navegación y tablas)
  const para = plain.split(/\n\n+/).map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p.length >= 80 && /[a-z]{3,}[^.]*\.\s|[a-z]\.$/.test(p) && !/^(try|docs|blog|paper|github|demo|license)\b/i.test(p));
  m.summary = firstSentences(para || '', 280) || m.summary || null;

  const out = useLLM && await llmJSON(
    'Eres analista de modelos de IA open source para una web en español. Respondes SOLO con un objeto JSON válido, sin texto adicional. No inventes datos que no aparezcan en la ficha.',
    `Modelo: ${m.id}
Tarea Hugging Face: ${m.pipeline_tag || m.task} (${task?.label || 'desconocida'})
Parámetros totales: ${m.params ? (m.params / 1e9).toFixed(2) + 'B' : 'desconocido'}
Etiquetas: ${(m.tags || []).join(', ')}
Licencia: ${m.license || 'desconocida'}

FICHA (README, recortada):
"""
${readme.slice(0, 7000)}
"""

Devuelve este JSON:
{
  "resumen": "2-3 frases en español: qué hace, qué lo distingue y para quién es útil",
  "casos_uso": ["3-5 problemas concretos que resuelve, en español"],
  "keywords": ["8-15 términos de búsqueda en español e inglés que un usuario escribiría"],
  "tarea": "pipeline tag de Hugging Face más adecuado si la tarea es desconocida, si no repite la indicada",
  "parametros_activos_b": número en miles de millones si es MoE y la ficha lo indica, si no null,
  "benchmarks": [{"nombre": "benchmark", "valor": "puntuación tal cual aparece"}],
  "calidad": entero 1-10 estimando la calidad frente al estado del arte open source de su tarea según los benchmarks y comparativas de la ficha (5 si no hay datos),
  "calidad_motivo": "una frase justificando la puntuación",
  "hardware_nota": "requisitos de hardware si la ficha los menciona, si no null",
  "velocidad_nota": "tiempos de inferencia si la ficha los menciona, si no null",
  "vram_gb": número con la VRAM mínima en GB si la ficha la indica, si no null,
  "parametros_b": número de parámetros en miles de millones si la ficha lo indica, si no null
}`,
    { maxTokens: 1200, kind: 'enrich' }
  );
  if (out) {
    m.summary = out.resumen || m.summary;
    m.useCases = arr(out.casos_uso).slice(0, 5);
    m.keywords = arr(out.keywords).slice(0, 20);
    m.benchmarks = arr(out.benchmarks).filter((b) => b && b.nombre).slice(0, 6).map((b) => ({ name: String(b.nombre), value: String(b.valor) }));
    if (num(out.calidad)) m.qualityLLM = Math.max(1, Math.min(10, Math.round(out.calidad)));
    m.qualityReason = out.calidad_motivo || null;
    m.hardwareNote = out.hardware_nota || null;
    m.speedNote = out.velocidad_nota || null;
    if (num(out.parametros_activos_b)) m.activeParams = out.parametros_activos_b * 1e9;
    if (num(out.vram_gb)) m.statedVram = out.vram_gb;
    if (!m.params && num(out.parametros_b)) m.params = out.parametros_b * 1e9;
    if (m.task === 'other' && typeof out.tarea === 'string' && /^[a-z0-9-]+$/.test(out.tarea)) m.task = out.tarea;
    m.enriched = 'llm';
  } else {
    m.enriched = m.enriched || 'basic'; // con LLM disponible se reintenta en otra ejecución
    m.keywords = m.keywords || [];
  }
}

// ---------- Estimaciones ----------

const GPU_TIERS = [
  [1.5, 'CPU / móvil'],
  [4, 'Portátil / GPU 4 GB'],
  [8, 'GPU 8 GB'],
  [12, 'GPU 12 GB'],
  [16, 'GPU 16 GB'],
  [24, 'GPU 24 GB'],
  [48, 'GPU 48 GB / 2× 24 GB'],
  [80, 'GPU 80 GB (H100/A100)'],
  [Infinity, 'Multi-GPU / servidor'],
];
const SPEED_LABELS = ['', 'Lento', 'Medio', 'Rápido', 'Muy rápido'];
const HEAVY_TASKS = new Set(['text-to-video', 'image-to-video', 'text-to-3d', 'image-to-3d', 'any-to-any']);

export function estimate(m, task, max) {
  const P = m.params || null;
  const isLLM = Boolean(task?.llm);
  const out = { vram: null, minVram: null, hwTier: 'Desconocido', speed: null, quality: 0, relevance: 0 };

  if (m.statedVram) {
    out.minVram = m.statedVram;
    out.hwTier = GPU_TIERS.find(([lim]) => out.minVram <= lim)[1];
  }
  if (P) {
    const gb = (bytesPerParam) => +(P * bytesPerParam * 1.2 / 1e9 + 0.3).toFixed(1);
    out.vram = { q4: gb(0.57), q8: gb(1.07), fp16: gb(2) };
    // LLMs se suelen ejecutar cuantizados a 4 bits (GGUF/AWQ); el resto en fp16/bf16
    out.minVram = m.statedVram || (isLLM || m.hasQuant ? out.vram.q4 : out.vram.fp16);
    out.hwTier = GPU_TIERS.find(([lim]) => out.minVram <= lim)[1];

    if (isLLM) {
      const active = (m.activeParams || P) / 1e9;
      let ref, bw, size;
      if (out.minVram <= 24) { ref = 'RTX 4090 (Q4)'; bw = 1008; size = active * 0.57; }
      else if (out.minVram <= 80) { ref = 'H100 80 GB (Q4)'; bw = 3350; size = active * 0.57; }
      else { ref = '8× H100 (FP8)'; bw = 3350 * 4; size = active * 1.07; }
      const tps = Math.min(400, Math.round((bw * 0.6) / Math.max(size, 0.05)));
      const level = tps >= 80 ? 4 : tps >= 30 ? 3 : tps >= 10 ? 2 : 1;
      out.speed = { value: tps, unit: 'tok/s', ref, level, label: SPEED_LABELS[level] };
    } else {
      const b = P / 1e9;
      let level = b < 0.5 ? 4 : b < 3 ? 3 : b < 15 ? 2 : 1;
      if (HEAVY_TASKS.has(m.task)) level = Math.max(1, level - 1);
      out.speed = { value: null, unit: null, ref: 'estimación por tamaño', level, label: SPEED_LABELS[level] };
    }
  }

  // Calidad: estimación del LLM a partir de benchmarks de la ficha + señal de la comunidad
  const lg = (v, mx) => Math.log10((v || 0) + 1) / Math.log10((mx || 1) + 1);
  const community = Math.max(lg(m.likes, max.likes), lg(m.trending, max.trending) * 0.95, lg(m.downloads, max.downloads) * 0.9);
  const expert = m.qualityLLM || m.researchScore;
  out.quality = expert
    ? Math.round(expert * 10 * 0.65 + community * 100 * 0.35)
    : Math.round(community * 90);
  // Proyectos de investigación: sin likes del Hub, la señal es la puntuación del radar de investigación
  if (m.kind === 'project') out.quality = Math.max(out.quality, Math.min(85, Math.round((m.trending || 0) * 2)));
  const ageDays = (Date.now() - new Date(m.createdAt || m.firstSeen)) / 86400000;
  out.relevance = +(out.quality * 0.6 + lg(m.trending, max.trending) * 40 + Math.max(0, 30 - ageDays) / 3).toFixed(2);
  out.permissive = m.license ? PERMISSIVE.test(m.license) : null;
  return out;
}

function paramsFromName(id) {
  const name = id.split('/')[1] || id;
  const moe = name.match(/(\d+)x(\d+(?:\.\d+)?)([BM])/i);
  if (moe) return +moe[1] * +moe[2] * (moe[3].toUpperCase() === 'B' ? 1e9 : 1e6);
  const m = name.match(/(?:^|[-_.\s])(\d+(?:\.\d+)?)([BM])(?![a-z])/i);
  if (!m) return null;
  return +m[1] * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6);
}

function activeFromName(id) {
  const m = (id.split('/')[1] || '').match(/[-_]A(\d+(?:\.\d+)?)B(?![a-z])/i);
  return m ? +m[1] * 1e9 : null;
}

const tagValue = (tags = [], key) => tags.find((t) => t.startsWith(key + ':'))?.split(':')[1] || null;
const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
