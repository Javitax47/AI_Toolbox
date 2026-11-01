// Radar IA — frontend estático (sin build). Lee /data/*.json generados por scripts/update.mjs
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');

const S = {
  models: [], tasks: [], taskMap: {}, articles: [], meta: {}, boards: {}, byId: new Map(),
  filters: defaultFilters(),
  query: '',
  shown: 48,
  dismissed: new Set(), // restricciones detectadas que el usuario ha quitado
};

function defaultFilters() {
  return { task: '', kind: '', maxVram: '', params: '', speed: 0, hideDominated: true, evidence: false, permissive: false, age: '', sort: 'relevance', quant: false };
}

// ---------- utilidades ----------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s = '') => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0));
const fmtParams = (p) => (!p ? '—' : p >= 1e9 ? `${+(p / 1e9).toFixed(p < 1e10 ? 1 : 0)}B` : `${Math.round(p / 1e6)}M`);
const paramsOf = (m) => (m.params ? (m.paramsApprox ? '≈' : '') + fmtParams(m.params) : '—');
const fmtVal = (v) => (v == null ? '—' : Math.abs(v) >= 100 ? String(Math.round(v)) : String(+v.toFixed(2)));
const bench = (m, key) => (m.benchmarks || []).find((b) => b.key === key);
const hasEvidence = (m) => m.cmp && m.cmp.basis !== 'comunidad';
const speedOf = (m) => (m.speed?.value ? `~${m.speed.value} tok/s` : m.speed?.text ? (m.speed.level >= 4 ? 'Tiempo real' : 'Declarada') : '—');
const SOURCE = { hf: 'Hugging Face (eval results)', 'model-index': 'ficha (model-index)', ficha: 'ficha / README', arena: 'LMArena (votos humanos)' };
const daysSince = (d) => (Date.now() - new Date(d)) / 86400000;
const timeAgo = (d) => {
  const m = (Date.now() - new Date(d)) / 60000;
  if (m < 60) return `hace ${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `hace ${Math.round(m / 60)} h`;
  if (m < 43200) return `hace ${Math.round(m / 1440)} d`;
  return new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtDate = (d) => new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
const taskLabel = (t) => S.taskMap[t]?.label || (t === 'other' ? 'Otros' : t.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
const taskIcon = (t) => S.taskMap[t]?.icon || '🧩';
const tasksOf = (m) => m.tasks || [m.task];
const isProject = (m) => m.kind === 'project';
const CAT_ICON = { Lanzamiento: '🚀', 'Open Source': '🔓', Investigación: '🔬', Industria: '🏢', Herramientas: '🛠️', Negocio: '💼' };

async function load() {
  const get = (p) => fetch(p, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [models, tasks, articles, meta] = await Promise.all([get('data/models.json'), get('data/tasks.json'), get('data/articles.json'), get('data/meta.json')]);
  S.models = models?.models || [];
  S.boards = models?.boards || {};
  S.byId = new Map(S.models.map((m) => [m.id, m]));
  S.tasks = tasks || [];
  S.taskMap = Object.fromEntries(S.tasks.map((t) => [t.tag, t]));
  S.articles = articles?.articles || [];
  S.meta = meta || {};
  // índice de artículos por modelo
  S.articlesByModel = {};
  for (const a of S.articles) for (const id of a.modelIds || []) (S.articlesByModel[id] ||= []).push(a);
  // texto de búsqueda precalculado
  for (const m of S.models) {
    m._hay = norm([m.id, m.summary, (m.keywords || []).join(' '), (m.useCases || []).join(' '), (m.tags || []).join(' '), taskLabel(m.task)].join(' '));
  }
  if (S.meta.updatedAt) $('#updated').textContent = `Actualizado ${timeAgo(S.meta.updatedAt)}`;
}

// ---------- búsqueda por problema ----------
const STOP = new Set('que quiero necesito busco para con una uno unos unas los las del por como mas sin hacer algo modelo modelos the and for with from tengo puedo mejor mis mi sea pueda desde'.split(' '));

function parseQuery(q) {
  const n = norm(q);
  const out = { tokens: [], taskScores: {}, constraints: {} };
  const words = n.split(/[^a-z0-9.]+/).filter(Boolean);
  out.tokens = words.filter((t) => t.length > 2 && !STOP.has(t));
  // una palabra clave casa si todas sus palabras aparecen en la consulta (plural/singular tolerado)
  const has = (w) => words.some((q) => q === w || (w.length >= 4 && (q.startsWith(w) || (q.length >= 4 && w.startsWith(q)))));
  for (const t of S.tasks) {
    let s = 0;
    for (const k of t.keywords) {
      const kw = norm(k).split(/[\s-]+/).filter((w) => w.length > 2 || /\d/.test(w));
      if (kw.every(has)) s += kw.length > 1 ? 3 * kw.length : 2;
    }
    if (s) out.taskScores[t.tag] = s;
  }
  out.maxTask = Math.max(0, ...Object.values(out.taskScores));
  const gb = n.match(/(\d+(?:[.,]\d+)?)\s*gb/);
  if (gb) out.constraints.maxVram = parseFloat(gb[1].replace(',', '.'));
  else if (/(sin gpu|solo cpu|\bcpu\b|movil|raspberry|telefono|smartphone|navegador)/.test(n)) out.constraints.maxVram = 2;
  else if (/(portatil|laptop|macbook|pc normal|ordenador normal)/.test(n)) out.constraints.maxVram = 8;
  if (/(comercial|empresa|negocio|producto)/.test(n)) out.constraints.permissive = true;
  if (/(tiempo real|real time|realtime|rapido|instantaneo|baja latencia)/.test(n)) out.constraints.speed = 3;
  if (/(espanol|castellano|spanish)/.test(n)) out.constraints.spanish = true;
  for (const k of Object.keys(out.constraints)) if (S.dismissed.has(k)) delete out.constraints[k];
  return out;
}

function scoreModel(m, pq) {
  if (!pq.tokens.length && !Object.keys(pq.taskScores).length) return m.relevance;
  let s = 0;
  const ts = Math.max(0, ...tasksOf(m).map((t) => pq.taskScores[t] || 0));
  if (ts) s += 60 * (ts / pq.maxTask);
  let hits = 0;
  for (const t of pq.tokens) {
    if (norm(m.name).includes(t)) { s += 25; hits++; }
    else if (m._hay.includes(t)) { s += 6; hits++; }
  }
  if (!ts && !hits) return -1;
  // si la consulta apunta a una tarea concreta, otras tareas solo entran con coincidencias fuertes
  if (pq.maxTask && !ts && hits < 2) return -1;
  if (pq.constraints.spanish && (m.languages || []).includes('es')) s += 8;
  // Entre candidatos de la misma tarea pesa más el que rinde mejor frente a sus competidores
  return s + (m.cmp?.score || 0) * (hasEvidence(m) ? 0.3 : 0.15) + Math.min(15, m.trending / 20) - (m.cmp?.dominatedBy?.length ? 15 : 0);
}

function filterModels() {
  const f = S.filters;
  const pq = parseQuery(S.query);
  const c = pq.constraints;
  const maxVram = f.maxVram !== '' ? +f.maxVram : c.maxVram;
  const minSpeed = Math.max(f.speed, c.speed || 0);
  const permissive = f.permissive || c.permissive;
  let list = S.models.map((m) => ({ m, s: scoreModel(m, pq) })).filter(({ m, s }) => {
    if (s < 0) return false;
    if (f.task && !tasksOf(m).includes(f.task)) return false;
    if (f.kind && (m.kind || 'model') !== f.kind) return false;
    if (maxVram != null && !(m.minVram != null && m.minVram <= maxVram)) return false;
    if (f.params) { const [lo, hi] = f.params.split('-').map(Number); const b = (m.params || 0) / 1e9; if (!m.params || b < lo || b >= hi) return false; }
    if (minSpeed && !(m.speed && m.speed.level >= minSpeed)) return false;
    if (f.hideDominated && m.cmp?.dominatedBy?.length) return false;
    if (f.evidence && !hasEvidence(m)) return false;
    if (permissive && m.permissive !== true) return false;
    if (f.quant && !m.hasQuant) return false;
    if (f.age && daysSince(m.createdAt) > +f.age) return false;
    return true;
  });
  const sorters = {
    relevance: (a, b) => b.s - a.s,
    quality: (a, b) => (hasEvidence(b.m) - hasEvidence(a.m)) || (b.m.cmp?.score || 0) - (a.m.cmp?.score || 0),
    trending: (a, b) => b.m.trending - a.m.trending,
    newest: (a, b) => new Date(b.m.createdAt) - new Date(a.m.createdAt),
    vram: (a, b) => (a.m.minVram ?? 1e9) - (b.m.minVram ?? 1e9),
    speed: (a, b) => (b.m.speed?.level || 0) - (a.m.speed?.level || 0) || (b.m.speed?.value || 0) - (a.m.speed?.value || 0),
  };
  list.sort(sorters[f.sort] || sorters.relevance);
  return { list: list.map((x) => x.m), pq };
}

// ---------- vistas: toolbox ----------
const EXAMPLES = [
  'quitar el fondo de un vídeo con pelo',
  'transcribir reuniones en español en mi portátil',
  'clonar mi voz para narrar audiolibros',
  'convertir una foto en un modelo 3D con 8 GB',
  'agente de programación que corra en 24 GB',
  'leer facturas y PDFs (OCR)',
  'traducción simultánea de voz',
  'controlar un robot humanoide',
];

function renderToolbox() {
  const counts = {};
  for (const m of S.models) for (const t of tasksOf(m)) counts[t] = (counts[t] || 0) + 1;
  const taskOrder = [...S.tasks.map((t) => t.tag), ...Object.keys(counts).filter((t) => !S.taskMap[t]).sort((a, b) => counts[b] - counts[a])].filter((t) => counts[t]);
  const newCount = S.models.filter((m) => daysSince(m.createdAt) <= 7).length;

  app.innerHTML = `
  <section class="hero">
    <h1>¿Qué problema quieres resolver?</h1>
    <p>${S.models.length} modelos open source indexados · ${newCount} publicados esta semana. Describe tu caso con tus palabras y filtra por hardware, velocidad, tamaño y calidad.</p>
    <div class="search"><input id="q" type="search" autocomplete="off" placeholder="Ej.: quiero transcribir entrevistas en español sin GPU" value="${esc(S.query)}" /></div>
    <div class="examples">${EXAMPLES.map((e) => `<button data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div>
    <div class="detected" id="detected"></div>
    <div class="task-strip">
      <button class="task-chip ${!S.filters.task ? 'active' : ''}" data-task="">Todas <small>${S.models.length}</small></button>
      ${taskOrder.map((t) => `<button class="task-chip ${S.filters.task === t ? 'active' : ''}" data-task="${t}">${taskIcon(t)} ${esc(taskLabel(t))} <small>${counts[t]}</small></button>`).join('')}
    </div>
  </section>
  <section class="toolbox">
    <aside class="filters" id="filters">
      <h3>Filtros</h3>
      <label>Tipo
        <select data-f="kind">
          <option value="">Modelos y proyectos</option>
          <option value="model">Modelos con pesos (Hugging Face)</option>
          <option value="project">Proyectos de investigación (código)</option>
        </select>
      </label>
      <label>Hardware disponible
        <select data-f="maxVram">
          <option value="">Cualquiera</option>
          <option value="2">Solo CPU / móvil (≤ 2 GB)</option>
          <option value="4">Portátil básico (≤ 4 GB)</option>
          <option value="8">GPU 8 GB (RTX 3060/4060)</option>
          <option value="12">GPU 12 GB</option>
          <option value="16">GPU 16 GB / Mac 16 GB</option>
          <option value="24">GPU 24 GB (RTX 3090/4090)</option>
          <option value="48">48 GB (2× GPU / Mac 64 GB)</option>
          <option value="80">80 GB (H100 / A100)</option>
        </select>
      </label>
      <label>Parámetros
        <select data-f="params">
          <option value="">Cualquiera</option>
          <option value="0-1">&lt; 1B (diminuto)</option>
          <option value="1-4">1B – 4B (pequeño)</option>
          <option value="4-10">4B – 10B</option>
          <option value="10-40">10B – 40B (mediano)</option>
          <option value="40-150">40B – 150B (grande)</option>
          <option value="150-100000">&gt; 150B (frontera)</option>
        </select>
      </label>
      <label>Velocidad de inferencia
        <select data-f="speed">
          <option value="0">Cualquiera</option>
          <option value="4">Muy rápido</option>
          <option value="3">Rápido o más</option>
          <option value="2">Medio o más</option>
        </select>
      </label>
      <label>Publicado
        <select data-f="age">
          <option value="">En cualquier momento</option>
          <option value="7">Últimos 7 días</option>
          <option value="30">Últimos 30 días</option>
          <option value="90">Últimos 3 meses</option>
          <option value="365">Último año</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" data-f="hideDominated" ${S.filters.hideDominated ? 'checked' : ''}/> Ocultar modelos superados por otro mejor y más ligero</label>
      <label class="check"><input type="checkbox" data-f="evidence" ${S.filters.evidence ? 'checked' : ''}/> Solo con benchmarks comparables</label>
      <label class="check"><input type="checkbox" data-f="permissive" ${S.filters.permissive ? 'checked' : ''}/> Licencia permisiva (uso comercial)</label>
      <label class="check"><input type="checkbox" data-f="quant" ${S.filters.quant ? 'checked' : ''}/> Con versiones cuantizadas</label>
      <button class="reset" id="reset">Restablecer filtros</button>
      <p class="note">La posición de cada modelo se calcula frente a los demás de su categoría con los benchmarks que publican sus autores y el Elo de LMArena. Si una categoría no tiene benchmarks comunes, se ordena por popularidad (estrellas, likes, descargas) y se indica.</p>
    </aside>
    <div>
      <div class="result-bar">
        <span id="count"></span>
        <span>
          <button class="filters-toggle reset" id="ftoggle">Filtros</button>
          Ordenar:
          <select data-f="sort">
            <option value="relevance">Relevancia</option>
            <option value="quality">Mejor en su categoría</option>
            <option value="trending">Tendencia</option>
            <option value="newest">Más nuevos</option>
            <option value="vram">Menos VRAM</option>
            <option value="speed">Más rápidos</option>
          </select>
        </span>
      </div>
      <div class="grid" id="grid"></div>
      <button class="more" id="more" hidden>Ver más</button>
    </div>
  </section>`;

  for (const el of app.querySelectorAll('[data-f]')) {
    const k = el.dataset.f;
    if (el.type !== 'checkbox' && el.type !== 'range') el.value = String(S.filters[k]);
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      S.filters[k] = el.type === 'checkbox' ? el.checked : k === 'speed' ? +el.value : el.value;
      S.shown = 48;
      renderResults();
    });
  }
  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { S.query = e.target.value; S.dismissed.clear(); S.shown = 48; renderResults(); }, 180);
  });
  app.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => { S.query = b.dataset.ex; $('#q').value = S.query; S.dismissed.clear(); renderResults(); }));
  app.querySelectorAll('[data-task]').forEach((b) => b.addEventListener('click', () => {
    S.filters.task = b.dataset.task; S.shown = 48;
    app.querySelectorAll('[data-task]').forEach((x) => x.classList.toggle('active', x === b));
    renderResults();
  }));
  $('#reset').addEventListener('click', () => { S.filters = defaultFilters(); S.query = ''; S.dismissed.clear(); renderToolbox(); });
  $('#ftoggle').addEventListener('click', () => $('#filters').classList.toggle('open'));
  $('#more').addEventListener('click', () => { S.shown += 48; renderResults(); });
  renderResults();
}

function renderResults() {
  const { list, pq } = filterModels();
  const c = pq.constraints;
  const labels = { maxVram: `≤ ${c.maxVram} GB VRAM`, permissive: 'Uso comercial', speed: 'Rápido', spanish: 'Prioriza español' };
  const topTasks = Object.entries(pq.taskScores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => taskLabel(t));
  $('#detected').innerHTML = (topTasks.length || Object.keys(c).length)
    ? `Interpretado: ${topTasks.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}
       ${Object.keys(c).map((k) => `<span class="pill">${esc(labels[k])}<button data-dismiss="${k}" title="Quitar">✕</button></span>`).join('')}`
    : '';
  $('#detected').querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => { S.dismissed.add(b.dataset.dismiss); renderResults(); }));

  $('#count').textContent = `${list.length} modelo${list.length === 1 ? '' : 's'}`;
  $('#grid').innerHTML = list.length
    ? list.slice(0, S.shown).map(modelCard).join('')
    : `<p class="empty">Sin resultados. Prueba a describir el problema de otra forma o relaja los filtros.</p>`;
  $('#more').hidden = list.length <= S.shown;
}

function rankLine(m) {
  const c = m.cmp;
  if (!c) return '';
  if (c.dominatedBy?.length) {
    const d = c.dominatedBy[0];
    return `<div class="rank warn" title="${esc(d.reason)}">⚠ Superado por <b>${esc(d.name)}</b>: ${esc(d.reason)}</div>`;
  }
  if (hasEvidence(m)) {
    const board = S.boards[m.task];
    return `<div class="rank"><span>🏆 <b>#${c.rank}</b> de ${board?.evidenced ?? c.evidenced} con benchmarks en ${esc(taskLabel(m.task))}</span><div class="bar" title="Percentil medio en ${c.keys} benchmark${c.keys === 1 ? '' : 's'} frente a su categoría"><i style="width:${c.score}%"></i></div></div>`;
  }
  return `<div class="rank muted">Sin benchmarks comparables · popularidad: percentil ${c.score} en su categoría</div>`;
}

function modelCard(m) {
  const isNew = daysSince(m.createdAt) <= 7;
  const hasNews = S.articlesByModel[m.id]?.length;
  const stats = isProject(m)
    ? [['Estrellas', `★ ${fmtNum(m.likes)}`], ['Ritmo', m.starVelocity ? `${m.starVelocity} ★/día` : '—'], ['VRAM mín.', m.minVram != null ? `${m.minVram} GB` : '—', m.vramBasis]]
    : [['Parámetros', paramsOf(m) + (m.activeParams ? ` <small>(${fmtParams(m.activeParams)} act.)</small>` : ''), m.paramsApprox ? 'Aproximado a partir del tamaño de los pesos' : ''],
       ['VRAM mín.', m.minVram != null ? `${m.minVram} GB` : '—', m.vramBasis],
       m.speed ? ['Velocidad', speedOf(m), m.speed.value ? `Estimación en ${m.speed.ref}` : m.speed.text] : ['Descargas', `⬇ ${fmtNum(m.downloads)}`]];
  const extra = [
    isNew && '<span class="badge new">Nuevo</span>',
    m.trending >= 50 && '<span class="badge hot">🔥 Tendencia</span>',
    hasNews && '<span class="badge news">📰 En la revista</span>',
    isProject(m) && '<span class="badge news">🧪 Investigación</span>',
    m.paper && !isProject(m) && '<span class="badge">📄 Paper</span>',
    m.mentions?.length && `<span class="badge hot" title="${esc(m.mentions.join(' · '))}">📺 Destacado</span>`,
    m.permissive && '<span class="badge">Uso comercial</span>',
    m.hasQuant && '<span class="badge">Cuantizado</span>',
  ].filter(Boolean);
  return `<a class="card" href="#/modelo/${encodeURI(m.id)}">
    <div class="card-top"><span class="task-tag">${taskIcon(m.task)} ${esc(taskLabel(m.task))}</span><span class="card-date">${timeAgo(m.createdAt)}</span></div>
    <div><div class="card-title">${esc(m.name)}</div><div class="card-author">${esc(m.author)}${isProject(m) ? '' : ` · ♥ ${fmtNum(m.likes)}`}</div></div>
    <p>${esc(m.summary || 'Sin descripción disponible.')}</p>
    <div class="stats">${stats.map(([k, v, t]) => `<div class="stat"${t ? ` title="${esc(t)}"` : ''}><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    ${rankLine(m)}
    ${extra.length ? `<div class="badges">${extra.join('')}</div>` : ''}
  </a>`;
}

/** Modelos de la misma tarea con los que compararse: los que lo superan + los mejores de tamaño parecido */
function peersOf(m, n = 7) {
  const same = S.models.filter((x) => x.task === m.task && x.id !== m.id);
  const dom = (m.cmp?.dominatedBy || []).map((d) => S.byId.get(d.id)).filter(Boolean);
  const shareKeys = (x) => (x.benchmarks || []).filter((b) => bench(m, b.key)).length;
  const near = (x) => !m.params || !x.params || (x.params / m.params > 0.2 && x.params / m.params < 5);
  const ranked = same.filter((x) => !dom.includes(x))
    .sort((a, b) => (shareKeys(b) >= 2) - (shareKeys(a) >= 2) || near(b) - near(a) || (a.cmp?.rank || 1e9) - (b.cmp?.rank || 1e9));
  return [m, ...dom, ...ranked].slice(0, n + 1);
}

function compareTable(m) {
  const peers = peersOf(m);
  if (peers.length < 2) return '';
  // Columnas: benchmarks que comparte con más modelos del grupo
  const count = {};
  for (const p of peers) for (const b of p.benchmarks || []) if (bench(m, b.key)) count[b.key] = (count[b.key] || 0) + 1;
  const keys = Object.keys(count).filter((k) => count[k] >= 2).sort((a, b) => count[b] - count[a]).slice(0, 6);
  const best = {};
  for (const k of keys) {
    const vals = peers.map((p) => bench(p, k)).filter(Boolean);
    best[k] = vals.length ? (vals[0].lower ? Math.min : Math.max)(...vals.map((b) => b.value)) : null;
  }
  const minVram = Math.min(...peers.map((p) => p.minVram ?? Infinity));
  const verdict = (p) => {
    if (p === m) return '<span class="badge">Este modelo</span>';
    const d = m.cmp?.dominatedBy?.find((x) => x.id === p.id);
    if (d) return `<span class="badge new" title="${esc(d.reason)}">Mejor opción</span>`;
    if (p.cmp?.dominatedBy?.some((x) => x.id === m.id)) return '<span class="badge">Superado por este</span>';
    return '';
  };
  const rows = peers.map((p) => `<tr class="${p === m ? 'self' : ''}">
    <td><a href="#/modelo/${encodeURI(p.id)}">${esc(p.name)}</a><div class="note">${esc(p.author)}</div></td>
    ${keys.map((k) => { const b = bench(p, k); return `<td class="${b && b.value === best[k] ? 'best' : ''}">${b ? fmtVal(b.value) : '—'}</td>`; }).join('')}
    <td>${isProject(p) ? '★ ' + fmtNum(p.likes) : paramsOf(p)}</td>
    <td class="${p.minVram === minVram ? 'best' : ''}">${p.minVram != null ? p.minVram + ' GB' : '—'}</td>
    <td>${speedOf(p)}</td>
    <td>${p.permissive ? 'Sí' : p.permissive === false ? 'No' : '?'}</td>
    <td>${verdict(p)}</td></tr>`).join('');
  return `<div class="panel"><h2>Comparativa con modelos de la misma tarea</h2>
    ${keys.length ? '' : '<p class="note">Estos modelos no publican benchmarks en común con este; se comparan tamaño, memoria y licencia.</p>'}
    <div class="table-wrap"><table class="cmp">
      <tr><th>Modelo</th>${keys.map((k) => { const b = bench(m, k); return `<th title="${esc(SOURCE[b.source] || '')}">${esc(b.name)}${b.lower ? ' ↓' : ''}</th>`; }).join('')}<th>${isProject(m) ? 'Tamaño' : 'Parámetros'}</th><th>VRAM mín.</th><th>Velocidad</th><th>Uso comercial</th><th></th></tr>
      ${rows}
    </table></div>
    <p class="note">En verde, el mejor valor de cada columna. ↓ = menos es mejor. Los benchmarks los declaran los autores de cada modelo y pueden usar configuraciones distintas.</p></div>`;
}

function renderModel(id) {
  const m = S.byId.get(id);
  if (!m) { app.innerHTML = `<p class="empty">Modelo no encontrado. <a href="#/toolbox">Volver al toolbox</a></p>`; return; }
  const arts = S.articlesByModel[m.id] || [];
  const c = m.cmp || {};
  const board = S.boards[m.task];
  const position = hasEvidence(m)
    ? `#${c.rank} de ${board?.evidenced ?? c.evidenced} con benchmarks`
    : `Sin benchmarks comparables`;
  app.innerHTML = `<article class="detail">
    <a class="back" href="#/toolbox">← Toolbox</a>
    <div class="kicker">${taskIcon(m.task)} ${esc(taskLabel(m.task))} <time>publicado ${fmtDate(m.createdAt)}</time></div>
    <h1>${esc(m.name)}</h1>
    <p class="lead">${esc(m.summary || '')}</p>
    <p class="actions"><a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">${isProject(m) ? 'Ver código en GitHub ↗' : 'Ver en Hugging Face ↗'}</a>
       ${m.paper ? `<a class="btn ghost" href="${esc(safeUrl(m.paper))}" target="_blank" rel="noopener">Paper ↗</a>` : ''}
       ${m.project ? `<a class="btn ghost" href="${esc(safeUrl(m.project))}" target="_blank" rel="noopener">Página del proyecto ↗</a>` : ''}
       ${m.code && !isProject(m) ? `<a class="btn ghost" href="${esc(safeUrl(m.code))}" target="_blank" rel="noopener">Código ↗</a>` : ''}
       ${m.hasQuant ? `<a class="btn ghost" href="https://huggingface.co/models?other=base_model:quantized:${encodeURIComponent(m.id)}" target="_blank" rel="noopener">Versiones cuantizadas ↗</a>` : ''}
       <a class="btn ghost" href="#/rankings/${encodeURIComponent(m.task)}">Ranking de ${esc(taskLabel(m.task))}</a></p>
    ${c.dominatedBy?.length ? `<div class="panel warn"><h2>⚠ Hay alternativas mejores</h2><ul>${c.dominatedBy.map((d) => `<li><a href="#/modelo/${encodeURI(d.id)}">${esc(d.name)}</a>: ${esc(d.reason)} (${d.shared} benchmarks en común)</li>`).join('')}</ul></div>` : ''}
    <div class="detail-stats">
      <div class="stat"><span>Posición en su categoría</span><b>${position}</b><span>${hasEvidence(m) ? `percentil medio ${c.score} en ${c.keys} benchmark${c.keys === 1 ? '' : 's'}` : `popularidad: percentil ${c.score}`}</span></div>
      <div class="stat"><span>${isProject(m) ? 'Estrellas GitHub' : 'Parámetros'}</span><b>${isProject(m) ? '★ ' + fmtNum(m.likes) : paramsOf(m) + (m.activeParams ? ` (${fmtParams(m.activeParams)} activos)` : '')}</b><span>${isProject(m) ? (m.starVelocity ? m.starVelocity + ' ★/día' : '') : m.paramsApprox ? 'aprox. por tamaño de pesos' : ''}</span></div>
      <div class="stat"><span>Memoria mínima</span><b>${m.minVram != null ? m.minVram + ' GB' : 'Sin datos'}</b><span>${esc(m.vramBasis || '')}</span></div>
      <div class="stat"><span>Hardware</span><b>${esc(m.hwTier || 'Sin datos')}</b></div>
      <div class="stat"><span>Velocidad</span><b>${m.speed?.value ? `~${m.speed.value} tok/s` : m.speed?.text ? esc(m.speed.text) : 'Sin datos'}</b><span>${m.speed?.value ? 'estimación en ' + esc(m.speed.ref) : m.speed ? 'según la ficha' : ''}</span></div>
      <div class="stat"><span>Licencia</span><b>${esc(m.license || '?')}</b><span>${m.permissive ? 'permite uso comercial' : m.permissive === false ? 'revisa las condiciones' : ''}</span></div>
      ${isProject(m) ? '' : `<div class="stat"><span>Likes / descargas</span><b>${fmtNum(m.likes)} / ${fmtNum(m.downloads)}</b></div>`}
    </div>
    ${compareTable(m)}
    ${m.benchmarks?.length ? `<div class="panel"><h2>Benchmarks (${m.benchmarks.length})</h2><div class="table-wrap"><table class="cmp">
      <tr><th>Benchmark</th><th>Resultado</th><th>Fuente</th><th>Posición en la categoría</th></tr>
      ${m.benchmarks.map((b) => {
        const others = S.models.filter((x) => x.task === m.task && bench(x, b.key));
        const better = others.filter((x) => (b.lower ? bench(x, b.key).value < b.value : bench(x, b.key).value > b.value)).length;
        return `<tr><td>${esc(b.name)}${b.lower ? ' ↓' : ''}</td><td>${fmtVal(b.value)}${b.ci ? ` <small>±${b.ci}</small>` : ''}</td><td class="note" title="${esc(b.note || '')}">${esc(SOURCE[b.source] || b.source)}</td><td>${others.length >= 3 ? `${better + 1}.º de ${others.length}` : '<span class="note">pocos modelos lo publican</span>'}</td></tr>`;
      }).join('')}
    </table></div></div>` : ''}
    ${m.mentions?.length ? `<div class="panel"><h2>Destacado en</h2><ul>${m.mentions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${m.useCases?.length ? `<div class="panel"><h2>Casos de uso</h2><ul>${m.useCases.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
    ${m.vram ? `<div class="panel"><h2>Memoria estimada por precisión</h2>
      <table class="vram"><tr><th>Precisión</th><th>Memoria</th></tr>
      <tr><td>4 bits (Q4 / AWQ)</td><td>${m.vram.q4} GB</td></tr>
      <tr><td>8 bits (Q8 / FP8)</td><td>${m.vram.q8} GB</td></tr>
      <tr><td>16 bits (FP16 / BF16)</td><td>${m.vram.fp16} GB</td></tr></table>
      ${m.hardwareNote ? `<p class="note">Según la ficha: ${esc(m.hardwareNote)}</p>` : ''}
      <p class="note">Parámetros × bytes por peso × 1,2 de margen (contexto y activaciones). Contextos largos o vídeo de alta resolución necesitan más.</p></div>` : ''}
    ${arts.length ? `<div class="panel"><h2>En la revista</h2><ul>${arts.map((a) => `<li><a href="#/articulo/${a.slug}">${esc(a.title)}</a></li>`).join('')}</ul></div>` : ''}
  </article>`;
}

// ---------- vistas: rankings ----------
let rkHide = true;
let rkVram = '';

function renderRankings(task) {
  const tasksWith = Object.keys(S.boards).filter((t) => S.boards[t].total >= 3 && t !== 'other')
    .sort((a, b) => (S.boards[b].evidenced >= 3) - (S.boards[a].evidenced >= 3) || S.boards[b].evidenced - S.boards[a].evidenced || S.boards[b].total - S.boards[a].total);
  task = task && S.boards[task] ? task : tasksWith[0];
  const board = S.boards[task] || { keys: [], names: {} };
  app.innerHTML = `
    <div class="mag-head"><div><h1>Rankings</h1><p>Los mejores modelos open source de cada categoría según sus benchmarks y el Elo de LMArena. Si una categoría no tiene benchmarks comunes, se ordena por popularidad.</p></div></div>
    <div class="cats">${tasksWith.map((t) => `<a class="task-chip ${t === task ? 'active' : ''}" href="#/rankings/${encodeURIComponent(t)}">${taskIcon(t)} ${esc(taskLabel(t))} <small>${S.boards[t].evidenced >= 3 ? S.boards[t].evidenced + ' con benchmarks' : S.boards[t].total}</small></a>`).join('')}</div>
    <div class="rk-opts">
      <label class="check"><input type="checkbox" id="rk-hide" ${rkHide ? 'checked' : ''}/> Ocultar modelos superados</label>
      <label>Hardware <select id="rk-vram">
        <option value="">Cualquiera</option><option value="8">≤ 8 GB</option><option value="16">≤ 16 GB</option><option value="24">≤ 24 GB</option><option value="48">≤ 48 GB</option><option value="80">≤ 80 GB</option>
      </select></label>
    </div>
    <div id="rk"></div>`;
  $('#rk-vram').value = rkVram;
  $('#rk-hide').addEventListener('change', (e) => { rkHide = e.target.checked; draw(); });
  $('#rk-vram').addEventListener('change', (e) => { rkVram = e.target.value; draw(); });
  function draw() {
    const list = S.models.filter((m) => m.task === task && (!rkHide || !m.cmp?.dominatedBy?.length) && (!rkVram || (m.minVram != null && m.minVram <= +rkVram)))
      .sort((a, b) => (a.cmp?.rank || 1e9) - (b.cmp?.rank || 1e9));
    const ev = list.filter(hasEvidence);
    const rest = list.filter((m) => !hasEvidence(m));
    const keys = board.keys || [];
    const row = (m, i, withKeys) => `<tr onclick="location.hash='#/modelo/${encodeURI(m.id)}'">
      <td class="num">${i + 1}</td>
      <td><a href="#/modelo/${encodeURI(m.id)}">${esc(m.name)}</a><div class="note">${esc(m.author)} · ${timeAgo(m.createdAt)}</div></td>
      <td><div class="score"><div class="bar"><i style="width:${m.cmp?.score || 0}%"></i></div><b>${m.cmp?.score ?? '—'}</b></div></td>
      ${withKeys ? keys.map((k) => { const b = bench(m, k); return `<td>${b ? fmtVal(b.value) : '<span class="note">—</span>'}</td>`; }).join('') : ''}
      <td>${isProject(m) ? '★ ' + fmtNum(m.likes) : paramsOf(m)}</td>
      <td>${m.minVram != null ? m.minVram + ' GB' : '—'}</td>
      <td>${speedOf(m)}</td>
      <td>${m.permissive ? '✓' : m.permissive === false ? '✗' : '?'}</td></tr>`;
    const head = (withKeys, label) => `<tr><th>#</th><th>Modelo</th><th>${label}</th>${withKeys ? keys.map((k) => `<th title="Publicado por ${board.names[k]?.n} modelos">${esc(board.names[k]?.name || k)}${board.names[k]?.lower ? ' ↓' : ''}</th>`).join('') : ''}<th>Tamaño</th><th>VRAM mín.</th><th>Velocidad</th><th title="Licencia permisiva">Comercial</th></tr>`;
    $('#rk').innerHTML = `
      ${ev.length ? `<h2 class="rk-h">Con benchmarks comparables (${ev.length})</h2>
        <div class="table-wrap"><table class="cmp rk">${head(true, 'Puntuación')}${ev.map((m, i) => row(m, i, true)).join('')}</table></div>
        <p class="note">Puntuación = percentil medio en los benchmarks que publica cada modelo frente al resto de su categoría (LMArena cuenta doble). Un benchmark solo entra si lo publican al menos 3 modelos.</p>` : ''}
      ${rest.length ? `<h2 class="rk-h">${ev.length ? 'Sin benchmarks comparables' : 'Ordenados por popularidad'} (${rest.length})</h2>
        ${ev.length ? '' : '<p class="note">En esta categoría los autores no publican benchmarks comunes. El orden refleja estrellas de GitHub, likes y descargas, no una medida de calidad.</p>'}
        <div class="table-wrap"><table class="cmp rk">${head(false, 'Popularidad')}${rest.slice(0, 60).map((m, i) => row(m, i, false)).join('')}</table></div>` : ''}
      ${list.length ? '' : '<p class="empty">Ningún modelo cumple esos filtros.</p>'}`;
  }
  draw();
}

// ---------- vistas: revista ----------
let magCat = '';
let magQ = '';

function renderMagazine() {
  const cats = [...new Set(S.articles.map((a) => a.category))];
  app.innerHTML = `
    <div class="mag-head">
      <div><h1>La Revista</h1><p>Lanzamientos, investigación y noticias de IA, redactados automáticamente cada hora.</p></div>
      <div class="mag-search"><input id="mq" type="search" placeholder="Buscar artículos…" value="${esc(magQ)}" /></div>
    </div>
    <div class="cats">
      <button class="task-chip ${!magCat ? 'active' : ''}" data-cat="">Todo</button>
      ${cats.map((c) => `<button class="task-chip ${magCat === c ? 'active' : ''}" data-cat="${esc(c)}">${CAT_ICON[c] || '•'} ${esc(c)}</button>`).join('')}
    </div>
    <div id="mag"></div>`;
  app.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    magCat = b.dataset.cat;
    app.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('active', x === b));
    renderMagList();
  }));
  $('#mq').addEventListener('input', (e) => { magQ = e.target.value; renderMagList(); });
  renderMagList();
}

function thumb(a) {
  return `<div class="thumb">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span>${CAT_ICON[a.category] || '📰'}</span></div>`;
}

function renderMagList() {
  const q = norm(magQ);
  const list = S.articles.filter((a) => (!magCat || a.category === magCat) && (!q || norm(`${a.title} ${a.dek} ${(a.tags || []).join(' ')}`).includes(q)));
  if (!list.length) { $('#mag').innerHTML = `<p class="empty">Aún no hay artículos${magCat || q ? ' con ese filtro' : ''}.</p>`; return; }
  const kicker = (a) => `<div class="kicker">${esc(a.category)} <time datetime="${a.date}">${timeAgo(a.date)}</time></div>`;
  const card = (a, h = 'h3') => `<a class="art-card" href="#/articulo/${a.slug}">${thumb(a)}<div>${kicker(a)}<${h}>${esc(a.title)}</${h}><p>${esc(a.dek)}</p></div></a>`;
  const [main, ...rest] = list;
  const side = rest.slice(0, 3);
  $('#mag').innerHTML = `
    <section class="featured">
      <a class="feat-main" href="#/articulo/${main.slug}">${thumb(main)}${kicker(main)}<h2>${esc(main.title)}</h2><p>${esc(main.dek)}</p></a>
      <div class="feat-side">${side.map((a) => `<a class="art-card" href="#/articulo/${a.slug}">${thumb(a)}<div>${kicker(a)}<h3>${esc(a.title)}</h3></div></a>`).join('')}</div>
    </section>
    <section class="art-grid">${rest.slice(3).map((a) => card(a)).join('')}</section>`;
}

async function renderArticle(slug) {
  app.innerHTML = '<p class="loading">Cargando artículo…</p>';
  const a = await fetch(`data/articles/${encodeURIComponent(slug)}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!a) { app.innerHTML = `<p class="empty">Artículo no encontrado. <a href="#/revista">Volver a la revista</a></p>`; return; }
  document.title = `${a.title} — Radar IA`;
  const models = (a.modelIds || []).map((id) => S.models.find((m) => m.id === id)).filter(Boolean);
  app.innerHTML = `<article class="article">
    <a class="back" href="#/revista">← Revista</a>
    <div class="kicker">${CAT_ICON[a.category] || ''} ${esc(a.category)} <time datetime="${a.date}">${fmtDate(a.date)}</time></div>
    <h1>${esc(a.title)}</h1>
    <p class="dek">${esc(a.dek)}</p>
    ${a.image ? thumb(a) : ''}
    ${a.keyPoints?.length ? `<aside class="keypoints"><h2>Claves</h2><ul>${a.keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></aside>` : ''}
    <div class="prose">${markdown(a.body)}</div>
    ${models.length ? `<div class="panel"><h2>Modelos en el toolbox</h2><div class="grid">${models.map(modelCard).join('')}</div></div>` : ''}
    <div class="panel sources"><h2>Fuentes</h2><ul>${a.sources.map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="note">— ${esc(s.source)}</span></li>`).join('')}</ul>
    <p class="note">${a.generated === 'llm' ? 'Artículo redactado automáticamente por IA a partir de las fuentes citadas.' : 'Resumen automático a partir de la fuente original.'}</p></div>
    ${a.tags?.length ? `<div class="tags">${a.tags.map((t) => `<span class="badge">#${esc(t)}</span>`).join('')}</div>` : ''}
  </article>`;
}

// ---------- markdown mínimo y seguro ----------
function safeUrl(u = '') { return /^https?:\/\//i.test(u) ? u : '#'; }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u.replace(/&amp;/g, '&'))}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function markdown(md = '') {
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '', list = null, para = [], code = null;
  const flush = () => {
    if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; }
    if (list) { html += `</${list}>`; list = null; }
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) { html += `<pre><code>${esc(code)}</code></pre>`; code = null; } else code += line + '\n';
      continue;
    }
    if (/^```/.test(line)) { flush(); code = ''; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); const lv = Math.min(4, Math.max(2, h[1].length)); html += `<h${lv}>${inline(h[2])}</h${lv}>`; continue; }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; }
      const type = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== type) { if (list) html += `</${list}>`; html += `<${type}>`; list = type; }
      html += `<li>${inline(li[2])}</li>`;
      continue;
    }
    if (/^>\s?/.test(line)) { flush(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    if (!line.trim()) { flush(); continue; }
    if (list) { html += `</${list}>`; list = null; }
    para.push(line.trim());
  }
  flush();
  if (code !== null) html += `<pre><code>${esc(code)}</code></pre>`;
  return html;
}

// ---------- router ----------
function route() {
  const h = decodeURI(location.hash.slice(1)) || '/toolbox';
  const tab = h.startsWith('/revista') || h.startsWith('/articulo') ? 'revista' : h.startsWith('/rankings') ? 'rankings' : 'toolbox';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.title = tab === 'revista' ? 'Revista — Radar IA' : tab === 'rankings' ? 'Rankings — Radar IA' : 'Radar IA — Toolbox open source y revista de IA';
  window.scrollTo(0, 0);
  if (h.startsWith('/articulo/')) return renderArticle(h.slice('/articulo/'.length));
  if (h.startsWith('/modelo/')) return renderModel(h.slice('/modelo/'.length));
  if (tab === 'rankings') return renderRankings(h.split('/')[2] || '');
  if (tab === 'revista') return renderMagazine();
  return renderToolbox();
}

// ---------- tema ----------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch {}
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = cur;
    try { localStorage.setItem('theme', cur); } catch {}
  });
}

initTheme();
await load();
window.addEventListener('hashchange', route);
route();
