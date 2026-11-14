/* ============================================================================
 *  PIXEL WAR  -  CORE v2  (tarayıcı istemcisi ve Node sunucusu TARAFINDAN PAYLAŞILIR)
 *  ----------------------------------------------------------------------------
 *  - DOM / ağ / gerçek zamanlayıcı YOK: deterministik, advance(ms) ile ilerler.
 *  - Oyun kurallarının TEK doğruluk kaynağı burasıdır (otoriter sunucu modeli).
 *  - Aynı dosya game.html içindeki <script id="px-core"> bloğunda ve
 *    server/core.js içinde BİREBİR aynı olmalıdır (npm run sync / npm test kontrol eder).
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PXCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ CONFIG */
  const PROTOCOL = 2;

  const CONFIG = {
    MIN_PLAYERS: 10,            // oyun başlama eşiği
    MAX_PLAYERS: 20,            // oda kapasitesi
    LOBBY_COUNTDOWN: 20,        // sn: 10 oyuncuya ulaşınca
    LOBBY_WAIT_SECONDS: 60,     // sn: 10'a ulaşılamazsa botlarla doldur ve hemen başlat
    BOT_FILL_TO: 10,            // doldurma hedefi (20 yaparsan oda tamamen dolar)
    SETUP_SECONDS: 30,          // başkent + ilk yerleşim
    ROUND_SECONDS: 30,          // 1 TUR = 30 sn = zar atışı aralığı
    START_POOL: 25,             // başkent dahil başlangıç pikseli (anlık yerleşim)
    MAX_DICE_POINTS: 20,        // zar (d6*d6) üst sınırı = tur başına genişleme puanı
    MAX_POINTS: 120,            // biriktirilebilen puan üst sınırı
    CAPTURE_MS_FREE: 1000,      // katı sıralı fetih: her hücre en az 1 sn
    CAPTURE_MS_SEA: 1000,       // deniz çıkarma hücresi de 1 sn
    CAPTURE_MS_ENEMY: 1000,     // düşman pikseli: 1.0 sn
    MAX_QUEUE: 40,              // aynı anda kuyruktaki fetih sayısı
    ATTRITION_STEP: 10,         // savunan, saldırana her 10 piksel kaybettiğinde yıpranma zarı
    ATTRITION_CHANCE: 0.5,
    ATTRITION_LOSS_SINGLE: 2,   // tek cephe: isabette -2 puan
    ATTRITION_LOSS_MULTI: 1,    // çok cephe: cephe başına isabette -1 puan
    SIEGE_LOSS: 2,              // kuşatılan başkent: tur başına -2 puan
    SIEGE_RADIUS: 2,            // başkente bu mesafedeki (Chebyshev) fetih = kuşatma
    PACT_LOCK_ROUNDS: 5,        // barış / ittifak kilidi (tur)
    WAR_DELAY_ROUNDS: 1,
    PROPOSAL_TTL_ROUNDS: 3,
    MAX_ROUNDS: 60,
    SETUP_FREE_PLACEMENT: false,   // v3: ilk yerleşim de başkente/kendi toprağına BİTİŞİK olmalı (bağlantısız toprak yok)
    MAX_CELLS_PER_MESSAGE: 64,
    NAME_MAX: 16,
    CHAT_MAX: 60,
    CHAT_COOLDOWN_MS: 5000,     // gazete duyurusu
    DM_COOLDOWN_MS: 3000,       // diplomasi özel mesajı
    CAPITAL_RELOC_SECONDS: 30,  // yeni başkent seçme süresi (barış sonrası)
    EXP_REWARDS: [50, 40, 30, 20, 10],
    GAME_OVER_SECONDS: 25,
    EMPTY_ROOM_SECONDS: 60,
    REJECT_FLOOD: 250,          // 10 sn içinde bu kadar ret = şüpheli (sunucu atar)
    /* ---- v3 kuralları ---- */
    RATE_TIER1_MAX: 50,         // S < 50  -> 1 piksel/sn
    RATE_TIER2_MAX: 100,        // 50 <= S < 100 -> 2 piksel/sn ; S >= 100 -> 3 piksel/sn
    WAR_PROTECTION_ROUNDS: 5,   // ilk 5 tur: savaş ilanı ve işgal yasak
    FLAG_PENALTY: 2,            // bayrak (başkent) kaybı / manuel taşıma bedeli (puan)
    DEBT_FLOOR: -2,             // bakiye en fazla -2'ye düşebilir (borç); borç bitene dek yeni genişleme yok
    GIFT_MAX_CELLS: 3,          // tek seferde en fazla 3 piksel devri
    GIFT_COOLDOWN_ROUNDS: 5,    // devir sonrası 5 tur bekleme
    /* ---- v4: deniz hareketi ---- */
    NAVAL_UNLOCK_MS: 5000,      // oyun başladıktan (kurulum bittikten) sonra deniz hareketi 5 sn kilitli
    SEA_HOLD_MS: 5000           // alınan deniz hücresi 5 sn sonra geri döner (geçici köprü)
  };

  const SEA_COLOR = '#2980b9';
  const LAND_COLOR = '#2c3e50';

  const BOT_NAMES = ['ANADOLU', 'TRAKYA', 'İBERYA', 'GALYA', 'ROMA', 'SLAV', 'VİKİNG', 'KELT',
    'HUN', 'PERS', 'BİZANS', 'ARAGON', 'BAVYERA', 'LİTVANYA', 'KASTİLYA', 'SAKSONYA',
    'PRUSYA', 'FRANK', 'LOMBARD', 'NORMAN'];

  /* ------------------------------------------------------------------ BAYRAK */
  const FLAG_W = 30, FLAG_H = 15;                    // bayrak oranı 30x15'e KİLİTLİ
  const FLAG_B64_LEN = FLAG_W * FLAG_H * 4;           // 450 piksel * 3 bayt = 1350 bayt -> 1800 base64 karakteri
  function validateFlag(s) {
    return (typeof s === 'string' && s.length === FLAG_B64_LEN && /^[A-Za-z0-9+/]+$/.test(s)) ? s : '';
  }

  /* --------------------------------------------------------------- RENK ÇARKI */
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const x = (v) => Math.round(255 * v).toString(16).padStart(2, '0');
    return '#' + x(f(0)) + x(f(8)) + x(f(4));
  }
  function hexToRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function colorDistance(a, b) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  }
  function rgbToHsl(hex) {
    const [r, g, b] = hexToRgb(hex).map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0); else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }
  // MAVİ tamamen yasak (denizle karışır): camgöbeği-mavi-lacivert tonları
  function isBlueish(hex) {
    const c = rgbToHsl(hex);
    return c.h >= 175 && c.h <= 265 && c.s >= 0.2 && c.l > 0.08 && c.l < 0.95;
  }
  // 9 renk tonu (mavi aralığı çıkarıldı) x 3 parlaklık halkası + 3 nötr
  const PALETTE = (function () {
    const hues = [0, 30, 60, 90, 120, 150, 270, 300, 330];
    const tones = [{ s: 80, l: 68 }, { s: 78, l: 50 }, { s: 70, l: 32 }];
    const raw = [];
    tones.forEach((t, ring) => hues.forEach((h, i) => raw.push({ hex: hslToHex(h, t.s, t.l), hue: h, ring: ring, slot: i })));
    [['#ffffff', 0], ['#bdc3c7', 1], ['#8d6e63', 2]].forEach(n => raw.push({ hex: n[0], hue: -1, ring: 3, slot: n[1] }));
    const out = [];
    for (const c of raw) {
      if (isBlueish(c.hex)) continue;
      if (colorDistance(c.hex, SEA_COLOR) < 40 || colorDistance(c.hex, LAND_COLOR) < 40) continue;
      if (out.some(o => colorDistance(o.hex, c.hex) < 45)) continue;
      out.push(c);
    }
    return out.map((c, i) => ({ id: i, hex: c.hex, hue: c.hue, ring: c.ring, slot: c.slot }));
  })();
  const PALETTE_HEX = new Set(PALETTE.map(p => p.hex));

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
    "00000000zx00000000000000000001111111111111111111111111111111111111111111110011111000111111111111110000",
    "0000000000000000000000000000111111111111111111111111111111111111111111100000100000111111111111110000",
    "0000000000000000000000000000111111111111111111110111111111111111111111000001110000111111111111110000",
    "0000000000000000000000000000111111111111111111100011111111111111111111000001111101111111111111110000",
    "0000000000000000000000000000111111111111111111100011111111111111111110000000110001111111111111111000",
    "0000000000000000000000000000111111111110001111110001111111111111111110000000000000011111111111111110",
    "0000000000000000000000000000111111111110000111110000111111111111111100000000000000001111111111111111",
    "0000000000000000111111111111111111111000000011111000001111111111111100000000000000000000111111111111",
    "0000000000000000011111111111111111100000010001111100000111111111111000000000000000000000001111111111",
    "0000000000000000001111111111111111000000011000111100000011111111111000000000000000000000000111111111",
    "0000000000000000011111111111111110000000011000011110000011111111111100000011111110000000000111111111",
    "0000000000000000001111111111111000000000000000000111100011111110010001111111111111111000011111111111",
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
    "0000000000000000000111111111111111111111111111100000000000000000000000000000011100000000111111111111",
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
  function gridHash(grid) { // sunucu-istemci durum senkronu doğrulaması
    let h = 2166136261 >>> 0;
    for (let i = 0; i < grid.length; i++) { h ^= (grid[i] & 0xffff); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

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
  function pairKey(a, b) { return a < b ? a + '-' + b : b + '-' + a; }
  function cheb(a, b) {
    return Math.max(Math.abs(((a / COLS) | 0) - ((b / COLS) | 0)), Math.abs((a % COLS) - (b % COLS)));
  }

  /* Genişleme hızı R (piksel/sn): S = oyuncunun toplam piksel sayısı */
  function expansionRate(px, cfg) {
    cfg = cfg || CONFIG;
    return px < cfg.RATE_TIER1_MAX ? 1 : (px < cfg.RATE_TIER2_MAX ? 2 : 3);
  }

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
   * Sunucu (doğrulama) ve istemci (fare üstü vurgusu) AYNI fonksiyonu kullanır.
   * v = { grid, activeWar, pendingWar, isAlly, extraOwned?(idx) }
   * grid: -1 boş kara | 0 boş deniz | >0 sahibi olan hücre (denizde geçici işgal)  */
  function anyNeighbor(idx, test) {
    const r = (idx / COLS) | 0, c = idx - r * COLS;
    for (let k = 0; k < 8; k++) {
      const nr = r + DIRS8[k][0], nc = c + DIRS8[k][1];
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      if (test(nr * COLS + nc)) return true;
    }
    return false;
  }
  function adjacentOwned(grid, idx, pid) { return anyNeighbor(idx, (n) => grid[n] === pid); }
  function captureCheck(v, pid, idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= N) return { ok: false, code: 'bounds' };
    const cur = v.grid[idx];
    if (cur === pid) return { ok: false, code: 'own' };
    const land = LAND_MASK[idx] === 1;
    const naval = !!v.navalOpen;                                           // kurulumda ve ilk 5 sn: deniz kapalı
    if (!land) {
      if (!naval) return { ok: false, code: 'naval_locked' };
      if (cur !== 0) return { ok: false, code: 'sea_taken' };
    } else if (cur > 0) {
      if (v.protectedNow) return { ok: false, code: 'protected' };         // savaş koruması: işgal yok
      if (!v.activeWar(pid, cur)) {
        if (v.isAlly(pid, cur)) return { ok: false, code: 'ally' };
        if (v.pendingWar(pid, cur)) return { ok: false, code: 'war_pending' };
        return { ok: false, code: 'no_war' };
      }
    }
    const ex = v.extraOwned;
    // komşuluk: kara komşuluğu her zaman geçerli; deniz köprüsü (geçici deniz hücresi) yalnızca deniz açıkken
    if (!anyNeighbor(idx, (n) => (v.grid[n] === pid || (ex && ex(n))) && (naval || LAND_MASK[n] === 1))) return { ok: false, code: 'not_adjacent' };
    return { ok: true, kind: land ? (cur === -1 ? 'free' : 'enemy') : 'sea', target: cur };
  }

  const REJECT_TEXT = {
    no_war: 'Savaş ilan etmeden başka bir ülkenin topraklarını alamazsın!',
    war_pending: 'Savaş henüz başlamadı! Bir sonraki turda aktifleşecek.',
    ally: 'Müttefikinin topraklarına saldıramazsın.',
    not_adjacent: 'Sadece kendi sınırına komşu pikselleri alabilirsin.',
    sea_taken: 'Bu deniz hücresi başka bir ülke tarafından işgal edilmiş.',
    no_points: 'Genişleme puanın bitti. Yeni zar için turu bekle.',
    queue_full: 'Fetih kuyruğu dolu.',
    cell_busy: 'Bu piksel şu an başka bir ülke tarafından fethediliyor.',
    pool_empty: 'Yerleştirecek pikselin kalmadı.',
    need_capital: 'Önce başkentini seç ve onayla.',
    bad_capital: 'Başkent için uygun bir kara parçası seç.',
    cap_locked: 'Savaş sürerken yeni başkent seçilemez; barış yapınca seçeceksin.',
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
    lock: 'Antlaşma kilidi aktif.',
    color_taken: 'Bu renk başka bir oyuncu tarafından seçildi.',
    bad_color: 'Geçersiz renk (mavi tonları yasak).',
    dead: 'Ülken yok edildi.',
    no_sea: 'Denizaşırı toprak alınamaz: yalnızca kara sınırındaki pikselleri alabilirsin.',
    naval_locked: 'Deniz hareketi kilitli: kurulumda kullanılamaz, oyun başladıktan 5 sn sonra açılır.',
    protected: 'Savaş koruması: oyunun ilk turlarında işgal yapılamaz.',
    war_protect: 'Savaş koruması: ilk turlarda savaş ilan edilemez.',
    debt: 'Borcun var: borç ödenene kadar yeni genişleme kilitli (yeni zarla ödenir).',
    gift_cd: 'Toprak transferi bekleme süresinde.',
    gift_adj: 'Devir yalnızca alıcının topraklarına komşu sınır pikselleriyle yapılabilir.',
    cap_gift: 'Başkent hiçbir diplomatik işlemle devredilemez.',
    cap_debt: 'Borcun varken başkent taşınamaz.',
    cap_same: 'Başkent zaten bu piksel.'
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
      this.countdown = null;
      this.lobbyElapsed = 0;
      this.nowMs = 0;
      this.acc = 0;
      this.matchId = '';
      this.wars = new Map();       // pairKey -> {a,b,declared,startRound,active}
      this.allies = new Set();     // pairKey
      this.locks = new Map();      // pairKey -> {type:'peace'|'alliance'|'breakup', until}
      this.proposals = new Map();  // id -> {id,kind,from,to,exp}
      this.nextProposalId = 1;
      this.pending = new Map();    // idx -> pid  (fethedilmekte olan şeritli pikseller)
      this.seaExpiries = new Map(); // idx -> mutlak deterministik bitiş zamanı (ms)
      this.navalUnlockAt = Infinity; // deniz hareketinin açılacağı oyun saati (kurulum boyunca kapalı)
      this.out = [];
      this.tickCount = 0;
      this.winners = null;
      this.rank = null;
      this.overTimer = 0;
      this.pendingGifts = new Map();
      this.suspects = new Set();
    }

    /* ---------- çıkış kuyruğu (taşıyıcıdan bağımsız) ---------- */
    emit(msg, to) { this.out.push({ to: to === undefined ? 'all' : to, msg: msg }); }
    drain() { const o = this.out; this.out = []; return o; }
    news(text, kind, who) { this.emit({ t: 'news', text: text, kind: kind || 'info', who: who || [] }); }
    notice(pid, text, kind) { this.emit({ t: 'notice', text: text, kind: kind || 'info' }, pid); }
    reject(pid, code, text) {
      const p = this.players.get(pid);
      if (!p) return;
      p.rej10++;
      const last = p.lastReject[code];
      if (last !== undefined && this.nowMs - last < 1500) return; // spam kontrolü
      p.lastReject[code] = this.nowMs;
      this.emit({ t: 'reject', code: code, text: text || REJECT_TEXT[code] || 'Reddedildi.' }, pid);
    }

    publicCfg() {
      const c = this.cfg;
      return {
        proto: PROTOCOL, mapHash: MAP_HASH, rows: ROWS, cols: COLS,
        MIN_PLAYERS: c.MIN_PLAYERS, MAX_PLAYERS: c.MAX_PLAYERS, LOBBY_COUNTDOWN: c.LOBBY_COUNTDOWN,
        LOBBY_WAIT_SECONDS: c.LOBBY_WAIT_SECONDS, SETUP_SECONDS: c.SETUP_SECONDS, ROUND_SECONDS: c.ROUND_SECONDS,
        START_POOL: c.START_POOL, MAX_CELLS_PER_MESSAGE: c.MAX_CELLS_PER_MESSAGE, NAME_MAX: c.NAME_MAX,
        CHAT_MAX: c.CHAT_MAX, CHAT_COOLDOWN_MS: c.CHAT_COOLDOWN_MS, DM_COOLDOWN_MS: c.DM_COOLDOWN_MS,
        WAR_DELAY_ROUNDS: c.WAR_DELAY_ROUNDS, PACT_LOCK_ROUNDS: c.PACT_LOCK_ROUNDS, MAX_QUEUE: c.MAX_QUEUE,
        SETUP_FREE_PLACEMENT: c.SETUP_FREE_PLACEMENT, WAR_PROTECTION_ROUNDS: c.WAR_PROTECTION_ROUNDS, FLAG_PENALTY: c.FLAG_PENALTY,
        DEBT_FLOOR: c.DEBT_FLOOR, GIFT_MAX_CELLS: c.GIFT_MAX_CELLS, GIFT_COOLDOWN_ROUNDS: c.GIFT_COOLDOWN_ROUNDS
      };
    }
    info() {
      return {
        phase: this.phase, players: this.players.size, max: this.cfg.MAX_PLAYERS, humans: this.humanCount(),
        bots: this.players.size - this.humanCount(), countdown: this.countdown,
        wait: this.phase === 'LOBBY' ? Math.max(0, this.cfg.LOBBY_WAIT_SECONDS - this.lobbyElapsed) : 0, round: this.round
      };
    }

    /* ---------- oyuncular ---------- */
    colorTaken(hex, exceptPid) {
      for (const p of this.players.values()) if (p.id !== exceptPid && p.color === hex) return true;
      return false;
    }
    freePaletteColors() {
      return PALETTE.filter(c => !this.colorTaken(c.hex, 0));
    }
    pickFreeColor() {
      const free = this.freePaletteColors();
      return free.length ? free[Math.floor(this.rng() * free.length)].hex : null;
    }

    addPlayer(info, isBot) {
      info = info || {};
      if (this.phase !== 'LOBBY') return { ok: false, code: 'in_progress', text: 'Oyun zaten başladı.' };
      if (this.players.size >= this.cfg.MAX_PLAYERS) return { ok: false, code: 'full', text: 'Sunucu dolu.' };
      let color = null;
      if (info.color !== undefined && info.color !== null) {
        color = normalizeColor(info.color);
        if (!color || !PALETTE_HEX.has(color)) return { ok: false, code: 'bad_color', text: REJECT_TEXT.bad_color };
        if (this.colorTaken(color, 0)) return { ok: false, code: 'color_taken', text: REJECT_TEXT.color_taken };
      }
      const id = this.nextId++;
      let name = sanitizeName(info.name, this.cfg.NAME_MAX) || ('ÜLKE ' + id);
      const lower = new Set(Array.from(this.players.values()).map(p => p.name.toLowerCase()));
      if (lower.has(name.toLowerCase())) {
        let k = 2, cand;
        do { cand = Array.from(name).slice(0, this.cfg.NAME_MAX - String(k).length - 1).join('') + ' ' + k; k++; }
        while (lower.has(cand.toLowerCase()));
        name = cand;
      }
      const p = {
        id: id, name: name, color: color, flag: validateFlag(info.flag), isBot: !!isBot, connected: true, alive: true,
        token: isBot ? '' : this.genToken(), pool: 0, px: 0, capital: -1, needCapital: false, capDue: 0,
        points: 0, dice: [0, 0], queue: [], queued: new Set(), siege: false, lost: {},
        botDue: 0, lastChat: -1e9, lastDm: -1e9, lastReject: {}, rej10: 0, giftUntil: 0
      };
      this.players.set(id, p);
      this.afterRosterChange();
      return { ok: true, pid: id, token: p.token };
    }

    addBot() {
      const color = this.pickFreeColor();
      if (!color) return { ok: false, code: 'full' };
      const used = new Set(Array.from(this.players.values()).map(p => p.name));
      const free = BOT_NAMES.filter(n => !used.has(n));
      const name = free.length ? free[Math.floor(this.rng() * free.length)] : 'BOT ' + this.nextId;
      return this.addPlayer({ name: name, color: color }, true);
    }
    fillBots(target) {
      while (this.players.size < Math.min(target, this.cfg.MAX_PLAYERS)) {
        if (!this.addBot().ok) break;
      }
    }

    setColor(pid, hex) {
      const p = this.players.get(pid);
      if (!p) return;
      if (this.phase !== 'LOBBY') return this.reject(pid, 'phase', 'Renk sadece lobide seçilebilir.');
      const c = normalizeColor(hex);
      if (!c || !PALETTE_HEX.has(c) || isBlueish(c)) return this.reject(pid, 'bad_color');
      if (this.colorTaken(c, pid)) { this.reject(pid, 'color_taken'); return this.emitSnapshot(pid); }
      p.color = c;
      this.emitSnapshots();
    }
    autoAssignColors() {
      for (const p of this.players.values()) if (!p.color) p.color = this.pickFreeColor() || PALETTE[0].hex;
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
    navalOpen() { return this.phase === 'PLAYING' && this.nowMs >= this.navalUnlockAt; }
    navalLeftMs() { return (this.phase === 'PLAYING' && isFinite(this.navalUnlockAt)) ? Math.max(0, Math.round(this.navalUnlockAt - this.nowMs)) : -1; }
    inProtection() { return this.phase === 'PLAYING' && this.round <= this.cfg.WAR_PROTECTION_ROUNDS; }
    isAlly(a, b) { return this.allies.has(pairKey(a, b)); }
    activeWar(a, b) { const w = this.wars.get(pairKey(a, b)); return !!(w && w.active); }
    pendingWar(a, b) { const w = this.wars.get(pairKey(a, b)); return !!(w && !w.active); }
    hasActiveWar(pid) { for (const w of this.wars.values()) if (w.active && (w.a === pid || w.b === pid)) return true; return false; }
    activeFronts(pid) {
      const out = [];
      for (const w of this.wars.values()) if (w.active && (w.a === pid || w.b === pid)) out.push(w.a === pid ? w.b : w.a);
      return out;
    }
    lockOf(a, b) {
      const l = this.locks.get(pairKey(a, b));
      return (l && l.until > this.round) ? l : null;
    }
    view(p) {
      return {
        grid: this.grid, activeWar: (a, b) => this.activeWar(a, b), pendingWar: (a, b) => this.pendingWar(a, b),
        isAlly: (a, b) => this.isAlly(a, b), extraOwned: p ? (i) => p.queued.has(i) : null,
        protectedNow: this.inProtection(),
        navalOpen: this.navalOpen()
      };
    }

    /* ---------- zaman: advance(ms) -> pump (fetih ilerlemesi) + her 1000 ms'de tick ---------- */
    advance(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return;
      this.nowMs += ms;
      this.pump(ms);
      this.expireSeaCells();
      this.acc += ms;
      while (this.acc >= 1000) { this.acc -= 1000; this.tick(); }
    }

    tick() {
      this.tickCount++;
      if (this.phase === 'LOBBY') this.tickLobby();
      else if (this.phase === 'SETUP') this.tickSetup();
      else if (this.phase === 'PLAYING') this.tickPlaying();
      else if (this.phase === 'ENDED') { if (this.overTimer > 0) this.overTimer--; }
      if (this.tickCount % 10 === 0) {
        for (const p of this.players.values()) { if (p.rej10 > this.cfg.REJECT_FLOOD) this.suspects.add(p.id); p.rej10 = 0; }
      }
      this.flushGifts();
      this.emitTick();
    }

    tickLobby() {
      if (this.players.size > 0) this.lobbyElapsed++;
      if (this.players.size >= this.cfg.MIN_PLAYERS) {
        if (this.countdown === null) this.countdown = this.cfg.LOBBY_COUNTDOWN;
        else this.countdown--;
        if (this.countdown <= 0) this.startSetup();
      } else {
        this.countdown = null;
        if (this.lobbyElapsed >= this.cfg.LOBBY_WAIT_SECONDS && this.humanCount() > 0) {
          this.fillBots(this.cfg.BOT_FILL_TO);   // 60 sn içinde 10'a ulaşılamadı: botlarla doldur, hemen başlat
          this.startSetup();
        }
      }
    }

    startSetup() {
      this.autoAssignColors();
      this.phase = 'SETUP';
      this.countdown = null;
      this.timer = this.cfg.SETUP_SECONDS;
      this.grid = freshGrid();
      this.matchId = 'm' + this.nextId + '-' + Math.floor(this.rng() * 0xffffffff).toString(36);
      for (const p of this.players.values()) {
        p.pool = this.cfg.START_POOL; p.px = 0; p.capital = -1; p.alive = true; p.points = 0; p.dice = [0, 0];
        p.queue = []; p.queued = new Set(); p.needCapital = false; p.capDue = 0; p.siege = false; p.lost = {}; p.giftUntil = 0;
        p.botDue = 1 + Math.floor(this.rng() * Math.max(1, Math.min(8, this.cfg.SETUP_SECONDS - 2)));
      }
      this.news('Savaş başladı! Başkentini seç, onayla ve ' + this.cfg.START_POOL + ' pikselini yerleştir.', 'info');
      this.emitSnapshots();
    }

    tickSetup() {
      this.timer--;
      for (const p of this.players.values()) {
        if (p.isBot && p.alive && p.botDue > 0 && --p.botDue === 0) this.botSetup(p);
      }
      if (this.timer <= 0) { this.finishSetup(); this.startRound(1); }
    }

    // süre bitince eksikleri otomatik tamamla
    finishSetup() {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (p.capital < 0) {
          // sahip olunan kara pikseli varsa onlardan rastgele; yoksa rastgele boş kara
          const owned = []; for (let i = 0; i < N; i++) if (this.grid[i] === p.id && LAND_MASK[i]) owned.push(i);
          if (owned.length) { p.capital = owned[Math.floor(this.rng() * owned.length)]; }
          else { const idx = this.pickRandomFreeLand(); if (idx >= 0) this.applySetupCell(p, idx); }
          this.notice(p.id, 'Başkent seçmediğin için rastgele atandı.', 'warn');
        }
        if (p.pool > 0) {
          const cells = this.growShape(p, p.pool, false);
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

    growShape(p, count, fallbackAnywhere) {
      const chosen = [], set = new Set(), cand = new Set();
      const g = this.grid;
      const consider = (i) => { if (LAND_MASK[i] && g[i] === -1 && !set.has(i)) cand.add(i); };
      const neighbors = (i, fn) => anyNeighbor(i, (n) => { fn(n); return false; });
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

    /* ---------- tur (30 sn): zar -> genişleme puanı ---------- */
    startRound(n) {
      this.phase = 'PLAYING';
      if (n === 1) { this.navalUnlockAt = this.nowMs + this.cfg.NAVAL_UNLOCK_MS; this.seaExpiries.clear(); }   // oyun başladı: 5 sn sonra deniz açılır
      this.round = n;
      this.timer = this.cfg.ROUND_SECONDS;
      for (const w of this.wars.values()) {
        if (!w.active && w.startRound <= n) {
          w.active = true;
          const a = this.players.get(w.a), b = this.players.get(w.b);
          if (a && b) this.news('⚔ ' + a.name + ' ile ' + b.name + ' arasında SAVAŞ BAŞLADI! Piksel cephesi aktif.', 'war', [w.a, w.b]);
        }
      }
      for (const [id, pr] of Array.from(this.proposals)) if (pr.exp < n) this.proposals.delete(id);
      for (const [k, l] of Array.from(this.locks)) if (l.until <= n) this.locks.delete(k);
      for (let i = 0; i < N; i++) if (!LAND_MASK[i] && this.grid[i] > 0) this.grid[i] = 0; // geçici deniz işgalleri
      for (const p of this.players.values()) {
        if (!p.alive) { p.dice = [0, 0]; continue; }
        // kuşatma bedeli (tur sonu): bakiye 0 ise kesinti atlanır, negatife düşmez
        if (p.siege) {
          p.siege = false;
          if (p.points > 0) {
            const cut = Math.min(p.points, this.cfg.SIEGE_LOSS);
            p.points -= cut;
            this.notice(p.id, '🏰 Başkent kuşatma altında: −' + cut + ' puan.', 'war');
          }
        }
        const d1 = 1 + Math.floor(this.rng() * 6), d2 = 1 + Math.floor(this.rng() * 6);
        p.dice = [d1, d2];
        p.points = Math.min(this.cfg.MAX_POINTS, p.points + Math.min(this.cfg.MAX_DICE_POINTS, d1 * d2));
        p.botDue = 1 + Math.floor(this.rng() * Math.max(1, Math.min(8, this.cfg.ROUND_SECONDS - 3)));
        this.maybePromptCapital(p);
      }
      this.emitSnapshots();
      this.emitDiploAll();
    }

    tickPlaying() {
      this.timer--;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (p.capDue > 0 && --p.capDue === 0) this.autoCapital(p);
        if (p.isBot && p.botDue > 0 && --p.botDue === 0) this.botAct(p);
      }
      if (this.phase !== 'PLAYING') return;
      if (this.timer <= 0) this.nextRound();
    }

    nextRound() {
      if (this.round >= this.cfg.MAX_ROUNDS) {
        this.endGame(null, 'Tur sınırı doldu — en çok piksele sahip ülke kazandı.');
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

    // sıralama: toplam piksel. İlk 5'e Savaş Deneyimi (50/40/30/20/10)
    computeRank() {
      const list = Array.from(this.players.values()).sort((a, b) => (b.px - a.px) || (a.id - b.id));
      return list.map((p, i) => ({ id: p.id, px: p.px, exp: i < this.cfg.EXP_REWARDS.length ? this.cfg.EXP_REWARDS[i] : 0 }));
    }

    endGame(winnerIds, reason) {
      this.rank = this.computeRank();
      if (!winnerIds) {
        const top = this.rank.length ? this.rank[0].px : 0;
        winnerIds = this.rank.filter(r => r.px === top).map(r => r.id);
      }
      this.phase = 'ENDED';
      this.winners = winnerIds.slice();
      this.overTimer = this.cfg.GAME_OVER_SECONDS;
      for (const p of this.players.values()) { p.queue = []; p.queued = new Set(); }
      this.pending.clear();
      const names = winnerIds.map(id => (this.players.get(id) || {}).name).filter(Boolean).join(', ');
      this.news('🏆 OYUN BİTTİ! Kazanan: ' + (names || '—') + '. ' + reason, 'info', winnerIds.slice(0, 2));
      this.emit({ t: 'over', winners: this.winners, reason: reason, rank: this.rank, match: this.matchId });
      this.emitTick();
    }

    /* ---------- başkent ---------- */
    chooseCapital(pid, idx) {
      const p = this.players.get(pid);
      if (!p) return;
      if (!p.alive) return this.reject(pid, 'dead');
      if (!Number.isInteger(idx) || idx < 0 || idx >= N) return this.reject(pid, 'bad_capital');
      if (this.phase === 'SETUP') {
        if (p.capital >= 0) return;
        if (!LAND_MASK[idx] || this.grid[idx] !== -1) return this.reject(pid, 'bad_capital');
        this.grid[idx] = pid; p.capital = idx; p.pool--; p.px++;
        this.emit({ t: 'cells', c: [[idx, pid]] });
        this.notice(pid, 'Başkent kuruldu! Kalan piksellerini yerleştir.', 'ok');
        this.emitYou(pid);
      } else if (this.phase === 'PLAYING') {
        if (p.needCapital) {                    // kaybedilen başkent yerine yenisi (ceza kayıp anında düşüldü)
          if (p.capDue <= 0) return this.reject(pid, 'cap_locked');
          if (!LAND_MASK[idx] || this.grid[idx] !== pid) return this.reject(pid, 'bad_capital');
          this.setCapital(p, idx);
        } else {                                // MANUEL bayrak relokasyonu: -2 puan
          if (!LAND_MASK[idx] || this.grid[idx] !== pid) return this.reject(pid, 'bad_capital');
          if (idx === p.capital) return this.reject(pid, 'cap_same');
          if (this.hasActiveWar(pid)) return this.reject(pid, 'cap_locked');
          if (p.points < 0) return this.reject(pid, 'cap_debt');
          p.capital = idx;
          this.flagPenalty(p, '🚩 Bayrak manuel taşındı');
        }
      } else this.reject(pid, 'phase');
    }
    setCapital(p, idx) {
      p.capital = idx; p.needCapital = false; p.capDue = 0;
      this.notice(p.id, '🏛 Yeni başkent belirlendi.', 'ok');
      this.emitYou(p.id);
    }
    autoCapital(p) {
      const owned = []; for (let i = 0; i < N; i++) if (this.grid[i] === p.id && LAND_MASK[i]) owned.push(i);
      if (!owned.length) return;
      this.setCapital(p, owned[Math.floor(this.rng() * owned.length)]);
      this.notice(p.id, 'Süre doldu; başkent rastgele atandı.', 'warn');
    }
    maybePromptCapital(p) {
      if (!p.alive || !p.needCapital || p.capDue > 0 || this.hasActiveWar(p.id)) return;
      p.capDue = this.cfg.CAPITAL_RELOC_SECONDS;
      this.emit({ t: 'capital_prompt', secs: p.capDue }, p.id);
      this.emitYou(p.id);
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
      if (this.phase === 'SETUP') return this.paintSetup(p, idxs);
      if (this.phase !== 'PLAYING') return this.reject(pid, 'phase');
      const added = [];
      for (const idx of idxs) {
        if (p.queued.has(idx)) continue;
        if (p.queue.length >= this.cfg.MAX_QUEUE) { this.reject(pid, 'queue_full'); break; }
        if (p.points <= 0) { this.reject(pid, p.points < 0 ? 'debt' : 'no_points'); break; }
        const other = this.pending.get(idx);
        if (other !== undefined && other !== pid) { this.reject(pid, 'cell_busy'); continue; }
        const res = captureCheck(this.view(p), pid, idx);
        if (!res.ok) { if (res.code !== 'own' && res.code !== 'bounds') this.reject(pid, res.code); continue; }
        const ms = res.kind === 'enemy' ? this.cfg.CAPTURE_MS_ENEMY : (res.kind === 'sea' ? this.cfg.CAPTURE_MS_SEA : this.cfg.CAPTURE_MS_FREE);
        p.points--;
        p.queue.push({ idx: idx, kind: res.kind, ms: ms, left: ms, base: ms, started: false });
        p.queued.add(idx);
        this.pending.set(idx, pid);
        added.push(idx);
      }
      if (added.length) {
        this.emit({ t: 'capq', pid: pid, c: added });
        this.emitYou(pid);
      }
    }

    paintSetup(p, idxs) {
      if (p.capital < 0) return this.reject(p.id, 'need_capital');
      const changes = [];
      for (const idx of idxs) {
        if (p.pool <= 0) { this.reject(p.id, 'pool_empty'); break; }
        if (!LAND_MASK[idx] || this.grid[idx] !== -1) continue;
        if (!this.cfg.SETUP_FREE_PLACEMENT && !adjacentOwned(this.grid, idx, p.id)) { this.reject(p.id, 'not_adjacent'); continue; }
        this.grid[idx] = p.id; p.pool--; p.px++;
        changes.push([idx, p.id]);
      }
      if (changes.length) { this.emit({ t: 'cells', c: changes }); this.emitYou(p.id); }
    }

    /* Süresi dolan geçici deniz köprülerini deterministik oyun saatine göre kaldır. */
    expireSeaCells() {
      if (!this.seaExpiries.size) return;
      const expired = [];
      for (const [idx, expiresAt] of this.seaExpiries) {
        if (expiresAt <= this.nowMs && !LAND_MASK[idx] && this.grid[idx] > 0) {
          this.grid[idx] = 0;
          expired.push([idx, 0]);
        }
        if (expiresAt <= this.nowMs) this.seaExpiries.delete(idx);
      }
      if (expired.length) this.emit({ t: 'cells', c: expired });
    }

    /* zamanlı fetih: oyuncu kuyruğunda yalnızca ilk hücre çalışır; sonraki hücre öncekinin
       tamamlanmasından sonra başlar. Büyük zaman adımlarında dahi sıralama korunur. */
    pump(ms) {
      if (this.phase !== 'PLAYING' || ms <= 0) return;
      for (const p of this.players.values()) {
        if (!p.alive || !p.queue.length) continue;
        let budget = ms;
        while (budget > 0 && p.queue.length) {
          const h = p.queue[0];
          if (!h.started) {
            h.started = true;
            // dinamik hız: hücre süresi = taban süre / R  (R, S = toplam piksele göre)
            h.ms = Math.max(1, Math.round((h.base || h.ms) / expansionRate(p.px, this.cfg)));
            h.left = h.ms;
            this.emit({ t: 'capstart', pid: p.id, idx: h.idx, ms: h.ms });
          }
          if (h.left > budget) { h.left -= budget; budget = 0; break; }
          budget -= h.left; h.left = 0;
          p.queue.shift(); p.queued.delete(h.idx); this.pending.delete(h.idx);
          this.finishCapture(p, h);
          if (this.phase !== 'PLAYING') return;
        }
      }
    }

    finishCapture(p, h) {
      if (!p.alive) return;
      const res = captureCheck(this.view(null), p.id, h.idx);
      if (!res.ok) { // durum değişti (barış, komşuluk kaybı...): iptal + iade
        p.points = Math.min(this.cfg.MAX_POINTS, p.points + 1);
        this.emit({ t: 'capcancel', pid: p.id, c: [h.idx] });
        this.emitYou(p.id);
        return;
      }
      const changes = [[h.idx, p.id]];
      this.grid[h.idx] = p.id;
      if (res.kind === 'sea') this.seaExpiries.set(h.idx, this.nowMs + this.cfg.SEA_HOLD_MS);   // geçici: 5 sn sonra geri döner
      else p.px++;
      let victim = null;
      if (res.kind === 'enemy') {
        const d = this.players.get(res.target);
        d.px--;
        if (d.capital === h.idx) {
          this.capitalLost(d, p);
        } else if (d.capital >= 0 && cheb(h.idx, d.capital) <= this.cfg.SIEGE_RADIUS) {
          d.siege = true; // başkent muharebe içinde
        }
        d.lost[p.id] = (d.lost[p.id] || 0) + 1;
        if (d.lost[p.id] % this.cfg.ATTRITION_STEP === 0) this.attrition(d);
        if (d.px <= 0 && d.alive) victim = d;
      }
      if (victim) this.eliminate(victim, p, changes);
      if (p.alive && res.kind !== 'sea') this.enclose(p, changes);   // çevrelenen alanlar otomatik oyuncuya geçer
      this.emit({ t: 'cells', c: changes });
      if (this.phase === 'PLAYING') this.checkEnd();
    }

    /* BAYRAK (başkent) kaybı: başkent düşer + 2 puan ceza (bakiye -2'ye kadar düşebilir = borç) */
    capitalLost(d, by) {
      d.capital = -1; d.needCapital = true; d.capDue = 0;
      this.notice(d.id, '🏛 BAŞKENT DÜŞTÜ! Savaş bitince (barış) yeni başkent seçeceksin.', 'war');
      this.news('🏛 ' + d.name + ' ülkesinin başkenti ' + by.name + ' tarafından ele geçirildi!', 'war', [d.id, by.id]);
      this.flagPenalty(d, '🚩 Bayrak konumu kaybedildi');
    }
    flagPenalty(p, why) {
      if (!p.alive) return;
      p.points = Math.max(this.cfg.DEBT_FLOOR, p.points - this.cfg.FLAG_PENALTY);
      this.notice(p.id, why + ': −' + this.cfg.FLAG_PENALTY + ' puan' +
        (p.points < 0 ? ' — BORÇ ' + p.points + ': borç ödenene kadar yeni genişleme kilitli.' : '.'), 'war');
      this.emitYou(p.id);
    }

    /* ÇEVRELEME (flood-fill): haritanın dışından (4 yönlü) erişilemeyen, oyuncu dışı kara hücreleri
       tamamen oyuncunun topraklarıyla çevrilidir -> sahipsiz ve (müttefik olmayan, korumadışı) rakip
       parçaları otomatik oyuncuya geçer. Oyuncu toprağı 8 yönlü bitişik sayıldığı için dış akış 4 yönlüdür. */
    enclose(p, changes) {
      if (!p.alive || p.px <= 0 || this.phase !== 'PLAYING') return 0;
      const g = this.grid, me = p.id, seen = new Uint8Array(N), stack = [];
      const push = (i) => { if (!seen[i] && (g[i] !== me || !LAND_MASK[i])) { seen[i] = 1; stack.push(i); } };   // geçici deniz köprüsü duvar olmaz
      for (let c = 0; c < COLS; c++) { push(c); push((ROWS - 1) * COLS + c); }
      for (let r = 0; r < ROWS; r++) { push(r * COLS); push(r * COLS + COLS - 1); }
      while (stack.length) {
        const i = stack.pop(), r = (i / COLS) | 0, c = i - r * COLS;
        if (r > 0) push(i - COLS);
        if (r < ROWS - 1) push(i + COLS);
        if (c > 0) push(i - 1);
        if (c < COLS - 1) push(i + 1);
      }
      const prot = this.inProtection();
      const victims = []; let gained = 0;
      for (let i = 0; i < N; i++) {
        if (seen[i] || !LAND_MASK[i] || g[i] === me) continue;
        const o = g[i];
        if (o === -1) { g[i] = me; p.px++; gained++; changes.push([i, me]); continue; }
        const d = this.players.get(o);
        if (!d || !d.alive || prot || this.isAlly(me, o)) continue;   // koruma süresi / müttefik: dokunulmaz
        g[i] = me; p.px++; d.px--; gained++; changes.push([i, me]);
        if (d.capital === i) this.capitalLost(d, p);
        if (d.px <= 0 && victims.indexOf(d) < 0) victims.push(d);
      }
      for (const d of victims) if (d.alive) this.eliminate(d, p, changes);
      if (gained) this.notice(p.id, '🧩 Çevrelenen ' + gained + ' piksel otomatik olarak topraklarına katıldı.', 'ok');
      return gained;
    }

    // yıpranma zarı: her aktif cephe için ayrı %50. Tek cephe isabeti -2, çok cephede cephe başına -1
    attrition(d) {
      const fronts = this.activeFronts(d.id);
      if (!fronts.length) return;
      const per = fronts.length >= 2 ? this.cfg.ATTRITION_LOSS_MULTI : this.cfg.ATTRITION_LOSS_SINGLE;
      let hits = 0;
      for (let i = 0; i < fronts.length; i++) if (this.rng() < this.cfg.ATTRITION_CHANCE) hits++;
      const want = hits * per;
      if (want <= 0 || d.points <= 0) return;   // bakiye 0 ise kesinti atlanır
      const cut = Math.min(d.points, want);
      d.points -= cut;
      this.notice(d.id, '🩸 Savaş yorgunluğu (' + fronts.length + ' cephe, ' + hits + ' isabet): −' + cut + ' puan.', 'war');
      this.emitYou(d.id);
    }

    eliminate(victim, by, changes) {
      victim.alive = false; victim.points = 0; victim.needCapital = false; victim.capDue = 0;
      for (const q of victim.queue) this.pending.delete(q.idx);
      if (victim.queue.length) this.emit({ t: 'capcancel', pid: victim.id, c: victim.queue.map(q => q.idx) });
      victim.queue = []; victim.queued = new Set();
      for (let i = 0; i < N; i++) {
        if (!LAND_MASK[i] && this.grid[i] === victim.id) { this.grid[i] = 0; changes.push([i, 0]); }
      }
      for (const [k, w] of Array.from(this.wars)) if (w.a === victim.id || w.b === victim.id) this.wars.delete(k);
      for (const k of Array.from(this.allies)) { const [a, b] = k.split('-').map(Number); if (a === victim.id || b === victim.id) this.allies.delete(k); }
      for (const [id, pr] of Array.from(this.proposals)) if (pr.from === victim.id || pr.to === victim.id) this.proposals.delete(id);
      for (const q of this.players.values()) delete q.lost[victim.id];
      this.news('💀 ' + victim.name + ' YOK EDİLDİ! (' + by.name + ' son pikselini ele geçirdi)', 'war', [victim.id, by.id]);
      this.emitDiploAll();
      this.emitYou(victim.id);
    }

    gift(pid, to, idxs) {
      const p = this.players.get(pid), t = this.players.get(to);
      if (!p) return;
      if (this.phase !== 'PLAYING') return this.reject(pid, 'phase');
      if (!p.alive) return this.reject(pid, 'dead');
      if (!t || !t.alive || to === pid) return this.reject(pid, 'bad_target');
      if (this.round < p.giftUntil) {
        return this.reject(pid, 'gift_cd', '⏳ Toprak transferi bekleme süresinde: ' + (p.giftUntil - this.round) + ' tur sonra yeniden devredebilirsin.');
      }
      idxs = this.ints(idxs);
      const changes = []; let reason = null;
      for (const idx of idxs) {
        if (changes.length >= this.cfg.GIFT_MAX_CELLS) break;          // tek seferde en fazla 3 piksel
        if (idx === p.capital) { reason = 'cap_gift'; continue; }     // başkent asla devredilemez
        if (!LAND_MASK[idx] || this.grid[idx] !== pid || p.px <= 1 || this.pending.has(idx)) { reason = reason || 'gift_bad'; continue; }
        // alıcıda bağlantısız toprak oluşmasın: alıcının (veya bu devirde verilen) toprağına komşu olmalı
        if (!anyNeighbor(idx, (n) => LAND_MASK[n] === 1 && this.grid[n] === to)) { reason = reason || 'gift_adj'; continue; }
        this.grid[idx] = to; p.px--; t.px++;
        changes.push([idx, to]);
      }
      if (!changes.length) { if (reason) this.reject(pid, reason); return; }
      p.giftUntil = this.round + this.cfg.GIFT_COOLDOWN_ROUNDS;       // transfer cooldown: 5 tur
      this.enclose(t, changes);
      this.emit({ t: 'cells', c: changes });
      const k = pid + '>' + to;
      this.pendingGifts.set(k, (this.pendingGifts.get(k) || 0) + changes.length);
      this.emitYou(pid);
      this.checkEnd();
    }
    flushGifts() {
      if (!this.pendingGifts.size) return;
      for (const [k, n] of this.pendingGifts) {
        const [a, b] = k.split('>').map(Number);
        const pa = this.players.get(a), pb = this.players.get(b);
        if (!pa || !pb) continue;
        this.notice(b, '🎁 ' + pa.name + ' sana ' + n + ' piksel devretti!', 'ok');
        this.notice(a, '🎁 ' + pb.name + ' ülkesine ' + n + ' piksel devrettin.', 'ok');
        this.news('🎁 ' + pa.name + ' → ' + pb.name + ': ' + n + ' piksel devredildi.', 'ally', [a, b]);
      }
      this.pendingGifts.clear();
    }

    /* ---------- diplomasi ---------- */
    dropProposalsBetween(a, b) {
      for (const [id, pr] of Array.from(this.proposals)) {
        if ((pr.from === a && pr.to === b) || (pr.from === b && pr.to === a)) this.proposals.delete(id);
      }
    }
    setLock(a, b, type) { this.locks.set(pairKey(a, b), { type: type, until: this.round + this.cfg.PACT_LOCK_ROUNDS }); }
    clearWarState(a, b) {
      const pa = this.players.get(a), pb = this.players.get(b);
      if (pa) delete pa.lost[b];
      if (pb) delete pb.lost[a];
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
      if (this.inProtection()) {
        return this.reject(pid, 'war_protect', '🛡 Savaş koruması: TUR ' + (this.cfg.WAR_PROTECTION_ROUNDS + 1) + ' başlayana kadar savaş ilan edilemez ve işgal yapılamaz.');
      }
      const key = pairKey(pid, to);
      if (this.allies.has(key)) return this.reject(pid, 'ally_war');
      if (this.wars.has(key)) return this.reject(pid, 'already_war');
      const lk = this.lockOf(pid, to);
      if (lk && (lk.type === 'peace' || lk.type === 'breakup')) {
        return this.reject(pid, 'lock', (lk.type === 'peace' ? '🕊 Barış antlaşması' : '💔 İttifak bozma') + ' kilidi: ' + (lk.until - this.round) + ' tur sonra savaş ilan edebilirsin.');
      }
      const startRound = this.round + this.cfg.WAR_DELAY_ROUNDS;
      this.wars.set(key, { a: pid, b: to, declared: this.round, startRound: startRound, active: false });
      this.dropProposalsBetween(pid, to);
      this.news('⚔ ' + g.p.name + ', ' + g.t.name + ' ülkesine SAVAŞ İLAN ETTİ! Savaş TUR ' + startRound + ' başında başlıyor.', 'war', [pid, to]);
      this.notice(to, '⚔ ' + g.p.name + ' sana savaş ilan etti! TUR ' + startRound + ' başında saldırabilir.', 'war');
      this.emitDiploAll();
    }

    breakAlliance(pid, to) {
      const g = this.diploGuard(pid, to);
      if (!g) return;
      const key = pairKey(pid, to);
      if (!this.allies.has(key)) return this.reject(pid, 'not_allied');
      const lk = this.lockOf(pid, to);
      if (lk && lk.type === 'alliance') {
        return this.reject(pid, 'lock', '🤝 İttifak kilidi: ' + (lk.until - this.round) + ' tur boyunca ittifak bozulamaz.');
      }
      this.allies.delete(key);
      this.setLock(pid, to, 'breakup');
      this.news('💔 ' + g.p.name + ', ' + g.t.name + ' ile ittifakını BOZDU.', 'war', [pid, to]);
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
        const lk = this.lockOf(pid, to);
        if (lk && lk.type === 'breakup') return this.reject(pid, 'lock', '💔 İttifak bozma kilidi: ' + (lk.until - this.round) + ' tur sonra yeniden ittifak teklif edebilirsin.');
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
          this.setLock(pid, pr.from, 'alliance');
          this.dropProposalsBetween(pid, pr.from);
          this.news('🤝 ' + from.name + ' ve ' + me.name + ' İTTİFAK kurdu!', 'ally', [pr.from, pid]);
        } else {
          this.notice(pr.from, me.name + ' ittifak teklifini reddetti.', 'war');
        }
      } else {
        if (!this.wars.has(key)) return this.emitDiploAll();
        if (accept) {
          this.wars.delete(key);
          this.setLock(pid, pr.from, 'peace');
          this.clearWarState(pid, pr.from);
          this.dropProposalsBetween(pid, pr.from);
          this.news('🕊 ' + from.name + ' ve ' + me.name + ' BARIŞ yaptı! Savaş sona erdi.', 'peace', [pr.from, pid]);
          this.maybePromptCapital(from); this.maybePromptCapital(me);   // kaybedilen başkent için yeniden seçim
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
      const wait = this.cfg.CHAT_COOLDOWN_MS - (this.nowMs - p.lastChat);
      if (wait > 0) return this.reject(pid, 'cooldown', 'Gazete için ' + Math.ceil(wait / 1000) + ' sn bekle.');
      p.lastChat = this.nowMs;
      this.emit({ t: 'chat', from: pid, text: text });
    }
    dm(pid, to, text) {
      const p = this.players.get(pid), t = this.players.get(to);
      if (!p || !t || to === pid) return;
      text = sanitizeChat(text, this.cfg.CHAT_MAX);
      if (!text) return;
      const wait = this.cfg.DM_COOLDOWN_MS - (this.nowMs - p.lastDm);
      if (wait > 0) return this.reject(pid, 'cooldown', 'Mesaj için ' + Math.ceil(wait / 1000) + ' sn bekle.');
      p.lastDm = this.nowMs;
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
        case 'capital': return this.chooseCapital(pid, msg.idx);
        case 'color': return this.setColor(pid, msg.color);
        case 'gift': return this.gift(pid, msg.to, msg.cells);
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
        conn: p.connected, cap: p.capital, hasFlag: !!p.flag
      }));
    }
    flagsFor(ids) {
      const f = {};
      for (const p of this.players.values()) if (p.flag && (!ids || ids.includes(p.id))) f[p.id] = p.flag;
      return f;
    }
    youFor(pid) {
      const p = this.players.get(pid);
      if (!p) return null;
      return { pool: p.pool, points: p.points, dice: p.dice.slice(), capital: p.capital, alive: p.alive, queue: p.queue.length, needCap: p.needCapital, capDue: p.capDue, giftCd: Math.max(0, p.giftUntil - this.round) };
    }
    diploFor(pid) {
      const wars = [];
      for (const w of this.wars.values()) wars.push([w.a, w.b, w.startRound, w.active ? 1 : 0]);
      const allies = Array.from(this.allies).map(k => k.split('-').map(Number));
      const props = [];
      for (const pr of this.proposals.values()) {
        if (pr.from === pid || pr.to === pid) props.push({ id: pr.id, kind: pr.kind, from: pr.from, to: pr.to, exp: pr.exp });
      }
      const locks = [];
      for (const [k, l] of this.locks) if (l.until > this.round) { const [a, b] = k.split('-').map(Number); locks.push([a, b, l.type, l.until]); }
      return { t: 'diplo', wars: wars, allies: allies, props: props, locks: locks };
    }
    snapshotFor(pid) {
      const s = {
        t: 'snap', phase: this.phase, timer: this.timer, round: this.round, countdown: this.countdown,
        wait: this.phase === 'LOBBY' ? Math.max(0, this.cfg.LOBBY_WAIT_SECONDS - this.lobbyElapsed) : 0,
        max: this.cfg.MAX_PLAYERS, min: this.cfg.MIN_PLAYERS,
        players: this.publicPlayers(), you: this.youFor(pid), diplo: this.diploFor(pid),
        winners: this.winners, rank: this.rank, match: this.matchId, nv: this.navalLeftMs()
      };
      if (this.phase !== 'LOBBY') {
        s.grid = rleEncode(this.grid);
        s.pending = Array.from(this.pending);
        s.seaExpiries = Array.from(this.seaExpiries);
        s.activeCaptures = Array.from(this.players.values()).filter(p => p.queue.length && p.queue[0].started).map(p => [p.id, p.queue[0].idx, p.queue[0].ms, p.queue[0].left]);
      }
      return s;
    }
    emitSnapshot(pid) { const p = this.players.get(pid); if (p && !p.isBot) this.emit(this.snapshotFor(pid), pid); }
    emitSnapshots() { for (const p of this.players.values()) if (!p.isBot) this.emit(this.snapshotFor(p.id), p.id); }
    emitYou(pid) { const p = this.players.get(pid); if (p && !p.isBot) this.emit(Object.assign({ t: 'you' }, this.youFor(pid)), pid); }
    emitDiplo(pid) { const p = this.players.get(pid); if (p && !p.isBot) this.emit(this.diploFor(pid), pid); }
    emitDiploAll() { for (const p of this.players.values()) if (!p.isBot) this.emit(this.diploFor(p.id), p.id); }
    emitTick() {
      const m = {
        t: 'tick', phase: this.phase, timer: this.timer, round: this.round, countdown: this.countdown,
        wait: this.phase === 'LOBBY' ? Math.max(0, this.cfg.LOBBY_WAIT_SECONDS - this.lobbyElapsed) : 0,
        n: this.players.size, nv: this.navalLeftMs(),
        ps: Array.from(this.players.values()).map(p => [p.id, p.px, p.alive ? 1 : 0, p.connected ? 1 : 0, p.capital])
      };
      if (this.phase !== 'LOBBY' && this.tickCount % 5 === 0) m.h = gridHash(this.grid); // istemci senkron doğrulaması
      this.emit(m);
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
          if (caps.every(k => cheb(k, cand) > 6)) idx = cand;
        }
        if (idx < 0) idx = this.pickRandomFreeLand();
        if (idx >= 0) this.chooseCapital(p.id, idx);
      }
      if (p.pool > 0 && p.capital >= 0) this.paint(p.id, this.growShape(p, p.pool, false));
    }

    neighborOwners(pid) {
      const set = new Set(), g = this.grid;
      for (let i = 0; i < N; i++) {
        if (g[i] !== pid || !LAND_MASK[i]) continue;
        anyNeighbor(i, (n) => { if (g[n] > 0 && g[n] !== pid) set.add(g[n]); return false; });
      }
      return Array.from(set);
    }

    botAct(p) {
      if (this.phase !== 'PLAYING' || !p.alive) return;
      this.botDiplomacy(p);
      this.botExpand(p);
    }

    botDiplomacy(p) {
      for (const pr of Array.from(this.proposals.values())) {
        if (pr.to !== p.id) continue;
        const accept = pr.kind === 'alliance' ? this.rng() < 0.5 : this.rng() < 0.55;
        this.respond(p.id, pr.id, accept);
      }
      if (this.phase !== 'PLAYING' || !p.alive) return;
      const others = this.aliveList().filter(q => q.id !== p.id);
      if (this.round >= 2 && others.length && this.rng() < 0.12) {
        const cands = others.filter(q => !this.isAlly(p.id, q.id) && !this.wars.has(pairKey(p.id, q.id)) && !this.lockOf(p.id, q.id));
        if (cands.length) this.propose(p.id, 'alliance', cands[Math.floor(this.rng() * cands.length)].id);
      }
      const myWars = Array.from(this.wars.values()).filter(w => w.a === p.id || w.b === p.id);
      if (this.round > this.cfg.WAR_PROTECTION_ROUNDS && !myWars.length && this.rng() < 0.18) {
        const nb = this.neighborOwners(p.id).filter(id => !this.isAlly(p.id, id) && !this.lockOf(p.id, id) && this.players.get(id).alive);
        if (nb.length) this.declareWar(p.id, nb[Math.floor(this.rng() * nb.length)]);
      }
      for (const w of myWars) {
        if (w.active && this.round - w.startRound >= 3 && this.rng() < 0.25) this.propose(p.id, 'peace', w.a === p.id ? w.b : w.a);
      }
    }

    botExpand(p) {
      if (!p.alive || p.points <= 0) return;
      const g = this.grid, me = p.id;
      const qualifies = (i) => {
        if (!LAND_MASK[i]) return false;
        const o = g[i];
        if (this.pending.has(i)) return false;
        return o === -1 || (o > 0 && o !== me && this.activeWar(me, o));
      };
      const free = new Set(), enemy = new Set(), chosen = new Set();
      const add = (i) => {
        if (chosen.has(i) || !qualifies(i)) return;
        if (g[i] === -1) free.add(i); else enemy.add(i);
      };
      for (let i = 0; i < N; i++) if (g[i] === me && LAND_MASK[i]) anyNeighbor(i, (n) => { add(n); return false; });
      const room = Math.max(0, this.cfg.MAX_QUEUE - p.queue.length);
      const want = Math.min(p.points, room);
      const list = [];
      for (let k = 0; k < want; k++) {
        if (!free.size && !enemy.size) break;
        let pool;
        if (enemy.size && (!free.size || this.rng() < 0.75)) pool = enemy; else pool = free;
        const arr = Array.from(pool);
        const idx = arr[Math.floor(this.rng() * arr.length)];
        pool.delete(idx); chosen.add(idx); list.push(idx);
        anyNeighbor(idx, (n) => { add(n); return false; });
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
      this.name = opts.name || this.id;
      this.game = new Game(opts);
      this.sends = new Map();       // pid -> send(obj)
      this.emptyTicks = 0;
    }
    welcomeFor(pid, token) {
      return { t: 'welcome', you: pid, token: token, room: this.id, roomName: this.name, cfg: this.game.publicCfg() };
    }
    sendFlags(send) { const f = this.game.flagsFor(null); if (Object.keys(f).length) send({ t: 'flags', f: f }); }
    join(send, msg) {
      const r = this.game.addPlayer({ name: msg && msg.name, color: msg && msg.color, flag: msg && msg.flag }, false);
      if (!r.ok) return r;
      this.sends.set(r.pid, send);
      send(this.welcomeFor(r.pid, r.token));
      this.sendFlags(send);
      const mine = this.game.flagsFor([r.pid]);
      if (mine[r.pid]) for (const [pid, s] of this.sends) if (pid !== r.pid) s({ t: 'flags', f: mine });
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
      this.sendFlags(send);
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
    // gerçek zaman ilerletme: fetih ilerlemesi (ms hassasiyeti) + saniyelik tick
    advance(ms) {
      const g = this.game;
      const before = g.tickCount;
      g.advance(ms);
      if (g.tickCount !== before) this.emptyTicks = (g.connectedHumans() === 0) ? this.emptyTicks + (g.tickCount - before) : 0;
      this.flush();
    }
    tick() { this.advance(1000); }
    flush() {
      const items = this.game.drain();
      for (const it of items) {
        if (it.to === 'all') { for (const send of this.sends.values()) send(it.msg); }
        else { const s = this.sends.get(it.to); if (s) s(it.msg); }
      }
    }
    drainSuspects() { const a = Array.from(this.game.suspects); this.game.suspects.clear(); return a; }
    info() { return Object.assign({ id: this.id, name: this.name }, this.game.info()); }
    isFinished() {
      const g = this.game;
      if (g.phase === 'ENDED' && g.overTimer <= 0) return true;
      if (g.phase === 'LOBBY') return g.humanCount() === 0;
      return this.emptyTicks >= g.cfg.EMPTY_ROOM_SECONDS;
    }
  }

  return {
    PROTOCOL, CONFIG, PALETTE, PALETTE_HEX, SEA_COLOR, LAND_COLOR, MAP_DATA, MAP_HASH, ROWS, COLS, N, LAND_MASK, DIRS8,
    FLAG_W, FLAG_H, FLAG_B64_LEN, REJECT_TEXT, Game, Room, captureCheck, adjacentOwned, anyNeighbor, rleEncode, rleDecode,
    freshGrid, sanitizeName, sanitizeChat, normalizeColor, hexToRgb, colorDistance, pairKey, mulberry32, hash32, gridHash,
    validateFlag, isBlueish, hslToHex, cheb, expansionRate
  };
});
    
