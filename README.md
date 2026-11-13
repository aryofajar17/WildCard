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
npm start        # atau: klik start-server.bat (Windows, auto-restart)
```

> **Penting untuk main WiFi**: gunakan `start-server.bat` dan biarkan jendelanya terbuka —
> server mati = semua ruang hilang dan HP teman tidak bisa konek (penyebab paling sering).

Server otomatis mencetak alamat yang bisa dibuka:

```
Komputer ini     : http://localhost:3000
HP di WiFi sama  : http://192.168.x.x:3000
```

### Main via WiFi lokal / hotspot (tanpa internet)
1. Jalankan **`start-server.bat`** (Windows, cara paling mudah) atau `npm start` di salah satu laptop/PC.
   - `start-server.bat` otomatis membuka browser dan **menyalakan ulang server** kalau crash.
   - **Biarkan jendela hitamnya terbuka** — menutupnya = mematikan server.
2. Sambungkan semua HP ke WiFi/hotspot yang sama.
3. Di lobby, **scan QR code** yang tampil (atau buka alamat `http://192.168.x.x:3000` yang tercetak di console).
   QR sudah memuat kode ruang — teman tinggal isi nama → Gabung.
4. Kalau pemain kurang, tuan rumah bisa **Tambah Bot**.

#### HP tidak bisa connect? Cek urut ini:
| Gejala | Penyebab | Solusi |
|---|---|---|
| Halaman tidak terbuka sama sekali | **Server mati / terminal tertutup** | Jalankan `start-server.bat`, biarkan terbuka |
| Halaman tidak terbuka, server jalan | **Firewall Windows memblokir Node.js** | Saat server start, console memberi tahu. Jalankan perintah `netsh ...` yang dicetak di console (CMD as Administrator), sekali saja |
| Halaman tidak terbuka, firewall aman | Pakai **IP adapter virtual** (VirtualBox/WSL) | Pakai IP yang tercetak di console versi terbaru (adapter virtual sudah difilter). Di lobby ada QR — scan saja |
| Halaman terbuka tapi "Ruang tidak ditemukan" | HP buka alamat server yang **berbeda** / server di-restart | Semua harus buka alamat yang sama; server di-restart = ruang lama hilang, buat ruang baru |
| Halaman terbuka tapi tidak bisa apa-apa di hotspot HP | **AP isolation** (perangkat saling terisolasi) | Cek pengaturan hotspot; coba WiFi router biasa |
| "Tidak bisa terhubung ke server" muncul | koneksi WS gagal | sama dengan di atas — app kini menampilkan toast ini otomatis |

> Cek firewall: saat server start di Windows, console otomatis memeriksa apakah Node.exe sudah
> diizinkan dari jaringan. Kalau belum, perintah perbaikannya dicetak langsung di console.

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
