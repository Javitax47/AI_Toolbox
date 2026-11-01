// Orquestador: radar de investigación → catálogo de modelos → revista.
// Uso: node scripts/update.mjs [--only=models|news]
import path from 'node:path';
import { readJSON, writeJSON, DATA_DIR, CONFIG_DIR } from './lib/util.mjs';
import { updateResearch } from './lib/research.mjs';
import { updateModels } from './lib/models.mjs';
import { updateNews } from './lib/news.mjs';
import { llmEnabled, llmModel } from './lib/llm.mjs';

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const t0 = Date.now();
console.log(`Radar IA · actualización ${new Date().toISOString()} · LLM: ${llmEnabled ? llmModel : 'no configurado (modo plantilla)'}`);

const tasks = await readJSON(path.join(CONFIG_DIR, 'tasks.json'), []);
const research = await updateResearch(tasks);

let models;
if (only !== 'news') models = await updateModels(research);
else models = (await readJSON(path.join(DATA_DIR, 'models.json'), { models: [] })).models;

if (only !== 'models') await updateNews(models, research);

await writeJSON(path.join(DATA_DIR, 'meta.json'), { updatedAt: new Date().toISOString(), llm: llmEnabled });
console.log(`Listo en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
