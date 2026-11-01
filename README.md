# Radar IA

Web con dos secciones, 100 % automatizadas:

- **Toolbox**: catálogo de modelos open source más recientes y en tendencia (Hugging Face), buscable describiendo tu problema en lenguaje natural ("quitar el fondo de un vídeo con 8 GB") y filtrable por hardware/VRAM, parámetros, velocidad de inferencia, calidad, licencia y fecha.
- **Revista**: artículos en español sobre lanzamientos, investigación y noticias de IA, redactados por un LLM a partir de las fuentes y actualizados cada hora.

Sitio estático (sin build) + un pipeline Node sin dependencias, ejecutado cada hora por GitHub Actions, que publica en GitHub Pages.

## Cómo funciona

```
scripts/update.mjs          orquestador (cron horario)
├─ lib/research.mjs         radar de investigación de nicho (ver abajo)
├─ lib/models.mjs           Hugging Face (por tarea y por dominio) + proyectos del radar → catálogo con estimaciones
├─ lib/news.mjs             RSS + páginas sin RSS + lanzamientos HF + radar + GitHub → agrupación por tema → artículo
└─ lib/llm.mjs              cadena de APIs gratuitas compatibles con OpenAI (Groq → Gemini → OpenRouter) con presupuesto diario
config/tasks.json           tareas/dominios: palabras clave (ES) para buscar, términos (EN) para clasificar, etiquetas HF y topics GitHub
config/sources.json         fuentes de noticias, agregadores, categorías de arXiv y umbrales
config/watchlist.json       (opcional) modelos que siempre deben aparecer
public/                     web (index.html, app.js, styles.css) + data/*.json generados
state/                      estado del pipeline (qué noticias ya se cubrieron)
```

### Radar de investigación

La mayoría de lanzamientos interesantes (animación, mundos 3D, terreno, assets, física…) no son de grandes laboratorios ni salen en trending: son papers con un repo de GitHub de pocas decenas de estrellas. El radar los encuentra así:

1. **arXiv** (cs.CV, cs.GR, cs.RO, cs.SD, cs.CL, cs.LG, cs.AI, cs.MA, cs.HC, eess.AS, eess.IV): unos 400 papers al día. Se quedan los que publican código, pesos o página de proyecto y encajan en algún dominio de `tasks.json`.
2. **Agregadores**: canales de YouTube (AI Search, Two Minute Papers) cuyas descripciones enlazan cada proyecto; los enlaces se resuelven a paper/repo/pesos. Una mención suma mucho interés.
3. **GitHub por dominio**: repos nuevos con topics como `motion-generation`, `terrain-generation`, `world-model`… desde 15 estrellas.
4. **HF Daily Papers**: votos de la comunidad y repos asociados.

Cada hallazgo se sigue 30 días: estrellas (y su velocidad), votos, menciones y pesos publicados en Hugging Face (`arxiv:<id>`). Con LLM se hace además un triaje de interés práctico. Lo que supera el umbral entra en el toolbox como **proyecto de investigación** y en la revista.

**Estimaciones** (marcadas como tales en la web):
- VRAM = parámetros × bytes por peso (Q4 0,57 · Q8 1,07 · FP16 2) × 1,2 de margen. LLMs se evalúan en Q4; el resto en FP16.
- Velocidad LLM = ancho de banda de la GPU de referencia × 0,6 / tamaño de los pesos activos (tok/s). Otros modelos: categoría por tamaño y tarea.
- Calidad = 65 % puntuación del LLM a partir de los benchmarks de la ficha + 35 % tracción en la comunidad (likes, tendencia, descargas). Sin LLM solo cuenta la tracción.

## Puesta en marcha

### Local

```bash
npm run update      # descarga modelos y noticias
npm run serve       # http://localhost:4321
```

### LLM gratuito

El LLM redacta los artículos en español, resume las fichas y hace el triaje de papers. Funciona con **APIs gratuitas** y encadena proveedores: si uno agota su cuota (HTTP 429) o falla, pasa al siguiente modelo o proveedor. Basta con una clave; cuantas más pongas, más margen tienes.

| Variable | Proveedor | Modelos por defecto |
|---|---|---|
| `GROQ_API_KEY` | [Groq](https://console.groq.com/keys) (recomendado, plan gratuito sin tarjeta) | `openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `qwen/qwen3-32b`, `openai/gpt-oss-20b` |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) | `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| `OPENROUTER_API_KEY` | [OpenRouter](https://openrouter.ai/keys) | se descubren solos los modelos `:free` |
| `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` | cualquier endpoint compatible con OpenAI | — |

Los modelos se cambian con `GROQ_MODELS`, `GEMINI_MODELS`, `OPENROUTER_MODELS` (lista separada por comas). Los límites de los planes gratuitos cambian a menudo; si un modelo desaparece, el pipeline lo salta y lo verás en el log.

Para no agotar la cuota, hay un **presupuesto diario** por tipo de tarea (`LLM_DAILY_BUDGET`, por defecto `article=40,triage=20,enrich=60`). Los artículos se reparten entre las horas que quedan del día, y lo que no se redacta por falta de cuota se reintenta más tarde. El consumo queda en `state/llm-usage.json`.

Sin ninguna clave funciona en **modo plantilla**: resúmenes en inglés sacados de las fichas y artículos básicos.

```bash
GROQ_API_KEY=gsk_... npm run update
```

Otras variables: `ARTICLES_PER_RUN` (5), `MIN_ARTICLE_SCORE` (16), `MAX_ENRICH_PER_RUN` (40), `SITE_URL` (para el RSS), `GITHUB_TOKEN` (más cuota para la API de GitHub; en Actions ya va incluido).

### Producción (GitHub Pages, cada hora)

1. Crea un repositorio en GitHub y sube este proyecto a la rama `main`.
2. *Settings → Pages → Source*: **GitHub Actions**.
3. *Settings → Secrets and variables → Actions*:
   - Secrets: al menos uno de `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`.
   - Variables opcionales: `GROQ_MODELS`, `GEMINI_MODELS`, `OPENROUTER_MODELS`, `LLM_DAILY_BUDGET`, `ARTICLES_PER_RUN`, `SITE_URL`.
4. Lanza el workflow *Actualizar Radar IA* manualmente la primera vez (pestaña *Actions → Run workflow*). Después corre solo cada hora a los :07.

El workflow guarda los datos generados en el repo (historial completo) y despliega `public/` en Pages.

## Personalizar

- **Fuentes**: `config/sources.json`. Tipos `rss`, `reddit` y `html` (para webs sin RSS: indica `linkPattern` y se detectan enlaces nuevos).
- **Modelos imprescindibles**: añade el nombre a `config/watchlist.json`.
- **Búsqueda por problema**: añade palabras clave a `config/tasks.json`.
