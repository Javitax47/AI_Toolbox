// Recolecta modelos open source de Hugging Face y proyectos de investigación, obtiene datos objetivos
// (benchmarks, tamaño real de los pesos, requisitos declarados) y los compara dentro de cada tarea.
import path from 'node:path';
import { fetchJSON, fetchText, readJSON, writeJSON, pool, stripMarkdown, firstSentences, DATA_DIR, CONFIG_DIR, STATE_DIR } from './util.mjs';
import { llmJSON, llmEnabled, llmBudgetLeft } from './llm.mjs';
import { classify } from './research.mjs';
import { structuredEvals, readmeBenchmarks, readmeFacts, weightsSize, loadArena, arenaIndex, arenaFor, mergeBenchmarks } from './evals.mjs';
import { compareModels } from './compare.mjs';

const HF = 'https://huggingface.co/api/models';
const EXPAND = ['safetensors', 'pipeline_tag', 'likes', 'downloads', 'createdAt', 'lastModified', 'tags', 'trendingScore', 'cardData', 'evalResults']
  .map((e) => `expand[]=${e}`).join('&');

const PER_TASK_LIMIT = 60;
const PER_TASK_CAP = 90;
const TASK_CAP = { 'text-generation': 160, 'image-text-to-text': 120 };
const MAX_ENRICH_PER_RUN = Number(process.env.MAX_ENRICH_PER_RUN || 40);
const MAX_ANALYZE_PER_RUN = Number(process.env.MAX_ANALYZE_PER_RUN || 250);
const MAX_TREE_PER_RUN = Number(process.env.MAX_TREE_PER_RUN || 100);
const EVALS_FILE = path.join(STATE_DIR, 'model-evals.json');
const FACTS_VERSION = 5; // subir para volver a analizar todas las fichas

const QUANT_RE = /(gguf|[-_.]awq|gptq|[-_]mlx|mlx[-_]|exl2|exl3|[-_]int[48]\b|bnb|[-_][2-8]bit|onnx|fp8[-_]dynamic|nvfp4|[-_]q[2-8]_)/i;
const PERMISSIVE = /^(apache-2\.0|mit|bsd.*|cc-by-4\.0|cc0-1\.0|openrail.*|creativeml-openrail-m|unlicense|isc|mpl-2\.0|artistic-2\.0)$/i;
const DTYPE_BYTES = { F64: 8, F32: 4, BF16: 2, F16: 2, F8_E4M3: 1, F8_E5M2: 1, I8: 1, U8: 1, I32: 4, I64: 8, I16: 2, BOOL: 1 };

export async function updateModels(research = []) {
  const tasks = await readJSON(path.join(CONFIG_DIR, 'tasks.json'), []);
  const rcfg = (await readJSON(path.join(CONFIG_DIR, 'sources.json'), {})).research || {};
  const customTasks = tasks.filter((t) => t.custom);
  const taskMap = Object.fromEntries(tasks.map((t) => [t.tag, t]));
  const watch = (await readJSON(path.join(CONFIG_DIR, 'watchlist.json'), { searches: [] })).searches;
  const prev = await readJSON(path.join(DATA_DIR, 'models.json'), { models: [] });
  const saved = await loadModelEvals();
  const byId = new Map(prev.models.map((m) => [m.id, { ...m, ...(saved[m.id] || {}) }]));
  const now = new Date().toISOString();

  // 1) Descarga: trending global + trending por tarea + recientes con likes + watchlist
  const urls = [
    `${HF}?sort=trendingScore&limit=300&${EXPAND}`,
    `${HF}?sort=createdAt&limit=500&${EXPAND}`,
    ...tasks.filter((t) => !t.custom).map((t) => `${HF}?pipeline_tag=${t.tag}&sort=trendingScore&limit=${PER_TASK_LIMIT}&${EXPAND}`),
    ...tasks.filter((t) => !t.custom).map((t) => `${HF}?pipeline_tag=${t.tag}&sort=likes30d&limit=25&${EXPAND}`),
    // LLMs consolidados (los que aparecen en clasificaciones aunque ya no sean tendencia)
    `${HF}?pipeline_tag=text-generation&sort=likes&limit=120&${EXPAND}`,
    `${HF}?pipeline_tag=image-text-to-text&sort=likes&limit=60&${EXPAND}`,
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
  const singles = await pool([...researchByWeight.keys()], 6, (id) => fetchJSON(`${HF}/${id}?${EXPAND}`, { retries: 1 }));
  // Solo cuenta como coincidencia si el término aparece como palabra en el nombre (evita "IDOL" → "idolsankaku")
  const watchIds = new Set(lists.slice(urls.length, urls.length + watchUrls.length).flatMap((list, n) => {
    const q = watch[n].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[-_./])${q}($|[-_.\\d])`, 'i');
    return (list || []).filter((m) => re.test(m.id.split('/')[1])).map((m) => m.id);
  }));
  lists.push(singles.filter((m) => m && m.id));

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
    const st = m.safetensors;
    const nativeGB = st?.parameters ? +(Object.entries(st.parameters).reduce((s, [d, n]) => s + n * (DTYPE_BYTES[d] || 2), 0) / 1e9).toFixed(2) : null;
    const r = researchByWeight.get(m.id);
    const rec = {
      ...old,
      id: m.id,
      name: m.id.split('/')[1],
      author: m.id.split('/')[0],
      url: `https://huggingface.co/${m.id}`,
      task,
      params: st?.total || paramsFromName(m.id) || (old.paramsApprox ? null : old.params) || null,
      paramsApprox: false,
      activeParams: old.activeParams || activeFromName(m.id) || null,
      nativeGB: nativeGB || old.nativeGB || null,
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
      domainHint: [...new Set([...(old.domainHint || []), ...(domainHint.get(m.id) || []), ...(r?.tasks || [])])],
      paper: r?.arxivId ? `https://arxiv.org/abs/${r.arxivId}` : old.paper || arxivTag(m.tags) || null,
      code: r?.repo ? `https://github.com/${r.repo}` : old.code || null,
      mentions: r?.mentions || old.mentions || [],
      evalsHF: structuredEvals(m),
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
    const created = r.repoCreated || r.published || r.firstSeen;
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
      task: (r.tasks || []).find((t) => taskMap[t]) || old.task || 'other',
      domainHint: (r.tasks || []).filter((t) => taskMap[t]),
      params: old.params || null,
      license: old.license || null,
      likes: r.stars || 0,
      starVelocity: +((r.stars || 0) / Math.max(3, (Date.now() - new Date(created)) / 86400000)).toFixed(1),
      downloads: 0,
      trending: Math.round(r.score || 0),
      researchScore: r.llmScore ?? null,
      mentions: r.mentions || [],
      summary: old.summary || r.summaryEs || firstSentences(r.summary || r.description || '', 280),
      createdAt: created,
      firstSeen: old.firstSeen || now,
      lastSeen: now,
      tags: r.topics || [],
    });
  }

  // 3) Análisis de fichas (README): benchmarks en tablas, requisitos y velocidad declarados, tamaño de los pesos
  const current = [...byId.values()].filter((m) => m.lastSeen === now);
  const readmes = new Map();
  const getReadme = async (m) => {
    if (!readmes.has(m.id)) {
      const url = m.kind === 'project' ? `https://raw.githubusercontent.com/${m.id.slice(3)}/HEAD/README.md` : `https://huggingface.co/${m.id}/raw/main/README.md`;
      const text = await fetchText(url, { retries: 1 });
      readmes.set(m.id, text === undefined ? undefined : text || '');
    }
    return readmes.get(m.id);
  };
  const toAnalyze = current.filter((m) => m.factsV !== FACTS_VERSION).sort((a, b) => b.likes - a.likes).slice(0, MAX_ANALYZE_PER_RUN);
  console.log(`· Analizando ${toAnalyze.length} fichas (benchmarks, requisitos, tamaño de pesos)`);
  let treeCalls = 0;
  await pool(toAnalyze, 6, async (m) => {
    const readme = await getReadme(m);
    if (readme === undefined) return; // se reintenta en la próxima ejecución
    m.readmeBench = readme ? readmeBenchmarks(readme, m.name) : [];
    const facts = readme ? readmeFacts(readme) : {};
    m.speedStated = facts.speedStated || null;
    m.vramStated = facts.vramStated || null;
    m.aiEvidence = facts.aiEvidence ?? null;
    // El listado de ficheros usa la API (con límite de peticiones): se reparte entre ejecuciones
    if (m.kind === 'model' && !m.nativeGB && m.weightsV !== 1) {
      if (treeCalls++ >= MAX_TREE_PER_RUN) return;
      const gb = await weightsSize(m.id);
      if (gb === undefined) return;
      m.weightsGB = gb;
      m.weightsV = 1;
    }
    m.factsV = FACTS_VERSION;
  });

  // 3b) Enriquecimiento con LLM (resumen en español, casos de uso, benchmarks) para los más relevantes
  const pending = current
    .filter((m) => m.enriched !== 'llm' && (!m.enriched || llmEnabled))
    .sort((a, b) => (b.watch - a.watch) || ((b.kind === 'project') - (a.kind === 'project')) || (b.trending - a.trending) || (b.likes - a.likes))
    .slice(0, MAX_ENRICH_PER_RUN);
  const llmSlots = await llmBudgetLeft('enrich');
  const work = [...pending.slice(0, llmSlots), ...pending.slice(llmSlots).filter((m) => !m.enriched)];
  console.log(`· Enriqueciendo ${work.length} modelos (LLM ${llmEnabled ? 'activado' : 'desactivado'})`);
  await pool(work, 4, async (m, i) => enrich(m, taskMap[m.task], await getReadme(m), i < llmSlots));

  // 4) Categorías: solo fuentes explícitas (pipeline tag, etiquetas del Hub, clasificación del paper)
  const all = [...byId.values()].filter((m) => {
    // Solo IA: un proyecto sin paper ni pesos tiene que demostrar en su README que es un sistema de ML
    if (m.kind !== 'project') return true;
    if (m.paper) return true;
    if (m.task === 'agents') return false;
    return (m.aiEvidence ?? 3) >= 3;
  });
  for (const m of all) {
    m.domainHint = (m.domainHint || []).filter((t) => taskMap[t]);
    // Un dominio explícito (etiqueta del Hub o paper) describe mejor el modelo que el pipeline tag genérico:
    // HY-Motion tiene pipeline "text-to-3d" pero es animación
    const custom = m.domainHint.find((t) => taskMap[t].custom);
    if (custom && !taskMap[m.task]?.llm) m.task = custom; // (un LLM etiquetado "agent" sigue siendo un LLM)
    else if (!taskMap[m.task] && m.domainHint.length) m.task = m.domainHint[0];
    if (m.task === 'other' || (!taskMap[m.task] && m.kind === 'project')) {
      const guess = classify(`${m.name.replace(/[-_]/g, ' ')} ${(m.tags || []).join(' ')} ${m.summary || ''}`, m.kind === 'project' ? tasks : customTasks)[0];
      m.task = guess?.tag || 'other';
    }
    m.tasks = [...new Set([m.task, ...m.domainHint])].slice(0, 3);
  }

  // 5) Benchmarks (todas las fuentes) + LMArena
  const arena = await loadArena();
  const aidx = arenaIndex(arena);
  for (const m of all) {
    m.benchmarks = mergeBenchmarks(m.kind === 'model' ? arenaFor(m, aidx) : [], m.evalsHF, m.readmeBench, m.benchLLM);
    Object.assign(m, estimate(m, taskMap[m.task]));
  }
  const boards = compareModels(all);
  const maxTrend = {};
  for (const m of all) maxTrend[m.task] = Math.max(maxTrend[m.task] || 1, m.trending);
  for (const m of all) {
    const lg = (v, mx) => Math.log10((v || 0) + 1) / Math.log10((mx || 1) + 1);
    const ageDays = (Date.now() - new Date(m.createdAt || m.firstSeen)) / 86400000;
    m.quality = m.cmp.score;
    m.relevance = +(m.cmp.score * 0.45 + (m.cmp.basis !== 'comunidad' ? 10 : 0) + lg(m.trending, maxTrend[m.task]) * 40
      + Math.max(0, 30 - ageDays) / 3 - (m.cmp.dominatedBy.length ? 25 : 0)).toFixed(2);
  }

  // 6) Poda: limita por tarea, conserva watchlist, modelos con benchmarks y vistos recientemente
  const grouped = {};
  for (const m of all) {
    const stale = (Date.now() - new Date(m.lastSeen)) / 86400000 > 120;
    if (stale && !m.watch && m.likes < 1000) continue;
    (grouped[m.kind === 'project' ? 'project:' + m.task : m.task] ||= []).push(m);
  }
  const final = [];
  for (const [task, list] of Object.entries(grouped)) {
    list.sort((a, b) => (b.watch - a.watch) || (b.relevance - a.relevance));
    final.push(...list.slice(0, task === 'other' ? 40 : TASK_CAP[task] || PER_TASK_CAP));
  }
  final.sort((a, b) => b.relevance - a.relevance);
  // Datos de trabajo que no necesita la web
  const slim = final.map(({ evalsHF, readmeBench, benchLLM, ...m }) => m);

  await writeJSON(path.join(DATA_DIR, 'models.json'), { updatedAt: now, count: slim.length, boards, models: slim });
  await writeJSON(path.join(DATA_DIR, 'tasks.json'), tasks.map(({ tag, label, icon, keywords, llm }) => ({ tag, label, icon, keywords, llm: Boolean(llm) })));
  console.log(`✓ ${final.length} modelos en el toolbox · ${final.filter((m) => m.cmp.basis !== 'comunidad').length} con benchmarks · ${final.filter((m) => m.cmp.dominatedBy.length).length} superados por otro`);
  // Se guardan también los datos de trabajo en el estado para no repetir análisis
  await writeJSON(EVALS_FILE, Object.fromEntries(final.map((m) => [m.id, { evalsHF: m.evalsHF, readmeBench: m.readmeBench, benchLLM: m.benchLLM }])), true);
  return final;
}

/** Recupera los datos de trabajo guardados en el estado (benchmarks de la ficha, etc.) */
export async function loadModelEvals() {
  return readJSON(EVALS_FILE, {});
}

async function enrich(m, task, readme, useLLM = true) {
  const plain = stripMarkdown(readme);
  // Primer párrafo con aspecto de prosa (evita badges, enlaces de navegación y tablas)
  const para = plain.split(/\n\n+/).map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p.length >= 80 && /[a-z]{3,}[^.]*\.\s|[a-z]\.$/.test(p) && !/^(try|docs|blog|paper|github|demo|license)\b/i.test(p));
  if (m.kind !== 'project' || !m.summary) m.summary = firstSentences(para || '', 280) || m.summary || null;

  const out = useLLM && readme && await llmJSON(
    'Eres analista de modelos de IA open source para una web en español. Respondes SOLO con un objeto JSON válido, sin texto adicional. No inventes datos que no aparezcan en la ficha.',
    `Modelo: ${m.id}
Tarea: ${m.task} (${task?.label || 'desconocida'})
Parámetros totales: ${m.params ? (m.params / 1e9).toFixed(2) + 'B' : 'desconocido'}
Etiquetas: ${(m.tags || []).join(', ')}
Licencia: ${m.license || 'desconocida'}

FICHA (README, recortada):
"""
${readme.slice(0, 7000)}
"""

Devuelve este JSON:
{
  "es_ia": true si es un modelo o sistema de inteligencia artificial / aprendizaje automático, false si es otra cosa (utilidad, juego, colección de recursos…),
  "resumen": "2-3 frases en español: qué hace, qué lo distingue y para quién es útil",
  "casos_uso": ["3-5 problemas concretos que resuelve, en español"],
  "keywords": ["8-15 términos de búsqueda en español e inglés que un usuario escribiría"],
  "parametros_activos_b": número en miles de millones si es MoE y la ficha lo indica, si no null,
  "benchmarks": [{"nombre": "nombre del benchmark", "valor": número}],  // SOLO resultados de ESTE modelo (no de los competidores), como número
  "hardware_nota": "requisitos de hardware si la ficha los menciona, si no null",
  "velocidad_nota": "tiempos de inferencia si la ficha los menciona, si no null",
  "vram_gb": número con la VRAM mínima en GB si la ficha la indica, si no null,
  "parametros_b": número de parámetros en miles de millones si la ficha lo indica, si no null
}`,
    { maxTokens: 1400, kind: 'enrich' }
  );
  if (out) {
    m.summary = out.resumen || m.summary;
    m.useCases = arr(out.casos_uso).slice(0, 5);
    m.keywords = arr(out.keywords).slice(0, 20);
    m.benchLLM = arr(out.benchmarks).filter((b) => b && b.nombre && Number.isFinite(+b.valor)).slice(0, 20).map((b) => ({ name: String(b.nombre), value: +b.valor, source: 'ficha' }));
    m.hardwareNote = out.hardware_nota || null;
    m.speedNote = out.velocidad_nota || null;
    if (out.es_ia === false) m.aiEvidence = 0;
    if (num(out.parametros_activos_b)) m.activeParams = out.parametros_activos_b * 1e9;
    if (num(out.vram_gb)) m.statedVram = out.vram_gb;
    if (!m.params && num(out.parametros_b)) m.params = out.parametros_b * 1e9;
    m.enriched = 'llm';
  } else {
    m.enriched = m.enriched || 'basic'; // con LLM disponible se reintenta en otra ejecución
    m.keywords = m.keywords || [];
  }
}

// ---------- Estimaciones de hardware y velocidad ----------

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

export function estimate(m, task) {
  const out = { vram: null, minVram: null, vramBasis: null, hwTier: null, speed: null, permissive: m.license ? PERMISSIVE.test(m.license) : null };
  const isLLM = Boolean(task?.llm);
  const weights = m.nativeGB || m.weightsGB || null;
  let P = m.params || null;
  if (!P && weights) { P = weights * 1e9 / 2; out.params = P; out.paramsApprox = true; }
  if (P) {
    const gb = (bytesPerParam) => +(P * bytesPerParam * 1.2 / 1e9 + 0.3).toFixed(1);
    out.vram = { q4: gb(0.57), q8: gb(1.07), fp16: gb(2) };
  }
  // Memoria mínima: lo que declara la ficha > LLM cuantizado a 4 bits > pesos publicados (precisión nativa)
  const stated = m.statedVram || m.vramStated;
  if (stated) { out.minVram = stated; out.vramBasis = 'declarada en la ficha'; }
  else if (out.vram && (isLLM || m.hasQuant)) { out.minVram = out.vram.q4; out.vramBasis = 'estimada con cuantización de 4 bits'; }
  else if (weights) { out.minVram = +(weights * 1.15 + 0.3).toFixed(1); out.vramBasis = 'estimada a partir del tamaño de los pesos publicados'; }
  else if (out.vram) { out.minVram = out.vram.fp16; out.vramBasis = 'estimada a partir de los parámetros (16 bits)'; }
  if (out.minVram != null) out.hwTier = GPU_TIERS.find(([lim]) => out.minVram <= lim)[1];

  if (isLLM && P && out.minVram != null) {
    // Generación limitada por ancho de banda: tok/s ≈ ancho de banda útil / bytes leídos por token
    const active = (m.activeParams || P) / 1e9;
    let ref, bw, size;
    if (out.minVram <= 24) { ref = 'RTX 4090, 4 bits'; bw = 1008; size = active * 0.57; }
    else if (out.minVram <= 80) { ref = 'H100 80 GB, 4 bits'; bw = 3350; size = active * 0.57; }
    else { ref = '8× H100, FP8'; bw = 3350 * 4; size = active * 1.07; }
    const tps = Math.min(400, Math.round((bw * 0.6) / Math.max(size, 0.05)));
    out.speed = { value: tps, unit: 'tok/s', ref, level: tps >= 80 ? 4 : tps >= 30 ? 3 : tps >= 10 ? 2 : 1, estimated: true };
  } else if (m.speedNote || m.speedStated) {
    const text = m.speedNote || m.speedStated;
    out.speed = { text, ref: 'según la ficha', level: /real[- ]?time|tiempo real|fps|\b0\.0\d/i.test(text) ? 4 : 2 };
  }
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

const arxivTag = (tags = []) => { const t = tags.find((x) => x.startsWith('arxiv:')); return t ? `https://arxiv.org/abs/${t.slice(6)}` : null; };
const tagValue = (tags = [], key) => tags.find((t) => t.startsWith(key + ':'))?.split(':')[1] || null;
const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
