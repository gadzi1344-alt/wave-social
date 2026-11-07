// Соцсеть: посты, просмотры, лайки, комментарии, подписки, профили, поиск,
// загрузка фото в Vercel Blob и админка (галочка и значки).
import { put, del } from '@vercel/blob';
import { init, json, q, one, run, now, clip, rnd, getUser, actionOf, ADMIN, db } from '../../lib/common.js';

// Node.js-рантайм: нужен для @vercel/blob (на Edge его модули не поддерживаются)

const BADGES = {
  star: { label: 'Звезда', emoji: '⭐' },
  fire: { label: 'Огонь', emoji: '🔥' },
  heart: { label: 'Сердечко', emoji: '💜' },
  cat: { label: 'Котик', emoji: '🐱' },
  crown: { label: 'Корона', emoji: '👑' },
  flower: { label: 'Цветочек', emoji: '🌸' },
  sparkle: { label: 'Блёстки', emoji: '✨' },
  bunny: { label: 'Зайка', emoji: '🐰' },
};

const parseBadges = (s) => { try { return JSON.parse(s || '[]').filter((b) => BADGES[b]); } catch (_) { return []; } };
const pic = (k) => (k && k.startsWith('https://') ? k : '');
const mapUser = (u) => ({
  id: u.id, name: u.name, bio: u.bio || '', created: u.created,
  avatar: pic(u.avatar_key), verified: !!u.verified, badges: parseBadges(u.badges),
});
const mapAuthor = (r) => ({ name: r.name, verified: !!r.verified, badges: parseBadges(r.badges), avatar: pic(r.avatar_key) });
const mapPost = (r, uid, isAdmin) => ({
  id: r.id, text: r.text || '', created: r.created, views: r.views || 0,
  image: pic(r.image_key), likes: Number(r.likes) || 0, comments: Number(r.comments) || 0,
  liked: !!Number(r.liked), can: isAdmin || r.user_id === uid, author: mapAuthor(r),
});

const POST_SQL = `SELECT p.id, p.text, p.image_key, p.views, p.created, p.user_id,
  u.name, u.verified, u.badges, u.avatar_key,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
  FROM posts p JOIN users u ON u.id = p.user_id`;

export default async function handler(request) {
  try {
    await init();
    const a = actionOf(request);
    const sp = new URL(request.url).searchParams;
    const user = await getUser(request);
    const uid = user ? user.id : 0;
    const isAdmin = !!user && user.name.toLowerCase() === ADMIN;
    const mapP = (r) => mapPost(r, uid, isAdmin);

    // ---- Загрузка картинки: тело запроса — сам файл ----
    if (a === 'upload') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const type = (request.headers.get('content-type') || '').split(';')[0];
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type];
      if (!ext) return json({ error: 'Только JPG, PNG, WebP или GIF' }, 400);
      const file = await request.blob();
      if (file.size > 5 * 1024 * 1024) return json({ error: 'Файл больше 5 МБ' }, 413);
      const kind = sp.get('kind') === 'avatar' ? 'avatar' : 'post';
      const r = await put(`${kind}/${user.id}/${rnd(12)}.${ext}`, file, { access: 'public', contentType: type });
      return json({ url: r.url });
    }

    if (request.method === 'GET') {
      if (a === 'feed') {
        const tab = sp.get('tab') === 'follow' ? 'follow' : 'all';
        if (tab === 'follow' && !user) return json({ error: 'Войдите, чтобы видеть подписки' }, 401);
        const before = Number(sp.get('before')) || 2147483647;
        const follow = tab === 'follow' ? ' AND p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)' : '';
        const args = [uid, before, ...(follow ? [uid] : [])];
        const rows = await q(`${POST_SQL} WHERE p.id < ?${follow} ORDER BY p.id DESC LIMIT 20`, args);
        return json({ posts: rows.map(mapP) });
      }

      if (a === 'post') {
        const id = Number(sp.get('id')) || 0;
        const row = await one(`${POST_SQL} WHERE p.id = ?`, [uid, id]);
        if (!row) return json({ error: 'Пост не найден' }, 404);
        const cm = await q(
          'SELECT c.id, c.text, c.created, u.name, u.verified, u.badges, u.avatar_key FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id LIMIT 200', [id]);
        return json({
          post: mapP(row),
          comments: cm.map((c) => ({ id: c.id, text: c.text, created: c.created, author: mapAuthor(c) })),
        });
      }

      if (a === 'profile') {
        const u = await one('SELECT * FROM users WHERE name = ?', [clip(sp.get('name'), 40)]);
        if (!u) return json({ error: 'Пользователь не найден' }, 404);
        const count = async (sql, ...args) => Number((await one(sql, args)).n);
        const stats = {
          posts: await count('SELECT COUNT(*) AS n FROM posts WHERE user_id = ?', u.id),
          followers: await count('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', u.id),
          following: await count('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', u.id),
        };
        const following = !!user && !!(await one('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?', [uid, u.id]));
        const rows = await q(`${POST_SQL} WHERE p.user_id = ? AND p.id < ? ORDER BY p.id DESC LIMIT 20`,
          [uid, u.id, Number(sp.get('before')) || 2147483647]);
        return json({ user: mapUser(u), stats, following, isMe: uid === u.id, posts: rows.map(mapP) });
      }

      if (a === 'search') {
        const qs = clip(sp.get('q'), 60);
        const like = `%${qs}%`;
        const us = await q('SELECT * FROM users WHERE name LIKE ? ORDER BY id DESC LIMIT 12', [like]);
        const posts = qs ? (await q(`${POST_SQL} WHERE p.text LIKE ? ORDER BY p.id DESC LIMIT 12`, [uid, like])).map(mapP) : [];
        return json({ users: us.map(mapUser), posts });
      }

      if (a === 'admin_users') {
        if (!isAdmin) return json({ error: 'Только для администратора' }, 403);
        const rows = await q('SELECT * FROM users WHERE name LIKE ? ORDER BY id DESC LIMIT 100', [`%${clip(sp.get('q'), 40)}%`]);
        return json({ users: rows.map(mapUser), badges: BADGES });
      }
      return json({ error: 'Не найдено' }, 404);
    }

    // ---- Запись ----
    const body = await request.json().catch(() => ({}));

    // Просмотры: фронтенд присылает id постов, которые появились на экране в ленте
    if (a === 'view') {
      if (!user) return json({ ok: true });
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => n > 0).slice(0, 50);
      for (const id of ids) {
        const ins = await run('INSERT OR IGNORE INTO post_views(post_id, user_id) VALUES(?, ?)', [id, user.id]);
        if (ins.rowsAffected) await run('UPDATE posts SET views = views + 1 WHERE id = ?', [id]);
      }
      return json({ ok: true });
    }

    if (a === 'post_create') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const text = clip(body.text, 1000);
      const img = String(body.image_key || '');
      if (img && !(img.startsWith('https://') && img.includes(`/post/${user.id}/`))) return json({ error: 'Плохое фото' }, 400);
      if (!text && !img) return json({ error: 'Напишите текст или добавьте фото' }, 400);
      const r = await run('INSERT INTO posts(user_id, text, image_key, views, created) VALUES(?, ?, ?, 0, ?)', [user.id, text, img, now()]);
      return json({ id: Number(r.lastInsertRowid) });
    }

    if (a === 'post_delete') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const id = Number(body.id) || 0;
      const p = await one('SELECT user_id, image_key FROM posts WHERE id = ?', [id]);
      if (!p) return json({ error: 'Пост не найден' }, 404);
      if (p.user_id !== user.id && !isAdmin) return json({ error: 'Нельзя удалить чужой пост' }, 403);
      await db.batch([
        { sql: 'DELETE FROM likes WHERE post_id = ?', args: [id] },
        { sql: 'DELETE FROM comments WHERE post_id = ?', args: [id] },
        { sql: 'DELETE FROM post_views WHERE post_id = ?', args: [id] },
        { sql: 'DELETE FROM posts WHERE id = ?', args: [id] },
      ], 'write');
      if (pic(p.image_key)) await del(p.image_key);
      return json({ ok: true });
    }

    if (a === 'like') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const id = Number(body.id) || 0;
      if (!(await one('SELECT 1 AS x FROM posts WHERE id = ?', [id]))) return json({ error: 'Пост не найден' }, 404);
      const ex = await one('SELECT 1 AS x FROM likes WHERE post_id = ? AND user_id = ?', [id, user.id]);
      if (ex) await run('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [id, user.id]);
      else await run('INSERT INTO likes(post_id, user_id) VALUES(?, ?)', [id, user.id]);
      const n = await one('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?', [id]);
      return json({ liked: !ex, likes: Number(n.n) });
    }

    if (a === 'comment') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const id = Number(body.post_id) || 0;
      const text = clip(body.text, 500);
      if (!text) return json({ error: 'Пустой комментарий' }, 400);
      if (!(await one('SELECT 1 AS x FROM posts WHERE id = ?', [id]))) return json({ error: 'Пост не найден' }, 404);
      await run('INSERT INTO comments(post_id, user_id, text, created) VALUES(?, ?, ?, ?)', [id, user.id, text, now()]);
      return json({ ok: true });
    }

    if (a === 'follow') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const t = await one('SELECT id FROM users WHERE name = ?', [clip(body.name, 40)]);
      if (!t) return json({ error: 'Пользователь не найден' }, 404);
      if (t.id === user.id) return json({ error: 'Нельзя подписаться на себя' }, 400);
      const ex = await one('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?', [user.id, t.id]);
      if (ex) await run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', [user.id, t.id]);
      else await run('INSERT INTO follows(follower_id, followee_id) VALUES(?, ?)', [user.id, t.id]);
      return json({ following: !ex });
    }

    if (a === 'profile_update') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const bio = body.bio !== undefined ? clip(body.bio, 200) : (user.bio || '');
      let avatar = user.avatar_key || '';
      if (body.avatar_key !== undefined) {
        const k = String(body.avatar_key || '');
        if (k && !(k.startsWith('https://') && k.includes(`/avatar/${user.id}/`))) return json({ error: 'Плохая аватарка' }, 400);
        if (user.avatar_key && pic(user.avatar_key) && user.avatar_key !== k) await del(user.avatar_key);
        avatar = k;
      }
      await run('UPDATE users SET bio = ?, avatar_key = ? WHERE id = ?', [bio, avatar, user.id]);
      return json({ ok: true });
    }

    if (a === 'admin_set') {
      if (!isAdmin) return json({ error: 'Только для администратора' }, 403);
      const t = await one('SELECT id FROM users WHERE name = ?', [clip(body.name, 40)]);
      if (!t) return json({ error: 'Пользователь не найден' }, 404);
      const badges = (Array.isArray(body.badges) ? body.badges : []).filter((b) => BADGES[b]).slice(0, 8);
      await run('UPDATE users SET verified = ?, badges = ? WHERE id = ?', [body.verified ? 1 : 0, JSON.stringify(badges), t.id]);
      return json({ ok: true });
    }

    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
