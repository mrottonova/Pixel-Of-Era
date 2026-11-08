'use strict';
/* ============================================================================
 *  PIXEL WAR - OYUN SUNUCUSU  (sıfır bağımlılık, Node >= 18)
 *  ----------------------------------------------------------------------------
 *  Mimari:   Cloudflare (proxy / DDoS / WAF)  ->  nginx (443, TLS)  ->  Node (127.0.0.1:8080)
 *  - Otoriter sunucu: tüm kurallar core.js içinde; istemciye güvenilmez.
 *  - Eşleştirme: oyuncular otomatik olarak dolmakta olan bir lobiye yerleştirilir
 *    (10 kişi -> 20 sn geri sayım -> oyun). Dolu/başlamış odalar yenisini açar.
 *  - Koruma: Origin allowlist, IP başına bağlantı/oyuncu limiti, mesaj boyut sınırı,
 *    token-bucket hız sınırı, heartbeat, yavaş tüketici (backpressure) kesme,
 *    sıkı JSON doğrulaması, yeniden bağlanma token'ı.
 *  Yapılandırma: ortam değişkenleri (README.md).
 * ========================================================================== */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Room, mulberry32 } = require('./core.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ------------------------------------------------------------------ ayarlar */
function envInt(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function envList(name) {
  return (process.env[name] || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
}
function loadSettings(over) {
  const s = {
    port: envInt('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',          // üretimde 127.0.0.1 (nginx arkasında)
    wsPath: process.env.WS_PATH || '/ws',
    allowedOrigins: envList('ALLOWED_ORIGINS'),    // örn: https://oyun.siten.com
    trustProxy: process.env.TRUST_PROXY === '1',   // yalnızca loopback (nginx) başlıklarına güven
    maxConnPerIp: envInt('MAX_CONN_PER_IP', 6),
    maxPlayersPerIpPerRoom: envInt('MAX_PLAYERS_PER_IP_PER_ROOM', 2),
    maxConnTotal: envInt('MAX_CONN_TOTAL', 2000),
    maxRooms: envInt('MAX_ROOMS', 50),
    serveStatic: process.env.SERVE_STATIC !== '0',
    staticDir: process.env.STATIC_DIR || path.resolve(__dirname, '..'),
    fillBotsAfter: envInt('FILL_BOTS_AFTER', 0),   // sn; 0 = kapalı (yalnızca gerçek oyuncular)
    maxPayload: 4096,                              // bayt (tek WS mesajı)
    pingMs: envInt('PING_MS', 25000),              // proxy zaman aşımına karşı heartbeat
    idleKillMs: envInt('IDLE_KILL_MS', 75000),
    rateCapacity: 60,                              // burst
    rateRefillPerSec: 40,
    maxViolations: 120,
    maxBuffered: 1024 * 1024,                      // yavaş istemci kesme eşiği
    config: {}                                     // core CONFIG geçersiz kılmaları (test/özel mod)
  };
  if (process.env.PX_CONFIG) {
    try { Object.assign(s.config, JSON.parse(process.env.PX_CONFIG)); } catch (e) { console.error('PX_CONFIG geçersiz JSON'); }
  }
  return Object.assign(s, over || {});
}

function log() {
  const a = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(a));
}

/* ------------------------------------------------------------ WebSocket bağlantısı */
class WSConn {
  constructor(socket, ip, settings, hooks) {
    this.socket = socket; this.ip = ip; this.settings = settings; this.hooks = hooks;
    this.buf = Buffer.alloc(0);
    this.frags = null; this.fragLen = 0;
    this.closed = false;
    this.lastRecv = Date.now();
    this.tokens = settings.rateCapacity; this.lastRefill = Date.now(); this.violations = 0;
    this.room = null; this.pid = 0; this.sendFn = null;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => this.terminate());
    socket.on('close', () => this.onSocketClose());
  }

  onData(chunk) {
    if (this.closed) return;
    this.lastRecv = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > this.settings.maxPayload * 4 + 64) return this.fail(1009, 'too big');
    this.parse();
  }

  parse() {
    for (;;) {
      if (this.closed || this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, rsv = b0 & 0x70, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (rsv !== 0) return this.fail(1002, 'rsv');
      if (!masked) return this.fail(1002, 'unmasked');
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) return this.fail(1009, 'too big');
        len = this.buf.readUInt32BE(6); off = 10;
      }
      const isControl = op >= 8;
      if (isControl && (len > 125 || !fin)) return this.fail(1002, 'bad control');
      if (len > this.settings.maxPayload) return this.fail(1009, 'too big');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (!this.onFrame(op, fin, payload)) return;
    }
  }

  onFrame(op, fin, payload) {
    switch (op) {
      case 0x8: this.close(1000, ''); return false;
      case 0x9: this.rawSend(0xA, payload); return true;
      case 0xA: return true;
      case 0x1: case 0x2:
        if (this.frags) { this.fail(1002, 'frag'); return false; }
        if (op === 0x2) { this.fail(1003, 'binary'); return false; }
        if (fin) return this.deliver(payload);
        this.frags = [payload]; this.fragLen = payload.length; return true;
      case 0x0:
        if (!this.frags) { this.fail(1002, 'cont'); return false; }
        this.fragLen += payload.length;
        if (this.fragLen > this.settings.maxPayload) { this.fail(1009, 'too big'); return false; }
        this.frags.push(payload);
        if (fin) { const all = Buffer.concat(this.frags); this.frags = null; this.fragLen = 0; return this.deliver(all); }
        return true;
      default: this.fail(1002, 'opcode'); return false;
    }
  }

  deliver(buf) {
    let text;
    try { text = this.decoder.decode(buf); } catch (e) { this.fail(1007, 'utf8'); return false; }
    this.hooks.onMessage(this, text);
    return !this.closed;
  }

  /* hız sınırı: false dönerse mesaj düşürülür */
  allow() {
    const now = Date.now();
    this.tokens = Math.min(this.settings.rateCapacity, this.tokens + ((now - this.lastRefill) / 1000) * this.settings.rateRefillPerSec);
    this.lastRefill = now;
    if (this.tokens < 1) {
      if (++this.violations > this.settings.maxViolations) this.fail(1008, 'rate limit');
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  rawSend(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length; let h;
    if (len < 126) { h = Buffer.allocUnsafe(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.allocUnsafe(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.allocUnsafe(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    h[0] = 0x80 | op;
    this.socket.write(Buffer.concat([h, payload]));
    if (this.socket.writableLength > this.settings.maxBuffered) this.terminate(); // yavaş tüketici
  }
  send(obj) { this.rawSend(0x1, Buffer.from(JSON.stringify(obj))); }
  ping() { this.rawSend(0x9, Buffer.alloc(0)); }

  close(code, reason) {
    if (this.closed) return;
    const r = Buffer.from(String(reason || '').slice(0, 100));
    const p = Buffer.allocUnsafe(2 + r.length); p.writeUInt16BE(code || 1000, 0); r.copy(p, 2);
    try { this.rawSend(0x8, p); } catch (e) { /* yoksay */ }
    this.finish();
    try { this.socket.end(); } catch (e) { /* yoksay */ }
    const s = this.socket; setTimeout(() => { if (!s.destroyed) s.destroy(); }, 2000).unref();
  }
  fail(code, reason) { this.close(code, reason); }
  terminate() { this.finish(); try { this.socket.destroy(); } catch (e) { /* yoksay */ } }
  finish() { if (this.closed) return; this.closed = true; this.hooks.onClose(this); }
  onSocketClose() { this.finish(); }
}

/* ------------------------------------------------------------------ sunucu */
function start(overrides) {
  const settings = loadSettings(overrides);
  const rooms = new Map();            // id -> Room
  const tokens = new Map();           // token -> Room
  const conns = new Set();
  const ipCounts = new Map();
  let roomSeq = 0;
  let warnedProxy = false;
  const startedAt = Date.now();

  if (!settings.allowedOrigins.length) log('UYARI: ALLOWED_ORIGINS tanımsız — her Origin kabul ediliyor (üretimde ayarlayın).');

  function isLoopback(a) { return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
  function clientIp(req) {
    const peer = req.socket.remoteAddress || '';
    if (settings.trustProxy && isLoopback(peer)) {
      const h = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
      const v = String(h || '').trim();
      if (/^[0-9a-fA-F:.]{3,45}$/.test(v)) return v;
    }
    return peer.replace(/^::ffff:/, '');
  }

  /* ---------- HTTP (statik dosya + healthz) ---------- */
  const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/game.html': 'game.html', '/map.png': 'map.png' };
  const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
  function secHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
  }
  const httpServer = http.createServer((req, res) => {
    secHeaders(res);
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { res.writeHead(400); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (pathname === '/healthz') {
      let players = 0; for (const r of rooms.values()) players += r.game.connectedHumans();
      const body = JSON.stringify({ ok: true, rooms: rooms.size, players: players, conns: conns.size, uptime: Math.round((Date.now() - startedAt) / 1000) });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    const file = settings.serveStatic ? STATIC[pathname] : null;
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    fs.readFile(path.join(settings.staticDir, file), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      const ext = path.extname(file);
      if (file === 'game.html') {
        // sunucu kendi WS adresini sayfaya enjekte eder -> sıfır yapılandırma
        const host = String(req.headers.host || '');
        const proto = (settings.trustProxy && isLoopback(req.socket.remoteAddress || '') && req.headers['x-forwarded-proto'] === 'https') || req.socket.encrypted ? 'wss' : 'ws';
        if (/^[a-zA-Z0-9.\-:\[\]]{1,255}$/.test(host)) {
          data = Buffer.from(data.toString('utf8').replace('<meta name="px-ws-url" content="">', '<meta name="px-ws-url" content="' + proto + '://' + host + settings.wsPath + '">'));
        }
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.png' ? 'public, max-age=3600' : 'no-cache',
        'Content-Security-Policy': ext === '.html' ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'" : "default-src 'none'"
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
  httpServer.headersTimeout = 15000;
  httpServer.requestTimeout = 20000;

  /* ---------- WebSocket upgrade ---------- */
  function reject(socket, code, text) {
    try { socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (e) { /* yoksay */ }
    socket.destroy();
  }
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { return reject(socket, 400, 'Bad Request'); }
    if (pathname !== settings.wsPath) return reject(socket, 404, 'Not Found');
    if (req.method !== 'GET') return reject(socket, 405, 'Method Not Allowed');
    const up = String(req.headers.upgrade || '').toLowerCase();
    const cn = String(req.headers.connection || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    if (up !== 'websocket' || !cn.includes('upgrade') || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16 || req.headers['sec-websocket-version'] !== '13') {
      return reject(socket, 400, 'Bad Request');
    }
    if (settings.allowedOrigins.length) {
      const origin = String(req.headers.origin || '').replace(/\/$/, '');
      if (!settings.allowedOrigins.includes(origin)) { log('Origin reddedildi:', origin || '(yok)'); return reject(socket, 403, 'Forbidden'); }
    }
    const ip = clientIp(req);
    if (!settings.trustProxy && !warnedProxy && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])) {
      warnedProxy = true;
      log('UYARI: proxy başlıkları görüldü ama TRUST_PROXY=1 değil; tüm oyuncular tek IP gibi sayılır (IP limitleri yanlış çalışır).');
    }
    if (conns.size >= settings.maxConnTotal) return reject(socket, 503, 'Service Unavailable');
    if ((ipCounts.get(ip) || 0) >= settings.maxConnPerIp) return reject(socket, 429, 'Too Many Requests');

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    socket.setTimeout(0);
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    const conn = new WSConn(socket, ip, settings, { onMessage, onClose });
    conns.add(conn);
    if (head && head.length) conn.onData(head);
  });

  /* ---------- odalar / eşleştirme ---------- */
  function newRoom() {
    const id = 'r' + (++roomSeq);
    const room = new Room({
      id: id, config: settings.config,
      rng: mulberry32(crypto.randomInt(1, 0x7fffffff)),
      genToken: () => crypto.randomBytes(24).toString('hex'),
      autoBotsAfter: settings.fillBotsAfter, autoBotsPerTick: 1
    });
    room.meta = { conns: new Map(), ips: new Map() };
    rooms.set(id, room);
    log('oda açıldı', id);
    return room;
  }
  function ipInRoom(room, ip) { let n = 0; for (const v of room.meta.ips.values()) if (v === ip) n++; return n; }

  function joinMatchmaking(conn, msg) {
    const cands = Array.from(rooms.values())
      .filter(r => r.game.phase === 'LOBBY' && r.game.players.size < r.game.cfg.MAX_PLAYERS && ipInRoom(r, conn.ip) < settings.maxPlayersPerIpPerRoom)
      .sort((a, b) => b.game.players.size - a.game.players.size); // en dolu lobi önce
    let firstErr = null;
    const attempt = (room) => {
      const send = (m) => conn.send(m);
      const r = room.join(send, msg);
      if (!r.ok) return r;
      conn.room = room; conn.pid = r.pid; conn.sendFn = send;
      room.meta.conns.set(r.pid, conn); room.meta.ips.set(r.pid, conn.ip);
      tokens.set(r.token, room);
      return r;
    };
    for (const room of cands) {
      const r = attempt(room);
      if (r.ok) return r;
      if (r.code !== 'color_taken') return r;   // isim/renk geçersiz vb.: başka odada da geçersiz
      if (!firstErr) firstErr = r;
    }
    if (rooms.size >= settings.maxRooms) return firstErr || { ok: false, code: 'server_full', text: 'Sunucu dolu, biraz sonra tekrar dene.' };
    const room = newRoom();
    const r = attempt(room);
    if (!r.ok && firstErr && r.code !== 'color_taken') return r;
    return r;
  }

  function leaveRoom(conn) {
    const room = conn.room;
    if (!room) return;
    const before = room.game.players.get(conn.pid);
    const token = before && before.token;
    room.detach(conn.pid, conn.sendFn);
    if (room.meta.conns.get(conn.pid) === conn) room.meta.conns.delete(conn.pid);
    if (!room.game.players.has(conn.pid)) { room.meta.ips.delete(conn.pid); if (token) tokens.delete(token); } // lobiden ayrıldı
    conn.room = null; conn.pid = 0; conn.sendFn = null;
  }

  function disposeRoom(room, reason) {
    for (const c of room.meta.conns.values()) {
      try { c.send({ t: 'room_closed', reason: reason }); } catch (e) { /* yoksay */ }
      c.room = null; c.pid = 0; c.sendFn = null;
    }
    for (const p of room.game.players.values()) if (p.token) tokens.delete(p.token);
    rooms.delete(room.id);
    log('oda kapandı', room.id, reason);
  }

  /* ---------- mesaj işleme ---------- */
  function sendErr(conn, code, text, extra) { conn.send(Object.assign({ t: 'error', code: code, text: text }, extra || {})); }

  function violation(conn) { if (++conn.violations > settings.maxViolations) conn.fail(1008, 'protocol violations'); }

  function onMessage(conn, text) {
    if (!conn.allow()) return;
    let m;
    try { m = JSON.parse(text); } catch (e) { return violation(conn); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return violation(conn);
    switch (m.t) {
      case 'ping':
        return conn.send({ t: 'pong', ts: typeof m.ts === 'number' ? m.ts : 0 });
      case 'join': {
        if (conn.room) return sendErr(conn, 'already_joined', 'Zaten bir odadasın.');
        const r = joinMatchmaking(conn, { name: m.name, color: m.color });
        if (!r.ok) return sendErr(conn, r.code, r.text || 'Katılım reddedildi.', r.taken ? { taken: r.taken } : undefined);
        log('katıldı', conn.room.id, 'pid=' + r.pid, 'oyuncu=' + conn.room.game.players.size);
        return;
      }
      case 'resume': {
        if (conn.room) return sendErr(conn, 'already_joined', 'Zaten bir odadasın.');
        const room = typeof m.token === 'string' ? tokens.get(m.token) : null;
        if (!room) return sendErr(conn, 'resume_failed', 'Oturum bulunamadı veya süresi doldu.');
        const p = room.findByToken(m.token);
        if (!p) return sendErr(conn, 'resume_failed', 'Oturum bulunamadı veya süresi doldu.');
        const old = room.meta.conns.get(p.id);
        const send = (x) => conn.send(x);
        const r = room.resume(m.token, send);
        if (!r.ok) return sendErr(conn, r.code, r.text);
        conn.room = room; conn.pid = p.id; conn.sendFn = send;
        room.meta.conns.set(p.id, conn); room.meta.ips.set(p.id, conn.ip);
        if (old && old !== conn) { old.room = null; old.pid = 0; old.sendFn = null; old.close(4000, 'replaced'); }
        room.flush();
        return;
      }
      case 'leave':
        leaveRoom(conn);
        return;
      default:
        if (conn.room) conn.room.receive(conn.pid, m);
    }
  }

  function onClose(conn) {
    conns.delete(conn);
    const n = (ipCounts.get(conn.ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(conn.ip); else ipCounts.set(conn.ip, n);
    leaveRoom(conn);
  }

  /* ---------- zamanlayıcılar ---------- */
  const tickTimer = setInterval(() => {
    for (const room of Array.from(rooms.values())) {
      try {
        room.tick();
        if (room.isFinished()) disposeRoom(room, 'finished');
      } catch (e) {
        log('ODA HATASI', room.id, e && e.stack || e);
        try { disposeRoom(room, 'error'); } catch (e2) { rooms.delete(room.id); }
      }
    }
  }, 1000);
  const hbTimer = setInterval(() => {
    const now = Date.now();
    for (const c of Array.from(conns)) {
      if (now - c.lastRecv > settings.idleKillMs) { log('zaman aşımı', c.ip); c.terminate(); continue; }
      try { c.ping(); } catch (e) { c.terminate(); }
    }
  }, settings.pingMs);
  tickTimer.unref(); hbTimer.unref();

  /* ---------- yaşam döngüsü ---------- */
  function close() {
    return new Promise((resolve) => {
      clearInterval(tickTimer); clearInterval(hbTimer);
      for (const c of Array.from(conns)) c.close(1001, 'server shutdown');
      httpServer.close(() => resolve());
      setTimeout(resolve, 500).unref();
    });
  }
  return new Promise((resolve, reject2) => {
    httpServer.once('error', reject2);
    httpServer.listen(settings.port, settings.host, () => {
      const port = httpServer.address().port;
      log('Pixel War sunucusu dinliyor: ' + settings.host + ':' + port + ' (ws yolu ' + settings.wsPath + ')');
      resolve({ httpServer, rooms, conns, tokens, settings, port, close });
    });
  });
}

module.exports = { start, loadSettings };

if (require.main === module) {
  start().then((srv) => {
    const stop = () => { log('kapatılıyor…'); srv.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch((e) => { console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack || e));
}
