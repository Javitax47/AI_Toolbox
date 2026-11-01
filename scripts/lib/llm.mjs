// Cliente LLM mínimo para cualquier API compatible con OpenAI (OpenRouter por defecto).
// Sin LLM_API_KEY el pipeline sigue funcionando con resúmenes y artículos de plantilla.

const BASE = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || 'anthropic/claude-haiku-5.5';
const KEY = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '';

export const llmEnabled = Boolean(KEY);
export const llmModel = MODEL;

let failures = 0;

export async function llmJSON(system, user, { maxTokens = 2500, temperature = 0.3 } = {}) {
  if (!llmEnabled || failures >= 5) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY}`,
          'HTTP-Referer': 'https://github.com/radar-ia',
          'X-Title': 'Radar IA',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      const json = parseJSONLoose(content);
      if (json) return json;
      throw new Error('respuesta sin JSON válido');
    } catch (e) {
      console.warn(`  ! LLM: ${e.message}`);
      if (attempt === 1) failures++;
    }
  }
  return null;
}

function parseJSONLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}
