// Общие функции: база Turso (SQLite по сети), сессии, пароли, ответы.
import { createClient } from '@libsql/client/web';

export const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const ADMIN = (process.env.ADMIN_USER || 'bibnaq').toLowerCase();

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL COLLATE NOCASE, email TEXT, salt TEXT, hash TEXT, listen_sec INTEGER DEFAULT 0, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, text TEXT, image_key TEXT, views INTEGER DEFAULT 0, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS post_views(post_id INTEGER, user_id INTEGER, PRIMARY KEY(post_id, user_id))',
  'CREATE TABLE IF NOT EXISTS likes(post_id INTEGER, user_id INTEGER, PRIMARY KEY(post_id, user_id))',
  'CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, text TEXT, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS follows(follower_id INTEGER, followee_id INTEGER, PRIMARY KEY(follower_id, followee_id))',
];
const ALTERS = [
  "ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN avatar_key TEXT DEFAULT ''",
  'ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0',
  "ALTER TABLE users ADD COLUMN badges TEXT DEFAULT '[]'",
];

let ready;
export function init() {
  if (!ready) {
    ready = (async () => {
      await db.batch(SCHEMA, 'write');
      for (const a of ALTERS) {
        try { await db.execute(a); } catch (_) { /* колонка уже есть */ }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h },
  });

export const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;
export const one = async (sql, args = []) => (await q(sql, args))[0] ?? null;
export const run = (sql, args = []) => db.execute({ sql, args });
export const now = () => Math.floor(Date.now() / 1000);
export const clip = (v, n) => String(v ?? '').trim().slice(0, n);

const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const rnd = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));

export async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(salt), iterations: 100000 }, k, 256));
}

export async function getUser(request) {
  const token = (request.headers.get('cookie') || '').match(/(?:^|; )wave_s=([a-f0-9]+)/)?.[1];
  if (!token) return null;
  return one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', [await sha(token)]);
}

export const actionOf = (request) => new URL(request.url).pathname.split('/').pop();
