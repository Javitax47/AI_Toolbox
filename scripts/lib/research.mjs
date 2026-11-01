// Descubrimiento de investigación de nicho: papers de arXiv con código, enlaces de canales
// agregadores (YouTube), repos nuevos de GitHub por dominio y HF Daily Papers.
// Cada hallazgo se sigue durante semanas (estrellas, votos, pesos publicados) para detectar
// proyectos poco conocidos que empiezan a despegar.
import path from 'node:path';
import { fetchJSON, fetchText, readJSON, writeJSON, pool, sleep, stripHtml, decodeEntities, firstSentences, normalizeText, STATE_DIR, CONFIG_DIR } from './util.mjs';
import { llmJSON, llmEnabled } from './llm.mjs';

const TRACK_DAYS = 30;
const GH_HEADERS = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } : { Accept: 'application/vnd.github+json' };
const GH_BUDGET = process.env.GITHUB_TOKEN ? 120 : 20; // llamadas a la API de repos por ejecución
const SKIP_DOMAINS = /(youtube\.com|youtu\.be|twitter\.com|x\.com|patreon|discord|instagram|tiktok|facebook|linkedin|ko-fi|buymeacoffee|amzn|amazon\.|gumroad|bit\.ly|linktr\.ee|lumalabs|skool\.com|beehiiv|substack\.com\/subscribe|google\.com\/search|forms\.gle)/i;

let ghCalls = 0;

/** Clasifica un texto en tareas del toolbox (multi-etiqueta) por términos en inglés. */
export function classify(text, tasks) {
  const t = ` ${normalizeText(text).replace(/[^a-z0-9+.\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  return tasks
    .map((task) => ({ tag: task.tag, hits: (task.terms || []).filter((term) => t.includes(` ${term} `) || t.includes(` ${term}s `) || t.includes(` ${term}-`)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || (tasks.find((x) => x.tag === b.tag).custom ? 1 : 0) - (tasks.find((x) => x.tag === a.tag).custom ? 1 : 0));
}

export async function updateResearch(tasks) {
  const cfg = (await readJSON(path.join(CONFIG_DIR, 'sources.json'), {})).research || {};
  const statePath = path.join(STATE_DIR, 'research-state.json');
  const state = await readJSON(statePath, { items: {}, alias: {}, arxivSeen: {}, ytSeen: {} });
  const now = new Date().toISOString();
  ghCalls = 0;

  const upsert = (it) => {
    const keys = [it.arxivId && `arxiv:${it.arxivId}`, it.repo && `gh:${it.repo.toLowerCase()}`, it.hfId && `hf:${it.hfId}`].filter(Boolean);
    let key = keys.map((k) => state.alias[k] || (state.items[k] ? k : null)).find(Boolean);
    if (!key) key = keys[0] || `url:${it.url}`;
    const old = state.items[key] || { firstSeen: now, mentions: [], tasks: [], weights: [] };
    const merged = { ...old };
    for (const [k, v] of Object.entries(it)) {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      if (k === 'mentions' || k === 'weights') merged[k] = [...new Set([...(old[k] || []), ...v])];
      else if (k === 'upvotes' || k === 'stars') merged[k] = Math.max(old[k] || 0, v);
      else if (old[k] == null || k === 'summary' && v.length > (old.summary || '').length) merged[k] = v;
    }
    merged.key = key;
    merged.lastSeen = now;
    state.items[key] = merged;
    for (const k of keys) if (k !== key) state.alias[k] = key;
    return merged;
  };

  // 1) Fuentes
  const [arxiv, daily, aggregated, topics] = await Promise.all([
    collectArxiv(cfg.arxiv || {}, state, tasks),
    collectDailyPapers(),
    collectAggregators(cfg.aggregators || [], state),
    collectGitHubTopics(tasks, cfg.githubTopics || {}),
  ]);
  console.log(`· Investigación: arXiv ${arxiv.length} con código · HF Papers ${daily.length} · agregadores ${aggregated.length} enlaces · GitHub por dominio ${topics.length}`);

  for (const it of arxiv) upsert(it);
  for (const it of aggregated) upsert(it);
  for (const it of topics) upsert(it);
  // HF Daily Papers: actualiza votos de lo que ya seguimos y añade papers populares o de dominios de interés
  for (const it of daily) {
    const known = state.items[state.alias[`arxiv:${it.arxivId}`] || `arxiv:${it.arxivId}`];
    if (known || it.upvotes >= 25 || (it.hasCode && classify(`${it.title} ${it.summary}`, tasks).length)) upsert(it);
  }

  // 2) Completa metadatos que faltan (papers citados por agregadores sin título, etc.)
  const items = Object.values(state.items);
  const missingArxiv = items.filter((i) => i.arxivId && !i.title).map((i) => i.arxivId);
  if (missingArxiv.length) for (const e of await arxivById(missingArxiv)) upsert(e);

  // 3) Clasificación y señales
  for (const it of Object.values(state.items)) {
    if (!it.tasks?.length) it.tasks = classify(`${it.title || ''} ${it.summary || ''} ${(it.topics || []).join(' ')}`, tasks).slice(0, 3).map((x) => x.tag);
    it.hasCode = Boolean(it.repo || it.weights?.length);
  }

  // 4) Estrellas de GitHub: repos nuevos primero, luego los que llevan más tiempo sin comprobar
  const toCheck = Object.values(state.items)
    .filter((i) => i.repo && Date.now() - new Date(i.firstSeen) < TRACK_DAYS * 86400000)
    .sort((a, b) => (a.starsCheckedAt ? 1 : 0) - (b.starsCheckedAt ? 1 : 0) || new Date(a.starsCheckedAt || 0) - new Date(b.starsCheckedAt || 0))
    .slice(0, GH_BUDGET);
  await pool(toCheck, 4, async (it) => {
    const r = await gh(`https://api.github.com/repos/${it.repo}`);
    if (!r) return;
    it.stars = r.stargazers_count;
    it.repoCreated = r.created_at;
    it.topics = r.topics || it.topics;
    it.description = r.description || it.description;
    it.homepage = r.homepage || it.homepage;
    it.starsCheckedAt = now;
    it.starsHist = [...(it.starsHist || []), [now, r.stargazers_count]].slice(-30);
  });
  console.log(`· Estrellas comprobadas: ${toCheck.length} repos (${ghCalls} llamadas a GitHub)`);

  // 5) ¿Hay pesos publicados en Hugging Face para el paper?
  const weightCheck = Object.values(state.items).filter((i) => i.arxivId && !i.weightsCheckedAt && (i.tasks.length || i.upvotes >= 10 || i.mentions.length)).slice(0, 40);
  await pool(weightCheck, 6, async (it) => {
    const list = await fetchJSON(`https://huggingface.co/api/models?filter=arxiv:${it.arxivId}&sort=likes&limit=3`, { retries: 1 });
    it.weights = [...new Set([...(it.weights || []), ...(list || []).map((m) => m.id)])];
    it.weightsCheckedAt = now;
  });

  // 6) Triaje con LLM de lo nuevo (relevancia práctica, tarea, resumen)
  await triage(Object.values(state.items).filter((i) => i.llmScore == null && (i.hasCode || i.mentions.length || i.upvotes >= 10)).slice(0, 80), tasks);

  // 7) Puntuación y poda
  const weightOf = (tag) => (tasks.find((t) => t.tag === tag)?.custom ? 1.5 : 1) * ((cfg.domainWeights || {})[tag] ?? 1);
  for (const it of Object.values(state.items)) it.score = scoreItem(it, weightOf);
  const cutoff = Date.now() - TRACK_DAYS * 86400000;
  for (const [k, it] of Object.entries(state.items)) if (new Date(it.firstSeen) < cutoff && !(it.score >= 25)) delete state.items[k];
  for (const [a, k] of Object.entries(state.alias)) if (!state.items[k]) delete state.alias[a];
  const old = Date.now() - 20 * 86400000;
  state.arxivSeen = Object.fromEntries(Object.entries(state.arxivSeen).filter(([, d]) => new Date(d) > old));
  state.ytSeen = Object.fromEntries(Object.entries(state.ytSeen).filter(([, d]) => new Date(d) > old));

  await writeJSON(statePath, state);
  const all = Object.values(state.items).sort((a, b) => b.score - a.score);
  console.log(`✓ ${all.length} proyectos de investigación en seguimiento; top: ${all.slice(0, 5).map((i) => i.name).join(', ')}`);
  return all;
}

function scoreItem(it, weightOf) {
  const lg = (v) => Math.log10((v || 0) + 1);
  const domain = it.tasks.length ? 6 * Math.max(...it.tasks.map(weightOf)) : 0;
  const hist = it.starsHist || [];
  let velocity = 0;
  if (hist.length >= 2) {
    const [t0, s0] = hist[0];
    const [t1, s1] = hist[hist.length - 1];
    velocity = Math.max(0, (s1 - s0) / Math.max(0.5, (new Date(t1) - new Date(t0)) / 86400000));
  } else if (it.stars && it.repoCreated) {
    velocity = it.stars / Math.max(1, (Date.now() - new Date(it.repoCreated)) / 86400000);
  }
  return +(
    domain
    + (it.hasCode ? 3 : 0)
    + (it.weights?.length ? 4 : 0)
    + 4 * lg(it.stars)
    + 4 * lg(it.upvotes)
    + 5 * lg(velocity)
    + 12 * Math.min(2, it.mentions.length)
    + (it.llmScore != null ? (it.llmScore - 5) * 3 : 0)
  ).toFixed(2);
}

// ---------- arXiv ----------

function parseArxiv(xml) {
  return xml.split('<entry>').slice(1).map((e) => {
    const get = (tag) => decodeEntities((e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const id = get('id').replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
    const summary = get('summary');
    const comment = get('arxiv:comment');
    const cats = [...e.matchAll(/<category[^>]+term="([^"]+)"/g)].map((m) => m[1]);
    return { id, title: get('title'), summary, comment, published: get('published'), cats, ...extractLinks(`${summary} ${comment}`) };
  });
}

/** Extrae repo de GitHub, página de proyecto y pesos de HF de un texto. */
export function extractLinks(text) {
  const out = {};
  const repo = text.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (repo && !/^(orgs|topics|features|sponsors|settings|marketplace)$/.test(repo[1])) out.repo = `${repo[1]}/${repo[2].replace(/\.git$|[.,;)]+$/, '')}`;
  const project = text.match(/https?:\/\/[A-Za-z0-9-]+\.github\.io\/[^\s,;)<>"']*/) || text.match(/https?:\/\/(?!github\.com|huggingface\.co|arxiv\.org)[^\s,;)<>"']+\/(?:project|projects|page)\/?[^\s,;)<>"']*/i);
  if (project) out.project = project[0].replace(/[.]+$/, '');
  const hf = [...text.matchAll(/huggingface\.co\/(?!datasets|spaces|papers|docs|blog)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)].map((m) => m[1].replace(/[.,;)]+$/, ''));
  if (hf.length) out.weights = [...new Set(hf)];
  return out;
}

async function collectArxiv(cfg, state, tasks) {
  const cats = cfg.categories || ['cs.CV', 'cs.GR', 'cs.RO', 'cs.SD', 'eess.AS', 'cs.CL', 'cs.LG', 'cs.AI', 'cs.MA', 'cs.HC', 'eess.IV'];
  const q = cats.map((c) => `cat:${c}`).join('+OR+');
  const entries = [];
  for (let start = 0; start < (cfg.maxResults || 1200); start += 400) {
    const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=400`, { timeout: 60000, retries: 2 });
    if (!xml) break;
    const page = parseArxiv(xml);
    entries.push(...page);
    if (page.length < 400 || page.every((e) => state.arxivSeen[e.id])) break;
    await sleep(3100); // normas de uso de la API de arXiv
  }
  const now = new Date().toISOString();
  const out = [];
  for (const e of entries) {
    if (!e.id || state.arxivSeen[e.id]) continue;
    state.arxivSeen[e.id] = now;
    // Solo nos interesa lo que se puede usar (código, pesos o página de proyecto) y encaja en algún dominio
    if (!(e.repo || e.weights || e.project || /code (is|will be)|available at|project page|open-source/i.test(e.summary + e.comment))) continue;
    if (!classify(`${e.title} ${e.summary}`, tasks).length) continue;
    out.push(paperItem(e));
  }
  return out;
}

function paperItem(e) {
  return {
    kind: 'paper',
    arxivId: e.id,
    title: e.title,
    name: shortName(e.title),
    summary: e.summary,
    published: e.published,
    repo: e.repo,
    project: e.project,
    weights: e.weights,
    url: `https://arxiv.org/abs/${e.id}`,
    source: 'arXiv',
  };
}

async function arxivById(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const xml = await fetchText(`https://export.arxiv.org/api/query?id_list=${ids.slice(i, i + 50).join(',')}&max_results=50`, { timeout: 60000 });
    if (xml) out.push(...parseArxiv(xml).map(paperItem));
    await sleep(3100);
  }
  return out;
}

function shortName(title = '') {
  const m = title.match(/^([^:]{2,40}):\s/);
  return m ? m[1].trim() : title.split(/\s+/).slice(0, 6).join(' ');
}

// ---------- HF Daily Papers ----------

async function collectDailyPapers() {
  const days = [0, 1, 2, 3].map((d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10));
  const lists = await pool(days, 4, (d) => fetchJSON(`https://huggingface.co/api/daily_papers?date=${d}&limit=100`, { retries: 1 }));
  const base = (await fetchJSON('https://huggingface.co/api/daily_papers?limit=100', { retries: 1 })) || [];
  const seen = new Set();
  return [...lists.flat(), ...base].filter(Boolean).filter((p) => p.paper?.id && !seen.has(p.paper.id) && seen.add(p.paper.id)).map((p) => {
    const repo = p.paper.githubRepo ? extractLinks(p.paper.githubRepo).repo : null;
    return {
      kind: 'paper',
      arxivId: p.paper.id,
      title: p.paper.title || p.title,
      name: shortName(p.paper.title || p.title),
      summary: p.paper.summary,
      published: p.paper.publishedAt,
      upvotes: p.paper.upvotes || 0,
      repo,
      stars: p.paper.githubStars || 0,
      hasCode: Boolean(repo),
      url: `https://arxiv.org/abs/${p.paper.id}`,
      image: p.thumbnail || null,
      source: 'Hugging Face Papers',
    };
  });
}

// ---------- Agregadores (canales de YouTube que enlazan proyectos en la descripción) ----------

async function collectAggregators(aggs, state) {
  const out = [];
  for (const a of aggs) {
    const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${a.channelId}`, { retries: 1 });
    if (!xml) continue;
    const videos = xml.split('<entry>').slice(1).map((e) => ({
      id: e.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1],
      title: decodeEntities(e.match(/<title>(.*?)<\/title>/)?.[1] || ''),
      date: e.match(/<published>(.*?)<\/published>/)?.[1],
      desc: decodeEntities(e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || ''),
    })).filter((v) => v.id && !state.ytSeen[v.id] && Date.now() - new Date(v.date) < 10 * 86400000);
    for (const v of videos) {
      state.ytSeen[v.id] = new Date().toISOString();
      const links = [...new Set([...v.desc.matchAll(/https?:\/\/[^\s<>"']+/g)].map((m) => m[0].replace(/[.,;)]+$/, '')))]
        .filter((u) => !SKIP_DOMAINS.test(u))
        .slice(0, a.maxLinks || 60);
      const mention = `${a.name}: ${v.title}`;
      const resolved = await pool(links, 5, (u) => resolveLink(u, mention, v.date));
      out.push(...resolved.filter(Boolean));
      console.log(`  · ${a.name} «${v.title.slice(0, 60)}»: ${resolved.filter(Boolean).length}/${links.length} enlaces útiles`);
    }
  }
  return out;
}

async function resolveLink(url, mention, date) {
  const base = { mentions: [mention], published: date };
  const ax = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/) || url.match(/huggingface\.co\/papers\/(\d{4}\.\d{4,5})/);
  if (ax) return { ...base, kind: 'paper', arxivId: ax[1], url: `https://arxiv.org/abs/${ax[1]}`, source: 'arXiv' };
  const gh = url.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (gh) {
    const repo = `${gh[1]}/${gh[2].replace(/\.git$/, '')}`;
    return { ...base, kind: 'repo', repo, name: gh[2], title: repo, url: `https://github.com/${repo}`, source: 'GitHub' };
  }
  const hf = url.match(/^https?:\/\/huggingface\.co\/(?!datasets|spaces|papers|docs|blog)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (hf) return { ...base, kind: 'model', hfId: hf[1], weights: [hf[1]], name: hf[1].split('/')[1], title: hf[1], url: `https://huggingface.co/${hf[1]}`, source: 'Hugging Face' };
  // Página de proyecto o noticia: busca dentro enlaces a paper / código
  const html = await fetchText(url, { retries: 0, timeout: 15000 });
  if (!html) return null;
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0, 160);
  const desc = decodeEntities(html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']+)["']/i)?.[1] || '');
  const links = extractLinks(html);
  const axIn = html.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/);
  if (!title && !axIn && !links.repo) return null;
  return {
    ...base,
    kind: axIn ? 'paper' : links.repo ? 'repo' : 'web',
    arxivId: axIn?.[1],
    repo: links.repo,
    weights: links.weights,
    project: url,
    title: title || url,
    name: shortName(title) || url,
    summary: desc,
    url: axIn ? `https://arxiv.org/abs/${axIn[1]}` : url,
    source: new URL(url).hostname.replace(/^www\./, ''),
  };
}

// ---------- GitHub por dominio ----------

async function collectGitHubTopics(tasks, cfg) {
  const since = new Date(Date.now() - (cfg.maxAgeDays || 21) * 86400000).toISOString().slice(0, 10);
  const topics = [...new Set(tasks.flatMap((t) => (t.githubTopics || []).map((topic) => `${t.tag}|${topic}`)))];
  const out = [];
  for (const tt of topics) {
    const [tag, topic] = tt.split('|');
    const res = await gh(`https://api.github.com/search/repositories?q=topic:${topic}+created:%3E${since}+stars:%3E${cfg.minStars || 15}&sort=stars&order=desc&per_page=10`, true);
    for (const r of (res?.items || []).filter(okRepo)) {
      out.push({
        kind: 'repo', repo: r.full_name, name: r.name, title: `${r.full_name}${r.description ? ': ' + r.description : ''}`.slice(0, 200),
        summary: r.description || '', stars: r.stargazers_count, repoCreated: r.created_at, topics: r.topics, homepage: r.homepage,
        published: r.created_at, url: r.html_url, tasks: [tag], source: 'GitHub', ...extractLinks(`${r.description || ''} ${r.homepage || ''}`),
      });
    }
    await sleep(process.env.GITHUB_TOKEN ? 2100 : 6500); // límite de la API de búsqueda
  }
  return out;
}

async function gh(url, search = false) {
  if (!search && ghCalls >= GH_BUDGET) return null;
  ghCalls++;
  return fetchJSON(url, { headers: GH_HEADERS, retries: 1 });
}

// ---------- Triaje ----------

async function triage(items, tasks) {
  if (!llmEnabled || !items.length) return;
  const tagList = tasks.map((t) => `${t.tag} (${t.label})`).join(', ');
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20);
    const out = await llmJSON(
      'Eres el editor de investigación de una revista de IA en español. Tu trabajo es detectar proyectos y papers poco conocidos pero interesantes y utilizables. Respondes SOLO con JSON válido.',
      `Puntúa cada elemento del 1 al 10 según su interés para lectores que siguen lanzamientos de IA y quieren herramientas que puedan usar:
- 8-10: capacidad nueva o salto claro de calidad/eficiencia, con código o pesos, demo llamativa (p. ej. generar mundos 3D explorables, animación de personajes en tiempo real, TTS diminuto que corre en CPU).
- 5-7: útil o curioso pero incremental.
- 1-4: puramente teórico, benchmark menor, survey, o mejora marginal.
Asigna también hasta 2 tareas de esta lista: ${tagList}.

ELEMENTOS:
${batch.map((it, n) => `[${n}] ${it.title}\n${firstSentences(it.summary || it.description || '', 700)}`).join('\n\n')}

Devuelve: {"items":[{"i":0,"puntuacion":7,"tareas":["tag"],"resumen":"una frase en español"}]}`,
      { maxTokens: 2500, temperature: 0.2, kind: 'triage' }
    );
    for (const r of out?.items || []) {
      const it = batch[r.i];
      if (!it) continue;
      it.llmScore = Math.max(1, Math.min(10, Number(r.puntuacion) || 5));
      const valid = (r.tareas || []).filter((t) => tasks.some((x) => x.tag === t));
      if (valid.length) it.tasks = [...new Set([...valid, ...(it.tasks || [])])].slice(0, 3);
      if (r.resumen) it.summaryEs = String(r.resumen);
    }
  }
}

/** Descarta listas "awesome" y repos cuya descripción no está en alfabeto latino (la revista es en español). */
function okRepo(r) {
  const d = r.description || '';
  return !/awesome|curated (list|collection)/i.test(`${r.name} ${d}`) && d.replace(/[^\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g, '').length < d.length * 0.2;
}
