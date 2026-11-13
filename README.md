# 🃏 UNO Chips

Aplikasi mobile (PWA) untuk main UNO bareng teman dengan **chip virtual** — tanpa uang asli.
Satu server Node.js melayani tiga cara bermain:

| Mode | Cara main | Butuh internet? |
|---|---|---|
| 🏠 **Ruang kode** | Buat ruang → bagikan kode 4 huruf → teman gabung dari mana saja | Ya (server online) |
| 📶 **WiFi lokal / hotspot** | Semua buka alamat IP komputer host di satu jaringan | Tidak (LAN saja) |
| 🤖 **Latihan vs Bot** | Main solo melawan 1–4 bot, langsung di HP | Tidak (jalan di browser) |

## ⚙️ Aturan yang didukung

Semua bisa dinyalakan/dimatikan saat membuat ruang:

- **Standar UNO** — cocok warna/angka, Skip, Reverse, +2, Wild, +4, panggil "UNO!", tangkap pemain lupa UNO (kena 2 kartu)
- **Stacking +2/+4** — penalti bisa ditumpuk ke pemain berikutnya (mis. +2 di atas +2 jadi +4)
- **Jump-in** — mainkan kartu *identik* dengan kartu atas walau bukan giliranmu
- **Aturan 7-0** — kartu **7** = tukar tangan dengan pemain pilihanmu; kartu **0** = semua tangan diputar searah
- **Kartu Ekstrem** 🎇
  - **+99** — penalti maut 99 kartu (tapi bisa ditumpuk +99 lain / dipantulkan)
  - **🛡 COUNTER** — kembalikan seluruh penalti ke pemain sebelumnya, dan bisa berantai balik!
  - Contoh: A mengeluarkan +99 → B memasang COUNTER → A kena 99 kartu → A bisa memasang COUNTER lagi → dst.

**Sistem chip**: setiap ronde semua pemain membayar *ante* ke pot, pemenang ronde mengambil semua.
Chip 100% virtual — bisa diisi ulang gratis kapan saja dari layar utama.

## 🚀 Menjalankan

Butuh [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Server otomatis mencetak alamat yang bisa dibuka:

```
Komputer ini     : http://localhost:3000
HP di WiFi sama  : http://192.168.x.x:3000
```

### Main via WiFi lokal / hotspot (tanpa internet)
1. Jalankan `npm start` di salah satu laptop/PC (atau HP yang bisa menjalankan Node).
2. Sambungkan semua HP ke WiFi/hotspot yang sama.
3. Semua buka alamat `http://192.168.x.x:3000` (tercetak di console server).
4. Satu orang **Buat Ruang** → bagikan kode → yang lain **Gabung Ruang**.
5. Kalau pemain kurang, tuan rumah bisa **Tambah Bot**.

> Tips Windows: kalau HP tidak bisa mengakses, izinkan Node.js di Windows Defender Firewall
> (Biasanya muncul dialog saat pertama kali menjalankan server — centang "Jaringan privat").

### Main online dengan teman jauh
Server ini perlu di-host agar bisa diakses dari internet. Pilihan mudah:
- **Render / Railway / Fly.io** — deploy repo ini langsung (set `PORT` sesuai platform, gratis untuk coba)
- **VPS / Raspberry Pi** — jalankan `npm start` di belakang reverse proxy (Caddy/Nginx) dengan HTTPS
- **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:3000` tanpa buka port

> Catatan: service worker PWA aktif di `localhost` atau HTTPS. Untuk testing lokal dengan HP,
> buka via IP HTTP biasa tetap bisa (mode online LAN), hanya fitur "install app" yang butuh HTTPS.

### Install sebagai aplikasi di HP (PWA)
Buka alamatnya di Chrome (Android) / Safari (iOS) → menu → **"Tambahkan ke layar utama"**.
Aplikasi akan terbuka layar penuh seperti aplikasi native. Mode vs Bot tetap jalan offline.

## 🧪 Uji yang sudah dilakukan

- 1000 game penuh bot-vs-bot (meja 2/4/6 pemain): 0 macet, semua ronde berakhir
- Game dengan simulasi manusia: 0 macet
- Mode online 2 tab: sinkron real-time, settlement chip (+100/-100), ronde berikutnya, host gating
- Guard anti-macet: ronde tanpa progres diakhiri otomatis (tangan terkecil menang)

## 📁 Struktur

```
server/index.js     — HTTP statis + WebSocket + room + timer giliran + bot
shared/uno.js       — engine permainan (dipakai server & browser)
shared/bot.js       — AI bot
public/             — PWA (index.html, css, js, manifest, service worker)
```

## ⚠️ Catatan penting

Chip di aplikasi ini murni virtual untuk hiburan — tidak ada, dan tidak bisa, ditukar dengan uang
asli. Aplikasi ini tidak memproses pembayaran apa pun.

Menguji dua pemain di satu PC: buka dua tab (identitas per-tab sudah terpisah), tapi ketik nama
berbeda di masing-masing tab sebelum membuat/masuk ruang.
