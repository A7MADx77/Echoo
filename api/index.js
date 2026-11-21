// Schedule Sync API (Vercel). One file, no dependencies.
// Data lives in Upstash Redis when connected (permanent); otherwise in /tmp (temporary).
const fs = require('fs');
const KEY = process.env.SYNC_KEY || 'shared-key';
function envFind(re) {
  const k = Object.keys(process.env).find((n) => re.test(n) && !/READ_ONLY/.test(n));
  return k ? process.env[k] : '';
}
// Works with whatever names Vercel/Upstash gave the variables (KV_REST_API_*, UPSTASH_REDIS_REST_*, ...)
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envFind(/REST.*URL$/);
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envFind(/REST.*TOKEN$/);
const FILE = '/tmp/schedule-data.json';
const EMPTY = () => ({ ticks: {}, notes: [], sched: {}, log: [], nid: 1 });

async function load() {
  try {
    if (R_URL && R_TOKEN) {
      const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOKEN }, body: JSON.stringify(['GET', 'schedule-data']) });
      const j = await r.json();
      return j.result ? Object.assign(EMPTY(), JSON.parse(j.result)) : EMPTY();
    }
    return Object.assign(EMPTY(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) { return EMPTY(); }
}
async function save(d) {
  const s = JSON.stringify(d);
  if (R_URL && R_TOKEN) {
    await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOKEN }, body: JSON.stringify(['SET', 'schedule-data', s]) });
  } else { try { fs.writeFileSync(FILE, s); } catch (e) {} }
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); } }
  return new Promise((ok) => {
    let t = ''; req.on('data', (c) => (t += c));
    req.on('end', () => { try { ok(JSON.parse(t || '{}')); } catch (e) { ok({}); } });
    req.on('error', () => ok({}));
  });
}
function addLog(d, kind, person, text) {
  d.log.unshift({ id: 'g' + Date.now() + Math.random().toString(36).slice(2, 5), kind, person: person || '', text: String(text || '').slice(0, 260), at: Date.now() });
  d.log = d.log.slice(0, 12);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const u = new URL(req.url, 'http://x');
  const path = u.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  if (path === '/health' || path === '/') return send(200, {
    ok: true, store: R_URL && R_TOKEN ? 'redis' : 'tmp', hasUrl: !!R_URL, hasToken: !!R_TOKEN,
    // names only (never values), to help find the right variables
    envNames: Object.keys(process.env).filter((n) => /REDIS|KV_|UPSTASH|STORAGE/i.test(n)),
  });

  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
  const key = req.headers['x-sync-key'] || u.searchParams.get('key') || body.key;
  if (key !== KEY) return send(401, { error: 'bad key' });

  const d = await load();
  let m;
  try {
    if (path === '/ticks') {
      if (req.method === 'GET') return send(200, { ticks: Object.values(d.ticks) });
      if (req.method === 'POST') {
        const { person, date, block } = body;
        if (!person || !date || block === undefined) return send(400, { error: 'person, date, block needed' });
        const k = person + '_' + date + '_' + block;
        const on = body.done === undefined ? !d.ticks[k] : !!body.done;
        if (on) { d.ticks[k] = { person, date, block: String(block), at: Date.now(), done: true }; addLog(d, 'tick', person, body.text); }
        else { delete d.ticks[k]; addLog(d, 'untick', person, body.text); }
        await save(d); return send(200, { ok: true, done: on });
      }
    }
    if (path === '/notes') {
      if (req.method === 'GET') return send(200, { notes: d.notes });
      if (req.method === 'POST') {
        const n = { id: 'n' + d.nid++, person: body.person || '', text: String(body.text || ''), date: body.date || '', at: body.at || Date.now() };
        d.notes.push(n); addLog(d, 'note', n.person, n.text.slice(0, 90)); await save(d); return send(201, n);
      }
    }
    if ((m = path.match(/^\/notes\/(.+)$/))) {
      const id = decodeURIComponent(m[1]), i = d.notes.findIndex((n) => n.id === id);
      if (i < 0) return send(404, { error: 'not found' });
      const n = d.notes[i];
      if (req.method === 'PUT') { n.text = String(body.text || ''); n.edited = body.edited || Date.now(); addLog(d, 'noteEdit', n.person, n.text.slice(0, 90)); }
      else if (req.method === 'DELETE') {
        if (u.searchParams.get('action') === 'hide') n.hs = true;
        else { d.notes.splice(i, 1); addLog(d, 'noteDel', n.person, n.text.slice(0, 90)); }
      } else return send(405, { error: 'method' });
      await save(d); return send(200, { ok: true });
    }
    if (path === '/log' && req.method === 'GET') return send(200, { log: d.log });
    if ((m = path.match(/^\/schedule\/(hana|ahmad)$/))) {
      const p = m[1];
      if (req.method === 'GET') return d.sched[p] ? send(200, d.sched[p]) : send(404, { error: 'no schedule' });
      if (req.method === 'PUT') {
        if (!Array.isArray(body.blocks)) return send(400, { error: 'blocks needed' });
        if (body.blocks.length) d.sched[p] = { blocks: body.blocks, updatedAt: body.updatedAt || Date.now() }; else delete d.sched[p];
        if (body.text) addLog(d, 'sched', p, body.text);
        await save(d); return send(200, { ok: true });
      }
    }
    if ((m = path.match(/^\/reset\/(hana|ahmad)$/)) && req.method === 'POST') {
      Object.keys(d.ticks).forEach((k) => { if (d.ticks[k].person === m[1]) delete d.ticks[k]; });
      await save(d); return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  } catch (e) { return send(500, { error: String(e && e.message) }); }
};
                                              
