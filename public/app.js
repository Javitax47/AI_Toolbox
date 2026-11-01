// Radar IA — frontend estático (sin build). Lee /data/*.json generados por scripts/update.mjs
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');

const S = {
  models: [], tasks: [], taskMap: {}, articles: [], meta: {},
  filters: defaultFilters(),
  query: '',
  shown: 48,
  dismissed: new Set(), // restricciones detectadas que el usuario ha quitado
};

function defaultFilters() {
  return { task: '', maxVram: '', params: '', speed: 0, quality: 0, permissive: false, age: '', sort: 'relevance', quant: false };
}

// ---------- utilidades ----------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s = '') => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0));
const fmtParams = (p) => (!p ? '?' : p >= 1e9 ? `${+(p / 1e9).toFixed(p < 1e10 ? 1 : 0)}B` : `${Math.round(p / 1e6)}M`);
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
const CAT_ICON = { Lanzamiento: '🚀', 'Open Source': '🔓', Investigación: '🔬', Industria: '🏢', Herramientas: '🛠️', Negocio: '💼' };

async function load() {
  const get = (p) => fetch(p, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [models, tasks, articles, meta] = await Promise.all([get('data/models.json'), get('data/tasks.json'), get('data/articles.json'), get('data/meta.json')]);
  S.models = models?.models || [];
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
      const kw = norm(k).split(/[\s-]+/);
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
  const ts = pq.taskScores[m.task];
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
  return s + m.quality * 0.25 + Math.min(15, m.trending / 20);
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
    if (f.task && m.task !== f.task) return false;
    if (maxVram != null && !(m.minVram != null && m.minVram <= maxVram)) return false;
    if (f.params) { const [lo, hi] = f.params.split('-').map(Number); const b = (m.params || 0) / 1e9; if (!m.params || b < lo || b >= hi) return false; }
    if (minSpeed && !(m.speed && m.speed.level >= minSpeed)) return false;
    if (f.quality && m.quality < f.quality) return false;
    if (permissive && m.permissive !== true) return false;
    if (f.quant && !m.hasQuant) return false;
    if (f.age && daysSince(m.createdAt) > +f.age) return false;
    return true;
  });
  const sorters = {
    relevance: (a, b) => b.s - a.s,
    quality: (a, b) => b.m.quality - a.m.quality,
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
  for (const m of S.models) counts[m.task] = (counts[m.task] || 0) + 1;
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
      <label>Calidad mínima: <span id="qv">${S.filters.quality}</span>
        <input type="range" min="0" max="90" step="5" data-f="quality" value="${S.filters.quality}" />
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
      <label class="check"><input type="checkbox" data-f="permissive" ${S.filters.permissive ? 'checked' : ''}/> Licencia permisiva (uso comercial)</label>
      <label class="check"><input type="checkbox" data-f="quant" ${S.filters.quant ? 'checked' : ''}/> Con versiones cuantizadas</label>
      <button class="reset" id="reset">Restablecer filtros</button>
      <p class="note">VRAM, velocidad y calidad son estimaciones automáticas. Calidad combina los benchmarks de la ficha (evaluados por IA) con la tracción en la comunidad.</p>
    </aside>
    <div>
      <div class="result-bar">
        <span id="count"></span>
        <span>
          <button class="filters-toggle reset" id="ftoggle">Filtros</button>
          Ordenar:
          <select data-f="sort">
            <option value="relevance">Relevancia</option>
            <option value="quality">Calidad</option>
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
      S.filters[k] = el.type === 'checkbox' ? el.checked : ['speed', 'quality'].includes(k) ? +el.value : el.value;
      if (k === 'quality') $('#qv').textContent = el.value;
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

function modelCard(m) {
  const isNew = daysSince(m.createdAt) <= 7;
  const hasNews = S.articlesByModel[m.id]?.length;
  return `<a class="card" href="#/modelo/${encodeURI(m.id)}">
    <div class="card-head">
      <div><div class="card-title">${esc(m.name)}</div><div class="card-author">${esc(m.author)} · ${timeAgo(m.createdAt)}</div></div>
      <span class="task-tag">${taskIcon(m.task)} ${esc(taskLabel(m.task))}</span>
    </div>
    <p>${esc(m.summary || 'Sin descripción disponible.')}</p>
    <div class="stats">
      <div class="stat"><span>Parámetros</span><b>${fmtParams(m.params)}${m.activeParams ? ` <small>(${fmtParams(m.activeParams)} act.)</small>` : ''}</b></div>
      <div class="stat" title="${esc(m.hwTier)}"><span>VRAM mín.</span><b>${m.minVram != null ? m.minVram + ' GB' : '?'}</b></div>
      <div class="stat" title="${esc(m.speed?.ref || '')}"><span>Velocidad</span><b>${m.speed ? (m.speed.value ? `${m.speed.value} tok/s` : m.speed.label) : '?'}</b></div>
    </div>
    <div class="quality"><span>Calidad</span><div class="bar"><i style="width:${m.quality}%"></i></div><b>${m.quality}</b></div>
    <div class="badges">
      ${isNew ? '<span class="badge new">Nuevo</span>' : ''}
      ${m.trending >= 50 ? '<span class="badge hot">🔥 Tendencia</span>' : ''}
      ${hasNews ? '<span class="badge news">📰 En la revista</span>' : ''}
      ${m.license ? `<span class="badge">${esc(m.license)}</span>` : ''}
      ${m.hasQuant ? '<span class="badge">Cuantizado</span>' : ''}
      <span class="badge">♥ ${fmtNum(m.likes)}</span>
      <span class="badge">⬇ ${fmtNum(m.downloads)}</span>
    </div>
  </a>`;
}

function renderModel(id) {
  const m = S.models.find((x) => x.id === id);
  if (!m) { app.innerHTML = `<p class="empty">Modelo no encontrado. <a href="#/toolbox">Volver al toolbox</a></p>`; return; }
  const arts = S.articlesByModel[m.id] || [];
  app.innerHTML = `<article class="detail">
    <a class="back" href="#/toolbox">← Toolbox</a>
    <div class="kicker">${taskIcon(m.task)} ${esc(taskLabel(m.task))} <time>publicado ${fmtDate(m.createdAt)}</time></div>
    <h1>${esc(m.name)}</h1>
    <p class="lead">${esc(m.summary || '')}</p>
    <p><a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">Ver en Hugging Face ↗</a>
       ${m.hasQuant ? `<a class="btn ghost" href="https://huggingface.co/models?other=base_model:quantized:${encodeURIComponent(m.id)}" target="_blank" rel="noopener">Versiones cuantizadas ↗</a>` : ''}</p>
    <div class="detail-stats">
      <div class="stat"><span>Autor</span><b>${esc(m.author)}</b></div>
      <div class="stat"><span>Parámetros</span><b>${fmtParams(m.params)}${m.activeParams ? ` (${fmtParams(m.activeParams)} activos)` : ''}</b></div>
      <div class="stat"><span>Hardware mínimo</span><b>${esc(m.hwTier)}</b></div>
      <div class="stat"><span>Velocidad est.</span><b>${m.speed ? (m.speed.value ? `~${m.speed.value} tok/s` : m.speed.label) : '?'}</b><span>${esc(m.speed?.ref || '')}</span></div>
      <div class="stat"><span>Calidad</span><b>${m.quality}/100</b></div>
      <div class="stat"><span>Licencia</span><b>${esc(m.license || '?')}</b></div>
      <div class="stat"><span>Likes / descargas</span><b>${fmtNum(m.likes)} / ${fmtNum(m.downloads)}</b></div>
    </div>
    ${m.useCases?.length ? `<div class="panel"><h2>Casos de uso</h2><ul>${m.useCases.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
    ${m.vram ? `<div class="panel"><h2>Memoria estimada (VRAM / RAM unificada)</h2>
      <table class="vram"><tr><th>Precisión</th><th>Memoria</th></tr>
      <tr><td>4 bits (Q4 / AWQ)</td><td>${m.vram.q4} GB</td></tr>
      <tr><td>8 bits (Q8 / FP8)</td><td>${m.vram.q8} GB</td></tr>
      <tr><td>16 bits (FP16 / BF16)</td><td>${m.vram.fp16} GB</td></tr></table>
      ${m.hardwareNote ? `<p class="note">Según la ficha: ${esc(m.hardwareNote)}</p>` : ''}
      ${m.speedNote ? `<p class="note">Velocidad según la ficha: ${esc(m.speedNote)}</p>` : ''}
      <p class="note">Estimación: parámetros × bytes por peso × 1,2 de margen (contexto/activaciones). Contextos largos necesitan más.</p></div>` : ''}
    ${m.benchmarks?.length ? `<div class="panel"><h2>Benchmarks declarados</h2><ul>${m.benchmarks.map((b) => `<li><b>${esc(b.name)}</b>: ${esc(b.value)}</li>`).join('')}</ul>${m.qualityReason ? `<p class="note">${esc(m.qualityReason)}</p>` : ''}</div>` : ''}
    ${arts.length ? `<div class="panel"><h2>En la revista</h2><ul>${arts.map((a) => `<li><a href="#/articulo/${a.slug}">${esc(a.title)}</a></li>`).join('')}</ul></div>` : ''}
  </article>`;
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
  const tab = h.startsWith('/revista') || h.startsWith('/articulo') ? 'revista' : 'toolbox';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.title = tab === 'revista' ? 'Revista — Radar IA' : 'Radar IA — Toolbox open source y revista de IA';
  window.scrollTo(0, 0);
  if (h.startsWith('/articulo/')) return renderArticle(h.slice('/articulo/'.length));
  if (h.startsWith('/modelo/')) return renderModel(h.slice('/modelo/'.length));
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
