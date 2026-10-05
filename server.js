// FushaVoice web server: serves the site, records visits, and provides a
// password-protected /mfares page with the visitor log. No third-party services.
//
// Environment:
//   PORT            port to listen on (default 8080)
//   ADMIN_PASSWORD  password for /mfares (required; /mfares is disabled without it)
//   ADMIN_USER      username for /mfares (default "admin")
//   DATABASE_URL    PostgreSQL connection string; if unset, visits are stored in DATA_FILE
//   SITE_URL        public site address used in robots.txt and sitemap.xml (default https://fushavoice.com)
//   DATA_FILE       JSON-lines file for visits (default ./data/visits.jsonl)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'visits.jsonl');
const SITE_URL = (process.env.SITE_URL || 'https://fushavoice.com').replace(/\/$/, '');
const STARTED = new Date().toISOString().slice(0, 10);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

// ===== Storage =====

const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore(DATA_FILE);

function fileStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return {
    async init() {},
    async add(v) { fs.appendFileSync(file, JSON.stringify(v) + '\n'); },
    async since(ts) {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(v => v && v.ts >= ts);
    },
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS visits (
        id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL, data JSONB NOT NULL)`);
      await pool.query('CREATE INDEX IF NOT EXISTS visits_ts ON visits (ts)');
    },
    async add(v) { await pool.query('INSERT INTO visits (ts, data) VALUES ($1, $2)', [v.ts, v]); },
    async since(ts) {
      const { rows } = await pool.query('SELECT data FROM visits WHERE ts >= $1 ORDER BY ts', [ts]);
      return rows.map(r => r.data);
    },
  };
}

// ===== Visit details =====

function clientIp(req) {
  const h = req.headers;
  return (h['do-connecting-ip'] || h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0] ||
    req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
}

function parseUA(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const device = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi|iPhone|Android/.test(ua) ? 'Mobile' : 'Desktop';
  const bot = !ua || /bot|crawl|spider|slurp|curl|wget|python|headless|monitor|preview|facebookexternalhit/i.test(ua);
  return { browser, os, device, bot };
}

function refSource(ref, host) {
  if (!ref) return '';
  try {
    const u = new URL(ref);
    return u.host === host ? '' : u.host.replace(/^www\./, '');
  } catch { return ''; }
}

// Anonymous visitor id: same person on the same day gets the same id.
function visitorId(ip, ua, ts) {
  return crypto.createHash('sha256').update(`${ip}|${ua}|${ts.slice(0, 10)}`).digest('hex').slice(0, 10);
}

function record(req, extra) {
  const ts = new Date().toISOString();
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  const url = new URL(req.url, 'http://x');
  const visit = {
    ts, ip,
    visitor: visitorId(ip, ua, ts),
    country: req.headers['cf-ipcountry'] || '',
    path: url.pathname,
    referrer: refSource(req.headers.referer, req.headers.host),
    utm: url.searchParams.get('utm_source') || '',
    lang: (req.headers['accept-language'] || '').split(',')[0],
    ua, ...parseUA(ua), ...extra,
  };
  store.add(visit).catch(err => console.error('Failed to save visit:', err.message));
}

// ===== Admin page =====

function checkAuth(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  const a = Buffer.from(`${user}:${rest.join(':')}`), b = Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function top(rows, key, n = 10) {
  const counts = {};
  for (const r of rows) { const k = r[key] || '(none)'; counts[k] = (counts[k] || 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function topTable(title, entries) {
  const max = entries[0]?.[1] || 1;
  return `<div class="card"><h3>${esc(title)}</h3><table>${entries.map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td class="num"><span class="bar" style="width:${Math.round(v / max * 60)}px"></span>${v}</td></tr>`).join('') ||
    '<tr><td class="muted">No data yet</td></tr>'}</table></div>`;
}

async function adminPage(req) {
  const url = new URL(req.url, 'http://x');
  const days = [1, 7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
  const showBots = url.searchParams.get('bots') === '1';
  const all = await store.since(new Date(Date.now() - days * 864e5).toISOString());
  const rows = all.filter(r => showBots || !r.bot);
  const views = rows.filter(r => !r.event);
  const quotes = rows.filter(r => r.event === 'quote-request-sent');

  const perDay = {};
  for (let i = days - 1; i >= 0; i--) perDay[new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)] = { v: 0, u: new Set() };
  for (const r of views) { const d = perDay[r.ts.slice(0, 10)]; if (d) { d.v++; d.u.add(r.visitor); } }
  const dayEntries = Object.entries(perDay);
  const maxDay = Math.max(1, ...dayEntries.map(([, d]) => d.v));

  const fmt = ts => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' });
  const link = (d, b) => `?days=${d}${b ? '&bots=1' : ''}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>صوت الفصحى (قناة ورق) — Admin</title><style>
:root { --bg:#f7f5f0; --card:#fff; --ink:#1d1b16; --muted:#7a7468; --line:#e6e1d6; --accent:#9a6b1f; }
@media (prefers-color-scheme: dark) { :root { --bg:#14130f; --card:#1e1c17; --ink:#eee9df; --muted:#9a9384; --line:#322f27; --accent:#d9a548; } }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
.wrap { max-width:1200px; margin:0 auto; padding:24px 16px; } h1 { margin:0 0 4px; font-size:22px; } h3 { margin:0 0 10px; font-size:14px; }
.muted { color:var(--muted); } .nav a { margin-right:12px; color:var(--accent); text-decoration:none; } .nav a.on { font-weight:700; text-decoration:underline; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:20px 0; }
.stat, .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.stat b { display:block; font-size:28px; } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin-bottom:12px; }
table { width:100%; border-collapse:collapse; } td, th { padding:5px 6px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:12px; } .num { text-align:right; white-space:nowrap; }
.bar { display:inline-block; height:8px; background:var(--accent); opacity:.5; border-radius:4px; margin-right:6px; }
.chart { display:flex; align-items:flex-end; gap:3px; height:120px; } .chart div { flex:1; background:var(--accent); border-radius:3px 3px 0 0; min-height:2px; }
.scroll { overflow-x:auto; } .log td { white-space:nowrap; } .ua { max-width:280px; overflow:hidden; text-overflow:ellipsis; }
.tag { background:var(--accent); color:var(--card); border-radius:4px; padding:1px 6px; font-size:12px; }
</style></head><body><div class="wrap">
<h1>صوت الفصحى (قناة ورق) — Visitors</h1>
<div class="nav">${[1, 7, 30, 90].map(d => `<a class="${d === days ? 'on' : ''}" href="${link(d, showBots)}">${d === 1 ? 'Today (24h)' : d + ' days'}</a>`).join('')}
<a href="${link(days, !showBots)}">${showBots ? 'Hide bots' : 'Show bots'}</a></div>
<div class="stats">
<div class="stat"><span class="muted">Page views</span><b>${views.length}</b></div>
<div class="stat"><span class="muted">Unique visitors</span><b>${new Set(views.map(r => r.visitor)).size}</b></div>
<div class="stat"><span class="muted">Quote requests sent</span><b>${quotes.length}</b></div>
<div class="stat"><span class="muted">Bot hits ${showBots ? 'included' : 'hidden'}</span><b>${all.filter(r => r.bot).length}</b></div>
</div>
${days > 1 ? `<div class="card" style="margin-bottom:12px"><h3>Page views per day</h3><div class="chart">${dayEntries.map(([d, x]) =>
  `<div title="${d}: ${x.v} views, ${x.u.size} visitors" style="height:${Math.round(x.v / maxDay * 100)}%"></div>`).join('')}</div>
<div class="muted" style="display:flex;justify-content:space-between;font-size:12px"><span>${dayEntries[0][0]}</span><span>${dayEntries.at(-1)[0]}</span></div></div>` : ''}
<div class="grid">
${topTable('Where visitors came from', top(views, 'referrer'))}
${topTable('Countries', top(views, 'country'))}
${topTable('Pages', top(views, 'path'))}
${topTable('Devices', top(views, 'device'))}
${topTable('Browsers', top(views, 'browser'))}
${topTable('Operating systems', top(views, 'os'))}
</div>
<div class="card scroll"><h3>Visitor log (latest 500)</h3><table class="log">
<tr><th>Time (Dubai)</th><th>Event</th><th>Visitor</th><th>IP</th><th>Country</th><th>Page</th><th>From</th><th>Device</th><th>Browser</th><th>Language</th><th>User agent</th></tr>
${rows.slice(-500).reverse().map(r => `<tr><td>${esc(fmt(r.ts))}</td>
<td>${r.event ? `<span class="tag">${esc(r.event === 'quote-request-sent' ? 'Quote: ' + (r.type || '') : r.event)}</span>` : 'View'}${r.bot ? ' <span class="muted">bot</span>' : ''}</td>
<td>${esc(r.visitor)}</td><td>${esc(r.ip)}</td><td>${esc(r.country)}</td><td>${esc(r.path)}</td><td>${esc(r.referrer || r.utm)}</td>
<td>${esc(r.device)} · ${esc(r.os)}</td><td>${esc(r.browser)}</td><td>${esc(r.lang)}</td><td class="ua" title="${esc(r.ua)}">${esc(r.ua)}</td></tr>`).join('') ||
'<tr><td colspan="11" class="muted">No visits yet</td></tr>'}
</table></div>
</div></body></html>`;
}

// ===== HTTP server =====

function readBody(req, limit = 2048) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
      if (req.method === 'GET') record(req);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : INDEX_HTML);
    }

    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    }

    if (pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><lastmod>${STARTED}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`);
    }

    if (req.method === 'POST' && pathname === '/api/event') {
      let data = {};
      try { data = JSON.parse(await readBody(req)); } catch {}
      if (data.event === 'quote-request-sent') record(req, { event: data.event, type: String(data.type || '').slice(0, 60) });
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/mfares' || pathname === '/mfares/') {
      if (!ADMIN_PASSWORD) {
        // 200 so hosting platforms show this message instead of their own error page.
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('Admin is disabled: set the ADMIN_PASSWORD environment variable (Run time) and redeploy.');
      }
      if (!checkAuth(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FushaVoice Admin"', 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex, nofollow' });
        return res.end('Login required');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
      return res.end(await adminPage(req));
    }

    if (pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
});

store.init().then(() => {
  server.listen(PORT, () => console.log(`FushaVoice listening on port ${PORT} (storage: ${process.env.DATABASE_URL ? 'PostgreSQL' : DATA_FILE})`));
}).catch(err => { console.error('Storage init failed:', err); process.exit(1); });
