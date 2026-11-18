# Absen Piket PMR – SMK N 2 Pati (versi Cloudflare)

Cloudflare Worker (API) + D1 (database) + R2 (foto bukti) + HTML/CSS/JS biasa.
Tidak ada Supabase, tidak ada `config.js`, tidak ada URL/kunci database yang perlu diisi.

```
wrangler.jsonc        konfigurasi Cloudflare (binding D1 & R2) - tidak perlu diubah
package.json          hanya berisi wrangler
public/               halaman web: index.html, style.css, app.js, _headers
src/worker.js         seluruh backend (login, jadwal, absen, foto, admin)
src/seed.json         data awal hasil import Excel (berisi HASH password, bukan password asli)
scripts/              make-seed.mjs (Excel -> seed.json), jadwal.json, nama-panggilan.json
schema.sql            referensi struktur tabel (dibuat otomatis oleh Worker)
```

## Deploy paling singkat (GitHub → Cloudflare)

1. **Hapus file lama dari repository** (versi Supabase), jika ada: folder `web/`, `supabase/`, `import/`, file `build-config.js`, `config.js`. Lalu upload isi folder ini ke repository (file Excel Anda biarkan di tempatnya).
2. **Aktifkan R2 sekali saja:** Cloudflare Dashboard → *Storage & databases* → *R2* → aktifkan. (Cloudflare bisa meminta metode pembayaran; paket gratis R2 sudah cukup.)
3. Dashboard → *Workers & Pages* → *Create* → *Import a repository* → pilih repository. **Nama proyek harus `absen-piket-pmr`** (sama dengan `name` di `wrangler.jsonc`). Biarkan *Deploy command* bawaan (`npx wrangler deploy`) → *Save and Deploy*.

Saat deploy, Cloudflare membuat sendiri database D1 `absen-piket-db` dan bucket R2 `absen-piket-bukti`. Saat website pertama kali dibuka, Worker membuat tabel dan memasukkan semua akun serta jadwal dari `src/seed.json`. Tidak ada langkah import manual. Alamat: `https://absen-piket-pmr.<akun-anda>.workers.dev` — halaman admin: tambahkan `/#/admin`.

Jika pembuatan otomatis gagal, buat manual lalu deploy ulang:
`npx wrangler d1 create absen-piket-db` dan `npx wrangler r2 bucket create absen-piket-bukti`.

## Import data Excel (anggota & admin)

Data awal sudah dibuat dari file Excel Anda (23 anggota + 1 admin, 23 nama jadwal semuanya terhubung).
Jika Excel diubah (tambah anggota, dll.), jalankan di komputer Anda (butuh Node.js, tanpa `npm install`):

```
node scripts/make-seed.mjs          # membaca "DATA PMR GEN 10.xlsx" & "admin piket.xlsx"
git add -A && git commit -m "update data" && git push     # deploy otomatis
```
- Anggota baru ditambahkan. Akun yang sudah ada **tidak ditimpa passwordnya** (password baru buatan anggota aman).
- Ingin mengembalikan semua password ke Excel: `node scripts/make-seed.mjs --reset`, lalu push.
- Pencocokan nama panggilan jadwal ke nama lengkap ada di `scripts/nama-panggilan.json`; jadwal resmi di `scripts/jadwal.json`.
- Script hanya membaca file Excel; file Excel tidak ikut dibuka oleh website (hanya folder `public/` yang disajikan).

## Keamanan singkat
- Password disimpan sebagai hash PBKDF2-SHA256 (bukan teks biasa). Admin tidak bisa melihat password siapa pun.
- Login memakai cookie HttpOnly + Secure + SameSite=Strict; admin otomatis keluar setelah 8 jam, anggota 30 hari.
- Semua pemeriksaan (jadwal, absen ganda, foto wajib, hak admin) dilakukan di server (Worker), bukan hanya di tampilan. Mengetik `/#/admin` tidak memberi akses apa pun tanpa login admin.
- Foto di R2 (private) hanya bisa dibuka pemiliknya dan admin. Login dibatasi 10 percobaan gagal per 15 menit.
- **Repository sebaiknya PRIVATE**: file Excel berisi password awal dalam teks biasa.
- Paket Workers gratis membatasi CPU 10 ms per permintaan, sehingga hash memakai 50.000 iterasi (batas Cloudflare 100.000). Jika memakai paket berbayar, naikkan `PBKDF2_ITER` di `src/worker.js` dan `ITERASI` di `scripts/make-seed.mjs` ke 100000.

## Kamera
Kamera hanya jalan di HTTPS; alamat `*.workers.dev` sudah HTTPS. Saat pertama kali menekan **Ambil Foto Bukti**, browser meminta izin kamera: pilih *Izinkan*. Foto dikecilkan di HP (maks. 960 px) sebelum dikirim.
