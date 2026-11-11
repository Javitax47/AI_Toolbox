// Cliente LLM para APIs gratuitas compatibles con OpenAI, con cadena de proveedores:
// si uno agota su cuota (429) o falla, se pasa al siguiente modelo/proveedor.
// Proveedores (se activan los que tengan clave):
//   GROQ_API_KEY        → Groq (plan gratuito)
//   GEMINI_API_KEY      → Google Gemini (plan gratuito, endpoint compatible con OpenAI)
//   OPENROUTER_API_KEY  → OpenRouter, solo modelos ":free"
//   LLM_API_KEY + LLM_BASE_URL + LLM_MODEL → cualquier otro endpoint compatible (Cerebras, Mistral, local…)
// Los modelos de cada proveedor se pueden cambiar con GROQ_MODELS, GEMINI_MODELS, OPENROUTER_MODELS
// y LLM_MODEL (lista separada por comas).
// (GitHub Models se retiró el 30/07/2026, por eso no está.)
import path from 'node:path';
import { readJSON, writeJSON, STATE_DIR } from './util.mjs';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

const GROQ_DEFAULT = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'openai/gpt-oss-20b'];
const GEMINI_DEFAULT = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const PROVIDERS = [
  process.env.LLM_API_KEY && {
    name: 'custom', base: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1', key: process.env.LLM_API_KEY,
    models: list(process.env.LLM_MODEL, ['openrouter/auto']), maxChars: 60000,
  },
  process.env.GROQ_API_KEY && {
    name: 'groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY,
    models: list(process.env.GROQ_MODELS, GROQ_DEFAULT), defaults: GROQ_DEFAULT, maxChars: 24000,
  },
  process.env.GEMINI_API_KEY && {
    name: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: process.env.GEMINI_API_KEY,
    models: list(process.env.GEMINI_MODELS, GEMINI_DEFAULT), defaults: GEMINI_DEFAULT, maxChars: 60000,
  },
  process.env.OPENROUTER_API_KEY && {
    name: 'openrouter', base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY,
    models: list(process.env.OPENROUTER_MODELS, null), maxChars: 40000, // null → se descubren los ":free" disponibles
  },
].filter(Boolean);

export const llmEnabled = PROVIDERS.length > 0;
export const llmModel = PROVIDERS.map((p) => p.name).join(' → ');

// Presupuesto diario por tipo de tarea, para que los artículos no se queden sin cuota.
// Se puede ajustar con LLM_DAILY_BUDGET="article=40,triage=20,enrich=60"
const BUDGET = { article: 40, triage: 20, enrich: 60, ...Object.fromEntries(list(process.env.LLM_DAILY_BUDGET, []).map((kv) => { const [k, v] = kv.split('='); return [k, +v]; })) };
const USAGE_FILE = path.join(STATE_DIR, 'llm-usage.json');
let usage = null;
const exhausted = new Set(); // "proveedor/modelo" sin cuota en esta ejecución
const disabled = new Set(); // proveedores con clave inválida
const badReplies = {}; // respuestas sin JSON por modelo; a la segunda se deja de usar en esta ejecución

async function loadUsage() {
  if (usage) return usage;
  const today = new Date().toISOString().slice(0, 10);
  usage = await readJSON(USAGE_FILE, {});
  if (usage.date !== today) usage = { date: today, calls: {}, byModel: {} };
  return usage;
}

export async function saveLLMUsage() {
  if (usage) await writeJSON(USAGE_FILE, usage, true);
}

/** ¿Queda presupuesto hoy para este tipo de tarea? */
export async function llmBudgetLeft(kind) {
  if (!llmEnabled) return 0;
  const u = await loadUsage();
  return Math.max(0, (BUDGET[kind] ?? 20) - (u.calls[kind] || 0));
}

async function resolveModels(p) {
  if (p.models) return p.models;
  // OpenRouter: elige modelos gratuitos con contexto suficiente
  try {
    const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key}` } });
    const data = (await res.json()).data || [];
    p.models = data.filter((m) => m.id.endsWith(':free') && (m.context_length || 0) >= 32000)
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0)).slice(0, 4).map((m) => m.id);
  } catch { p.models = []; }
  return p.models;
}

export async function llmJSON(system, user, { maxTokens = 2500, temperature = 0.3, kind = 'article' } = {}) {
  if (!llmEnabled) return null;
  const u = await loadUsage();
  if ((u.calls[kind] || 0) >= (BUDGET[kind] ?? 20)) return null;

  for (const p of PROVIDERS) {
    if (disabled.has(p.name)) continue;
    const models = await resolveModels(p);
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      const id = `${p.name}/${model}`;
      if (exhausted.has(id)) continue;
      const body = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user.length > p.maxChars ? user.slice(0, p.maxChars - 1500) + '\n…\n' + user.slice(-1500) : user },
        ],
      };
      if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
      try {
        const res = await fetch(`${p.base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}`, 'HTTP-Referer': 'https://github.com/radar-ia', 'X-Title': 'Radar IA' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        if (res.status === 401 || res.status === 403) {
          console.warn(`  ! LLM ${p.name}: clave sin permiso (${res.status}), se desactiva`);
          disabled.add(p.name);
          break;
        }
        if (res.status === 429 || res.status === 413 || res.status === 404 || res.status === 400) {
          console.warn(`  ! LLM ${id}: HTTP ${res.status} (${(await res.text()).slice(0, 120).replace(/\s+/g, ' ')}), se prueba el siguiente`);
          exhausted.add(id);
          // Un nombre mal escrito en *_MODELS no debe dejar la web sin LLM: se añaden los modelos por defecto
          if (res.status === 404 && p.defaults) for (const d of p.defaults) if (!models.includes(d)) models.push(d);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const json = parseJSONLoose(data.choices?.[0]?.message?.content || '');
        u.calls[kind] = (u.calls[kind] || 0) + 1;
        u.byModel[id] = (u.byModel[id] || 0) + 1;
        if (json) return json;
        console.warn(`  ! LLM ${id}: respuesta sin JSON válido`);
        badReplies[id] = (badReplies[id] || 0) + 1;
        if (badReplies[id] >= 2) exhausted.add(id);
        if ((u.calls[kind] || 0) >= (BUDGET[kind] ?? 20)) return null;
      } catch (e) {
        console.warn(`  ! LLM ${id}: ${e.message}`);
        exhausted.add(id);
      }
    }
  }
  return null;
}

function parseJSONLoose(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : clean;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}
