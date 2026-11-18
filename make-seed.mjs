// =====================================================================
// IMPORT EXCEL -> src/seed.json   (dijalankan di komputer Anda, tanpa npm install)
//
//   node scripts/make-seed.mjs            membuat/memperbarui src/seed.json
//   node scripts/make-seed.mjs --reset    juga mengembalikan SEMUA password ke password Excel
//
// Membaca:  "DATA PMR GEN 10.xlsx" (anggota)  dan  "admin piket.xlsx" (admin)
//           (nama dengan spasi maupun underscore diterima; dicari di folder project,
//            ./data dan ./import)
// Hasil seed.json hanya berisi HASH password (bukan password asli).
// Saat Worker dijalankan pertama kali setelah deploy, isi seed.json masuk ke database D1.
// Akun yang sudah ada TIDAK ditimpa passwordnya (kecuali --reset), jadi password baru
// yang dibuat anggota tidak hilang saat Anda menambah anggota.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ITERASI = 50000; // HARUS sama dengan PBKDF2_ITER di src/worker.js
const reset = process.argv.includes('--reset');

// ---------- pembaca .xlsx sederhana (tanpa library) ----------
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('bukan file .xlsx yang valid');
  const jumlah = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < jumlah; i++) {
    const metode = buf.readUInt16LE(p + 10), ukuran = buf.readUInt32LE(p + 20);
    const nLen = buf.readUInt16LE(p + 28), eLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const nama = buf.toString('utf8', p + 46, p + 46 + nLen);
    const mulai = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(mulai, mulai + ukuran);
    files.set(nama, metode === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nLen + eLen + cLen;
  }
  return files;
}
const dekode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
});
const teksDalam = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => dekode(m[1])).join('');
const kolom = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Mengembalikan baris-baris sheet PERTAMA sebagai array of array string
function bacaXlsx(file) {
  const z = unzip(fs.readFileSync(file));
  const ambil = (n) => (z.get(n) ? z.get(n).toString('utf8') : '');
  const shared = [...ambil('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => teksDalam(m[1]));
  const rid = ambil('xl/workbook.xml').match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  let target = 'worksheets/sheet1.xml';
  for (const m of ambil('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    if (m[0].includes(`Id="${rid}"`)) target = m[0].match(/Target="([^"]+)"/)[1].replace(/^\/?(xl\/)?/, '');
  }
  const sheet = ambil('xl/' + target);
  if (!sheet) throw new Error('worksheet tidak ditemukan');
  const rows = [];
  for (const r of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const baris = [];
    for (const c of (r[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = c[1], isi = c[2] || '';
      const idx = kolom(attr.match(/\br="([A-Z]+\d+)"/)[1]);
      const tipe = attr.match(/\bt="([^"]+)"/)?.[1];
      let v = '';
      if (tipe === 's') v = shared[Number(isi.match(/<v>([\s\S]*?)<\/v>/)?.[1])] ?? '';
      else if (tipe === 'inlineStr') v = teksDalam(isi);
      else v = dekode(isi.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      baris[idx] = v;
    }
    rows.push(Array.from(baris, (x) => x ?? ''));
  }
  return rows;
}

// ---------- cari file ----------
function cariFile(...nama) {
  for (const dir of ['.', 'data', 'import'])
    for (const n of nama) { const f = path.join(root, dir, n); if (fs.existsSync(f)) return f; }
  throw new Error('File tidak ditemukan: ' + nama.join(' / ') + '  (letakkan di folder project)');
}
// Ubah baris -> objek dengan nama kolom (huruf kecil, tanpa spasi tepi)
function tabel(file, wajib) {
  const [kepala, ...data] = bacaXlsx(file);
  const nama = (kepala || []).map((k) => String(k).trim().toLowerCase());
  const hilang = wajib.filter((w) => !nama.includes(w));
  if (hilang.length) throw new Error(`${path.basename(file)}: kolom tidak ditemukan: ${hilang.join(', ')} (kolom yang ada: ${nama.filter(Boolean).join(', ')})`);
  return data.map((r) => Object.fromEntries(nama.map((n, i) => [n, String(r[i] ?? '').trim()])));
}

const hash = (pw) => {
  const salt = crypto.randomBytes(16);
  const h = crypto.pbkdf2Sync(pw, salt, ITERASI, 32, 'sha256');
  return `pbkdf2$${ITERASI}$${salt.toString('base64')}$${h.toString('base64')}`;
};
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

try {
  // ----- anggota -----
  const fAnggota = cariFile('DATA PMR GEN 10.xlsx', 'DATA_PMR_GEN_10.xlsx');
  const anggota = tabel(fAnggota, ['nama anggota', 'username', 'password awal']).filter((r) => r['username']);
  const peta = JSON.parse(fs.readFileSync(path.join(root, 'scripts/nama-panggilan.json'), 'utf8'));
  const namaKePanggilan = new Map(Object.entries(peta).filter(([k, v]) => !k.startsWith('_') && v).map(([k, v]) => [norm(v), k]));

  const users = [], dipakai = new Set(), username = new Set();
  for (const r of anggota) {
    const u = r['username'].toLowerCase();
    if (username.has(u)) throw new Error('Username ganda di Excel: ' + u);
    if (!r['password awal']) throw new Error('Password awal kosong untuk username ' + u);
    username.add(u);
    const nick = namaKePanggilan.get(norm(r['nama anggota'])) ?? null;
    if (nick) dipakai.add(nick);
    users.push({ username: u, full_name: r['nama anggota'], nickname: nick, role: 'member', hash: hash(r['password awal']) });
  }

  // ----- admin -----
  const fAdmin = cariFile('admin piket.xlsx', 'admin_piket.xlsx');
  const admin = tabel(fAdmin, ['username admin', 'password admin']).filter((r) => r['username admin']);
  if (!admin.length) throw new Error('Tidak ada akun admin di ' + path.basename(fAdmin));
  for (const r of admin) {
    const u = r['username admin'].toLowerCase();
    if (username.has(u)) throw new Error('Username admin sama dengan username anggota: ' + u);
    if (!r['password admin']) throw new Error('Password admin kosong untuk ' + u);
    username.add(u);
    users.push({ username: u, full_name: 'Admin', nickname: null, role: 'admin', hash: hash(r['password admin']) });
  }

  // ----- jadwal -----
  const jadwal = JSON.parse(fs.readFileSync(path.join(root, 'scripts/jadwal.json'), 'utf8'));
  const schedule = [];
  for (const [hari, sesi] of Object.entries(jadwal)) {
    if (hari.startsWith('_')) continue;
    for (const [s, daftar] of Object.entries(sesi)) for (const nickname of daftar) schedule.push({ nickname, day: Number(hari), session: s });
  }
  const tanpaAnggota = [...new Set(schedule.map((s) => s.nickname))].filter((n) => !dipakai.has(n));

  // versi = isi data (tanpa hash) supaya Worker hanya sinkron saat data benar-benar berubah
  const inti = JSON.stringify({ u: users.map(({ hash: _h, ...x }) => x), schedule, reset });
  const version = crypto.createHash('sha256').update(inti + (reset ? Date.now() : '')).digest('hex').slice(0, 16);

  fs.writeFileSync(path.join(root, 'src/seed.json'), JSON.stringify({ version, reset, users, schedule }, null, 1) + '\n');
  console.log(`Anggota : ${anggota.length} (dari ${path.basename(fAnggota)})`);
  console.log(`Admin   : ${admin.length} (dari ${path.basename(fAdmin)})`);
  console.log(`Jadwal  : ${schedule.length} baris`);
  console.log(`Terhubung ke jadwal: ${dipakai.size} dari ${new Set(schedule.map((s) => s.nickname)).size} nama panggilan`);
  if (tanpaAnggota.length) console.log('PERLU DIKONFIRMASI (belum cocok dengan Excel): ' + tanpaAnggota.join(', '));
  console.log('Tersimpan: src/seed.json' + (reset ? '  (mode --reset: semua password dikembalikan ke Excel saat deploy)' : ''));
} catch (e) {
  console.error('GAGAL membaca Excel: ' + e.message);
  process.exit(1);
}
