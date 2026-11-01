// Orquestador: radar de investigación → catálogo de modelos → revista.
// Uso: node scripts/update.mjs [--only=models|news] [--no-research]
import path from 'node:path';
import { readJSON, writeJSON, DATA_DIR, CONFIG_DIR, STATE_DIR } from './lib/util.mjs';
import { updateResearch } from './lib/research.mjs';
import { updateModels } from './lib/models.mjs';
import { updateNews } from './lib/news.mjs';
import { llmEnabled, llmModel, saveLLMUsage } from './lib/llm.mjs';

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const t0 = Date.now();
console.log(`Radar IA · actualización ${new Date().toISOString()} · LLM: ${llmEnabled ? llmModel : 'sin proveedores configurados (modo plantilla)'}`);

const tasks = await readJSON(path.join(CONFIG_DIR, 'tasks.json'), []);
// --no-research reutiliza el radar guardado (útil para probar en local sin esperar a arXiv)
const research = process.argv.includes('--no-research')
  ? Object.values((await readJSON(path.join(STATE_DIR, 'research-state.json'), { items: {} })).items)
  : await updateResearch(tasks);

let models;
if (only !== 'news') models = await updateModels(research);
else models = (await readJSON(path.join(DATA_DIR, 'models.json'), { models: [] })).models;

if (only !== 'models') await updateNews(models, research);

await saveLLMUsage();
await writeJSON(path.join(DATA_DIR, 'meta.json'), { updatedAt: new Date().toISOString(), llm: llmEnabled });
console.log(`Listo en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
