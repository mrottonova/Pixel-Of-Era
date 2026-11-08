/* ============================================================================
 *  PIXEL WAR  -  CORE  (tarayıcı istemcisi ve Node sunucusu TARAFINDAN PAYLAŞILIR)
 *  ----------------------------------------------------------------------------
 *  - DOM / ağ / zamanlayıcı YOK: tamamen deterministik, "tick" (1 sn) ile ilerler.
 *  - Oyun kurallarının TEK doğruluk kaynağı burasıdır (otoriter sunucu modeli).
 *    İstemci sadece niyet (intent) gönderir; sunucu doğrular ve sonucu yayınlar.
 *  - Aynı dosya game.html içindeki <script id="px-core"> bloğunda ve
 *    server/core.js içinde BİREBİR aynı olmalıdır (npm run sync / npm test kontrol eder).
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PXCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ CONFIG */
  const PROTOCOL = 1;

  const CONFIG = {
    MIN_PLAYERS: 10,          // geri sayımın başlaması için gereken minimum oyuncu
    MAX_PLAYERS: 16,
    LOBBY_COUNTDOWN: 20,      // sn  (10 oyuncuya ulaşınca)
    SETUP_SECONDS: 30,        // sn  (başkent + yerleşim fazı)
    ROUND_SECONDS: 60,        // sn  (eşzamanlı tur süresi)
    MIN_ROUND_SECONDS: 3,     // herkes "turu bitir" dese bile en az bu kadar sür
    START_POOL: 25,           // başkent dahil başlangıç piksel sayısı
    MAX_ACTIONS: 20,          // zar (d6*d6) üst sınırı
    WAR_DELAY_ROUNDS: 1,      // savaş ilanından kaç tur sonra aktifleşir
    PROPOSAL_TTL_ROUNDS: 2,   // teklif kaç tur geçerli
    MAX_ROUNDS: 40,           // güvenlik: bu turdan sonra puana göre biter
    SETUP_FREE_PLACEMENT: true, // true: yerleşimde boş herhangi bir karaya; false: sadece komşu
    MAX_CELLS_PER_MESSAGE: 64,
    NAME_MAX: 16,
    CHAT_MAX: 60,
    CHAT_COOLDOWN_TICKS: 3,   // sunucu tarafı spam koruması (istemci 4 sn gösterir)
    COLOR_MIN_DISTANCE: 40,   // oyuncu renkleri arası min. RGB mesafesi
    COLOR_RESERVED_DISTANCE: 30, // deniz / boş kara rengine min. mesafe
    GAME_OVER_SECONDS: 20,    // oyun bittikten sonra oda kaç sn açık kalsın
    EMPTY_ROOM_SECONDS: 60    // oyuncusuz oda ömrü (Room)
  };

  const SEA_COLOR = '#2980b9';
  const LAND_COLOR = '#2c3e50';

  const NATIONS = [
    { id: 1, name: 'MAVİ', color: '#3498db' },
    { id: 2, name: 'KIRMIZI', color: '#e74c3c' },
    { id: 3, name: 'YEŞİL', color: '#2ecc71' },
    { id: 4, name: 'SARI', color: '#f1c40f' },
    { id: 5, name: 'MOR', color: '#9b59b6' },
    { id: 6, name: 'TURUNCU', color: '#e67e22' },
    { id: 7, name: 'TURKUAZ', color: '#1abc9c' },
    { id: 8, name: 'PEMBE', color: '#e84393' },
    { id: 9, name: 'KAHVERENGİ', color: '#5d4037' },
    { id: 10, name: 'TENRENGİ', color: '#ffeaa7' }
  ];

  const BOT_NAMES = ['ANADOLU', 'TRAKYA', 'İBERYA', 'GALYA', 'ROMA', 'SLAV', 'VİKİNG', 'KELT',
    'HUN', 'PERS', 'BİZANS', 'ARAGON', 'BAVYERA', 'LİTVANYA', 'KASTİLYA', 'SAKSONYA'];

  /* --------------------------------------------------------------------- MAP */
  const MAP_DATA = [
    "0000000000000000000000000000000000000000000000000111111111111111111111111101111111111100001100011111",
    "0000000000000000000000000000000000000000000000001111111111111111111111111100111111111100000111111111",
    "0000000000000000000000000000000000000000000000001111111111111111111111111110001111111000001111111111",
    "0000000000000000000000000000000000000000000000001111111111111111111111111111000001110001101111111111",
    "0000000000000000100000000000000000000000000000011111111111111111111111111111100000000011111111111111",
    "0000000010001001110000000000000000000000000000011111111111100001111111111111000000001111111111111111",
    "0000001110011111110000000000000000000000000000011111111111100000111111111111100000001111111111111111",
    "0000000010111111111100000000000000000000000000111111111111100000111111111111100010000111111111111111",
    "0000000001111111111100000000000000000000000001111111111111000001111111111111100011100111111111111111",
    "0000000111111111111000000000000000000000000011111111111111100001111111111111100001111111111111111111",
    "0000000001111111110000000000000000000000000011111111111111000011111111111111111000111111111111111111",
    "0000000001111111100000000000000000000000000111111111111111000111111111111111111101111111111111111111",
    "0000000011111111000000000000000000000000000011111111111100001111111111111111111111111111111111111111",
    "0000000000011100000000000000000000000000011111111111111000001111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000001111111111111110000011111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000000111111111111110000011111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000111111111111111100000011111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000011111111111111100000011111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000111111111111111100000011111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000000111111111111100000011111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000111111111111111100000011111111111111111111111111111111111111111",
    "0000000000000000000000000000000000000111111111111111110000001111100001111111111111111111111111111111",
    "0000000000000000000000000000000000000011111111111111111000000110000000011111111111111111111111111111",
    "0000000000000000000000000000000000000011111111111111111000000000000001111111111111111111111111111111",
    "0000000000000000000000000000000000000011111111111111110000000001110011111111111111111111111111111111",
    "0000000000000000000000000000000000000011111001111111110000000011111111111111111111111111111111111111",
    "0000000000000000000000000000000000000111110001111111100000000011111111111111111111111111111111111111",
    "0000000000000000000000011000000000000011100001111111000000000001111111111111111111111111111111111111",
    "0000000000000000000000110000000000000000000000111111000000000001111111111111111111111111111111111111",
    "0000000000000000000000111100000000000000000000111111000000000001111111111111111111111111111111111111",
    "0000000000000000000000111100000000000000000100111111000000011000011111111111111111111111111111111111",
    "0000000000000000000000111100000000000000001000011111000000011111111111111111111111111111111111111111",
    "0000000000000000000000111000000000000000011100011110000000011111111111111111111111111111111111111111",
    "0000000000000000000000011000000000000000011000011000000000011111111111111111111111111111111111111111",
    "0000000000000000000000011110000000000000011001011000000000011111111111111111111111111111111111111111",
    "0000000000000000000000011110000000000000011001000000000000011111111111111111111111111111111111111111",
    "0000000000000000001110000111000000000000001000000000000001111111111111111111111111111111111111111111",
    "0000000000000000001110000111100000000000001100000000111011111111111111111111111111111111111111111111",
    "0000000000000000111100000011100000000000001111110011111111111111111111111111111111111111111111111111",
    "0000000000000000111110000111100000000000011111111111111111111111111111111111111111111111111111111111",
    "0000000000000000011110001111110000000111111111111111111111111111111111111111111111111111111111111111",
    "0000000000000000011110001111111000001111111111111111111111111111111111111111111111111111111111111111",
    "0000000000000000111100001111111100001111111111111111111111111111111111111111111111111111111111111111",
    "0000000000000000110000011111111000011111111111111111111111111111111111111111111111111111111111111111",
    "0000000000000000000000000011110000001111111111111111111111111111111111111111111111111111111111111100",
    "0000000000000000000000011111110011111111111111111111111111111111111111111111111111111111111111110000",
    "0000000000000000000000010000000011111111111111111111111111111111111111111111111111111111111111110000",
    "0000000000000000000000000000000111111111111111111111111111111111111111111111111111111111111111000000",
    "0000000000000000000000000000001111111111111111111111111111111111111111111111111111111111111111000000",
    "0000000000000000000000000001111111111111111111111111111111111111111111111111111111111111111111000000",
    "0000000000000000000000001001111111111111111111111111111111111111111111111111111111111111111110000000",
    "0000000000000000000000001111111111111111111111111111111111111111111111111111111111111111111111000000",
    "0000000000000000000000000111111111111111111111111111111111111111111111111111111111111111111111100000",
    "0000000000000000000000000001111111111111111111111111111111111111111111111111111110011111111111110000",
    "0000000000000000000000000001111111111111111111111111111111111111111111110011111000111111111111110000",
    "0000000000000000000000000000111111111111111111111111111111111111111111100000100000111111111111110000",
    "0000000000000000000000000000111111111111111111110111111111111111111111000001100000111111111111110000",
    "0000000000000000000000000000111111111111111111100011111111111111111111000001111101111111111111110000",
    "0000000000000000000000000000111111111111111111100011111111111111111110000000110001111111111111111000",
    "0000000000000000000000000000111111111110001111110001111111111111111110000000000000011111111111111110",
    "0000000000000000000000000000111111111110000111110000111111111111111100000000000000001111111111111111",
    "0000000000000000111111111111111111111000000011111000001111111111111100000000000000000000111111111111",
    "0000000000000000011111111111111111100000010001111100000111111111111000000000000000000000001111111111",
    "0000000000000000001111111111111111000000011000111100000011111111111000000000000000000000000111111111",
    "0000000000000000011111111111111110000000011000011110000011111111111100000011111110000000000111111111",
    "0000000000000000001111111111111000000000000000000111100011111110000001111111111111111000011111111111",
    "0000000000000000011111111111110000000000011000000011110011111100000000111111111111111111111111111111",
    "0000000000000000011111111111100000000000011000000001010001110000001111111111111111111111111111111111",
    "0000000000000000011111111111100000000000010000000011000000111000001111111111111111111111111111111111",
    "0000000000000000011111111111100000000000000000000000000000111100000111111111111111111111111111111111",
    "0000000000000000011111111111100000000000000000000000000000000110000111111111111111111111111111111111",
    "0000000000000000011111111111000000000000000000011100000000011100000111111111111111111111111111111111",
    "0000000000000000001011111110000000000000000000001110000000011000000111111111111111111111111111111111",
    "0000000000000000000001100000000000000000000000000000000000000000000001100111111111111011111111111111",
    "0000000000000000000000000000000000000011111111000000000000000000000000000001111111100001111111111111",
    "0000000000000000000001100000000011111111111111100000000000000000000000000000000000000000111111111111",
    "0000000000000000000111111111111111111111111111100000000000000000000000000000001110000000111111111111",
    "0000000000000000001111111111111111111111111100000000000000000000000000000000111000000001111111111111",
    "0000000000000000011111111111111111111111111000000000000000000000000000000000000000000001111111111111",
    "0000000000000000111111111111111111111111111000000000000000000000000000000000000000000011111111111111",
    "0000000000000001111111111111111111111111100000000000000000011111111100000000111111001111111111111111",
    "0000000000000001111111111111111111111111111000000000000000111111111111111111111111101111111111111111",
    "0000000000000011111111111111111111111111111110000000000000111111111111111111111111101011111111111111",
    "0000000000000011111111111111111111111111111111100000000000001111111111111111111111100001111111111111",
    "0000000000000111111111111111111111111111111111111111111000000111111111111111111111110000111111111111",
    "0000000000001111111111111111111111111111111111111111111111111111111111111111111111111000011111111111"
  ];
  const ROWS = MAP_DATA.length;
  const COLS = MAP_DATA.reduce((m, r) => Math.max(m, r.length), 0);
  const N = ROWS * COLS;
  const LAND_MASK = new Uint8Array(N);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) LAND_MASK[r * COLS + c] = MAP_DATA[r][c] === '1' ? 1 : 0;
  }
  const DIRS8 = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

  /* ----------------------------------------------------------------- HELPERS */
  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  const MAP_HASH = hash32(MAP_DATA.join('|'));

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

  function sanitizeName(s, max) {
    if (typeof s !== 'string') return '';
    s = s.normalize('NFC').replace(INVISIBLE, '');
    // harf, rakam, boşluk, _ - .  (HTML/enjeksiyon karakterleri ayıklanır)
    s = s.replace(/[^\p{L}\p{N} _\-.]/gu, '').replace(/\s+/g, ' ').trim();
    return Array.from(s).slice(0, max).join('').trim();
  }
  function sanitizeChat(s, max) {
    if (typeof s !== 'string') return '';
    s = s.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(s).slice(0, max).join('');
  }
  function normalizeColor(c) {
    if (typeof c !== 'string') return null;
    c = c.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(c) ? c : null;
  }
  function hexToRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function colorDistance(a, b) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  }
  function pairKey(a, b) { return a < b ? a + '-' + b : b + '-' + a; }

  function rleEncode(arr) {
    const out = [];
    let i = 0;
    while (i < arr.length) {
      const v = arr[i]; let j = i + 1;
      while (j < arr.length && arr[j] === v) j++;
      out.push(v, j - i); i = j;
    }
    return out;
  }
  function rleDecode(rle, len) {
    const out = new Int16Array(len);
    let p = 0;
    for (let i = 0; i + 1 < rle.length; i += 2) {
      const v = rle[i] | 0, n = rle[i + 1] | 0;
      if (n < 0 || p + n > len) throw new Error('rle overflow');
      if (v !== 0) out.fill(v, p, p + n);
      p += n;
    }
    if (p !== len) throw new Error('rle length mismatch');
    return out;
  }
  function freshGrid() {
    const g = new Int16Array(N);
    for (let i = 0; i < N; i++) g[i] = LAND_MASK[i] ? -1 : 0;
    return g;
  }

  /* ------------------------------------------------ SAF YAKALAMA KONTROLÜ ----
   * Hem sunucu (doğrulama) hem istemci (fare üstü vurgusu) aynı fonksiyonu kullanır.
   * v = { grid, activeWar(a,b), pendingWar(a,b), isAlly(a,b) }
   * grid: -1 boş kara | 0 boş deniz | >0 sahibi olan hücre (denizde geçici işgal)  */
  function adjacentOwned(grid, idx, pid) {
    const r = (idx / COLS) | 0, c = idx - r * COLS;
    for (let k = 0; k < 8; k++) {
      const nr = r + DIRS8[k][0], nc = c + DIRS8[k][1];
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      if (grid[nr * COLS + nc] === pid) return true;
    }
    return false;
  }
  function captureCheck(v, pid, idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= N) return { ok: false, code: 'bounds' };
    const cur = v.grid[idx];
    if (cur === pid) return { ok: false, code: 'own' };
    const land = LAND_MASK[idx] === 1;
    if (land) {
      if (cur > 0) {
        if (!v.activeWar(pid, cur)) {
          if (v.isAlly(pid, cur)) return { ok: false, code: 'ally' };
          if (v.pendingWar(pid, cur)) return { ok: false, code: 'war_pending' };
          return { ok: false, code: 'no_war' };
        }
      }
    } else if (cur !== 0) {
      return { ok: false, code: 'sea_taken' };
    }
    if (!adjacentOwned(v.grid, idx, pid)) return { ok: false, code: 'not_adjacent' };
    return { ok: true, kind: land ? (cur === -1 ? 'free' : 'enemy') : 'sea', target: cur };
  }

  const REJECT_TEXT = {
    no_war: 'Savaş ilan etmeden başka bir ülkenin topraklarını alamazsın!',
    war_pending: 'Savaş henüz başlamadı! Bir sonraki turda aktifleşecek.',
    ally: 'Müttefikinin topraklarına saldıramazsın.',
    not_adjacent: 'Sadece kendi sınırına komşu pikselleri alabilirsin.',
    sea_taken: 'Bu deniz hücresi başka bir ülke tarafından işgal edilmiş.',
    no_actions: 'Bu tur için piksel hakkın bitti.',
    turn_ended: 'Turu bitirdin; yeni turu bekle.',
    pool_empty: 'Yerleştirecek pikselin kalmadı.',
    bad_capital: 'Başkent için boş bir kara parçası seç.',
    phase: 'Şu an bu işlem yapılamaz.',
    cooldown: 'Çok hızlı yazıyorsun.',
    bad_target: 'Geçersiz hedef.',
    not_ally: 'Piksel devri sadece müttefiklere yapılabilir.',
    gift_bad: 'Sadece kendi (başkent olmayan) karalarını verebilirsin.',
    already_ally: 'Zaten müttefiksiniz.',
    at_war: 'Savaştaki ülkeyle ittifak kurulamaz. Önce barış yap.',
    no_war_with: 'Bu ülkeyle savaşta değilsin.',
    dup: 'Bu teklifi zaten gönderdin.',
    no_proposal: 'Teklif bulunamadı veya süresi doldu.',
    already_war: 'Bu ülkeyle zaten savaş halindesin.',
    ally_war: 'Müttefikine savaş açamazsın. Önce ittifakı boz.',
    not_allied: 'Bu ülkeyle müttefik değilsin.',
    dead: 'Ülken yok edildi.'
  };

  /* -------------------------------------------------------------------- GAME */
  class Game {
    constructor(opts) {
      opts = opts || {};
      this.cfg = Object.assign({}, CONFIG, opts.config || {});
      this.rng = opts.rng || Math.random;
      this.genToken = opts.genToken || function () {
        let s = '';
        for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
        return s;
      };
      this.grid = freshGrid();
      this.players = new Map();
      this.nextId = 1;
      this.phase = 'LOBBY';
      this.timer = 0;
      this.round = 0;
      this.roundElapsed = 0;
      this.countdown = null;
      this.wars = new Map();       // pairKey -> {a,b,declared,startRound,active}
      this.allies = new Set();     // pairKey
      this.proposals = new Map();  // id -> {id,kind,from,to,exp}
      this.nextProposalId = 1;
      this.out = [];
      this.tickCount = 0;
      this.winners = null;
      this.overTimer = 0;
      this.pendingGifts = new Map();
    }

    /* ---------- çıkış kuyruğu (taşıyıcıdan bağımsız) ---------- */
    emit(msg, to) { this.out.push({ to: to === undefined ? 'all' : to, msg: msg }); }
    drain() { const o = this.out; this.out = []; return o; }
    news(text, kind, to) { this.emit({ t: 'news', text: text, kind: kind || 'info', round: this.round }, to); }
    notice(pid, text, kind) { this.emit({ t: 'notice', text: text, kind: kind || 'info' }, pid); }
    reject(pid, code, text) {
      const p = this.players.get(pid);
      if (!p) return;
      const last = p.lastReject[code];
      if (last !== undefined && this.tickCount - last < 2) return; // spam kontrolü
      p.lastReject[code] = this.tickCount;
      this.emit({ t: 'reject', code: code, text: text || REJECT_TEXT[code] || 'Reddedildi.' }, pid);
    }

    publicCfg() {
      const c = this.cfg;
      return {
        proto: PROTOCOL, mapHash: MAP_HASH, rows: ROWS, cols: COLS,
        MIN_PLAYERS: c.MIN_PLAYERS, MAX_PLAYERS: c.MAX_PLAYERS, LOBBY_COUNTDOWN: c.LOBBY_COUNTDOWN,
        SETUP_SECONDS: c.SETUP_SECONDS, ROUND_SECONDS: c.ROUND_SECONDS, START_POOL: c.START_POOL,
        MAX_ACTIONS: c.MAX_ACTIONS, MAX_CELLS_PER_MESSAGE: c.MAX_CELLS_PER_MESSAGE, NAME_MAX: c.NAME_MAX,
        CHAT_MAX: c.CHAT_MAX, WAR_DELAY_ROUNDS: c.WAR_DELAY_ROUNDS, SETUP_FREE_PLACEMENT: c.SETUP_FREE_PLACEMENT
      };
    }

    /* ---------- oyuncular ---------- */
    takenColors() { return Array.from(this.players.values()).map(p => p.color); }

    addPlayer(info, isBot) {
      if (this.phase !== 'LOBBY') return { ok: false, code: 'in_progress', text: 'Oyun zaten başladı.' };
      if (this.players.size >= this.cfg.MAX_PLAYERS) return { ok: false, code: 'full', text: 'Lobi dolu.' };
      const color = normalizeColor(info && info.color);
      if (!color) return { ok: false, code: 'bad_color', text: 'Geçersiz renk.' };
      if (colorDistance(color, SEA_COLOR) < this.cfg.COLOR_RESERVED_DISTANCE ||
          colorDistance(color, LAND_COLOR) < this.cfg.COLOR_RESERVED_DISTANCE) {
        return { ok: false, code: 'color_reserved', text: 'Bu renk deniz/kara rengine çok benziyor.' };
      }
      for (const p of this.players.values()) {
        if (colorDistance(color, p.color) < this.cfg.COLOR_MIN_DISTANCE) {
          return { ok: false, code: 'color_taken', text: 'Bu renk (veya çok benzeri) alınmış.', taken: this.takenColors() };
        }
      }
      const id = this.nextId++;
      let name = sanitizeName(info && info.name, this.cfg.NAME_MAX) || ('ÜLKE ' + id);
      const lower = new Set(Array.from(this.players.values()).map(p => p.name.toLowerCase()));
      if (lower.has(name.toLowerCase())) {
        let k = 2, cand;
        do { cand = Array.from(name).slice(0, this.cfg.NAME_MAX - String(k).length - 1).join('') + ' ' + k; k++; }
        while (lower.has(cand.toLowerCase()));
        name = cand;
      }
      const p = {
        id: id, name: name, color: color, isBot: !!isBot, connected: true, alive: true,
        token: isBot ? '' : this.genToken(), pool: 0, px: 0, capital: -1, dice: [0, 0], actions: 0,
        ended: false, botDue: 0, lastChat: -99, lastDm: -99, lastReject: {}
      };
      this.players.set(id, p);
      this.afterRosterChange();
      return { ok: true, pid: id, token: p.token };
    }

    addBot() {
      let color = null;
      for (const n of NATIONS) {
        if (this.players.size >= this.cfg.MAX_PLAYERS) break;
        const taken = Array.from(this.players.values()).some(p => colorDistance(n.color, p.color) < this.cfg.COLOR_MIN_DISTANCE);
        if (!taken) { color = n.color; break; }
      }
      for (let tries = 0; !color && tries < 200; tries++) {
        const c = '#' + [0, 0, 0].map(() => Math.floor(this.rng() * 256).toString(16).padStart(2, '0')).join('');
        const ok = colorDistance(c, SEA_COLOR) >= this.cfg.COLOR_RESERVED_DISTANCE &&
          colorDistance(c, LAND_COLOR) >= this.cfg.COLOR_RESERVED_DISTANCE &&
          !Array.from(this.players.values()).some(p => colorDistance(c, p.color) < this.cfg.COLOR_MIN_DISTANCE);
        if (ok) color = c;
      }
      if (!color) return { ok: false, code: 'full' };
      const used = new Set(Array.from(this.players.values()).map(p => p.name));
      const free = BOT_NAMES.filter(n => !used.has(n));
      const name = free.length ? free[Math.floor(this.rng() * free.length)] : 'BOT ' + this.nextId;
      return this.addPlayer({ name: name, color: color }, true);
    }

    removePlayer(pid) {
      if (this.phase === 'LOBBY') {
        if (this.players.delete(pid)) this.afterRosterChange();
      } else {
        this.setConnected(pid, false);
      }
    }
    setConnected(pid, flag) {
      const p = this.players.get(pid);
      if (!p) return;
      if (this.phase === 'LOBBY' && !flag && !p.isBot) { this.removePlayer(pid); return; }
      p.connected = !!flag;
    }
    humanCount() { let n = 0; for (const p of this.players.values()) if (!p.isBot) n++; return n; }
    connectedHumans() { let n = 0; for (const p of this.players.values()) if (!p.isBot && p.connected) n++; return n; }
    aliveList() { return Array.from(this.players.values()).filter(p => p.alive); }

    afterRosterChange() {
      if (this.phase !== 'LOBBY') return;
      if (this.players.size >= this.cfg.MIN_PLAYERS) {
        if (this.countdown === null) this.countdown = this.cfg.LOBBY_COUNTDOWN;
      } else {
        this.countdown = null;
      }
      this.emitSnapshots();
    }

    /* ---------- ilişkiler ---------- */
    isAlly(a, b) { return this.allies.has(pairKey(a, b)); }
    activeWar(a, b) { const w = this.wars.get(pairKey(a, b)); return !!(w && w.active); }
    pendingWar(a, b) { const w = this.wars.get(pairKey(a, b)); return !!(w && !w.active); }
    view() {
      return { grid: this.grid, activeWar: (a, b) => this.activeWar(a, b), pendingWar: (a, b) => this.pendingWar(a, b), isAlly: (a, b) => this.isAlly(a, b) };
    }

    /* ---------- tick ---------- */
    tick() {
      this.tickCount++;
      if (this.phase === 'LOBBY') this.tickLobby();
      else if (this.phase === 'SETUP') this.tickSetup();
      else if (this.phase === 'PLAYING') this.tickPlaying();
      else if (this.phase === 'ENDED') { if (this.overTimer > 0) this.overTimer--; }
      this.flushGifts();
      this.emitTick();
    }

    tickLobby() {
      if (this.players.size >= this.cfg.MIN_PLAYERS) {
        if (this.countdown === null) this.countdown = this.cfg.LOBBY_COUNTDOWN;
        else this.countdown--;
        if (this.countdown <= 0) this.startSetup();
      } else {
        this.countdown = null;
      }
    }

    startSetup() {
      this.phase = 'SETUP';
      this.countdown = null;
      this.timer = this.cfg.SETUP_SECONDS;
      this.grid = freshGrid();
      for (const p of this.players.values()) {
        p.pool = this.cfg.START_POOL; p.px = 0; p.capital = -1; p.alive = true; p.ended = false;
        p.actions = 0; p.dice = [0, 0];
        p.botDue = 1 + Math.floor(this.rng() * Math.max(1, Math.min(8, this.cfg.SETUP_SECONDS - 2)));
      }
      this.news('Savaş başladı! Başkentini seç ve ' + this.cfg.START_POOL + ' pikselini haritaya yerleştir.', 'info');
      this.emitSnapshots();
    }

    tickSetup() {
      this.timer--;
      for (const p of this.players.values()) {
        if (p.isBot && p.alive && p.botDue > 0 && --p.botDue === 0) this.botSetup(p);
      }
      if (this.timer <= 0) { this.finishSetup(); this.startRound(1); }
    }

    // süre bitince eksik kalanları otomatik tamamla (başkent seçmeyen / piksel kalan)
    finishSetup() {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (p.capital < 0) {
          const idx = this.pickRandomFreeLand();
          if (idx >= 0) this.applySetupCell(p, idx);
        }
        if (p.pool > 0) {
          const cells = this.growShape(p, p.pool, true);
          for (const idx of cells) if (p.pool > 0) this.applySetupCell(p, idx);
        }
      }
    }

    pickRandomFreeLand() {
      const free = [];
      for (let i = 0; i < N; i++) if (this.grid[i] === -1) free.push(i);
      return free.length ? free[Math.floor(this.rng() * free.length)] : -1;
    }

    applySetupCell(p, idx) {
      this.grid[idx] = p.id;
      if (p.capital < 0) p.capital = idx;
      p.pool--; p.px++;
      this.emit({ t: 'cells', c: [[idx, p.id]] });
    }

    // p'nin mevcut toprağından başlayarak rastgele büyüyen 'count' hücrelik şekil (boş karalar)
    growShape(p, count, fallbackAnywhere) {
      const chosen = [], set = new Set(), cand = new Set();
      const g = this.grid;
      const consider = (i) => { if (LAND_MASK[i] && g[i] === -1 && !set.has(i)) cand.add(i); };
      const neighbors = (i, fn) => {
        const r = (i / COLS) | 0, c = i - r * COLS;
        for (let k = 0; k < 8; k++) {
          const nr = r + DIRS8[k][0], nc = c + DIRS8[k][1];
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) fn(nr * COLS + nc);
        }
      };
      for (let i = 0; i < N; i++) if (g[i] === p.id) neighbors(i, consider);
      while (chosen.length < count) {
        if (cand.size === 0) {
          if (!fallbackAnywhere) break;
          const free = [];
          for (let i = 0; i < N; i++) if (g[i] === -1 && !set.has(i)) free.push(i);
          if (!free.length) break;
          const s = free[Math.floor(this.rng() * free.length)];
          chosen.push(s); set.add(s); neighbors(s, consider);
          continue;
        }
        const arr = Array.from(cand);
        const idx = arr[Math.floor(this.rng() * arr.length)];
        cand.delete(idx); chosen.push(idx); set.add(idx);
        neighbors(idx, consider);
      }
      return chosen;
    }

    /* ---------- tur ---------- */
    startRound(n) {
      this.phase = 'PLAYING';
      this.round = n;
      this.timer = this.cfg.ROUND_SECONDS;
      this.roundElapsed = 0;
      for (const w of this.wars.values()) {
        if (!w.active && w.startRound <= n) {
          w.active = true;
          const a = this.players.get(w.a), b = this.players.get(w.b);
          if (a && b) this.news('⚔ ' + a.name + ' ile ' + b.name + ' arasında SAVAŞ BAŞLADI! Piksel cephesi aktif.', 'war');
        }
      }
      for (const [id, pr] of Array.from(this.proposals)) if (pr.exp < n) this.proposals.delete(id);
      for (let i = 0; i < N; i++) if (!LAND_MASK[i] && this.grid[i] > 0) this.grid[i] = 0; // geçici deniz işgalleri
      for (const p of this.players.values()) {
        p.ended = false;
        if (!p.alive) { p.actions = 0; p.dice = [0, 0]; continue; }
        const d1 = 1 + Math.floor(this.rng() * 6), d2 = 1 + Math.floor(this.rng() * 6);
        p.dice = [d1, d2];
        p.actions = Math.min(this.cfg.MAX_ACTIONS, d1 * d2);
        p.botDue = 1 + Math.floor(this.rng() * Math.max(1, Math.min(10, this.cfg.ROUND_SECONDS - 3)));
      }
      this.news('— TUR ' + n + ' başladı —', 'info');
      this.emitSnapshots();
      this.emitDiploAll();
    }

    tickPlaying() {
      this.timer--; this.roundElapsed++;
      for (const p of this.players.values()) {
        if (p.isBot && p.alive && !p.ended && --p.botDue <= 0) this.botAct(p);
      }
      if (this.phase !== 'PLAYING') return;
      const ready = this.roundElapsed >= this.cfg.MIN_ROUND_SECONDS && this.allReady();
      if (this.timer <= 0 || ready) this.nextRound();
    }

    allReady() {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (!p.isBot && !p.connected) continue;
        if (!p.ended) return false;
      }
      return true;
    }

    nextRound() {
      if (this.round >= this.cfg.MAX_ROUNDS) {
        const alive = this.aliveList().sort((a, b) => b.px - a.px);
        const top = alive.length ? alive[0].px : 0;
        this.endGame(alive.filter(p => p.px === top).map(p => p.id), 'Tur sınırı doldu — en çok piksele sahip ülke kazandı.');
        return;
      }
      this.startRound(this.round + 1);
    }

    checkEnd() {
      if (this.phase !== 'PLAYING') return;
      const alive = this.aliveList();
      if (alive.length <= 1) {
        this.endGame(alive.map(p => p.id), alive.length ? 'Son ayakta kalan ülke!' : 'Kimse hayatta kalmadı.');
        return;
      }
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) if (!this.isAlly(alive[i].id, alive[j].id)) return;
      }
      this.endGame(alive.map(p => p.id), 'Kalan tüm ülkeler müttefik — ortak zafer!');
    }

    endGame(winnerIds, reason) {
      this.phase = 'ENDED';
      this.winners = winnerIds.slice();
      this.overTimer = this.cfg.GAME_OVER_SECONDS;
      const names = winnerIds.map(id => (this.players.get(id) || {}).name).filter(Boolean).join(', ');
      this.news('🏆 OYUN BİTTİ! Kazanan: ' + (names || '—') + '. ' + reason, 'info');
      this.emit({ t: 'over', winners: this.winners, reason: reason });
      this.emitTick();
    }

    /* ---------- piksel işlemleri ---------- */
    ints(arr) {
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (let i = 0; i < arr.length && out.length < this.cfg.MAX_CELLS_PER_MESSAGE; i++) {
        if (Number.isInteger(arr[i]) && arr[i] >= 0 && arr[i] < N) out.push(arr[i]);
      }
      return out;
    }

    paint(pid, idxs) {
      const p = this.players.get(pid);
      if (!p) return;
      if (!p.alive) return this.reject(pid, 'dead');
      idxs = this.ints(idxs);
      if (!idxs.length) return;
      const changes = [];
      let youDirty = false;
      if (this.phase === 'SETUP') {
        for (const idx of idxs) {
          if (p.capital < 0) {
            if (LAND_MASK[idx] && this.grid[idx] === -1) {
              this.grid[idx] = pid; p.capital = idx; p.pool--; p.px++;
              changes.push([idx, pid]); youDirty = true;
              this.notice(pid, 'Başkent kuruldu! Kalan piksellerini yerleştir.', 'ok');
            } else this.reject(pid, 'bad_capital');
            continue;
          }
          if (p.pool <= 0) { this.reject(pid, 'pool_empty'); break; }
          if (!LAND_MASK[idx] || this.grid[idx] !== -1) continue;
          if (!this.cfg.SETUP_FREE_PLACEMENT && !adjacentOwned(this.grid, idx, pid)) { this.reject(pid, 'not_adjacent'); continue; }
          this.grid[idx] = pid; p.pool--; p.px++;
          changes.push([idx, pid]); youDirty = true;
        }
      } else if (this.phase === 'PLAYING') {
        if (p.ended) return this.reject(pid, 'turn_ended');
        for (const idx of idxs) {
          if (p.actions <= 0) { this.reject(pid, 'no_actions'); break; }
          const res = captureCheck(this.view(), pid, idx);
          if (!res.ok) { if (res.code !== 'own' && res.code !== 'bounds') this.reject(pid, res.code); continue; }
          const prevOwner = res.kind === 'enemy' ? this.players.get(res.target) : null;
          this.grid[idx] = pid;
          if (res.kind !== 'sea') p.px++;
          if (prevOwner) prevOwner.px--;
          p.actions--; youDirty = true;
          changes.push([idx, pid]);
          if (prevOwner && prevOwner.px <= 0 && prevOwner.alive) this.eliminate(prevOwner, p, changes);
        }
      } else {
        return this.reject(pid, 'phase');
      }
      if (changes.length) this.emit({ t: 'cells', c: changes });
      if (youDirty) this.emitYou(pid);
      if (this.phase === 'PLAYING') this.checkEnd();
    }

    eliminate(victim, by, changes) {
      victim.alive = false; victim.ended = true; victim.actions = 0;
      for (let i = 0; i < N; i++) {
        if (!LAND_MASK[i] && this.grid[i] === victim.id) { this.grid[i] = 0; changes.push([i, 0]); }
      }
      for (const [k, w] of Array.from(this.wars)) if (w.a === victim.id || w.b === victim.id) this.wars.delete(k);
      for (const k of Array.from(this.allies)) { const [a, b] = k.split('-').map(Number); if (a === victim.id || b === victim.id) this.allies.delete(k); }
      for (const [id, pr] of Array.from(this.proposals)) if (pr.from === victim.id || pr.to === victim.id) this.proposals.delete(id);
      this.news('💀 ' + victim.name + ' YOK EDİLDİ! (' + by.name + ' son pikselini ele geçirdi)', 'war');
      this.emitDiploAll();
      this.emitYou(victim.id);
    }

    gift(pid, to, idxs) {
      const p = this.players.get(pid), t = this.players.get(to);
      if (!p) return;
      if (this.phase !== 'PLAYING') return this.reject(pid, 'phase');
      if (!p.alive) return this.reject(pid, 'dead');
      if (!t || !t.alive || to === pid) return this.reject(pid, 'bad_target');
      if (!this.isAlly(pid, to)) return this.reject(pid, 'not_ally');
      idxs = this.ints(idxs);
      const changes = []; let bad = false;
      for (const idx of idxs) {
        if (!LAND_MASK[idx] || this.grid[idx] !== pid || idx === p.capital || p.px <= 1) { bad = true; continue; }
        this.grid[idx] = to; p.px--; t.px++;
        changes.push([idx, to]);
      }
      if (bad && !changes.length) this.reject(pid, 'gift_bad');
      if (changes.length) {
        this.emit({ t: 'cells', c: changes });
        const k = pid + '>' + to;
        this.pendingGifts.set(k, (this.pendingGifts.get(k) || 0) + changes.length);
      }
    }
    flushGifts() {
      if (!this.pendingGifts.size) return;
      for (const [k, n] of this.pendingGifts) {
        const [a, b] = k.split('>').map(Number);
        const pa = this.players.get(a), pb = this.players.get(b);
        if (!pa || !pb) continue;
        this.notice(b, '🎁 ' + pa.name + ' sana ' + n + ' piksel devretti!', 'ok');
        this.notice(a, '🎁 ' + pb.name + ' ülkesine ' + n + ' piksel devrettin.', 'ok');
        this.news('🎁 ' + pa.name + ' → ' + pb.name + ': ' + n + ' piksel devredildi.', 'ally');
      }
      this.pendingGifts.clear();
    }

    endTurn(pid) {
      const p = this.players.get(pid);
      if (!p || !p.alive) return;
      if (this.phase !== 'PLAYING') return;
      if (p.ended) return;
      p.ended = true;
      this.emitYou(pid);
    }

    /* ---------- diplomasi ---------- */
    dropProposalsBetween(a, b) {
      for (const [id, pr] of Array.from(this.proposals)) {
        if ((pr.from === a && pr.to === b) || (pr.from === b && pr.to === a)) this.proposals.delete(id);
      }
    }

    diploGuard(pid, to) {
      const p = this.players.get(pid), t = this.players.get(to);
      if (!p) return null;
      if (this.phase !== 'PLAYING') { this.reject(pid, 'phase', 'Diplomasi sadece oyun sırasında yapılabilir.'); return null; }
      if (!p.alive) { this.reject(pid, 'dead'); return null; }
      if (!t || !t.alive || to === pid) { this.reject(pid, 'bad_target'); return null; }
      return { p: p, t: t };
    }

    declareWar(pid, to) {
      const g = this.diploGuard(pid, to);
      if (!g) return;
      const key = pairKey(pid, to);
      if (this.allies.has(key)) return this.reject(pid, 'ally_war');
      if (this.wars.has(key)) return this.reject(pid, 'already_war');
      const startRound = this.round + this.cfg.WAR_DELAY_ROUNDS;
      this.wars.set(key, { a: pid, b: to, declared: this.round, startRound: startRound, active: false });
      this.dropProposalsBetween(pid, to);
      this.news('⚔ ' + g.p.name + ', ' + g.t.name + ' ülkesine SAVAŞ İLAN ETTİ! Savaş TUR ' + startRound + ' başında başlıyor.', 'war');
      this.notice(to, '⚔ ' + g.p.name + ' sana savaş ilan etti! TUR ' + startRound + ' başında saldırabilir.', 'war');
      this.emitDiploAll();
    }

    breakAlliance(pid, to) {
      const g = this.diploGuard(pid, to);
      if (!g) return;
      const key = pairKey(pid, to);
      if (!this.allies.has(key)) return this.reject(pid, 'not_allied');
      this.allies.delete(key);
      this.news('💔 ' + g.p.name + ', ' + g.t.name + ' ile ittifakını BOZDU.', 'war');
      this.emitDiploAll();
    }

    propose(pid, kind, to) {
      if (kind !== 'alliance' && kind !== 'peace') return;
      const g = this.diploGuard(pid, to);
      if (!g) return;
      const key = pairKey(pid, to);
      if (kind === 'alliance') {
        if (this.allies.has(key)) return this.reject(pid, 'already_ally');
        if (this.wars.has(key)) return this.reject(pid, 'at_war');
      } else if (!this.wars.has(key)) {
        return this.reject(pid, 'no_war_with');
      }
      for (const pr of this.proposals.values()) {
        if (pr.kind === kind && pr.from === pid && pr.to === to) return this.reject(pid, 'dup');
      }
      for (const pr of this.proposals.values()) { // karşılıklı teklif = otomatik kabul
        if (pr.kind === kind && pr.from === to && pr.to === pid) return this.respond(pid, pr.id, true);
      }
      const id = this.nextProposalId++;
      this.proposals.set(id, { id: id, kind: kind, from: pid, to: to, exp: this.round + this.cfg.PROPOSAL_TTL_ROUNDS - 1 });
      this.notice(to, (kind === 'alliance' ? '🤝 ' + g.p.name + ' sana İTTİFAK teklif etti!' : '🕊 ' + g.p.name + ' sana BARIŞ teklif etti!'), kind === 'alliance' ? 'ally' : 'peace');
      this.notice(pid, 'Teklif ' + g.t.name + ' ülkesine gönderildi.', 'ok');
      this.emitDiplo(pid); this.emitDiplo(to);
    }

    respond(pid, id, accept) {
      const me = this.players.get(pid);
      if (!me) return;
      const pr = this.proposals.get(id);
      if (!pr || pr.to !== pid) return this.reject(pid, 'no_proposal');
      if (this.phase !== 'PLAYING') return this.reject(pid, 'phase');
      this.proposals.delete(id);
      const from = this.players.get(pr.from);
      if (!from || !from.alive || !me.alive) return this.emitDiplo(pid);
      const key = pairKey(pid, pr.from);
      if (pr.kind === 'alliance') {
        if (accept) {
          if (this.wars.has(key)) { this.reject(pid, 'at_war'); return this.emitDiploAll(); }
          this.allies.add(key);
          this.dropProposalsBetween(pid, pr.from);
          this.news('🤝 ' + from.name + ' ve ' + me.name + ' İTTİFAK kurdu!', 'ally');
        } else {
          this.notice(pr.from, me.name + ' ittifak teklifini reddetti.', 'war');
        }
      } else {
        if (!this.wars.has(key)) return this.emitDiploAll();
        if (accept) {
          this.wars.delete(key);
          this.dropProposalsBetween(pid, pr.from);
          this.news('🕊 ' + from.name + ' ve ' + me.name + ' BARIŞ yaptı! Savaş sona erdi.', 'peace');
        } else {
          this.notice(pr.from, me.name + ' barış teklifini REDDETTİ — piksel savaşı devam ediyor!', 'war');
        }
      }
      this.emitDiploAll();
    }

    /* ---------- sohbet ---------- */
    chat(pid, text) {
      const p = this.players.get(pid);
      if (!p) return;
      text = sanitizeChat(text, this.cfg.CHAT_MAX);
      if (!text) return;
      if (this.tickCount - p.lastChat < this.cfg.CHAT_COOLDOWN_TICKS) return this.reject(pid, 'cooldown');
      p.lastChat = this.tickCount;
      this.emit({ t: 'chat', from: pid, text: text });
    }
    dm(pid, to, text) {
      const p = this.players.get(pid), t = this.players.get(to);
      if (!p || !t || to === pid) return;
      text = sanitizeChat(text, this.cfg.CHAT_MAX);
      if (!text) return;
      if (this.tickCount - p.lastDm < this.cfg.CHAT_COOLDOWN_TICKS) return this.reject(pid, 'cooldown');
      p.lastDm = this.tickCount;
      const msg = { t: 'dm', from: pid, to: to, text: text };
      this.emit(msg, pid); this.emit(msg, to);
    }

    /* ---------- istemci mesaj dağıtıcısı (doğrulamalı) ---------- */
    handle(pid, msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      const p = this.players.get(pid);
      if (!p) return;
      switch (msg.t) {
        case 'paint': return this.paint(pid, msg.cells);
        case 'gift': return this.gift(pid, msg.to, msg.cells);
        case 'end': return this.endTurn(pid);
        case 'chat': return this.chat(pid, msg.text);
        case 'dm': return this.dm(pid, msg.to, msg.text);
        case 'propose': return this.propose(pid, msg.kind, msg.to);
        case 'respond': return this.respond(pid, msg.id, msg.accept === true);
        case 'war': return this.declareWar(pid, msg.to);
        case 'unally': return this.breakAlliance(pid, msg.to);
        case 'sync': return this.emitSnapshot(pid);
        default: return;
      }
    }

    /* ---------- görünümler ---------- */
    publicPlayers() {
      return Array.from(this.players.values()).map(p => ({
        id: p.id, name: p.name, color: p.color, px: p.px, alive: p.alive, bot: p.isBot,
        conn: p.connected, ended: p.ended, cap: p.capital
      }));
    }
    youFor(pid) {
      const p = this.players.get(pid);
      if (!p) return null;
      return { pool: p.pool, actions: p.actions, dice: p.dice.slice(), capital: p.capital, ended: p.ended, alive: p.alive };
    }
    diploFor(pid) {
      const wars = [];
      for (const w of this.wars.values()) wars.push([w.a, w.b, w.startRound, w.active ? 1 : 0]);
      const allies = Array.from(this.allies).map(k => k.split('-').map(Number));
      const props = [];
      for (const pr of this.proposals.values()) {
        if (pr.from === pid || pr.to === pid) props.push({ id: pr.id, kind: pr.kind, from: pr.from, to: pr.to, exp: pr.exp });
      }
      return { t: 'diplo', wars: wars, allies: allies, props: props };
    }
    snapshotFor(pid) {
      const s = {
        t: 'snap', phase: this.phase, timer: this.timer, round: this.round, countdown: this.countdown,
        max: this.cfg.MAX_PLAYERS, min: this.cfg.MIN_PLAYERS,
        players: this.publicPlayers(), you: this.youFor(pid), diplo: this.diploFor(pid),
        winners: this.winners
      };
      if (this.phase !== 'LOBBY') s.grid = rleEncode(this.grid);
      return s;
    }
    emitSnapshot(pid) { const p = this.players.get(pid); if (p && !p.isBot) this.emit(this.snapshotFor(pid), pid); }
    emitSnapshots() { for (const p of this.players.values()) if (!p.isBot) this.emit(this.snapshotFor(p.id), p.id); }
    emitYou(pid) { const p = this.players.get(pid); if (p && !p.isBot) this.emit(Object.assign({ t: 'you' }, this.youFor(pid)), pid); }
    emitDiplo(pid) { const p = this.players.get(pid); if (p && !p.isBot) this.emit(this.diploFor(pid), pid); }
    emitDiploAll() { for (const p of this.players.values()) if (!p.isBot) this.emit(this.diploFor(p.id), p.id); }
    emitTick() {
      this.emit({
        t: 'tick', phase: this.phase, timer: this.timer, round: this.round, countdown: this.countdown,
        n: this.players.size,
        ps: Array.from(this.players.values()).map(p => [p.id, p.px, p.alive ? 1 : 0, p.ended ? 1 : 0, p.connected ? 1 : 0])
      });
    }

    /* ---------- BOTLAR (aynı doğrulanmış API'yi kullanır) ---------- */
    botSetup(p) {
      if (this.phase !== 'SETUP' || !p.alive) return;
      if (p.capital < 0) {
        let idx = -1;
        const caps = Array.from(this.players.values()).filter(q => q.capital >= 0).map(q => q.capital);
        for (let tries = 0; tries < 60 && idx < 0; tries++) {
          const cand = Math.floor(this.rng() * N);
          if (!LAND_MASK[cand] || this.grid[cand] !== -1) continue;
          const cr = (cand / COLS) | 0, cc = cand % COLS;
          if (caps.every(k => Math.max(Math.abs(((k / COLS) | 0) - cr), Math.abs((k % COLS) - cc)) > 6)) idx = cand;
        }
        if (idx < 0) idx = this.pickRandomFreeLand();
        if (idx >= 0) this.paint(p.id, [idx]);
      }
      if (p.pool > 0) {
        const cells = this.growShape(p, p.pool, true);
        this.paint(p.id, cells);
      }
    }

    neighborOwners(pid) {
      const set = new Set(), g = this.grid;
      for (let i = 0; i < N; i++) {
        if (g[i] !== pid || !LAND_MASK[i]) continue;
        const r = (i / COLS) | 0, c = i - r * COLS;
        for (let k = 0; k < 8; k++) {
          const nr = r + DIRS8[k][0], nc = c + DIRS8[k][1];
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
          const o = g[nr * COLS + nc];
          if (o > 0 && o !== pid) set.add(o);
        }
      }
      return Array.from(set);
    }

    botAct(p) {
      if (this.phase !== 'PLAYING' || !p.alive || p.ended) return;
      this.botDiplomacy(p);
      this.botExpand(p);
      p.ended = true;
    }

    botDiplomacy(p) {
      for (const pr of Array.from(this.proposals.values())) {
        if (pr.to !== p.id) continue;
        const accept = pr.kind === 'alliance' ? this.rng() < 0.5 : this.rng() < 0.55;
        this.respond(p.id, pr.id, accept);
      }
      if (this.phase !== 'PLAYING' || !p.alive) return;
      const others = this.aliveList().filter(q => q.id !== p.id);
      if (this.round >= 2 && others.length && this.rng() < 0.15) {
        const cands = others.filter(q => !this.isAlly(p.id, q.id) && !this.wars.has(pairKey(p.id, q.id)));
        if (cands.length) this.propose(p.id, 'alliance', cands[Math.floor(this.rng() * cands.length)].id);
      }
      const myWars = Array.from(this.wars.values()).filter(w => w.a === p.id || w.b === p.id);
      if (this.round >= 3 && !myWars.length && this.rng() < 0.22) {
        const nb = this.neighborOwners(p.id).filter(id => !this.isAlly(p.id, id) && this.players.get(id).alive);
        if (nb.length) this.declareWar(p.id, nb[Math.floor(this.rng() * nb.length)]);
      }
      for (const w of myWars) {
        if (w.active && this.round - w.startRound >= 2 && this.rng() < 0.25) {
          this.propose(p.id, 'peace', w.a === p.id ? w.b : w.a);
        }
      }
    }

    botExpand(p) {
      if (!p.alive || p.actions <= 0) return;
      const g = this.grid, me = p.id;
      const qualifies = (i) => {
        if (!LAND_MASK[i]) return false;
        const o = g[i];
        return o === -1 || (o > 0 && o !== me && this.activeWar(me, o));
      };
      const nbrs = (i, fn) => {
        const r = (i / COLS) | 0, c = i - r * COLS;
        for (let k = 0; k < 8; k++) {
          const nr = r + DIRS8[k][0], nc = c + DIRS8[k][1];
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) fn(nr * COLS + nc);
        }
      };
      const free = new Set(), enemy = new Set(), chosen = new Set();
      const add = (i) => {
        if (chosen.has(i) || !qualifies(i)) return;
        if (g[i] === -1) free.add(i); else enemy.add(i);
      };
      for (let i = 0; i < N; i++) if (g[i] === me && LAND_MASK[i]) nbrs(i, add);
      const list = [];
      for (let k = 0; k < p.actions; k++) {
        if (!free.size && !enemy.size) break;
        let pool;
        if (enemy.size && (!free.size || this.rng() < 0.75)) pool = enemy; else pool = free;
        const arr = Array.from(pool);
        const idx = arr[Math.floor(this.rng() * arr.length)];
        pool.delete(idx); chosen.add(idx); list.push(idx);
        nbrs(idx, add);
      }
      for (let i = 0; i < list.length; i += this.cfg.MAX_CELLS_PER_MESSAGE) {
        this.paint(me, list.slice(i, i + this.cfg.MAX_CELLS_PER_MESSAGE));
      }
    }
  }

  /* ------------------------------------------------------------------- ROOM */
  /* Game + bağlı istemciler. Taşıyıcı (WebSocket / yerel) bir send(obj) fonksiyonu verir. */
  class Room {
    constructor(opts) {
      opts = opts || {};
      this.id = opts.id || 'room';
      this.game = new Game(opts);
      this.sends = new Map();       // pid -> send(obj)
      this.autoBotsAfter = opts.autoBotsAfter || 0;   // sn (tick); 0 = kapalı
      this.autoBotsPerTick = opts.autoBotsPerTick || 1;
      this.lobbyTicks = 0;
      this.emptyTicks = 0;
    }
    welcomeFor(pid, token) {
      return { t: 'welcome', you: pid, token: token, cfg: this.game.publicCfg() };
    }
    join(send, msg) {
      const r = this.game.addPlayer({ name: msg && msg.name, color: msg && msg.color }, false);
      if (!r.ok) return r;
      this.sends.set(r.pid, send);
      send(this.welcomeFor(r.pid, r.token));
      this.flush();
      return r;
    }
    findByToken(token) {
      if (typeof token !== 'string' || token.length < 16) return null;
      for (const p of this.game.players.values()) if (!p.isBot && p.token === token) return p;
      return null;
    }
    resume(token, send) {
      const p = this.findByToken(token);
      if (!p) return { ok: false, code: 'resume_failed', text: 'Oturum bulunamadı veya süresi doldu.' };
      this.sends.set(p.id, send);
      this.game.setConnected(p.id, true);
      send(this.welcomeFor(p.id, p.token));
      send(this.game.snapshotFor(p.id));
      return { ok: true, pid: p.id, token: p.token };
    }
    detach(pid, send) {
      if (send && this.sends.get(pid) !== send) return; // eski bağlantı, yeni bağlantıyı bozmasın
      this.sends.delete(pid);
      this.game.setConnected(pid, false);
      this.flush();
    }
    receive(pid, msg) {
      this.game.handle(pid, msg);
      this.flush();
    }
    addBot() { const r = this.game.addBot(); return r; }
    tick() {
      const g = this.game;
      if (g.phase === 'LOBBY' && this.autoBotsAfter > 0 && g.connectedHumans() > 0) {
        this.lobbyTicks++;
        if (this.lobbyTicks >= this.autoBotsAfter) {
          for (let k = 0; k < this.autoBotsPerTick && g.players.size < g.cfg.MIN_PLAYERS; k++) g.addBot();
        }
      }
      g.tick();
      this.emptyTicks = (g.connectedHumans() === 0) ? this.emptyTicks + 1 : 0;
      this.flush();
    }
    flush() {
      const items = this.game.drain();
      for (const it of items) {
        if (it.to === 'all') { for (const send of this.sends.values()) send(it.msg); }
        else { const s = this.sends.get(it.to); if (s) s(it.msg); }
      }
    }
    isFinished() {
      const g = this.game;
      if (g.phase === 'ENDED' && g.overTimer <= 0) return true;
      if (g.phase === 'LOBBY') return g.humanCount() === 0;
      return this.emptyTicks >= g.cfg.EMPTY_ROOM_SECONDS;
    }
  }

  return {
    PROTOCOL, CONFIG, NATIONS, SEA_COLOR, LAND_COLOR, MAP_DATA, MAP_HASH, ROWS, COLS, N, LAND_MASK, DIRS8,
    REJECT_TEXT, Game, Room, captureCheck, adjacentOwned, rleEncode, rleDecode, freshGrid,
    sanitizeName, sanitizeChat, normalizeColor, hexToRgb, colorDistance, pairKey, mulberry32, hash32
  };
});
