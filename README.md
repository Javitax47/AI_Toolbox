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
└─ lib/llm.mjs              cliente para cualquier API compatible con OpenAI (OpenRouter por defecto)
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
