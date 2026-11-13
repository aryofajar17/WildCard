// ============================================================
// UNO Chips - Server (HTTP statis + WebSocket room)
// Mode online (kode ruang) & WiFi lokal/hotspot lewat server ini.
// ============================================================
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import * as uno from '../shared/uno.js';
import { botAction } from '../shared/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const MAX_MSG_BYTES = 64 * 1024;

// Biar satu error aneh tidak menjatuhkan seluruh server (semua ruang ikut mati).
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

// Alamat WiFi asli — buang adapter virtual (VirtualBox/WSL/Docker/VMware/Loopback dll)
// supaya pemilik PC tidak salah memberi IP ke temannya. Wi-Fi diprioritaskan di atas Ethernet.
function lanUrls() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vbox|vmware|hyper-v|wsl|docker|loopback|bluetooth/i.test(name)) continue;
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        out.push({ name, url: `http://${net.address}:${PORT}` });
      }
    }
  }
  out.sort((a, b) => {
    const w = (x) => (/wi-?fi|wireless|nirkabel/i.test(x.name) ? 0 : 1);
    return w(a) - w(b);
  });
  return out.map((x) => x.url);
}

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
const server = http.createServer(async (req, res) => {
  let urlPath;
  try {
    // URL dengan escape rusak (mis. GET /%) HARUS tidak mematikan server.
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  // QR code undangan (dipakai lobby untuk di-scan teman di WiFi yang sama)
  if (urlPath === '/qr') {
    const text = new URL(req.url, 'http://localhost').searchParams.get('text') || '';
    if (!text || text.length > 300) { res.writeHead(400); res.end('Bad text'); return; }
    try {
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      res.end(svg);
    } catch {
      res.writeHead(500); res.end('QR gagal');
    }
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  // /shared/ dipetakan ke folder shared di root (engine dipakai bersama klien)
  const isShared = urlPath === '/shared' || urlPath.startsWith('/shared/');
  const base = isShared ? ROOT : path.join(ROOT, 'public');
  const allowed = isShared ? path.join(ROOT, 'shared') : path.join(ROOT, 'public');
  const file = path.normalize(path.join(base, urlPath));
  // Cek path traversal dengan relative path (lebih aman dari startsWith biasa)
  const rel = path.relative(allowed, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  let info;
  try {
    info = statSync(file);
  } catch {
    res.writeHead(404); res.end('Not found'); return;
  }
  if (!info.isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(readFileSync(file));
});

// ---------- util ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function randomToken() { return randomBytes(9).toString('base64url'); }

function defaultSettings() {
  return {
    stacking: true, jumpIn: true, sevenZero: true, extreme: true,
    ante: 100, turnTime: 30, maxPlayers: 6, startingChips: 5000,
  };
}

const RULE_KEYS = ['stacking', 'jumpIn', 'sevenZero', 'extreme'];
const ACTION_TYPES = new Set(['play', 'jump', 'counter', 'swap', 'draw', 'keep', 'uno', 'catch']);

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

// Klien tidak dipercaya: hanya key yang dikenal, dengan tipe & rentang wajar.
function applySettings(target, patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const k of RULE_KEYS) if (typeof patch[k] === 'boolean') target[k] = patch[k];
  if ('ante' in patch) target.ante = clampInt(patch.ante, 0, 1_000_000, target.ante);
  if ('turnTime' in patch) target.turnTime = clampInt(patch.turnTime, 0, 600, target.turnTime);
  if ('maxPlayers' in patch) target.maxPlayers = clampInt(patch.maxPlayers, 2, 10, target.maxPlayers);
}

function cleanName(n, fallback) {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  return s || fallback;
}

class Room {
  constructor() {
    this.code = makeCode();
    this.hostSeat = 0;
    this.settings = defaultSettings();
    this.seats = []; // { token, name, chips, socket, isBot, connected, seat }
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

  // Buang "lubang" kursi supaya indeks kursi selalu sejajar dengan indeks pemain di
  // state permainan. Hanya boleh dipakai saat belum ada game yang jalan.
  compactSeats() {
    const kept = this.seats.filter(Boolean);
    if (kept.length === this.seats.length) return false;
    const prevHost = this.seats[this.hostSeat];
    this.seats = kept;
    kept.forEach((s, i) => { s.seat = i; });
    this.hostSeat = prevHost && kept.includes(prevHost) ? prevHost.seat : -1;
    // Nomor kursi klien ikut bergeser -> beri tahu mereka.
    for (const s of kept) if (s.socket) this.sendTo(s, { t: 'joined', token: s.token, seat: s.seat });
    this.reassignHost();
    return true;
  }

  // Pastikan selalu ada tuan rumah yang benar-benar terhubung (host kabur = ruang mati).
  reassignHost() {
    const cur = this.seats[this.hostSeat];
    if (cur && cur.connected && !cur.isBot) return;
    const next = this.seats.find((s) => s && s.connected && !s.isBot);
    if (next) this.hostSeat = next.seat;
    else if (cur) this.hostSeat = cur.seat;
  }

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
      lanUrls: lanUrls(), // untuk QR undangan di lobby
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
    if (this.game) return false; // jangan mulai ulang di tengah permainan
    this.compactSeats();         // buang lubang kursi dulu (kalau ada yang keluar)
    if (this.seatCount() < 2) return false;
    const players = this.seats.map((s) => ({ name: s.name, isBot: s.isBot, token: s.token }));
    this.game = uno.newGame({ players });
    uno.startRound(this.game);
    this.scheduleNext();
    return true;
  }

  nextRound() {
    if (!this.game || this.game.phase !== 'roundEnd') return;
    uno.startRound(this.game);
    this.scheduleNext();
  }

  destroy() {
    this.clearTimers();
    clearTimeout(this.closeTimer);
    rooms.delete(this.code);
  }
}

function getOrCreateSeat(room, { name, chips, token, isBot = false, socket = null }) {
  // reconnect/ambil alih kursi dengan token
  if (token) {
    const existing = room.seats.find((s) => s && s.token === token);
    if (existing) {
      // Tutup soket lama supaya satu kursi hanya dipegang satu koneksi.
      if (existing.socket && existing.socket !== socket) {
        try { existing.socket.close(); } catch { /* sudah mati */ }
      }
      existing.socket = socket;
      existing.connected = true;
      if (!isBot) existing.name = cleanName(name, existing.name);
      return existing;
    }
  }
  const idx = room.freeSeatIndex();
  if (idx < 0) return null;
  const seat = {
    seat: idx,
    token: token || ('tk_' + randomToken()),
    name: cleanName(name, 'Pemain' + (idx + 1)),
    chips: Number.isFinite(chips) ? Math.max(0, Math.min(1e9, Math.floor(chips))) : room.settings.startingChips,
    socket, isBot, connected: true,
  };
  room.seats[idx] = seat;
  return seat;
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

// Deteksi koneksi mati (mis. jaringan putus tanpa FIN) supaya kursi tidak "hantu".
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* sudah mati */ }
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws) => {
  let bound = null; // { room, seat }
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* jangan biarkan error soket menjatuhkan proses */ });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    try {
      handle(ws, msg);
    } catch (e) {
      console.error('kesalahan menangani pesan:', e?.message || e);
    }
  });

  ws.on('close', () => {
    if (!bound) return;
    const { room, seat } = bound;
    if (room.seats[seat.seat] === seat) {
      seat.socket = null;
      seat.connected = false;
    }
    room.reassignHost();
    room.broadcast();
    if (room.game && room.game.phase === 'playing') room.scheduleNext();
    // hapus room kalau kosong
    clearTimeout(room.closeTimer);
    room.closeTimer = setTimeout(() => {
      const alive = room.seats.some((s) => s && s.connected);
      if (!alive) room.destroy();
    }, 60_000);
  });

  function handle(ws2, msg) {
    const reply = (payload) => { try { ws2.send(JSON.stringify(payload)); } catch { /* putus */ } };

    switch (msg.t) {
      case 'create': {
        const room = new Room();
        const seat = getOrCreateSeat(room, {
          name: msg.name, chips: msg.chips, token: msg.token, socket: ws2,
        });
        if (!seat) { reply({ t: 'err', msg: 'Tidak bisa membuat ruang' }); break; }
        room.hostSeat = seat.seat;
        if (msg.settings) applySettings(room.settings, msg.settings);
        rooms.set(room.code, room);
        bound = { room, seat };
        reply({ t: 'joined', token: seat.token, seat: seat.seat });
        room.broadcast();
        break;
      }
      case 'join': {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room) { reply({ t: 'err', msg: 'Ruang tidak ditemukan' }); break; }
        const token = typeof msg.token === 'string' ? msg.token : null;
        const existing = token ? room.seats.find((s) => s && s.token === token) : null;
        // Jangan biarkan pemain baru "nyempil" di tengah permainan yang sudah jalan.
        if (room.game && !existing) { reply({ t: 'err', msg: 'Permainan sedang berjalan' }); break; }
        const seat = getOrCreateSeat(room, { name: msg.name, chips: msg.chips, token, socket: ws2 });
        if (!seat) { reply({ t: 'err', msg: 'Ruang penuh' }); break; }
        bound = { room, seat };
        room.reassignHost();
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
            if (seat.seat !== room.hostSeat || room.game) return;
            applySettings(room.settings, msg.patch);
            room.broadcast();
            break;
          case 'addBot': {
            if (seat.seat !== room.hostSeat || room.game) return;
            const n = room.seats.filter(Boolean).length;
            getOrCreateSeat(room, { name: `Bot ${n}`, isBot: true });
            room.broadcast();
            break;
          }
          case 'kick': {
            if (seat.seat !== room.hostSeat || room.game) return;
            const victim = room.seats[msg.seat];
            if (victim && !victim.isBot && victim !== seat) {
              if (victim.socket) {
                try {
                  victim.socket.send(JSON.stringify({ t: 'kicked', msg: 'Kamu dikeluarkan oleh tuan rumah' }));
                  victim.socket.close();
                } catch { /* sudah mati */ }
              }
              room.seats[victim.seat] = null;
              room.compactSeats();
              room.broadcast();
            }
            break;
          }
          case 'start':
            if (seat.seat !== room.hostSeat || room.game) return;
            if (!room.startGame()) reply({ t: 'err', msg: 'Minimal 2 pemain (tambah bot bila kurang)' });
            break;
          case 'next':
            if (seat.seat !== room.hostSeat) return;
            room.nextRound();
            break;
          case 'lobby':
            // Tuan rumah mengakhiri permainan: semua pemain kembali ke lobby yang sama.
            if (seat.seat !== room.hostSeat || !room.game) return;
            room.clearTimers();
            room.game = null;
            room.reassignHost();
            room.broadcast();
            break;
          case 'action': {
            const act = msg.action;
            if (!g || g.phase !== 'playing') return;
            if (!act || typeof act.t !== 'string' || !ACTION_TYPES.has(act.t)) return;
            if (seat.seat >= g.players.length) return;
            if (g.turn !== seat.seat && !isPassiveAction(act)) return;
            uno.applyAction(g, seat.seat, act);
            room.afterAction();
            break;
          }
          case 'leave': {
            if (room.seats[seat.seat] === seat) {
              if (g) {
                // Jangan sisakan lubang di tengah permainan: kursi ini lanjut sebagai bot
                // supaya ronde tetap bisa selesai wajar.
                seat.isBot = true;
                seat.connected = false;
                seat.socket = null;
                seat.token = null;
                const gp = g.players[seat.seat];
                if (gp) { gp.isBot = true; gp.name = `${gp.name} (bot)`; }
              } else {
                room.seats[seat.seat] = null;
                room.compactSeats();
              }
            }
            bound = null;
            room.reassignHost();
            room.broadcast();
            if (room.game && room.game.phase === 'playing') room.scheduleNext();
            break;
          }
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
  const urls = lanUrls();
  if (urls.length) {
    for (const u of urls) console.log(`HP di WiFi sama  : ${u}`);
  } else {
    console.log('(Tidak ada adapter WiFi/LAN terdeteksi — cek koneksi jaringan)');
  }
  console.log('----------------------------------------');
  console.log('Mode WiFi lokal/hotspot: jalankan server ini (atau start-server.bat),');
  console.log('lalu buka alamat "HP di WiFi sama" di browser teman-temanmu.');
  console.log('Di dalam lobby ada QR code — teman tinggal scan, tidak perlu ketik alamat.');

  // Windows: cek firewall Node.exe (penyebab #1 HP tidak bisa konek ke PC)
  if (process.platform === 'win32') {
    const ps = "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq '" +
      process.execPath.replace(/'/g, "''") +
      "' } | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' } | Measure-Object | Select-Object -ExpandProperty Count";
    exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 20_000 }, (err, stdout) => {
      const n = parseInt(String(stdout).trim(), 10);
      if (!err && n === 0) {
        console.log('');
        console.log('⚠  PENTING: Firewall Windows belum mengizinkan Node.exe diakses dari jaringan.');
        console.log('   HP temanmu kemungkinan TIDAK BISA membuka server ini.');
        console.log('   Jalankan SEKALI di Command Prompt (Run as Administrator):');
        console.log(`   netsh advfirewall firewall add rule name="UNO Chips" dir=in action=allow program="${process.execPath}" enable=yes`);
      }
    });
  }
});
