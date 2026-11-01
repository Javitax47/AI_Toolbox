// Servidor estático mínimo para desarrollo: node scripts/serve.mjs [puerto]
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib/util.mjs';

const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 4321);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(PUBLIC, url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Radar IA en http://localhost:${PORT}`));
