# Radar IA

Web con dos secciones, 100 % automatizadas:

- **Toolbox**: catálogo de modelos open source más recientes y en tendencia (Hugging Face), buscable describiendo tu problema en lenguaje natural ("quitar el fondo de un vídeo con 8 GB") y filtrable por hardware/VRAM, parámetros, velocidad de inferencia, calidad, licencia y fecha.
- **Revista**: artículos en español sobre lanzamientos, investigación y noticias de IA, redactados por un LLM a partir de las fuentes y actualizados cada hora.

Sitio estático (sin build) + un pipeline Node sin dependencias, ejecutado cada hora por GitHub Actions, que publica en GitHub Pages.

## Cómo funciona

```
scripts/update.mjs          orquestador (cron horario)
├─ lib/models.mjs           Hugging Face → catálogo, estimaciones de VRAM/velocidad/calidad, resumen ES por LLM (una vez por modelo)
├─ lib/news.mjs             RSS + páginas sin RSS + lanzamientos HF + HF Papers + GitHub → agrupación por tema → artículo por LLM
└─ lib/llm.mjs              cliente para cualquier API compatible con OpenAI (OpenRouter por defecto)
config/tasks.json           tareas, etiquetas y palabras clave en español para la búsqueda por problema
config/sources.json         fuentes de noticias y umbrales (añade/quita libremente)
config/watchlist.json       modelos que siempre deben aparecer aunque no estén en trending
public/                     web (index.html, app.js, styles.css) + data/*.json generados
state/                      estado del pipeline (qué noticias ya se cubrieron)
```

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

Sin `LLM_API_KEY` funciona en **modo plantilla**: resúmenes en inglés sacados de las fichas y artículos básicos. Con clave, los resúmenes y artículos se escriben en español y se descartan noticias irrelevantes.

```bash
LLM_API_KEY=sk-or-... npm run update
```

Variables opcionales: `LLM_BASE_URL` (por defecto `https://openrouter.ai/api/v1`), `LLM_MODEL` (por defecto `anthropic/claude-haiku-5.5`), `ARTICLES_PER_RUN` (5), `MIN_ARTICLE_SCORE` (16), `MAX_ENRICH_PER_RUN` (40), `SITE_URL` (para el RSS).

### Producción (GitHub Pages, cada hora)

1. Crea un repositorio en GitHub y sube este proyecto a la rama `main`.
2. *Settings → Pages → Source*: **GitHub Actions**.
3. *Settings → Secrets and variables → Actions*:
   - Secret `LLM_API_KEY` con tu clave de OpenRouter (u otro proveedor compatible).
   - Variables opcionales: `LLM_MODEL`, `LLM_BASE_URL`, `ARTICLES_PER_RUN`, `SITE_URL`.
4. Lanza el workflow *Actualizar Radar IA* manualmente la primera vez (pestaña *Actions → Run workflow*). Después corre solo cada hora a los :07.

El workflow guarda los datos generados en el repo (historial completo) y despliega `public/` en Pages.

## Personalizar

- **Fuentes**: `config/sources.json`. Tipos `rss`, `reddit` y `html` (para webs sin RSS: indica `linkPattern` y se detectan enlaces nuevos).
- **Modelos imprescindibles**: añade el nombre a `config/watchlist.json`.
- **Búsqueda por problema**: añade palabras clave a `config/tasks.json`.
