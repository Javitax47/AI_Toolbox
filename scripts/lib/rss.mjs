import { decodeEntities, stripHtml } from './util.mjs';

/** Parser RSS 2.0 / Atom sin dependencias. Devuelve [{title, url, date, html}] */
export function parseFeed(xml = '') {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const title = stripHtml(tag(b, 'title'));
    let url = tag(b, 'link').trim();
    if (!url || url.startsWith('<')) {
      const href = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = href ? href[1] : '';
    }
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const html = tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary');
    return { title, url: decodeEntities(stripCdata(url)).trim(), date: date ? new Date(stripCdata(date).trim()).toISOString() : null, html: stripCdata(html) };
  }).filter((i) => i.title && i.url && i.date && !Number.isNaN(new Date(i.date).getTime()));
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  return block.match(re)?.[1] ?? '';
}

function stripCdata(s = '') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

export function decodeHtmlContent(s = '') {
  // Algunos feeds escapan el HTML del contenido (&lt;p&gt;...)
  return /&lt;\w/.test(s) ? decodeEntities(s) : s;
}
