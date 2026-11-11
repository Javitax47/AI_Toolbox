// Repara las imágenes de artículos ya publicados: sustituye las tarjetas de opengraph.githubassets.com
// (dan 429 en el navegador) por la primera figura del README del repositorio.
// Uso: node scripts/backfill-images.mjs
import path from 'node:path';
import { readJSON, writeJSON, fetchText, DATA_DIR } from './lib/util.mjs';
import { readmeImage } from './lib/news.mjs';

const indexPath = path.join(DATA_DIR, 'articles.json');
const index = await readJSON(indexPath, { articles: [] });
let fixed = 0;
for (const entry of index.articles) {
  const repo = entry.image?.match(/opengraph\.githubassets\.com\/\d+\/([^/]+\/[^/?#]+)/)?.[1];
  if (!repo && entry.image) continue;
  const file = path.join(DATA_DIR, 'articles', `${entry.slug}.json`);
  const article = await readJSON(file, null);
  const src = repo || (article?.sources || []).map((s) => s.url.match(/github\.com\/([^/]+\/[^/?#]+)/)?.[1]).find(Boolean);
  const md = src ? await fetchText(`https://raw.githubusercontent.com/${src}/HEAD/README.md`, { retries: 1 }) : null;
  const model = (entry.modelIds || [])[0];
  const image = (md ? readmeImage(md, src) : null) || (model ? `https://cdn-thumbnails.huggingface.co/social-thumbnails/models/${model}.png` : null);
  entry.image = image;
  if (article) { article.image = image; await writeJSON(file, article); }
  if (image) fixed++;
  console.log(`${image ? '✓' : '·'} ${entry.title.slice(0, 60)} → ${image || 'sin imagen'}`);
}
await writeJSON(indexPath, index);
console.log(`${fixed} imágenes reparadas`);
