'use strict';
/* ============================================================================
 *  PIXEL WAR — SUNUCU (Render / VPS)
 *   - Statik: index.html, game.html, map.png (px-ws-url meta etiketini otomatik doldurur)
 *   - WS    : /ws                       (oyun protokolü, core.js ile otoriter simülasyon)
 *   - REST  : /api/servers              (canlı oda listesi, JSON)
 *   - SSE   : /api/servers/stream       (canlı oda listesi, değiştikçe push)
 *   - Sağlık: /healthz
 *  Ortam değişkenleri: README.md
 * ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const core = require('./core.js');
const { RoomManager } = require('./rooms.js');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || (fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, '..')));
const PUBLIC_WS_URL = (process.env.PUBLIC_WS_URL || '').trim();            // örn: wss://oyun.onrender.com/ws
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean); // boş = hepsi
const MAX_CONN_PER_IP = parseInt(process.env.MAX_CONN_PER_IP, 10) || 20;
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
const STATIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/game.html': 'game.html', '/map.png': 'map.png' };
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ yardımcılar */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}
function originAllowed(origin) {
  if (!ALLOWED_ORIGINS.length) return true;
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin);
}
function corsHeaders(req) {
  const o = req.headers.origin;
  const h = { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
  if (!ALLOWED_ORIGINS.length) h['Access-Control-Allow-Origin'] = '*';
  else if (o && originAllowed(o)) h['Access-Control-Allow-Origin'] = o;
  return h;
}
function publicWsUrl(req) {
  if (PUBLIC_WS_URL) return PUBLIC_WS_URL;
  const proto = (TRUST_PROXY && req.headers['x-forwarded-proto'] || 'http').toString().split(',')[0].trim();
  return (proto === 'https' ? 'wss' : 'ws') + '://' + req.headers.host + '/ws';
}
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* ------------------------------------------------------------------ oda yöneticisi + SSE */
const sseClients = new Set();
let lastPayload = '', pushTimer = null;
function payload() {
  const st = mgr.stats();
  return JSON.stringify({ servers: mgr.list(), online: st.humans, playing: st.playing, ts: Date.now() });
}
function pushNow() {
  pushTimer = null;
  if (!sseClients.size) return;
  const p = payload();
  const cmp = p.replace(/"ts":\d+/, '');
  if (cmp === lastPayload) return;
  lastPayload = cmp;
  for (const res of sseClients) { try { res.write('data: ' + p + '\n\n'); } catch (e) { sseClients.delete(res); } }
}
function schedulePush() { if (!pushTimer) pushTimer = setTimeout(pushNow, 120); }   // en fazla ~8 push/sn (birleştirir)

const conns = new Map();   // ws -> { entry, pid, send, ip }
const mgr = new RoomManager(core, { log: log, onChange: schedulePush });
mgr.onRoomRemoved = (entry) => {
  for (const [ws, c] of conns) if (c.entry === entry) { c.entry = null; try { ws.close(1000, 'room_closed'); } catch (e) { /* */ } }
};

/* ------------------------------------------------------------------ HTTP */
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (p === '/api/servers') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders(req)));
    return res.end(payload());
  }

  if (p === '/api/servers/stream') {
    if (sseClients.size >= 500) { res.writeHead(503, { 'Retry-After': '5' }); return res.end(); }
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    }, corsHeaders(req)));
    res.write('retry: 2000\n\n');
    res.write('data: ' + payload() + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  const file = STATIC_FILES[p];
  if (file) {
    fs.readFile(path.join(STATIC_DIR, file), (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Bulunamadı: ' + file); }
      const ext = path.extname(file);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-cache';
        const wsUrl = publicWsUrl(req);
        const html = buf.toString('utf8').replace(/(<meta name="px-ws-url" content=")[^"]*(")/, (m, a, b) => a + escAttr(wsUrl) + b);
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      headers['Cache-Control'] = 'public, max-age=86400';
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404');
});

/* ------------------------------------------------------------------ WebSocket */
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
const ipCount = new Map();

server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p !== '/ws') { socket.destroy(); return; }
  if (!originAllowed(req.headers.origin) && req.headers.origin) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const ip = clientIp(req);
  if ((ipCount.get(ip) || 0) >= MAX_CONN_PER_IP) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { ws._ip = ip; wss.emit('connection', ws, req); });
});

wss.on('connection', (ws) => {
  const ip = ws._ip;
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  const c = { entry: null, pid: 0, ip: ip, tokens: 60, last: Date.now(), alive: true };
  conns.set(ws, c);
  const send = (obj) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* */ } } };
  c.send = send;
  const hello = setTimeout(() => { if (!c.entry) { send({ t: 'error', code: 'timeout', text: 'Katılım mesajı gelmedi.' }); ws.close(); } }, 10000);

  ws.on('pong', () => { c.alive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    // token bucket: saniyede ~60 mesaj, 120 patlama
    const now = Date.now();
    c.tokens = Math.min(120, c.tokens + (now - c.last) * 0.06); c.last = now;
    if (--c.tokens < 0) { send({ t: 'error', code: 'rate', text: 'Çok hızlı mesaj gönderiyorsun.' }); return ws.close(); }

    let m; try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') return send({ t: 'pong', ts: m.ts });

    if (!c.entry) {                                    // henüz bir odada değil
      let r;
      if (m.t === 'join') r = mgr.join(m, send);
      else if (m.t === 'resume') r = mgr.resume(m.token, send);
      else return;
      if (!r.ok) { send({ t: 'error', code: r.code, text: r.text }); return; }   // istemci formu gösterir
      clearTimeout(hello);
      c.entry = r.entry; c.pid = r.pid;
      return;
    }

    if (m.t === 'leave') {
      const e = c.entry; c.entry = null;
      mgr.leave(e, c.pid, send);
      return ws.close(1000, 'leave');
    }
    if (m.t === 'join' || m.t === 'resume') return;
    if (!mgr.checkSeq(c.entry, c.pid, m.seq)) return;  // tekrar / eski sıra numarası
    c.entry.room.receive(c.pid, m);
    if (c.entry.room.game.phase === 'LOBBY') schedulePush();   // renk vb. değişiklikleri listeye yansıt
  });

  ws.on('close', () => {
    clearTimeout(hello);
    const n = (ipCount.get(ip) || 1) - 1; if (n <= 0) ipCount.delete(ip); else ipCount.set(ip, n);
    conns.delete(ws);
    if (c.entry) mgr.disconnect(c.entry, c.pid, send);
  });
  ws.on('error', () => { /* close ele alır */ });
});

// ölü bağlantı temizliği (30 sn)
setInterval(() => {
  for (const [ws, c] of conns) {
    if (!c.alive) { try { ws.terminate(); } catch (e) { /* */ } continue; }
    c.alive = false; try { ws.ping(); } catch (e) { /* */ }
  }
}, 30000);

/* ------------------------------------------------------------------ oyun saati (100 ms adım, sapmasız) */
let lastT = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now(); acc += now - lastT; lastT = now;
  let steps = Math.min(1200, Math.floor(acc / 100));
  acc = Math.min(acc, 100000) - Math.floor(acc / 100) * 100;
  for (let i = 0; i < steps; i++) {
    const kicked = mgr.advance(100);
    for (const k of kicked) {
      for (const [ws, c] of conns) if (c.entry === k.entry && c.pid === k.pid) { try { ws.close(1008, 'abuse'); } catch (e) { /* */ } }
    }
  }
}, 100);
// SSE canlı sayaçlar: geri sayım saniyede bir değişir; yine de arada kalp atışı yorumu gönder (proxy zaman aşımı)
setInterval(() => { for (const res of sseClients) { try { res.write(': hb\n\n'); } catch (e) { sseClients.delete(res); } } }, 15000);
// 10 sn'de bir değişmese de tam liste gönder (istemci 'canlı akış güncel' say, yedek yoklamaya düşmesin)
setInterval(() => { lastPayload = ''; pushNow(); }, 10000);

server.listen(PORT, () => log('Pixel War sunucusu :' + PORT + '  | statik: ' + STATIC_DIR + '  | havuz: lobi ' + mgr.kinds.lobby.pool + ' + düello ' + mgr.kinds.duel.pool));

function shutdown() {
  log('kapanıyor…');
  for (const ws of conns.keys()) { try { ws.close(1001, 'restart'); } catch (e) { /* */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
