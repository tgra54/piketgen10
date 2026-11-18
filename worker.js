// =====================================================================
// ABSEN PIKET PMR - SMK N 2 PATI   |   Backend: Cloudflare Worker + D1 + R2
//
// Satu file untuk seluruh API (/api/...). Halaman web (folder public/) disajikan
// langsung oleh Cloudflare. Tidak ada konfigurasi yang perlu diisi: tabel dibuat dan
// data awal (dari src/seed.json, hasil import Excel) dimasukkan otomatis saat
// permintaan pertama.
// =====================================================================
import SEED from './seed.json';

// Iterasi PBKDF2. Cloudflare membatasi maksimum 100.000. Di paket Workers gratis (10 ms CPU/request)
// 50.000 masih muat; jika memakai paket berbayar boleh dinaikkan ke 100000.
// Nilai ini tersimpan di setiap hash, jadi mengubahnya tidak merusak password lama.
// (harus sama dengan ITERASI di scripts/make-seed.mjs untuk data awal)
const PBKDF2_ITER = 50000;
const SESI_ANGGOTA_MS = 30 * 24 * 3600 * 1000; // login anggota bertahan 30 hari
const SESI_ADMIN_MS = 8 * 3600 * 1000;         // login admin bertahan 8 jam
const MAKS_GAGAL = 10;                         // percobaan login gagal per 15 menit
const HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

// ---------- STRUKTUR DATABASE (dibuat otomatis; sama dengan schema.sql) ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL UNIQUE,
     full_name TEXT NOT NULL,
     nickname TEXT,
     role TEXT NOT NULL CHECK (role IN ('member','admin')),
     password_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS schedule (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     nickname TEXT NOT NULL,
     day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 5),
     session TEXT NOT NULL CHECK (session IN ('Pagi','Sore')),
     UNIQUE (nickname, day))`,
  `CREATE TABLE IF NOT EXISTS attendance (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id),
     username TEXT NOT NULL,
     full_name TEXT NOT NULL,
     att_date TEXT NOT NULL,
     day_name TEXT NOT NULL,
     session TEXT NOT NULL,
     att_time TEXT NOT NULL,
     photo_key TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'Sudah Absen',
     UNIQUE (user_id, att_date))`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_fail (key TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_login_fail ON login_fail (key, ts)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

// ---------- ALAT BANTU ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
const fail = (status, error) => json({ error }, status);

// Tanggal & hari menurut WIB (Asia/Jakarta)
const isoDow = (ymd) => ((new Date(ymd + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1; // 1=Senin ... 7=Minggu
function sekarangWIB() {
  const d = new Date();
  const date = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
  return { date, dow: isoDow(date), iso: d.toISOString() };
}

// ---------- PASSWORD (PBKDF2-SHA256, bawaan Web Crypto) ----------
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(pw, salt, PBKDF2_ITER))}`;
}
function samaPersis(a, b) { // perbandingan waktu-tetap
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function cekPassword(pw, stored) {
  const [alg, iter, salt, h] = stored.split('$');
  if (alg !== 'pbkdf2') return false;
  return samaPersis(await pbkdf2(pw, unb64(salt), Number(iter)), unb64(h));
}
// hash palsu: dipakai agar waktu respons sama baik username ada maupun tidak
const HASH_PALSU = `pbkdf2$${PBKDF2_ITER}$AAAAAAAAAAAAAAAAAAAAAA==$${b64(new Uint8Array(32))}`;

// ---------- INISIALISASI DATABASE + DATA AWAL DARI EXCEL ----------
let siap = null;
function pastikanSiap(env) {
  if (!siap) siap = mulai(env).catch((e) => { siap = null; throw e; });
  return siap;
}
async function mulai(env) {
  const db = env.DB;
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  const versi = await db.prepare(`SELECT v FROM meta WHERE k = 'seed_version'`).first('v');
  if (versi === SEED.version) return; // data sudah mutakhir

  // Masukkan/perbarui anggota & admin dalam SATU perintah (json_each).
  // Akun yang sudah ada: nama/peran/nama panggilan diperbarui, PASSWORD TIDAK DITIMPA
  // (kecuali seed dibuat dengan --reset).
  const setPassword = SEED.reset ? ', password_hash = excluded.password_hash' : '';
  await db.batch([
    db.prepare(
      `INSERT INTO users (username, full_name, nickname, role, password_hash)
       SELECT json_extract(value,'$.username'), json_extract(value,'$.full_name'),
              json_extract(value,'$.nickname'), json_extract(value,'$.role'), json_extract(value,'$.hash')
       FROM json_each(?1) WHERE true
       ON CONFLICT(username) DO UPDATE SET
         full_name = excluded.full_name, nickname = excluded.nickname, role = excluded.role${setPassword}`
    ).bind(JSON.stringify(SEED.users)),
    db.prepare('DELETE FROM schedule'),
    db.prepare(
      `INSERT INTO schedule (nickname, day, session)
       SELECT json_extract(value,'$.nickname'), json_extract(value,'$.day'), json_extract(value,'$.session')
       FROM json_each(?1) WHERE true`
    ).bind(JSON.stringify(SEED.schedule)),
    db.prepare(`INSERT INTO meta (k, v) VALUES ('seed_version', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(SEED.version),
  ]);
}

// ---------- SESI LOGIN (cookie HttpOnly) ----------
const ambilCookie = (req, nama) => (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + nama + '=([^;]+)'))?.[1] ?? null;

async function penggunaSaatIni(req, env) {
  const token = ambilCookie(req, 'sid');
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.username, u.full_name, u.nickname, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  ).bind(await sha256(token), Date.now()).first();
}
function cookieSesi(req, token, maxAgeDetik) {
  const aman = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeDetik}${aman}`;
}

async function bacaJson(req) {
  try { const d = await req.json(); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}
const teks = (v, maks) => (typeof v === 'string' && v.length <= maks ? v : '');

// ---------- ROUTER ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req); // halaman web
    try {
      await pastikanSiap(env);
      return await route(req, env, url);
    } catch (e) {
      console.error('[error]', e && e.message);
      return fail(500, 'Terjadi kesalahan pada server. Coba lagi.');
    }
  },
};

async function route(req, env, url) {
  const m = req.method, p = url.pathname;

  // perlindungan CSRF tambahan: permintaan tulis harus dari situs ini sendiri
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return fail(403, 'Permintaan ditolak.');
  }

  if (m === 'POST' && p === '/api/login') return login(req, env);
  if (m === 'POST' && p === '/api/logout') return logout(req, env);

  const user = await penggunaSaatIni(req, env);
  if (!user) return fail(401, 'Silakan login terlebih dahulu.');

  if (m === 'GET' && p === '/api/me') return me(env, user);
  if (m === 'POST' && p === '/api/password') return gantiPassword(req, env, user);

  const foto = p.match(/^\/api\/photo\/(\d+)$/);
  if (m === 'GET' && foto) return ambilFoto(env, user, Number(foto[1]));

  // ----- khusus anggota -----
  if (p === '/api/today' || p === '/api/attend' || p === '/api/history') {
    if (user.role !== 'member') return fail(403, 'Akses ditolak.');
    if (m === 'GET' && p === '/api/today') return hariIni(env, user);
    if (m === 'POST' && p === '/api/attend') return absen(req, env, user);
    if (m === 'GET' && p === '/api/history') return riwayat(env, user);
  }

  // ----- khusus admin (dicek di server, bukan hanya disembunyikan di tampilan) -----
  if (p.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return fail(403, 'Akses ditolak.');
    if (m === 'GET' && p === '/api/admin/piket') return adminPiket(env, url);
    if (m === 'GET' && p === '/api/admin/riwayat') return adminRiwayat(env, url);
  }
  return fail(404, 'Tidak ditemukan.');
}

// ---------- LOGIN / LOGOUT ----------
async function login(req, env) {
  const b = await bacaJson(req);
  const username = teks(b.username, 100).trim().toLowerCase();
  const password = teks(b.password, 200);
  const peran = b.role === 'admin' ? 'admin' : 'member';
  const salah = peran === 'admin' ? 'Username atau password admin salah.' : 'Username atau password salah.';
  if (!username || !password) return fail(401, salah);

  // batasi tebak-tebakan password (sebelum menghitung hash yang mahal)
  const kunci = `${username}|${req.headers.get('CF-Connecting-IP') || '-'}`;
  const gagal = await env.DB.prepare('SELECT COUNT(*) AS c FROM login_fail WHERE key = ?1 AND ts > ?2')
    .bind(kunci, Date.now() - 15 * 60 * 1000).first('c');
  if (gagal >= MAKS_GAGAL) return fail(429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.');

  const u = await env.DB.prepare('SELECT id, role, password_hash FROM users WHERE username = ?1').bind(username).first();
  const cocok = await cekPassword(password, u ? u.password_hash : HASH_PALSU);
  if (!u || !cocok || u.role !== peran) {
    await env.DB.prepare('INSERT INTO login_fail (key, ts) VALUES (?1, ?2)').bind(kunci, Date.now()).run();
    return fail(401, salah);
  }

  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const lama = peran === 'admin' ? SESI_ADMIN_MS : SESI_ANGGOTA_MS;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)').bind(await sha256(token), u.id, Date.now() + lama),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(Date.now()),
    env.DB.prepare('DELETE FROM login_fail WHERE key = ?1 OR ts < ?2').bind(kunci, Date.now() - 15 * 60 * 1000),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': cookieSesi(req, token, Math.floor(lama / 1000)) });
}

async function logout(req, env) {
  const token = ambilCookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': cookieSesi(req, '', 0) });
}

async function me(env, user) {
  const jadwal = user.nickname
    ? (await env.DB.prepare('SELECT day, session FROM schedule WHERE nickname = ?1 ORDER BY day').bind(user.nickname).all()).results
    : [];
  return json({ user: { username: user.username, full_name: user.full_name, role: user.role }, schedule: jadwal });
}

// ---------- GANTI PASSWORD ----------
async function gantiPassword(req, env, user) {
  const b = await bacaJson(req);
  const lama = teks(b.old, 200), baru = teks(b.new, 200);
  if (!baru) return fail(400, 'Password baru tidak boleh kosong.');
  if (baru.length < 6) return fail(400, 'Password baru minimal 6 karakter.');
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(user.id).first();
  if (!lama || !(await cekPassword(lama, row.password_hash))) return fail(400, 'Password lama salah.');

  const token = ambilCookie(req, 'sid');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(await hashPassword(baru), user.id),
    // sesi di perangkat lain dikeluarkan; sesi sekarang tetap
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2').bind(user.id, await sha256(token)),
  ]);
  return json({ ok: true });
}

// ---------- ANGGOTA: JADWAL HARI INI, ABSEN, RIWAYAT ----------
async function jadwalHariIni(env, user, dow) {
  if (!user.nickname) return null;
  return env.DB.prepare('SELECT session FROM schedule WHERE nickname = ?1 AND day = ?2').bind(user.nickname, dow).first();
}

async function hariIni(env, user) {
  const { date, dow } = sekarangWIB();
  const s = await jadwalHariIni(env, user, dow);
  const a = await env.DB.prepare('SELECT id, att_time, status FROM attendance WHERE user_id = ?1 AND att_date = ?2').bind(user.id, date).first();
  return json({
    date, dow, has_schedule: !!s, session: s ? s.session : null,
    attended: !!a, att_time: a ? a.att_time : null, status: a ? a.status : null, photo_id: a ? a.id : null,
  });
}

async function absen(req, env, user) {
  const { date, dow, iso } = sekarangWIB();

  // 1) jadwal (validasi di server)
  const s = await jadwalHariIni(env, user, dow);
  if (!s) return fail(403, 'Anda tidak memiliki jadwal piket hari ini.');
  // 2) absen ganda
  const ada = await env.DB.prepare('SELECT 1 AS x FROM attendance WHERE user_id = ?1 AND att_date = ?2').bind(user.id, date).first();
  if (ada) return fail(409, 'Anda sudah melakukan absen piket hari ini.');

  // 3) foto wajib: harus benar-benar file JPEG
  let file = null;
  try { file = (await req.formData()).get('photo'); } catch { /* ditangani di bawah */ }
  if (!file || typeof file === 'string' || !file.size) return fail(400, 'Foto bukti diperlukan untuk melakukan absen.');
  if (file.size > 3 * 1024 * 1024) return fail(413, 'Ukuran foto terlalu besar.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return fail(400, 'Foto bukti diperlukan untuk melakukan absen.');

  // 4) simpan foto ke R2, lalu catat absensi di D1
  const key = `bukti/${user.id}/${date}-${hex(crypto.getRandomValues(new Uint8Array(8)))}.jpg`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  try {
    await env.DB.prepare(
      `INSERT INTO attendance (user_id, username, full_name, att_date, day_name, session, att_time, photo_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(user.id, user.username, user.full_name, date, HARI[dow - 1], s.session, iso, key).run();
  } catch (e) {
    await env.BUCKET.delete(key); // gagal/ganda: jangan tinggalkan foto yatim
    if (/UNIQUE/i.test(String(e && e.message))) return fail(409, 'Anda sudah melakukan absen piket hari ini.');
    throw e;
  }
  return json({ att_time: iso, session: s.session, status: 'Sudah Absen', date });
}

async function riwayat(env, user) {
  const r = await env.DB.prepare(
    `SELECT id, att_date, day_name, session, att_time, status FROM attendance WHERE user_id = ?1 ORDER BY att_date DESC`
  ).bind(user.id).all();
  return json({ rows: r.results });
}

// Foto: hanya pemiliknya dan admin
async function ambilFoto(env, user, id) {
  const row = await env.DB.prepare('SELECT user_id, photo_key FROM attendance WHERE id = ?1').bind(id).first();
  if (!row || (user.role !== 'admin' && row.user_id !== user.id)) return fail(404, 'Foto tidak ditemukan.');
  const obj = await env.BUCKET.get(row.photo_key);
  if (!obj) return fail(404, 'Foto tidak ditemukan.');
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
}

// ---------- ADMIN ----------
async function adminPiket(env, url) {
  const date = url.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return fail(400, 'Tanggal tidak valid.');
  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'member'`).first('c');
  const r = await env.DB.prepare(
    `SELECT s.nickname AS panggilan, u.full_name AS nama, u.username AS username, s.day AS hari, s.session AS sesi,
            CASE WHEN a.id IS NOT NULL THEN 'Sudah Absen' ELSE 'Belum Absen' END AS status,
            a.att_time AS jam, a.id AS foto_id
     FROM schedule s
     LEFT JOIN users u ON u.nickname = s.nickname AND u.role = 'member'
     LEFT JOIN attendance a ON a.user_id = u.id AND a.att_date = ?1
     WHERE s.day = ?2
     ORDER BY s.session ASC, s.nickname ASC`
  ).bind(date, isoDow(date)).all();
  return json({ total, rows: r.results });
}

async function adminRiwayat(env, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 500);
  const r = await env.DB.prepare(
    `SELECT id, full_name, username, att_date, day_name, session, att_time, status
     FROM attendance ORDER BY att_time DESC LIMIT ?1`
  ).bind(limit).all();
  return json({ rows: r.results });
}
