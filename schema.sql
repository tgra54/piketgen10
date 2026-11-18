-- REFERENSI SAJA. Tabel ini dibuat OTOMATIS oleh Worker saat permintaan pertama; Anda tidak perlu menjalankannya.
-- (Boleh dijalankan manual lewat: npx wrangler d1 execute absen-piket-db --remote --file schema.sql)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  nickname TEXT,
  role TEXT NOT NULL CHECK (role IN ('member','admin')),
  password_hash TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 5),
  session TEXT NOT NULL CHECK (session IN ('Pagi','Sore')),
  UNIQUE (nickname, day));

CREATE TABLE IF NOT EXISTS attendance (
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
  UNIQUE (user_id, att_date));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS login_fail (key TEXT NOT NULL, ts INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS idx_login_fail ON login_fail (key, ts);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
