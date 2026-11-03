// Comparación entre modelos de la misma tarea.
// La "calidad" no es un número absoluto: es la posición frente a los demás modelos de su categoría.
//  - Si hay clasificaciones independientes (LMArena, Epoch AI, Artificial Analysis) o benchmarks
//    compartidos, se usan: percentil en cada uno, promediado (las independientes pesan el triple).
//  - Si no los hay (texturas, animación, muchos proyectos de investigación…), se usa la señal de la
//    comunidad (estrellas de GitHub, likes y descargas del Hub) y se indica así en la web.
// Además se marca un modelo como "superado" cuando otro de su tarea es igual o mejor en todos los
// benchmarks comparables y además es igual o más ligero (o rinde casi igual siendo mucho más pequeño).

const MIN_MODELS_PER_KEY = 3; // un benchmark solo cuenta si lo publican al menos 3 modelos de la tarea
const INDEP_WEIGHT = 3;
const PRIOR_WEIGHT = 1.5;

// Clasificaciones independientes: un tercero evalúa a todos con el mismo método (claves "x-…")
const isArena = (k) => k.startsWith('x-');
// Tolerancia para considerar dos resultados "prácticamente iguales"
const tol = (b, v) => b.tol ?? (Math.abs(v) <= 100 ? 1 : Math.abs(v) * 0.01);
const better = (b, x, y) => (b.lower ? x < y : x > y);

export function compareModels(models) {
  const groups = {};
  const boards = {};
  for (const m of models) (groups[m.task] ||= []).push(m);

  for (const [task, list] of Object.entries(groups)) {
    // 1) benchmarks utilizables en esta tarea
    const byKey = {};
    for (const m of list) for (const b of m.benchmarks || []) if (typeof b.value === 'number') (byKey[b.key] ||= []).push({ m, b });
    const keys = Object.keys(byKey).filter((k) => byKey[k].length >= (isArena(k) ? 2 : MIN_MODELS_PER_KEY));
    const pct = new Map(); // modelo → {key: percentil}
    for (const k of keys) {
      const rows = byKey[k];
      for (const { m, b } of rows) {
        const worse = rows.filter((o) => better(b, b.value, o.b.value)).length;
        const ties = rows.filter((o) => o.b.value === b.value).length - 1;
        const p = (worse + ties / 2) / (rows.length - 1);
        (pct.get(m) || pct.set(m, {}).get(m))[k] = p;
      }
    }

    // 2) puntuación: benchmarks si hay evidencia suficiente; si no, comunidad
    const lg = (v) => Math.log10((v || 0) + 1);
    const pop = (m) => lg(m.likes) + lg(m.downloads) * 0.35 + (m.kind === 'project' ? lg(m.starVelocity || 0) * 0.5 : 0);
    const pops = list.map(pop).sort((a, b) => a - b);
    for (const m of list) {
      const p = pct.get(m) || {};
      // Si hay evaluación independiente, solo cuenta esa: mezclarla con cifras autodeclaradas resta consistencia
      const hasArena = Object.keys(p).some(isArena);
      const ks = Object.keys(p).filter((k) => !hasArena || isArena(k));
      const cmp = { basis: 'comunidad', score: 0, keys: ks.length, rank: null, of: list.length, dominatedBy: [], beats: 0 };
      if (ks.length >= 2 || hasArena) {
        // Contracción hacia la media: quien publica pocos benchmarks (quizá solo en los que destaca) no puntúa extremo
        const prior = hasArena ? PRIOR_WEIGHT / 3 : PRIOR_WEIGHT;
        let s = prior * 0.5, w = prior;
        for (const k of ks) { const wt = isArena(k) ? INDEP_WEIGHT : 1; s += p[k] * wt; w += wt; }
        cmp.basis = hasArena ? 'independiente' : 'benchmarks';
        cmp.score = Math.round((s / w) * 100);
      } else {
        const v = pop(m);
        cmp.score = Math.round((pops.filter((x) => x < v).length / Math.max(1, pops.length - 1)) * 100);
      }
      m.cmp = cmp;
    }

    // 3) ranking: primero los que tienen benchmarks (comparables entre sí), luego el resto por comunidad
    // Orden por fiabilidad del dato: evaluación independiente > benchmarks declarados > popularidad
    const TIER = { independiente: 2, benchmarks: 1, comunidad: 0 };
    const ranked = [...list].sort((a, b) => (TIER[b.cmp.basis] - TIER[a.cmp.basis]) || (b.cmp.score - a.cmp.score) || (b.likes - a.likes));
    ranked.forEach((m, i) => { m.cmp.rank = i + 1; });
    const evidenced = ranked.filter((m) => m.cmp.basis !== 'comunidad');
    for (const m of list) m.cmp.evidenced = evidenced.length;

    // 4) dominancia
    const vals = (m) => Object.fromEntries((m.benchmarks || []).filter((b) => keys.includes(b.key)).map((b) => [b.key, b]));
    const V = new Map(evidenced.map((m) => [m, vals(m)]));
    for (const a of evidenced) {
      if (a.kind === 'project') continue;
      const va = V.get(a);
      const hits = [];
      for (const b of evidenced) {
        if (a === b || b.kind === 'project' || !a.params || !b.params) continue;
        if (a.permissive === true && b.permissive === false) continue; // la licencia también es un motivo para elegir A
        const vb = V.get(b);
        let shared = Object.keys(va).filter((k) => vb[k]);
        if (shared.some(isArena)) shared = shared.filter(isArena);
        if (!(shared.length >= 2 || shared.some(isArena))) continue;
        // La dominancia debe ser coherente con la imagen global (no basta con ganar en 2 benchmarks escogidos)
        if (b.cmp.score < a.cmp.score - 5) continue;
        let wins = 0, ok = true;
        for (const k of shared) {
          const x = vb[k].value, y = va[k].value, t = tol(va[k], y);
          const diff = va[k].lower ? y - x : x - y; // >0: B mejor
          if (diff < -t) { ok = false; break; }
          if (diff > t) wins++;
        }
        if (!ok) continue;
        const sizeRatio = b.params / a.params;
        const activeOk = (b.activeParams || b.params) <= (a.activeParams || a.params) * 1.1;
        let reason = null;
        if (sizeRatio <= 1.05 && activeOk && wins === shared.length) reason = 'mejor en todos los benchmarks comparables y igual o más ligero';
        else if (sizeRatio <= 1.05 && activeOk && wins >= Math.ceil(shared.length / 2)) reason = 'mejor o igual en todos los benchmarks comparables y igual o más ligero';
        else if (sizeRatio <= 0.7 && activeOk && shared.length >= (shared.some(isArena) ? 2 : 3)) reason = `rendimiento similar con ${Math.round((1 - sizeRatio) * 100)} % menos parámetros`;
        if (reason) hits.push({ id: b.id, name: b.name, reason, shared: shared.length, score: b.cmp.score });
      }
      hits.sort((x, y) => y.score - x.score);
      a.cmp.dominatedBy = hits.slice(0, 3).map(({ score, ...h }) => h);
      for (const h of hits) { const b = list.find((x) => x.id === h.id); if (b) b.cmp.beats++; }
    }
    // Benchmarks más habituales de la tarea (columnas de la clasificación)
    const common = keys.sort((x, y) => (isArena(y) - isArena(x)) || byKey[y].length - byKey[x].length).slice(0, 6);
    const names = {};
    for (const k of common) {
      const freq = {};
      for (const { b } of byKey[k]) freq[b.name] = (freq[b.name] || 0) + 1;
      const name = Object.keys(freq).sort((x, y) => (/[A-Z]/.test(y) - /[A-Z]/.test(x)) || freq[y] - freq[x] || x.length - y.length)[0];
      names[k] = { name, lower: Boolean(byKey[k][0].b.lower), n: byKey[k].length };
    }
    boards[task] = { keys: common, names, evidenced: evidenced.length, total: list.length };
  }
  return boards;
}
