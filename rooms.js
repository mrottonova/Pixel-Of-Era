'use strict';
/* ============================================================================
 *  ODA HAVUZU (Auto-Pool) — RoomManager
 *  ----------------------------------------------------------------------------
 *  Mod 'lobby' : 15 kişilik standart lobi  (Oda #1, Oda #2 ...)
 *                15. oyuncu girince 20 sn geri sayım, bitince oyun başlar.
 *  Mod 'duel'  : 2 kişilik hızlı maç (Düello #1 ...)
 *                2. oyuncu girince 5 sn geri sayım, bitince oyun başlar. Bot yok.
 *
 *  Kurallar:
 *   - Her modda "katılınabilir" (LOBBY fazında ve boş yeri olan) oda sayısı HER ZAMAN
 *     en az hedef kadardır (lobby: 5, duel: 2). Bir oda dolduğu / başladığı AN yenisi açılır.
 *   - Oyun başlayan oda (phase != LOBBY) listeden anında kaybolur (list() yalnızca LOBBY döner).
 *   - Dolu ama henüz başlamamış oda (geri sayımda) listede "DOLU + geri sayım" olarak kalır.
 *   - Boş odalar kalıcıdır (core'un "boş lobi = biten oda" kuralı burada devre dışı).
 *   - Fazla boş oda hedefin üstüne çıkarsa en yeni boşlar silinir (sınırsız büyüme yok).
 * ========================================================================== */
const crypto = require('crypto');

const NO_BOTS = 1e9; // LOBBY_WAIT_SECONDS bu değerse "bot doldurma yok" demektir (istemci de böyle okur)

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}

function defaultKinds() {
  const lobbySize = envInt('LOBBY_SIZE', 15, 2, 20);
  const botFill = envInt('LOBBY_BOT_FILL_SECONDS', 90, 0, 3600); // 0 = bot yok
  return {
    lobby: {
      kind: 'lobby', idPrefix: 'l', label: 'Oda', pool: envInt('LOBBY_POOL_SIZE', 5, 1, 50),
      config: {
        MIN_PLAYERS: lobbySize, MAX_PLAYERS: lobbySize, BOT_FILL_TO: lobbySize,
        LOBBY_COUNTDOWN: envInt('LOBBY_COUNTDOWN', 20, 1, 120),
        LOBBY_WAIT_SECONDS: botFill > 0 ? botFill : NO_BOTS
      }
    },
    duel: {
      kind: 'duel', idPrefix: 'd', label: 'Düello', pool: envInt('DUEL_POOL_SIZE', 2, 1, 20),
      config: {
        MIN_PLAYERS: 2, MAX_PLAYERS: 2, BOT_FILL_TO: 2,
        LOBBY_COUNTDOWN: envInt('DUEL_COUNTDOWN', 5, 1, 60),
        LOBBY_WAIT_SECONDS: NO_BOTS,       // düelloda bot yok: gerçek rakip beklenir
        WAR_PROTECTION_ROUNDS: 2,          // hızlı maç: ilk 2 tur koruma (60 sn)
        EXP_REWARDS: [30, 0]               // kazanan 30 EXP, kaybeden 0 (EXP çiftliği engeli)
      }
    }
  };
}

class RoomManager {
  /**
   * @param {object} core   core.js (PXCore)
   * @param {object} [opts] { kinds, maxRooms, log, onChange }
   */
  constructor(core, opts) {
    opts = opts || {};
    this.core = core;
    this.kinds = opts.kinds || defaultKinds();
    this.maxRooms = opts.maxRooms || envInt('MAX_ROOMS', 200, 10, 5000);
    this.log = opts.log || function () { };
    this.onChange = opts.onChange || function () { };
    this.rooms = new Map();            // id -> entry
    this.counters = { lobby: 0, duel: 0 };
    this.seqs = new Map();             // roomId -> Map(pid -> son seq)  (anti-replay)
    this.ensurePool();
  }

  /* ------------------------------------------------------------ oda yaşam döngüsü */
  genToken() { return crypto.randomBytes(16).toString('hex'); }

  createRoom(kindName) {
    const k = this.kinds[kindName];
    if (!k) return null;
    if (this.rooms.size >= this.maxRooms) { this.log('oda sınırı doldu (' + this.maxRooms + ')'); return null; }
    const n = ++this.counters[kindName];
    const id = k.idPrefix + n;
    const room = new this.core.Room({
      id: id, name: k.label + ' #' + n,
      config: Object.assign({}, k.config),
      genToken: () => this.genToken()
    });
    const entry = { id: id, kind: kindName, n: n, room: room, createdAt: Date.now() };
    this.rooms.set(id, entry);
    this.seqs.set(id, new Map());
    this.log('oda açıldı: ' + room.name);
    return entry;
  }

  isJoinable(e) {
    const g = e.room.game;
    return g.phase === 'LOBBY' && g.players.size < g.cfg.MAX_PLAYERS;
  }
  joinableOf(kindName) {
    return Array.from(this.rooms.values()).filter(e => e.kind === kindName && this.isJoinable(e));
  }

  /** Her modda katılınabilir oda sayısını hedefe tamamlar; fazla BOŞ odaları budar. */
  ensurePool() {
    let changed = false;
    for (const kindName of Object.keys(this.kinds)) {
      const target = this.kinds[kindName].pool;
      let open = this.joinableOf(kindName);
      while (open.length < target) {
        const e = this.createRoom(kindName);
        if (!e) break;
        open.push(e); changed = true;
      }
      if (open.length > target) {
        const empties = open.filter(e => e.room.game.players.size === 0).sort((a, b) => b.n - a.n);
        let extra = open.length - target;
        for (const e of empties) { if (extra <= 0) break; this.removeRoom(e.id, 'prune'); extra--; changed = true; }
      }
    }
    if (changed) this.onChange();
    return changed;
  }

  removeRoom(id, why) {
    const e = this.rooms.get(id);
    if (!e) return;
    try { for (const send of e.room.sends.values()) send({ t: 'room_closed' }); } catch (err) { /* */ }
    this.rooms.delete(id);
    this.seqs.delete(id);
    this.log('oda kapandı: ' + e.room.name + ' (' + (why || '') + ')');
    if (this.onRoomRemoved) this.onRoomRemoved(e, why);
  }

  /* ---------------------------------------------------------------- katılım */
  /** Hedef odayı seçer: istenen oda katılınabilirse o; değilse aynı modun en dolu lobisi. */
  pick(kindName, roomId) {
    let kind = (kindName === 'duel' || kindName === 'lobby') ? kindName : null;
    if (typeof roomId === 'string' && roomId) {
      const e = this.rooms.get(roomId);
      if (e) { if (this.isJoinable(e)) return e; kind = e.kind; }   // yarış durumu: doldu/başladı -> aynı moddan başka oda
    }
    kind = kind || 'lobby';
    let list = this.joinableOf(kind);
    if (!list.length) { this.ensurePool(); list = this.joinableOf(kind); }
    if (!list.length) return null;
    list.sort((a, b) => (b.room.game.players.size - a.room.game.players.size) || (a.n - b.n)); // en doluya (hızlı başlasın)
    return list[0];
  }

  join(msg, send) {
    const e = this.pick(msg && msg.mode, msg && msg.room);
    if (!e) return { ok: false, code: 'no_room', text: 'Uygun oda bulunamadı. Biraz sonra tekrar dene.' };
    const r = e.room.join(send, { name: msg && msg.name, flag: msg && msg.flag });
    if (!r.ok) return r;
    this.ensurePool();
    this.onChange();
    return { ok: true, entry: e, pid: r.pid, token: r.token };
  }

  resume(token, send) {
    for (const e of this.rooms.values()) {
      if (!e.room.findByToken(token)) continue;
      const r = e.room.resume(token, send);
      if (!r.ok) return r;
      this.onChange();
      return { ok: true, entry: e, pid: r.pid, token: r.token };
    }
    return { ok: false, code: 'resume_failed', text: 'Oturum bulunamadı veya süresi doldu.' };
  }

  /** Oyuncu ayrıldı (kasıtlı 'leave'): lobide listeden çıkar, oyundaysa bağlantısız say. */
  leave(entry, pid, send) {
    if (!this.rooms.has(entry.id)) return;
    entry.room.game.removePlayer(pid);
    entry.room.detach(pid, send);
    this.afterChange(entry);
  }
  /** Bağlantı koptu (kasıtsız): lobide oyuncu düşer, oyunda yeniden bağlanabilir kalır. */
  disconnect(entry, pid, send) {
    if (!this.rooms.has(entry.id)) return;
    entry.room.detach(pid, send);
    this.afterChange(entry);
  }
  afterChange(entry) {
    if (entry && entry.room.game.phase === 'LOBBY' && entry.room.game.players.size === 0) entry.room.game.lobbyElapsed = 0;
    this.ensurePool();
    this.onChange();
  }

  /** anti-replay: istemci sıra numarası geriye gidemez */
  checkSeq(entry, pid, seq) {
    if (seq === undefined) return true;
    if (!Number.isInteger(seq) || seq < 1) return false;
    const m = this.seqs.get(entry.id); if (!m) return false;
    const last = m.get(pid) || 0;
    if (seq <= last) return false;
    m.set(pid, seq); return true;
  }

  /* -------------------------------------------------------------- zaman akışı */
  /** ms kadar ilerlet. Başlayan/biten odaları yakalar, havuzu tamamlar. Değişim varsa true. */
  advance(ms) {
    let dirty = false;
    const kicked = [];
    for (const e of Array.from(this.rooms.values())) {
      const g = e.room.game;
      const phaseBefore = g.phase, sizeBefore = g.players.size, cdBefore = g.countdown;
      e.room.advance(ms);
      if (g.phase === 'LOBBY' && g.players.size === 0) g.lobbyElapsed = 0;
      if (g.phase !== phaseBefore) { dirty = true; this.log(e.room.name + ': ' + phaseBefore + ' -> ' + g.phase); }
      if (g.players.size !== sizeBefore || g.countdown !== cdBefore) dirty = true;
      for (const pid of e.room.drainSuspects()) kicked.push({ entry: e, pid: pid });
      if (this.isFinished(e)) { this.removeRoom(e.id, 'bitti'); dirty = true; }
    }
    if (this.ensurePool()) dirty = true;
    if (dirty) this.onChange();
    return kicked;
  }

  /* core'un isFinished()'inden farkı: boş LOBBY havuz odası ASLA bitmiş sayılmaz. */
  isFinished(e) {
    const g = e.room.game;
    if (g.phase === 'LOBBY') return false;
    return e.room.isFinished();
  }

  /* ------------------------------------------------------------------ liste */
  /** Yalnızca LOBBY fazındaki odalar. Başlayan oda burada YOKTUR. */
  list() {
    const out = [];
    for (const e of this.rooms.values()) {
      const g = e.room.game;
      if (g.phase !== 'LOBBY') continue;
      const noBots = g.cfg.LOBBY_WAIT_SECONDS >= NO_BOTS;
      out.push({
        id: e.id, name: e.room.name, kind: e.kind, phase: 'LOBBY',
        players: g.players.size, max: g.cfg.MAX_PLAYERS, humans: g.humanCount(), bots: g.players.size - g.humanCount(),
        countdown: g.countdown, wait: (noBots || g.players.size === 0) ? null : Math.max(0, g.cfg.LOBBY_WAIT_SECONDS - g.lobbyElapsed),
        round: 0
      });
    }
    out.sort((a, b) => (a.kind === b.kind ? a.id.slice(1) - b.id.slice(1) : (a.kind === 'lobby' ? -1 : 1)));
    return out;
  }
  stats() {
    let humans = 0, playing = 0;
    for (const e of this.rooms.values()) {
      humans += e.room.game.connectedHumans();
      if (e.room.game.phase !== 'LOBBY') playing++;
    }
    return { rooms: this.rooms.size, playing: playing, humans: humans };
  }
}

module.exports = { RoomManager, defaultKinds, NO_BOTS };
