# Radar IA

Web con dos secciones, 100 % automatizadas:

- **Toolbox**: catálogo de modelos open source más recientes y en tendencia (Hugging Face), buscable describiendo tu problema en lenguaje natural ("quitar el fondo de un vídeo con 8 GB") y filtrable por hardware/VRAM, parámetros, velocidad de inferencia, licencia y fecha. Compara cada modelo con los de su tarea mediante benchmarks reales, oculta los que tienen una alternativa mejor y más ligera, y publica rankings por categoría.
- **Revista**: artículos en español sobre lanzamientos, investigación y noticias de IA, redactados por un LLM a partir de las fuentes y actualizados cada hora.

Sitio estático (sin build) + un pipeline Node sin dependencias, ejecutado cada hora por GitHub Actions, que publica en GitHub Pages.

## Cómo funciona

```
scripts/update.mjs          orquestador (cron horario)
├─ lib/research.mjs         radar de investigación de nicho (ver abajo)
├─ lib/models.mjs           Hugging Face (por tarea y por dominio) + proyectos del radar → catálogo
├─ lib/evals.mjs            benchmarks (HF, model-index, tablas del README, LMArena), tamaño de pesos, requisitos declarados
├─ lib/compare.mjs          puntuación relativa por tarea, rankings y modelos superados
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

Solo entra lo que es IA: un proyecto sin paper ni pesos publicados tiene que demostrar en su README que es un sistema de aprendizaje automático (entrenamiento, checkpoints, inferencia…).

### Comparar modelos (calidad relativa, rankings y "superados")

La calidad no es un número absoluto, sino la **posición frente a los demás modelos de la misma tarea** (`scripts/lib/evals.mjs` + `scripts/lib/compare.mjs`):

1. **Datos**, en dos niveles de fiabilidad:
   - **Evaluación independiente** (un tercero mide a todos con el mismo método; se descarga una vez al día):
     - [Epoch AI](https://epoch.ai/benchmarks) — Epoch Capabilities Index de LLM (CC BY 4.0, sin clave);
     - [LMArena](https://lmarena.ai/leaderboard) — Elo por votos humanos a ciegas en texto, WebDev, visión, imagen, edición y vídeo (CC BY 4.0, sin clave);
     - [Artificial Analysis](https://artificialanalysis.ai/) — índice de inteligencia de LLM y arenas de imagen, edición, vídeo, voz (TTS), transcripción (WER) y música. **Opcional**: requiere una clave gratuita (`AA_API_KEY`, 100 peticiones/día; se usan ~10) y citar la fuente.
     Los modelos de estas clasificaciones que no aparecen en los listados del Hub se buscan por nombre y se añaden al catálogo (`state/leaderboard-hf-ids.json`).
   - **Benchmarks declarados** por los autores: resultados de evaluación de Hugging Face (`.eval_results`), `model-index`, tablas del README y, con LLM, los que extrae de la ficha.
2. **Puntuación**: percentil del modelo en cada clasificación. Si tiene evaluación independiente, solo cuenta esa; si no, se usan los benchmarks declarados que publican al menos 3 modelos de su tarea, con contracción hacia la media para que nadie destaque solo por elegir dónde compararse. El ranking pone primero a los evaluados de forma independiente.
3. **Superado**: un modelo se marca así si otro de su tarea es igual o mejor en todos los benchmarks comunes y además igual o más ligero, o rinde prácticamente igual con al menos un 30 % menos de parámetros. No se aplica si el modelo superado tiene licencia permisiva y el otro no. La web los oculta por defecto.
4. **Categorías sin benchmarks comunes** (animación, mundos, terreno…): se ordenan por popularidad (estrellas y su ritmo, likes, descargas) y la web lo indica.

La pestaña **Cheatsheet** resume, por tarea, el mejor modelo, el mejor que cabe en tu hardware, el más ligero que rinde bien y la novedad destacada, con la fiabilidad del dato. **Rankings** muestra la clasificación completa de cada categoría y la ficha de cada modelo incluye una comparativa con sus competidores directos.

No existe una fuente gratuita única que cubra todo: hay evaluaciones independientes y actuales para LLM, visión, imagen, vídeo y (con Artificial Analysis) voz y música; para 3D, animación, mundos, robótica o segmentación solo hay cifras de los autores o popularidad, y la web lo indica.

**Hardware y velocidad**:
- Memoria mínima: lo que declara la ficha > LLM cuantizado a 4 bits (parámetros × 0,57 × 1,2) > tamaño real de los pesos publicados (listado de ficheros del Hub) × 1,15. Siempre se indica de dónde sale.
- Velocidad: en LLMs, estimación limitada por ancho de banda (tok/s en una GPU de referencia). En el resto, solo cuando la ficha da una cifra concreta (fps de inferencia, RTF, segundos por imagen); si no, aparece como "sin datos".

## Puesta en marcha

### Local

```bash
npm run update      # descarga modelos y noticias (añade -- --no-research para saltarte arXiv/GitHub)
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

Otras variables: `MAX_ANALYZE_PER_RUN` (250 fichas por ejecución) y `MAX_TREE_PER_RUN` (100 listados de ficheros), repartidos entre ejecuciones para no superar el límite de peticiones de Hugging Face; `ARTICLES_PER_RUN` (5), `MIN_ARTICLE_SCORE` (16), `MAX_ENRICH_PER_RUN` (40), `SITE_URL` (para el RSS), `GITHUB_TOKEN` (más cuota para la API de GitHub; en Actions ya va incluido), `HF_TOKEN` (token de Hugging Face de **solo lectura**, opcional: más cuota y acceso a las fichas de modelos restringidos cuyas condiciones hayas aceptado con tu cuenta).

### Producción (GitHub Pages, cada hora)

1. Crea un repositorio en GitHub y sube este proyecto a la rama `main`.
2. *Settings → Pages → Source*: **GitHub Actions**.
3. *Settings → Secrets and variables → Actions*:
   - Secrets: al menos uno de `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`. Opcionales: `HF_TOKEN`, `AA_API_KEY`.
   - Variables opcionales: `GROQ_MODELS`, `GEMINI_MODELS`, `OPENROUTER_MODELS`, `LLM_DAILY_BUDGET`, `ARTICLES_PER_RUN`, `SITE_URL`.
4. Lanza el workflow *Actualizar Radar IA* manualmente la primera vez (pestaña *Actions → Run workflow*). Después corre solo cada hora a los :07.

El workflow guarda los datos generados en el repo (historial completo) y despliega `public/` en Pages.

## Personalizar

- **Fuentes**: `config/sources.json`. Tipos `rss`, `reddit` y `html` (para webs sin RSS: indica `linkPattern` y se detectan enlaces nuevos).
- **Modelos imprescindibles**: añade el nombre a `config/watchlist.json`.
- **Búsqueda por problema**: añade palabras clave a `config/tasks.json`.
