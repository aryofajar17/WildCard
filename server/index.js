// ============================================================
// UNO Chips - Server (HTTP statis + WebSocket room)
// Mode online (kode ruang) & WiFi lokal/hotspot lewat server ini.
// ============================================================
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as uno from '../shared/uno.js';
import { botAction } from '../shared/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

// ---------- server statis ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // /shared/ dipetakan ke folder shared di root (engine dipakai bersama klien)
  const base = urlPath.startsWith('/shared/') ? ROOT : path.join(ROOT, 'public');
  const allowed = urlPath.startsWith('/shared/') ? path.join(ROOT, 'shared') : path.join(ROOT, 'public');
  const file = path.normalize(path.join(base, urlPath));
  if (!file.startsWith(allowed) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

// ---------- room ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function defaultSettings() {
  return {
    stacking: true, jumpIn: true, sevenZero: true, extreme: true,
    ante: 100, turnTime: 30, maxPlayers: 6, startingChips: 5000,
  };
}

class Room {
  constructor(hostSeat) {
    this.code = makeCode();
    this.hostSeat = 0;
    this.settings = defaultSettings();
    this.seats = [hostSeat]; // { token, name, chips, socket, isBot, connected, seat }
    this.game = null;
    this.turnTimer = null;
    this.botTimer = null;
    this.closeTimer = null;
  }

  freeSeatIndex() {
    for (let i = 0; i < this.settings.maxPlayers; i++) {
      if (!this.seats[i]) return i;
    }
    return -1;
  }

  seatCount() { return this.seats.filter(Boolean).length; }

  broadcast() {
    for (const s of this.seats) {
      if (!s || s.isBot || !s.socket) continue;
      if (this.game) {
        const view = uno.viewFor(this.game, s.seat);
        view.chips = this.seats.map((x) => (x ? x.chips : 0));
        view.settings = this.settings;
        view.now = Date.now();
        this.sendTo(s, view);
      } else {
        this.sendTo(s, this.lobbyView());
      }
    }
  }

  sendTo(seatObj, payload) {
    if (!seatObj.socket) return;
    try {
      seatObj.socket.send(JSON.stringify(payload));
    } catch { /* koneksi putus */ }
  }

  lobbyView() {
    return {
      t: 'lobby',
      code: this.code,
      hostSeat: this.hostSeat,
      settings: this.settings,
      seats: this.seats.map((s, i) => s && ({
        seat: i, name: s.name, chips: s.chips, isBot: s.isBot, connected: s.connected,
      })),
    };
  }

  // ---------- alur giliran ----------
  clearTimers() {
    clearTimeout(this.turnTimer); this.turnTimer = null;
    clearTimeout(this.botTimer); this.botTimer = null;
  }

  scheduleNext() {
    this.clearTimers();
    const g = this.game;
    if (!g || g.phase !== 'playing') { this.broadcast(); return; }

    const tt = this.settings.turnTime;
    g.turnDeadline = tt > 0 ? Date.now() + tt * 1000 : null;

    const cur = this.seats[g.turn];
    if (cur && cur.isBot) {
      this.botTimer = setTimeout(() => this.botStep(), 900 + Math.random() * 700);
      this.broadcast();
      return;
    }

    // jendela UNO terbuka: bot pemilik memanggil, bot lain menangkap manusia lalai
    if (g.unoPending !== null && Date.now() < g.unoDeadline) {
      const off = g.unoPending;
      const offSeat = this.seats[off];
      if (offSeat && offSeat.isBot) {
        setTimeout(() => {
          if (this.game && this.game.unoPending === off) {
            uno.applyAction(this.game, off, { t: 'uno' });
            this.afterAction();
          }
        }, 700 + Math.random() * 500);
      } else {
        const catcher = this.seats.find((s, i) => s && s.isBot && i !== off);
        if (catcher) {
          setTimeout(() => {
            if (this.game && this.game.unoPending === off) {
              uno.applyAction(this.game, catcher.seat, { t: 'catch', target: off });
              this.afterAction();
            }
          }, 1200 + Math.random() * 800);
        }
      }
    }

    if (tt > 0) {
      this.turnTimer = setTimeout(() => this.forceAction(), tt * 1000);
    }
    this.broadcast();
  }

  // manusia kehabisan waktu -> otomatis ambil kartu / tukar acak
  forceAction() {
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    const L = uno.legalMoves(g, g.turn);
    if (L.canUno) uno.applyAction(g, g.turn, { t: 'uno' });
    if (g.awaiting === 'seven') {
      const targets = uno.legalMoves(g, g.turn).canChooseSwap;
      if (targets && targets.length) {
        uno.applyAction(g, g.turn, { t: 'swap', target: targets[Math.floor(Math.random() * targets.length)] });
      }
      this.afterAction();
      return;
    }
    uno.applyAction(g, g.turn, { t: 'draw' });
    if (this.game.awaiting === 'draw-keep') uno.applyAction(g, g.turn, { t: 'keep' });
    this.afterAction();
  }

  botStep() {
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    const seat = g.turn;
    const act = botAction(g, seat);
    if (act) uno.applyAction(g, seat, act);
    this.afterAction();
  }

  afterAction() {
    const g = this.game;
    if (!g) return;
    if (g.phase === 'roundEnd') {
      this.clearTimers();
      this.settleChips();
      this.broadcast();
      return;
    }
    // bot mungkin masih punya giliran (satu meja penuh bot) -> lanjutkan
    this.scheduleNext();
  }

  settleChips() {
    const g = this.game;
    const w = this.seats[g.winner];
    if (!w) return;
    const ante = this.settings.ante;
    const deltas = new Array(this.seats.length).fill(0);
    let pot = 0;
    for (const s of this.seats) {
      if (!s || s.seat === w.seat) continue;
      const pay = Math.min(ante, s.chips);
      s.chips -= pay;
      pot += pay;
      deltas[s.seat] = -pay;
    }
    w.chips += pot;
    deltas[w.seat] = pot;
    g.log.push(`🏆 ${w.name} memenangkan pot ${pot} chip!`);
    g.deltas = deltas; // dikirim ke semua klien lewat view
  }

  startGame() {
    if (this.seatCount() < 2) return false;
    const players = this.seats.map((s) => s && ({ name: s.name, isBot: s.isBot, token: s.token }));
    this.game = uno.newGame({ players });
    uno.startRound(this.game);
    this.lastDeltas = null;
    this.scheduleNext();
    return true;
  }

  nextRound() {
    if (!this.game || this.game.phase !== 'roundEnd') return;
    uno.startRound(this.game);
    this.lastDeltas = null;
    this.scheduleNext();
  }

  destroy() {
    this.clearTimers();
    clearTimeout(this.closeTimer);
    rooms.delete(this.code);
  }
}

function getOrCreateSeat(room, { name, chips, token, isBot = false, socket = null }) {
  // reconnect dengan token
  if (token) {
    const existing = room.seats.find((s) => s && s.token === token);
    if (existing) {
      existing.socket = socket;
      existing.connected = true;
      if (!isBot) existing.name = name || existing.name;
      return existing;
    }
  }
  const idx = room.freeSeatIndex();
  if (idx < 0) return null;
  const seat = {
    seat: idx, token: token || ('tk_' + Math.random().toString(36).slice(2, 12)),
    name: name || 'Pemain' + (idx + 1), chips: Number.isFinite(chips) ? chips : room.settings.startingChips,
    socket, isBot, connected: true,
  };
  room.seats[idx] = seat;
  return seat;
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let bound = null; // { room, seat }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    if (!bound) return;
    const { room, seat } = bound;
    seat.socket = null;
    seat.connected = false;
    if (room.game) {
      room.broadcast();
      room.scheduleNext(); // timer tetap jalan; disconnected akan di-auto draw
    }
    // hapus room kalau kosong
    clearTimeout(room.closeTimer);
    room.closeTimer = setTimeout(() => {
      const alive = room.seats.some((s) => s && s.connected);
      if (!alive) room.destroy();
    }, 60_000);
  });

  function handle(ws2, msg) {
    const reply = (payload) => { try { ws2.send(JSON.stringify(payload)); } catch { } };

    switch (msg.t) {
      case 'create': {
        const room = new Room(null);
        const seat = getOrCreateSeat(room, {
          name: msg.name, chips: msg.chips, token: msg.token, socket: ws2,
        });
        room.hostSeat = seat.seat;
        rooms.set(room.code, room);
        if (msg.settings) Object.assign(room.settings, msg.settings);
        bound = { room, seat };
        reply({ t: 'joined', token: seat.token, seat: seat.seat });
        room.broadcast();
        break;
      }
      case 'join': {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room) { reply({ t: 'err', msg: 'Ruang tidak ditemukan' }); break; }
        const seat = getOrCreateSeat(room, {
          name: msg.name, chips: msg.chips, token: msg.token, socket: ws2,
        });
        if (!seat) { reply({ t: 'err', msg: 'Ruang penuh' }); break; }
        bound = { room, seat };
        reply({ t: 'joined', token: seat.token, seat: seat.seat });
        room.broadcast();
        break;
      }
      default: {
        if (!bound) return;
        const { room, seat } = bound;
        const g = room.game;

        switch (msg.t) {
          case 'settings':
            if (seat.seat !== room.hostSeat || (g && g.phase === 'playing')) return;
            Object.assign(room.settings, msg.patch || {});
            room.broadcast();
            break;
          case 'addBot': {
            if (seat.seat !== room.hostSeat || room.game) return;
            const n = room.seats.filter(Boolean).length;
            getOrCreateSeat(room, { name: `Bot ${n}`, isBot: true });
            room.broadcast();
            break;
          }
          case 'kick':
            if (seat.seat !== room.hostSeat || room.game) return;
            if (msg.seat !== undefined && room.seats[msg.seat] && !room.seats[msg.seat].isBot) {
              room.seats[msg.seat].socket = null;
              room.seats[msg.seat] = null;
              room.broadcast();
            }
            break;
          case 'start':
            if (seat.seat !== room.hostSeat) return;
            if (!room.startGame()) reply({ t: 'err', msg: 'Minimal 2 pemain (tambah bot bila kurang)' });
            break;
          case 'next':
            if (seat.seat !== room.hostSeat) return;
            room.nextRound();
            break;
          case 'action': {
            if (!g || g.phase !== 'playing') return;
            if (g.turn !== seat.seat && !isPassiveAction(msg.action)) return;
            uno.applyAction(g, seat.seat, msg.action);
            room.afterAction();
            break;
          }
          case 'leave':
            room.seats[seat.seat] = null;
            bound = null;
            room.broadcast();
            break;
        }
      }
    }
  }

  function isPassiveAction(a) {
    return a && (a.t === 'catch' || a.t === 'uno' || a.t === 'jump');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  UNO CHIPS — server siap!');
  console.log('========================================');
  console.log(`Komputer ini     : http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`HP di WiFi sama  : http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('----------------------------------------');
  console.log('Mode WiFi lokal/hotspot: jalankan server ini,');
  console.log('lalu buka alamat "HP di WiFi sama" di browser teman-temanmu.');
});
