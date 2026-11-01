// Recolecta noticias (RSS, lanzamientos en Hugging Face, papers, GitHub), agrupa las que
// hablan de lo mismo, y redacta artículos en español con un LLM.
import path from 'node:path';
import { fetchJSON, fetchText, readJSON, writeJSON, writeText, pool, stripHtml, stripMarkdown, extractPage, firstSentences, slugify, normalizeText, DATA_DIR, STATE_DIR, CONFIG_DIR } from './util.mjs';
import { parseFeed, decodeHtmlContent } from './rss.mjs';
import { llmJSON, llmEnabled, llmBudgetLeft } from './llm.mjs';

const ARTICLES_PER_RUN = Number(process.env.ARTICLES_PER_RUN || 5);
const MIN_SCORE = Number(process.env.MIN_ARTICLE_SCORE || 16);
const INDEX_LIMIT = 400;
const CATEGORIES = ['Lanzamiento', 'Open Source', 'Investigación', 'Industria', 'Herramientas', 'Negocio'];

const STOP = new Set(normalizeText('the a an and or of to in on for with by from is are new de la el los las un una y o en con por para del al que se su sus como más mas nuevo nueva its it this that how what why your you we our now ai ia'.replace(/ /g, ' ')).split(' '));
const AI_RE = /\b(ai|llm|llms|agent|agents|agentic|model|models|diffusion|gpt|transformer|neural|inference|rag|machine learning|deep learning|vision|speech|tts|mcp|claude|openai|gemini|ollama|lora|multimodal|embedding|robot|robotics|copilot)\b/i;

export async function updateNews(models = [], research = []) {
  const cfg = await readJSON(path.join(CONFIG_DIR, 'sources.json'), {});
  const statePath = path.join(STATE_DIR, 'news-state.json');
  const state = await readJSON(statePath, { seen: {}, recent: [] });
  const index = await readJSON(path.join(DATA_DIR, 'articles.json'), { articles: [] });

  // 1) Recolección
  const groups = await Promise.all([
    collectFeeds(cfg, state),
    collectHFReleases(models, cfg.huggingFaceReleases || {}),
    collectGitHub(cfg.github || {}),
  ]);
  groups.push(researchCandidates(research, cfg.research || {}));
  let items = groups.flat();
  console.log(`· ${items.length} elementos recolectados`);

  const maxAge = cfg.maxItemAgeDays || 4;
  items = items.filter((i) => {
    if (state.seen[key(i.url)] || state.seen['t:' + titleKey(i.title)]) return false;
    const age = (Date.now() - new Date(i.date)) / 86400000;
    return age <= (i.maxAge || maxAge) && age > -1;
  });

  // 2) Agrupación por tema y puntuación
  const clusters = cluster(items);
  const recentTokens = new Set(state.recent.filter((r) => Date.now() - new Date(r.date) < 5 * 86400000).flatMap((r) => r.tokens));
  const ranked = clusters
    .map((c) => ({ ...c, score: c.items.map((i) => i.score).sort((a, b) => b - a).reduce((s, v, n) => s + (n ? v * 0.5 : v), 0) }))
    .filter((c) => c.score >= MIN_SCORE)
    .filter((c) => !c.tokens.some((t) => recentTokens.has(t)))
    .sort((a, b) => b.score - a.score);
  console.log(`· ${clusters.length} temas, ${ranked.length} publicables; se redactan hasta ${ARTICLES_PER_RUN}`);

  // 3) Redacción
  // Con cuota gratuita, el presupuesto diario se reparte entre las horas que quedan del día (UTC)
  const hoursLeft = 24 - new Date().getUTCHours();
  const perRun = llmEnabled ? Math.min(ARTICLES_PER_RUN, Math.ceil((await llmBudgetLeft('article')) / hoursLeft)) : ARTICLES_PER_RUN;
  const chosen = [];
  const perType = {};
  const cap = Math.max(1, Math.ceil(ARTICLES_PER_RUN / 2));
  for (const c of ranked) {
    if (chosen.length >= perRun) break;
    const t = c.items[0].type === 'reddit' ? 'rss' : c.items[0].type;
    if ((perType[t] || 0) >= cap) continue;
    perType[t] = (perType[t] || 0) + 1;
    chosen.push(c);
  }
  for (const c of ranked) if (chosen.length < perRun && !chosen.includes(c)) chosen.push(c);
  const modelsById = new Map(models.map((m) => [m.id, m]));
  const results = await pool(chosen, 3, (c) => writeArticle(c, modelsById));
  const written = results.filter((r) => r && !r.discarded);

  // Solo se marca como cubierto lo redactado o descartado; si el LLM falló, se reintenta en la próxima hora
  for (const [n, c] of chosen.entries()) for (const i of results[n] ? c.items : []) {
    state.seen[key(i.url)] = new Date().toISOString();
    state.seen['t:' + titleKey(i.title)] = new Date().toISOString();
  }
  for (const a of written) {
    if (index.articles.some((x) => x.slug === a.slug)) a.slug += '-' + Date.now().toString(36).slice(-4);
    const tokens = a._tokens || [];
    delete a._tokens;
    await writeJSON(path.join(DATA_DIR, 'articles', `${a.slug}.json`), a);
    const { body, sources, keyPoints, ...entry } = a;
    entry.sourceNames = [...new Set(sources.map((s) => s.source))];
    index.articles = [entry, ...index.articles.filter((x) => x.slug !== a.slug)];
    state.recent.push({ date: a.date, tokens });
  }

  // 4) Poda de estado y escritura
  const cutoff = Date.now() - 30 * 86400000;
  state.seen = Object.fromEntries(Object.entries(state.seen).filter(([, d]) => new Date(d) > cutoff));
  state.recent = state.recent.filter((r) => new Date(r.date) > cutoff);
  index.articles.sort((a, b) => new Date(b.date) - new Date(a.date));
  index.articles = index.articles.slice(0, INDEX_LIMIT);
  index.updatedAt = new Date().toISOString();

  await writeJSON(path.join(DATA_DIR, 'articles.json'), index);
  await writeJSON(statePath, state);
  await writeText(path.join(DATA_DIR, '..', 'feed.xml'), buildFeed(index.articles.slice(0, 50)));
  console.log(`✓ ${written.length} artículos nuevos (${index.articles.length} en total)`);
  return written;
}

// ---------- Recolectores ----------

async function collectFeeds(cfg, state) {
  const feeds = cfg.feeds || [];
  const results = await pool(feeds, 6, async (f) => {
    const xml = await fetchText(f.url, { retries: 1, timeout: 15000 });
    if (!xml) return [];
    if (f.type === 'html') return collectHtmlLinks(f, xml, state);
    const parsed = parseFeed(xml).sort((a, b) => new Date(b.date) - new Date(a.date));
    return parsed.slice(0, 25).map((it, pos) => {
      const ageH = (Date.now() - new Date(it.date)) / 3600000;
      const fresh = Math.max(0.3, 1 - ageH / 96);
      const html = decodeHtmlContent(it.html);
      const text = stripHtml(html);
      const isReddit = f.type === 'reddit';
      if (isReddit && !AI_RE.test(it.title + ' ' + text)) return null;
      return {
        type: isReddit ? 'reddit' : 'rss',
        source: f.name,
        category: f.category,
        title: it.title,
        url: it.url,
        date: it.date,
        summary: firstSentences(text, 1200),
        score: f.weight * 10 * fresh * (isReddit ? Math.max(0.4, 1 - pos / 25) : 1),
      };
    }).filter(Boolean);
  });
  return results.flat().filter(Boolean);
}

/** Páginas sin RSS: cualquier enlace que case con linkPattern y no se haya visto antes es una noticia nueva. */
function collectHtmlLinks(f, html, state) {
  const origin = new URL(f.url).origin;
  const re = new RegExp(`<a[^>]+href=["'](${f.linkPattern})["'][^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  const found = new Map();
  for (const m of html.matchAll(re)) {
    const url = new URL(m[1], origin).href.replace(/\/$/, '');
    if ((f.exclude || []).some((x) => url.endsWith(x))) continue;
    const text = stripHtml(m[2]).replace(/\s+/g, ' ').trim();
    if (text.length > (found.get(url)?.length || 0)) found.set(url, text);
  }
  state.html ||= {};
  const firstRun = !state.html[f.name];
  const known = new Set(state.html[f.name] || []);
  const links = [...found.entries()];
  state.html[f.name] = [...new Set([...links.map(([u]) => u), ...known])].slice(0, 300);
  // En la primera ejecución solo se consideran las 3 primeras (lo más reciente suele ir arriba)
  return links
    .filter(([, text]) => text.length >= 15)
    .filter(([u], i) => !known.has(u) && (!firstRun || i < 3))
    .map(([url, text]) => ({
      type: 'rss',
      source: f.name,
      category: f.category,
      title: firstSentences(text || url.split('/').pop().replace(/-/g, ' '), 160),
      url,
      date: new Date().toISOString(),
      undated: true, // la fecha real se lee de la página al redactar
      summary: '',
      score: f.weight * 10,
    }));
}

function collectHFReleases(models, cfg) {
  const maxAge = cfg.maxAgeDays || 10;
  return models
    .filter((m) => m.kind !== 'project')
    .filter((m) => (Date.now() - new Date(m.createdAt)) / 86400000 <= maxAge && (m.likes >= (cfg.minLikes || 80) || (m.watch && m.likes >= 20)))
    .filter((m) => !/(abliterat|obliterat|uncensor|unrestrict|nsfw|eros|heretic|merge|prism|jailbreak)/i.test(m.id))
    .map((m) => ({
      type: 'hf-model',
      source: 'Hugging Face',
      category: 'Lanzamiento',
      title: `${m.name} (${m.author})`,
      url: m.url,
      date: m.createdAt,
      maxAge,
      modelId: m.id,
      summary: m.summary || '',
      image: `https://cdn-thumbnails.huggingface.co/social-thumbnails/models/${m.id}.png`,
      score: (cfg.weight || 2.5) * Math.log10(m.likes + 1) * 4.5,
    }));
}

/** Papers y proyectos de nicho que el radar de investigación considera destacables. */
function researchCandidates(research, cfg) {
  const maxAge = cfg.maxAgeDaysNews || 14;
  return research
    .filter((r) => r.title && (r.hasCode || r.mentions?.length || r.upvotes >= 25))
    .map((r) => {
      const links = [r.repo && `código: https://github.com/${r.repo}`, r.project && `proyecto: ${r.project}`, r.weights?.length && `pesos: ${r.weights.map((w) => 'https://huggingface.co/' + w).join(', ')}`].filter(Boolean).join(' · ');
      return {
        type: 'research',
        source: r.source || 'arXiv',
        category: r.kind === 'paper' ? 'Investigación' : 'Herramientas',
        title: r.title,
        name: r.name,
        url: r.url,
        repo: r.repo,
        project: r.project,
        modelId: (r.weights || [])[0],
        date: r.published || r.firstSeen,
        maxAge,
        summary: `${r.summary || r.description || ''}${links ? '\n\nEnlaces: ' + links : ''}${r.stars ? `\nEstrellas en GitHub: ${r.stars}` : ''}${r.mentions?.length ? `\nMencionado en: ${r.mentions.join('; ')}` : ''}`,
        image: r.image || (r.repo ? `https://opengraph.githubassets.com/1/${r.repo}` : null),
        score: r.score,
      };
    });
}

async function collectGitHub(cfg) {
  const since = new Date(Date.now() - (cfg.maxAgeDays || 10) * 86400000).toISOString().slice(0, 10);
  const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const res = await fetchJSON(`https://api.github.com/search/repositories?q=created:%3E${since}+stars:%3E${cfg.minStars || 150}&sort=stars&order=desc&per_page=60`, { headers, retries: 1 });
  return (res?.items || [])
    .filter((r) => AI_RE.test(`${r.name} ${r.description || ''} ${(r.topics || []).join(' ')}`) && !/awesome|curated (list|collection)/i.test(`${r.name} ${r.description || ''}`))
    .filter((r) => (r.description || '').replace(/[^぀-ヿ一-鿿]/g, '').length < (r.description || '').length * 0.2)
    .map((r) => ({
      type: 'github',
      source: 'GitHub',
      category: 'Herramientas',
      title: `${r.full_name}: ${r.description || ''}`.slice(0, 200),
      url: r.html_url,
      repo: r.full_name,
      date: r.created_at,
      maxAge: cfg.maxAgeDays || 10,
      summary: r.description || '',
      stars: r.stargazers_count,
      image: `https://opengraph.githubassets.com/1/${r.full_name}`,
      score: (cfg.weight || 1) * Math.log10(r.stargazers_count + 1) * 5,
    }));
}

// ---------- Agrupación ----------

function tokens(title) {
  return normalizeText(title).replace(/[^a-z0-9.\s-]/g, ' ').split(/[\s-]+/).filter((t) => t.length > 2 && !STOP.has(t));
}

/** Tokens distintivos: nombres con versión (gpt-6.1, gemini 4, nanbeige4.3) o ids de modelo. */
function distinctive(item) {
  const t = normalizeText(item.title);
  const out = new Set();
  for (const m of t.matchAll(/([a-z][a-z]+)[\s-]?(\d+(?:\.\d+)*)\b/g)) if (!STOP.has(m[1]) && m[1].length > 2) out.add(m[1] + m[2]);
  for (const m of t.matchAll(/\b([a-z]*\d+[a-z][a-z0-9.-]*)\b/g)) if (m[1].length >= 4 && !/^\d+(b|m|k|gb|x)$/.test(m[1])) out.add(m[1]);
  const named = item.title.match(/^([A-Za-z][\w.+-]{2,30}):\s/);
  if (named && !STOP.has(normalizeText(named[1]))) out.add(normalizeText(named[1]).replace(/[^a-z0-9.]/g, ''));
  if (item.name && /[A-Z].*[A-Z]|\d/.test(item.name) && item.name.length <= 30) out.add(normalizeText(item.name).replace(/[^a-z0-9.]/g, ''));
  if (item.modelId) out.add(normalizeText(item.modelId.split('/')[1]).replace(/[^a-z0-9.]/g, ''));
  if (item.repo) out.add(normalizeText(item.repo.split('/')[1]));
  return [...out].filter((x) => !/^(20\d\d|19\d\d)/.test(x));
}

function cluster(items) {
  const clusters = [];
  for (const it of items) {
    const tk = new Set(tokens(it.title));
    const ds = distinctive(it);
    const hit = clusters.find((c) => ds.some((d) => c.tokens.includes(d)) || jaccard(tk, c.words) >= 0.5);
    if (hit) {
      hit.items.push(it);
      ds.forEach((d) => !hit.tokens.includes(d) && hit.tokens.push(d));
      tk.forEach((w) => hit.words.add(w));
    } else clusters.push({ items: [it], tokens: ds, words: tk });
  }
  return clusters;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const key = (url) => url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
const titleKey = (t) => tokens(t).slice(0, 8).join(' ');

// ---------- Redacción ----------

async function gatherContext(item) {
  let text = item.summary || '';
  let image = item.image || null;
  let date = null;
  if (item.type === 'hf-model') {
    const md = await fetchText(`https://huggingface.co/${item.modelId}/raw/main/README.md`, { retries: 1 });
    if (md) text = stripMarkdown(md);
  } else if (item.type === 'research') {
    const parts = [item.summary || ''];
    if (item.repo) {
      const md = await fetchText(`https://raw.githubusercontent.com/${item.repo}/HEAD/README.md`, { retries: 1 });
      if (md) parts.push('README:\n' + stripMarkdown(md).slice(0, 3500));
    }
    if (item.project) {
      const html = await fetchText(item.project, { retries: 0, timeout: 15000 });
      if (html) { const page = extractPage(html); parts.push('Página del proyecto:\n' + page.text.slice(0, 2500)); image = image || page.image; }
    }
    text = parts.join('\n\n');
  } else if (item.type === 'github') {
    const md = await fetchText(`https://raw.githubusercontent.com/${item.repo}/HEAD/README.md`, { retries: 1 });
    if (md) text = `${item.summary}\n\n${stripMarkdown(md)}`;
  } else if (item.type === 'rss') {
    const html = await fetchText(item.url, { retries: 1, timeout: 15000 });
    if (html) {
      const page = extractPage(html);
      if (page.text.length > text.length) text = page.text;
      image = image || page.image;
      date = page.date;
    }
  }
  return { text: text.slice(0, 4500), image, date };
}

async function writeArticle(c, modelsById) {
  const items = c.items.sort((a, b) => b.score - a.score).slice(0, 3);
  const ctx = await Promise.all(items.map(gatherContext));
  const lead = items[0];
  // Fuentes sin RSS: usa la fecha publicada en la página y descarta lo antiguo
  for (const [n, it] of items.entries()) {
    if (!it.undated) continue;
    if (ctx[n].date) it.date = ctx[n].date;
    if (ctx[n].date && (Date.now() - new Date(ctx[n].date)) / 86400000 > 7 && items.length === 1) {
      console.log(`  · antiguo, se omite: ${it.title}`);
      return { discarded: true };
    }
  }
  const linkedModels = [...new Set(items.map((i) => i.modelId).filter(Boolean))];
  const modelFacts = linkedModels.map((id) => modelsById.get(id)).filter(Boolean).map(modelFactLine).join('\n');
  const date = new Date(Math.max(...items.map((i) => new Date(i.date).getTime()))).toISOString();

  const out = await llmJSON(
    `Eres redactor jefe de "Radar IA", una revista digital en español sobre inteligencia artificial, centrada en lanzamientos, modelos open source e investigación.
Reglas:
- Escribe en español neutro, claro y preciso, para un público técnico curioso.
- Usa SOLO la información de las fuentes proporcionadas. No inventes cifras, fechas, benchmarks ni citas. Si algo es una afirmación no verificada, dilo.
- Si el contenido NO es una noticia relevante sobre IA (publicidad, contenido genérico, tema ajeno a la IA), responde {"descartar": true}.
- Responde SOLO con un objeto JSON válido.`,
    `FUENTES:
${items.map((it, n) => `--- Fuente ${n + 1}: ${it.source} (${it.type}) ---
Título: ${it.title}
URL: ${it.url}
Fecha: ${it.date}
Contenido:
${ctx[n].text}`).join('\n\n')}
${modelFacts ? `\nDATOS DEL TOOLBOX (estimaciones calculadas por nosotros):\n${modelFacts}` : ''}

Devuelve este JSON:
{
  "descartar": false,
  "titulo": "titular atractivo y concreto (máx. 90 caracteres)",
  "entradilla": "1-2 frases que resumen la noticia",
  "categoria": "una de: ${CATEGORIES.join(', ')}",
  "etiquetas": ["3-6 etiquetas cortas"],
  "puntos_clave": ["3-5 puntos clave"],
  "cuerpo": "artículo en Markdown de 350-700 palabras, con subtítulos ##. Incluye qué es, qué aporta frente a lo anterior, limitaciones, y si es open source una sección '## Cómo probarlo' con requisitos de hardware y enlaces de las fuentes",
  "modelos_hf": ["ids org/modelo de Hugging Face mencionados en las fuentes"]
}`,
    { maxTokens: 3000, temperature: 0.4, kind: 'article' }
  );

  if (out?.descartar) { console.log(`  · descartado: ${lead.title}`); return { discarded: true }; }

  const article = out && out.titulo && out.cuerpo
    ? {
        title: String(out.titulo).trim(),
        dek: String(out.entradilla || '').trim(),
        category: CATEGORIES.includes(out.categoria) ? out.categoria : lead.category,
        tags: (out.etiquetas || []).slice(0, 6).map(String),
        keyPoints: (out.puntos_clave || []).slice(0, 5).map(String),
        body: String(out.cuerpo),
        modelIds: [...new Set([...linkedModels, ...(out.modelos_hf || []).filter((id) => modelsById.has(id))])],
        generated: 'llm',
      }
    : fallbackArticle(items, ctx, linkedModels, modelsById);
  if (!article) return null;

  const slug = `${date.slice(0, 10)}-${slugify(article.title)}`;
  console.log(`  ✎ ${article.title}`);
  return {
    slug,
    date,
    image: ctx.map((x) => x.image).find(Boolean) || null,
    ...article,
    sources: items.map((i) => ({ title: i.title, url: i.url, source: i.source })),
    _tokens: c.tokens,
  };
}

function fallbackArticle(items, ctx, linkedModels, modelsById) {
  if (llmEnabled) return null; // con LLM configurado preferimos esperar a la próxima ejecución
  const lead = items[0];
  const m = linkedModels.length ? modelsById.get(linkedModels[0]) : null;
  const text = ctx[0].text || lead.summary || '';
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 60).slice(0, 4);
  let body = paragraphs.map((p) => firstSentences(p, 600)).join('\n\n');
  if (m) {
    body = `${m.summary || ''}\n\n## Ficha rápida\n\n${modelFactLine(m).split(' · ').map((l) => `- ${l}`).join('\n')}\n\n## Descripción original\n\n${body}`;
  }
  return {
    title: m ? `Nuevo modelo open source: ${m.name}` : lead.title,
    dek: firstSentences(m?.summary || text, 220),
    category: lead.category,
    tags: [lead.source],
    keyPoints: [],
    body: body || lead.summary || '',
    modelIds: linkedModels,
    generated: 'template',
  };
}

function modelFactLine(m) {
  const p = m.params ? `${(m.params / 1e9).toFixed(m.params < 1e10 ? 1 : 0)}B parámetros` : 'parámetros desconocidos';
  return [
    `${m.id}`,
    p,
    m.activeParams ? `${(m.activeParams / 1e9).toFixed(1)}B activos (MoE)` : null,
    m.minVram ? `VRAM mínima estimada ${m.minVram} GB (${m.hwTier})` : null,
    m.speed?.value ? `~${m.speed.value} ${m.speed.unit} en ${m.speed.ref}` : null,
    m.license ? `licencia ${m.license}` : null,
    `${m.likes} likes en Hugging Face`,
  ].filter(Boolean).join(' · ');
}

function buildFeed(articles) {
  const esc = (s = '') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const site = process.env.SITE_URL || '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Radar IA</title><link>${esc(site)}</link><description>Noticias y lanzamientos de IA, actualizados automáticamente.</description><language>es</language>
${articles.map((a) => `<item><title>${esc(a.title)}</title><link>${esc(site)}#/articulo/${a.slug}</link><guid>${a.slug}</guid><pubDate>${new Date(a.date).toUTCString()}</pubDate><description>${esc(a.dek)}</description><category>${esc(a.category)}</category></item>`).join('\n')}
</channel></rss>`;
}
