// Аккаунты: регистрация, вход, выход, текущий пользователь.
import { init, json, one, run, now, clip, rnd, sha, hashPw, getUser, actionOf, ADMIN } from '../../lib/common.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    await init();
    const a = actionOf(request);
    const user = await getUser(request);
    const pub = (u) => u && { name: u.name, listen_sec: u.listen_sec || 0, created: u.created, admin: u.name.toLowerCase() === ADMIN };

    if (a === 'me') return json({ user: pub(user) });
    if (request.method !== 'POST') return json({ error: 'Не найдено' }, 404);
    const body = await request.json().catch(() => ({}));

    const startSession = async (id) => {
      const t = rnd(32);
      await run('INSERT INTO sessions(token, user_id, created) VALUES(?, ?, ?)', [await sha(t), id, now()]);
      const u = await one('SELECT * FROM users WHERE id = ?', [id]);
      return json({ user: pub(u) }, 200, {
        'set-cookie': `wave_s=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
      });
    };

    if (a === 'register') {
      const name = String(body.name || '').trim();
      const pw = String(body.password || '');
      if (!/^[\w.\-а-яёА-ЯЁ]{3,20}$/.test(name)) return json({ error: 'Имя: 3–20 символов (буквы, цифры, _ . -)' }, 400);
      if (pw.length < 6) return json({ error: 'Пароль: минимум 6 символов' }, 400);
      if (name.toLowerCase() === ADMIN && !(process.env.ADMIN_CODE && body.code === process.env.ADMIN_CODE))
        return json({ error: 'Это имя зарезервировано. Нужен верный админ-код.' }, 403);
      const salt = rnd(16);
      let id;
      try {
        const r = await run('INSERT INTO users(name, email, salt, hash, created) VALUES(?, ?, ?, ?, ?)',
          [name, '', salt, await hashPw(pw, salt), now()]);
        id = Number(r.lastInsertRowid);
      } catch (_) {
        return json({ error: 'Такое имя уже занято' }, 409);
      }
      return startSession(id);
    }

    if (a === 'login') {
      const u = await one('SELECT * FROM users WHERE name = ?', [clip(body.name, 40)]);
      if (!u || (await hashPw(String(body.password || ''), u.salt)) !== u.hash)
        return json({ error: 'Неверное имя или пароль' }, 401);
      return startSession(u.id);
    }

    if (a === 'logout') {
      const token = (request.headers.get('cookie') || '').match(/(?:^|; )wave_s=([a-f0-9]+)/)?.[1];
      if (token) await run('DELETE FROM sessions WHERE token = ?', [await sha(token)]);
      return json({ ok: true }, 200, { 'set-cookie': 'wave_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
    }

    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
