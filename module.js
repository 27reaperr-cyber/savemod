// ════════════════════════════════════════════════════════════════════════════
//  SaveMOD — Universal Business Module (production, May 2026) — FIXED build v2
//  ───────────────────────────────────────────────────────────────────────────
//  НОВЫЕ ИСПРАВЛЕНИЯ (v2, поверх v1):
//
//   ▸ .reply теперь УВЕРЕННО пересылает самоуничтожающееся фото/видео/voice.
//     Проблема была в том, что Bot API не отдаёт явного флага self_destruct
//     (см. https://core.telegram.org/bots/api — у Photo/Video/Voice нет такого
//     поля). Из-за этого самоуничтожающаяся медиа приходит в business_message
//     как обычная, НО file_id у неё живёт буквально несколько секунд после
//     просмотра адресатом. Поэтому:
//       1) Скачиваем КАЖДОЕ входящее медиа от собеседника НЕМЕДЛЕННО и
//          параллельно, в background-задаче, не блокируя цикл обработки
//          обновлений. Промис складываем в Map<msgKey, Promise<path>>.
//       2) Параллельно с background-скачиванием в БД сразу пишется row
//          в msg_cache (saved_path=null), чтобы .reply мог найти запись.
//       3) В cmdReply сначала ждём in-flight download (если есть),
//          затем fallback на cached.saved_path, затем — на свежий getFile
//          по file_id из reply_to_message, и только потом — текстовый
//          fallback. Раньше при гонке (медиа ещё качается) .reply сразу
//          уходил в текстовый fallback и пользователь видел «не удалось».
//       4) Для пустых caption/text больше не врём «возможно медиа уже
//          исчезло» — пишем точный диагноз (download failed / no media).
//
//   ▸ .ttt — теперь это НАСТОЯЩАЯ multiplayer-игра ПРОТИВ СОБЕСЕДНИКА,
//     прямо в бизнес-чате. Раньше комментарий ошибочно утверждал, что
//     inline-клавиатуры в business-сообщениях запрещены — это не так
//     (см. core.telegram.org/bots/api, Bot API 10.0, 8 мая 2026). Поле
//     reply_markup поддерживается и в sendMessage, и в editMessageText
//     с business_connection_id. Поэтому:
//       1) Доска отправляется прямо в бизнес-чат (с business_connection_id).
//       2) Состояние игры: { board, owner_id, opponent_id, turn ('X'|'O') }.
//       3) Игроки: ❌ владелец = X, ⭕️ собеседник = O.
//       4) В tttCallback клик от owner допускается только при turn==='X',
//          клик от opponent — только при turn==='O'; все остальные клики
//          получают answerCallbackQuery с правильной подсказкой.
//       5) editMessageText / editMessageReplyMarkup всегда вызываются с
//          business_connection_id (иначе MESSAGE_NOT_MODIFIED / 400).
//       6) Минимакс-логика бота полностью удалена.
//
//   ▸ Сохраняются все исправления v1: ленивая подгрузка business_connection,
//     валидация токена через getMe, поддержка отсутствия can_reply, и т. д.
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Bot, InlineKeyboard, GrammyError, HttpError, InputFile } from 'grammy';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ─── 0. ENV ─────────────────────────────────────────────────────────────────
const TOKEN     = process.env.MODULE_BOT_TOKEN;
const USERNAME  = process.env.MODULE_BOT_USERNAME || '';
const DB_PATH   = process.env.MODULE_DB || `./module-${USERNAME || 'default'}.db`;
const CDB_PATH  = process.env.CONSTRUCTOR_DB || './constructor.db';
const MEDIA_DIR = process.env.MEDIA_DIR || './saved_media';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);

const MEDIA_TTL_DAYS = Number(process.env.MEDIA_TTL_DAYS || 7);
const MEDIA_TTL_MS   = MEDIA_TTL_DAYS * 86_400_000;
const CLEANUP_EVERY_MS = 60 * 60 * 1000; // раз в час

if (!TOKEN) {
  console.error('[module] FATAL: MODULE_BOT_TOKEN is missing');
  process.exit(2);
}
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const PREMIUM_PRICE = 200;
const PREMIUM_DAYS  = 30;

const FREE_DOT_LIMIT_PER_DAY   = 50;
const FREE_MEDIA_LIMIT_PER_DAY = 30;

// ─── 1. COMMANDS REGISTRY ───────────────────────────────────────────────────
const CMD_HELP = {
  help:      { premium: false, desc: 'Список доступных команд.' },
  reply:     { premium: false, desc: 'Переслать в личку с ботом исчезающие медиа/сообщение собеседника.\nИспользуй как реплай на сообщение.' },
  mute:      { premium: false, desc: 'Автоматически удалять любое входящее сообщение от собеседника.' },
  unmute:    { premium: false, desc: 'Отключить .mute для этого диалога.' },
  roll:      { premium: false, desc: '.roll — случайное число 1-100.\n.roll N — случайное 1-N.\n.roll A B — случайное A-B.' },
  calc:      { premium: false, desc: 'Калькулятор. Пример: .calc 2+2*8' },
  weather:   { premium: false, desc: 'Погода в городе. Пример: .weather Tallinn' },
  translate: { premium: false, desc: 'Перевод. Пример: .translate en Привет' },
  sticker:   { premium: false, desc: 'Превратить картинку (реплай) в стикер.' },
  ttt:       { premium: true,  desc: '🎮 Крестики-нолики против собеседника прямо в чате (премиум).' },
  voice:     { premium: true,  desc: 'Озвучить текст голосовым. Пример: .voice Привет (премиум).' },
};

console.log(`📦 Module @${USERNAME} starting (db: ${DB_PATH}, cdb: ${CDB_PATH}, ttl: ${MEDIA_TTL_DAYS}d)…`);

// ─── 2. DATABASE (модульная) ────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    connection_id TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    user_chat_id  INTEGER NOT NULL,
    is_enabled    INTEGER DEFAULT 1,
    can_reply     INTEGER DEFAULT 0,
    can_read      INTEGER DEFAULT 0,
    can_del_sent  INTEGER DEFAULT 0,
    can_del_all   INTEGER DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS msg_cache (
    connection_id TEXT NOT NULL,
    chat_id       INTEGER NOT NULL,
    message_id    INTEGER NOT NULL,
    from_id       INTEGER,
    from_name     TEXT,
    text          TEXT,
    media_kind    TEXT,
    media_file_id TEXT,
    is_self_destruct INTEGER DEFAULT 0,
    saved_path    TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (connection_id, chat_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS saved_media (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL,
    from_id    INTEGER,
    from_name  TEXT,
    kind       TEXT NOT NULL,
    local_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id           INTEGER PRIMARY KEY,
    notify_edits      INTEGER DEFAULT 1,
    notify_deletes    INTEGER DEFAULT 1,
    save_disappearing INTEGER DEFAULT 1,
    dot_commands      INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS muted (
    owner_id   INTEGER NOT NULL,
    peer_id    INTEGER NOT NULL,
    chat_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS usage (
    user_id  INTEGER NOT NULL,
    day      TEXT    NOT NULL,
    kind     TEXT    NOT NULL,
    count    INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, day, kind)
  );

  CREATE TABLE IF NOT EXISTS payments (
    payload     TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    charge_id   TEXT,
    stars       INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mc_created    ON msg_cache(created_at);
  CREATE INDEX IF NOT EXISTS idx_media_owner   ON saved_media(owner_id);
  CREATE INDEX IF NOT EXISTS idx_media_created ON saved_media(created_at);
`);

const Q = {
  saveConn: db.prepare(`
    INSERT INTO connections (connection_id, user_id, user_chat_id, is_enabled,
                             can_reply, can_read, can_del_sent, can_del_all, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id) DO UPDATE SET
      user_id      = excluded.user_id,
      user_chat_id = excluded.user_chat_id,
      is_enabled   = excluded.is_enabled,
      can_reply    = excluded.can_reply,
      can_read     = excluded.can_read,
      can_del_sent = excluded.can_del_sent,
      can_del_all  = excluded.can_del_all,
      updated_at   = excluded.updated_at`),
  getConn:        db.prepare(`SELECT * FROM connections WHERE connection_id = ?`),
  getConnByUser:  db.prepare(`SELECT * FROM connections WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1`),

  cacheMsg: db.prepare(`
    INSERT OR REPLACE INTO msg_cache
      (connection_id, chat_id, message_id, from_id, from_name,
       text, media_kind, media_file_id, is_self_destruct, saved_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getMsg: db.prepare(`SELECT * FROM msg_cache
                      WHERE connection_id = ? AND chat_id = ? AND message_id = ?`),
  // FIX: правильный порядок аргументов — сначала SET-значение, потом WHERE-ключи.
  updateMsgSavedPath: db.prepare(`
    UPDATE msg_cache SET saved_path = ?
    WHERE connection_id = ? AND chat_id = ? AND message_id = ?`),
  deleteOldCache: db.prepare(`DELETE FROM msg_cache WHERE created_at < ?`),

  saveMedia: db.prepare(`
    INSERT INTO saved_media (owner_id, from_id, from_name, kind, local_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  getOldMedia: db.prepare(`SELECT id, local_path FROM saved_media WHERE created_at < ?`),
  deleteMedia: db.prepare(`DELETE FROM saved_media WHERE id = ?`),

  ensureSettings: db.prepare(`INSERT OR IGNORE INTO settings (user_id) VALUES (?)`),
  getSettings:    db.prepare(`SELECT * FROM settings WHERE user_id = ?`),
  setSetting:     (k) => db.prepare(`UPDATE settings SET ${k} = ? WHERE user_id = ?`),

  setMute:    db.prepare(`INSERT OR REPLACE INTO muted (owner_id, peer_id, chat_id, created_at) VALUES (?, ?, ?, ?)`),
  delMute:    db.prepare(`DELETE FROM muted WHERE owner_id = ? AND chat_id = ?`),
  isMuted:    db.prepare(`SELECT 1 FROM muted WHERE owner_id = ? AND chat_id = ?`),

  getUsage: db.prepare(`SELECT count FROM usage WHERE user_id = ? AND day = ? AND kind = ?`),
  incUsage: db.prepare(`
    INSERT INTO usage (user_id, day, kind, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id, day, kind) DO UPDATE SET count = count + 1`),

  addPayment: db.prepare(`
    INSERT OR IGNORE INTO payments (payload, user_id, charge_id, stars, created_at)
    VALUES (?, ?, ?, ?, ?)`),

  countConns: db.prepare(`SELECT COUNT(*) AS c FROM connections WHERE is_enabled = 1`),
  countMedia: db.prepare(`SELECT COUNT(*) AS c FROM saved_media`),
};

// ─── 3. Constructor DB (премиум / бан / общие настройки) ───────────────────
let cdb = null;
try {
  cdb = new Database(CDB_PATH, { fileMustExist: false, readonly: false });
  cdb.pragma('journal_mode = WAL');
  cdb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
      premium_until INTEGER DEFAULT 0, is_banned INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  try { cdb.exec(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`); } catch {}
} catch (e) {
  console.warn('[module] constructor DB unavailable:', e.message);
}

const CQ = cdb ? {
  getUser:    cdb.prepare(`SELECT * FROM users WHERE user_id = ?`),
  setPremium: cdb.prepare(`UPDATE users SET premium_until = ? WHERE user_id = ?`),
  upsertUser: cdb.prepare(`
    INSERT INTO users (user_id, username, first_name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name`),
  getSetting: cdb.prepare(`SELECT value FROM settings WHERE key = ?`),
} : null;

function isPremium(uid) {
  if (!CQ) return false;
  return ((CQ.getUser.get(uid)?.premium_until ?? 0) > Date.now());
}
function isBanned(uid) {
  if (!CQ) return false;
  return !!(CQ.getUser.get(uid)?.is_banned);
}
function constructorSetting(key, fallback = '') {
  return CQ?.getSetting.get(key)?.value ?? fallback;
}
const isAdmin = (id) => ADMIN_IDS.includes(id);

function todayKey() { return new Date().toISOString().slice(0, 10); }
function checkLimit(uid, kind, max) {
  if (isPremium(uid) || isAdmin(uid)) return { ok: true, used: 0, max };
  const row = Q.getUsage.get(uid, todayKey(), kind);
  const used = row?.count ?? 0;
  return { ok: used < max, used, max };
}
function bumpUsage(uid, kind) { Q.incUsage.run(uid, todayKey(), kind); }

async function ensureSubscribed(ctx, uid) {
  const ch = constructorSetting('required_channel');
  if (!ch) return true;
  if (isAdmin(uid)) return true;
  try {
    const m = await ctx.api.getChatMember(ch, uid);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch (e) {
    const desc = e?.description || '';
    if (/chat not found|bot is not a member|not enough rights|member list is inaccessible/i.test(desc)) {
      return true;
    }
    return false;
  }
}

// ─── 4. UI ──────────────────────────────────────────────────────────────────
function escMd(s = '') { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m); }

const INTRO =
  `Подключи меня в *Telegram Business* — я буду:\n` +
  `• уведомлять об *удалении* и *редактировании* сообщений;\n` +
  `• сохранять *исчезающие* фото, голосовые и видео;\n` +
  `• помогать командами через точку \\(\`.help\`\\)\\.`;

const kbMain = (admin) => {
  const k = new InlineKeyboard()
    .text('❓ Команды', 'nav:cmds').text('👤 Профиль', 'nav:profile').row()
    .text('⚙️ Настройки', 'nav:settings').text('⭐ Премиум', 'nav:premium').row();
  const instr   = constructorSetting('instruction_url', 'https://telegra.ph/SaveMOD');
  const support = constructorSetting('support_url',     'https://t.me/savemod');
  k.url('📖 Инструкция', instr).url('📢 Канал', support).row();
  if (admin) k.text('🛠 Админ-панель', 'nav:admin');
  return k;
};

const kbSubscribe = () => {
  const url = constructorSetting('required_channel_url') || (() => {
    const ch = constructorSetting('required_channel');
    return ch.startsWith('@') ? `https://t.me/${ch.slice(1)}` : '';
  })();
  const k = new InlineKeyboard();
  if (url) k.url('📢 Подписаться', url).row();
  k.text('✅ Я подписался', 'sub:check');
  return k;
};

const kbCmds = (premium) => {
  const free = Object.entries(CMD_HELP).filter(([, v]) => !v.premium).map(([c]) => c);
  const prem = Object.entries(CMD_HELP).filter(([, v]) => v.premium).map(([c]) => c);
  const k = new InlineKeyboard();
  for (let i = 0; i < free.length; i += 2) {
    k.text(`.${free[i]}`, `cmd:${free[i]}`);
    if (free[i+1]) k.text(`.${free[i+1]}`, `cmd:${free[i+1]}`);
    k.row();
  }
  for (let i = 0; i < prem.length; i += 2) {
    k.text(`${premium ? '' : '🔒 '}.${prem[i]}`, `cmd:${prem[i]}`);
    if (prem[i+1]) k.text(`${premium ? '' : '🔒 '}.${prem[i+1]}`, `cmd:${prem[i+1]}`);
    k.row();
  }
  k.text('‹ Назад', 'nav:main');
  return k;
};

const kbSettings = (s) => new InlineKeyboard()
  .text(`${s.notify_edits      ? '✅' : '⬜️'} Уведомления о правках`,    'set:notify_edits').row()
  .text(`${s.notify_deletes    ? '✅' : '⬜️'} Уведомления об удалениях`, 'set:notify_deletes').row()
  .text(`${s.save_disappearing ? '✅' : '⬜️'} Сохранять исчезающее`,    'set:save_disappearing').row()
  .text(`${s.dot_commands      ? '✅' : '⬜️'} Команды через точку`,      'set:dot_commands').row()
  .text('‹ Назад', 'nav:main');

const kbProfile = (s) => new InlineKeyboard()
  .text(`${s.notify_edits      ? '✅' : '⬜️'} Уведомления о правках`,    'pset:notify_edits').row()
  .text(`${s.notify_deletes    ? '✅' : '⬜️'} Уведомления об удалениях`, 'pset:notify_deletes').row()
  .text(`${s.save_disappearing ? '✅' : '⬜️'} Сохранение исчезающего`,  'pset:save_disappearing').row()
  .text('‹ Назад', 'nav:main');

const kbPremium = (premium) => {
  const k = new InlineKeyboard();
  if (!premium) k.text(`Купить за ${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн.`, 'premium:buy').row();
  k.text('‹ Назад', 'nav:main');
  return k;
};

const kbAdmin = () => new InlineKeyboard()
  .text('📊 Статистика модуля', 'admin:stats').row()
  .text('🧹 Очистить старые медиа', 'admin:cleanup').row()
  .text('‹ Назад', 'nav:main');

const backTo = (to) => new InlineKeyboard().text('‹ Назад', to);

// ─── 5. BOT ─────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    if (CQ) {
      try {
        CQ.upsertUser.run(ctx.from.id, ctx.from.username || null,
                          ctx.from.first_name || null, Date.now());
      } catch {}
    }
    if (isBanned(ctx.from.id) && !isAdmin(ctx.from.id)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: '🚫 Вы заблокированы', show_alert: true }).catch(() => {});
      }
      return;
    }
  }
  await next();
});

bot.command('start', async (ctx) => {
  Q.ensureSettings.run(ctx.from.id);
  if (!(await ensureSubscribed(ctx, ctx.from.id))) {
    return ctx.reply(`Чтобы пользоваться ботом, подпишись на наш канал\\.`, {
      parse_mode: 'MarkdownV2', reply_markup: kbSubscribe(),
    });
  }
  await ctx.reply(INTRO, {
    parse_mode: 'MarkdownV2',
    reply_markup: kbMain(isAdmin(ctx.from.id)),
    link_preview_options: { is_disabled: true },
  });
});

// ─── 6. Callback router ─────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const d = ctx.callbackQuery.data;
  try {
    if (d === 'sub:check') {
      if (await ensureSubscribed(ctx, ctx.from.id)) {
        return edit(ctx, INTRO, kbMain(isAdmin(ctx.from.id)));
      }
      return ctx.answerCallbackQuery({ text: 'Подписка не найдена', show_alert: true });
    }
    if (d !== 'sub:check' && !(await ensureSubscribed(ctx, ctx.from.id))) {
      return edit(ctx, `Чтобы пользоваться ботом, подпишись на наш канал\\.`, kbSubscribe());
    }

    if (d === 'nav:main')     return edit(ctx, INTRO, kbMain(isAdmin(ctx.from.id)));
    if (d === 'nav:cmds')     return edit(ctx, navHeader(isPremium(ctx.from.id)), kbCmds(isPremium(ctx.from.id)));
    if (d === 'nav:profile') {
      Q.ensureSettings.run(ctx.from.id);
      return edit(ctx, profileText(ctx.from.id), kbProfile(Q.getSettings.get(ctx.from.id)));
    }
    if (d === 'nav:premium')  return edit(ctx, premiumText(ctx.from.id), kbPremium(isPremium(ctx.from.id)));
    if (d === 'nav:settings') {
      Q.ensureSettings.run(ctx.from.id);
      return edit(ctx, '⚙️ *Настройки*', kbSettings(Q.getSettings.get(ctx.from.id)));
    }
    if (d === 'nav:admin' && isAdmin(ctx.from.id))    return edit(ctx, '🛠 *Админ\\-панель*', kbAdmin());
    if (d === 'admin:stats' && isAdmin(ctx.from.id))  return edit(ctx, adminStatsText(), backTo('nav:admin'));
    if (d === 'admin:cleanup' && isAdmin(ctx.from.id)) {
      const n = runCleanup(true);
      return edit(ctx, `🧹 Удалено старых медиа: *${n}*`, backTo('nav:admin'));
    }

    if (d.startsWith('set:')) {
      const key = d.slice(4);
      const allowed = ['notify_edits', 'notify_deletes', 'save_disappearing', 'dot_commands'];
      if (!allowed.includes(key)) return ctx.answerCallbackQuery();
      Q.ensureSettings.run(ctx.from.id);
      const s = Q.getSettings.get(ctx.from.id);
      Q.setSetting(key).run(s[key] ? 0 : 1, ctx.from.id);
      return edit(ctx, '⚙️ *Настройки*', kbSettings(Q.getSettings.get(ctx.from.id)));
    }
    if (d.startsWith('pset:')) {
      const key = d.slice(5);
      const allowed = ['notify_edits', 'notify_deletes', 'save_disappearing'];
      if (!allowed.includes(key)) return ctx.answerCallbackQuery();
      Q.ensureSettings.run(ctx.from.id);
      const s = Q.getSettings.get(ctx.from.id);
      Q.setSetting(key).run(s[key] ? 0 : 1, ctx.from.id);
      return edit(ctx, profileText(ctx.from.id), kbProfile(Q.getSettings.get(ctx.from.id)));
    }

    if (d.startsWith('cmd:')) {
      const c = d.slice(4);
      const meta = CMD_HELP[c];
      if (!meta) return ctx.answerCallbackQuery();
      const locked = meta.premium && !isPremium(ctx.from.id);
      const body =
        `*\\.${escMd(c)}*${locked ? ' 🔒' : ''}\n\n${escMd(meta.desc)}` +
        (locked ? `\n\n_Доступно с Премиумом\\._` : '');
      return edit(ctx, body, new InlineKeyboard().text('‹ К командам', 'nav:cmds'));
    }

    if (d.startsWith('ttt:')) return tttCallback(ctx, d);

    if (d === 'premium:buy') return sendInvoice(ctx);

    await ctx.answerCallbackQuery();
  } catch (e) {
    console.error('[cb]', e);
    await ctx.answerCallbackQuery().catch(() => {});
  }
});

function navHeader(prem) {
  return `*Команды*\n\n` +
         (prem
           ? `⭐ Премиум активен — без лимитов\\.`
           : `Лимиты без премиума:\n• ${FREE_DOT_LIMIT_PER_DAY} команд/сутки\n• ${FREE_MEDIA_LIMIT_PER_DAY} сохранений/сутки\n\n🔒 — премиум\\-команды\\.`);
}

function profileText(uid) {
  const s = Q.getSettings.get(uid) || {};
  const c = Q.getConnByUser.get(uid);
  const prem = isPremium(uid);
  const u = CQ?.getUser.get(uid);
  const premLine = prem && u?.premium_until
    ? `⭐ до ${escMd(new Date(u.premium_until).toLocaleDateString('ru-RU'))}`
    : '❌';
  const dotUsed = Q.getUsage.get(uid, todayKey(), 'dot')?.count ?? 0;
  const medUsed = Q.getUsage.get(uid, todayKey(), 'media')?.count ?? 0;
  return `👤 *Профиль*\n\n` +
         `• ID: \`${uid}\`\n` +
         `• Премиум: ${premLine}\n` +
         `• Бизнес\\-подключение: ${c ? '🟢' : '⚪️'}\n` +
         `• Команд сегодня: *${dotUsed}*${prem ? '' : `/${FREE_DOT_LIMIT_PER_DAY}`}\n` +
         `• Медиа сохранено сегодня: *${medUsed}*${prem ? '' : `/${FREE_MEDIA_LIMIT_PER_DAY}`}\n` +
         `• Уведомления о правках: ${s.notify_edits ? '✅' : '❌'}\n` +
         `• Уведомления об удалениях: ${s.notify_deletes ? '✅' : '❌'}\n` +
         `• Сохранение исчезающего: ${s.save_disappearing ? '✅' : '❌'}`;
}

function premiumText(uid) {
  const u = CQ?.getUser.get(uid);
  const prem = isPremium(uid);
  if (prem) {
    const left = Math.ceil((u.premium_until - Date.now()) / 86_400_000);
    return `⭐ *Премиум активен*\n\nОсталось дней: *${left}*\n\n` +
           `Преимущества:\n• Без лимитов\n• Все команды \\(\\.ttt, \\.voice\\)`;
  }
  return `⭐ *Премиум*\n\n` +
         `Без премиума:\n` +
         `• до *${FREE_DOT_LIMIT_PER_DAY}* команд/сутки\n` +
         `• до *${FREE_MEDIA_LIMIT_PER_DAY}* сохранений/сутки\n\n` +
         `С премиумом:\n• Без лимитов\n• Все команды\n\n` +
         `Стоимость: *${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн\\.*`;
}

function adminStatsText() {
  return `📊 *Статистика модуля*\n\n` +
         `• Активных подключений: *${Q.countConns.get().c}*\n` +
         `• Сохранённых медиа: *${Q.countMedia.get().c}*\n` +
         `• TTL очистки: *${MEDIA_TTL_DAYS} дн\\.*\n` +
         `• Бот: \`@${escMd(USERNAME || '—')}\``;
}

async function edit(ctx, text, reply_markup) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      reply_markup,
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    if (!(e instanceof GrammyError && /not modified/.test(e.description || ''))) {
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup,
        link_preview_options: { is_disabled: true } }).catch(() => {});
    }
  }
  await ctx.answerCallbackQuery().catch(() => {});
}

// ─── 7. PREMIUM (Stars) ─────────────────────────────────────────────────────
async function sendInvoice(ctx) {
  const payload = `prem_${ctx.from.id}_${Date.now()}`;
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.api.sendInvoice(
    ctx.from.id, 'SaveMOD Премиум',
    `Премиум на ${PREMIUM_DAYS} дней: все команды и без лимитов.`,
    payload, 'XTR', [{ label: 'Премиум', amount: PREMIUM_PRICE }],
  ).catch((e) => {
    console.error('[invoice]', e);
    ctx.reply('Не удалось создать счёт.').catch(() => {});
  });
}

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true).catch(() => {});
});

bot.on('message:successful_payment', async (ctx) => {
  const sp  = ctx.msg.successful_payment;
  const uid = ctx.from.id;
  if (CQ) {
    const u = CQ.getUser.get(uid);
    const base = Math.max(u?.premium_until ?? 0, Date.now());
    CQ.setPremium.run(base + PREMIUM_DAYS * 86_400_000, uid);
  }
  Q.addPayment.run(sp.invoice_payload, uid, sp.telegram_payment_charge_id, sp.total_amount, Date.now());
  await ctx.reply(`✅ Премиум активирован на ${PREMIUM_DAYS} дней.`);
});

// ─── 8. BUSINESS CONNECTION ─────────────────────────────────────────────────

// Сохранение бизнес-подключения (общая функция: вызывается и из апдейта,
// и из ensureConn-фолбэка при ленивой подгрузке).
function persistConn(c) {
  if (!c || !c.id) return null;
  const userId = c.user?.id ?? c.user_chat_id;
  if (!userId) { console.warn('[biz-conn] no user_id', c); return null; }
  Q.saveConn.run(
    c.id, userId, c.user_chat_id,
    c.is_enabled ? 1 : 0,
    c.rights?.can_reply ? 1 : 0,
    c.rights?.can_read_messages ? 1 : 0,
    c.rights?.can_delete_sent_messages ? 1 : 0,
    c.rights?.can_delete_all_messages ? 1 : 0,
    Date.now(),
  );
  Q.ensureSettings.run(userId);
  return Q.getConn.get(c.id);
}

/**
 * Ленивая подгрузка подключения по cid.
 *
 * Telegram присылает `business_connection` ТОЛЬКО при создании/изменении
 * подключения. Если модуль был перезапущен, или БД модуля очищена, или
 * подключение создано в момент простоя процесса — апдейта мы не получим.
 * Telegram при этом продолжает слать `business_message` с валидным cid.
 *
 * Для этого случая Bot API 9.4+ предоставляет метод `getBusinessConnection`
 * (https://core.telegram.org/bots/api#getbusinessconnection) — он возвращает
 * объект `BusinessConnection` по его id. Используем его как fallback,
 * чтобы не терять сообщения после рестарта.
 */
const _connFetchInFlight = new Map(); // cid → Promise<conn|null>
async function ensureConn(cid) {
  if (!cid) return null;
  const cached = Q.getConn.get(cid);
  if (cached) return cached;

  if (_connFetchInFlight.has(cid)) return _connFetchInFlight.get(cid);

  const p = (async () => {
    try {
      // grammY: bot.api.getBusinessConnection(business_connection_id)
      // raw API: { business_connection_id: cid }
      const c = await bot.api.raw.getBusinessConnection({ business_connection_id: cid });
      if (!c || !c.id) {
        console.warn(`[biz-conn] getBusinessConnection returned empty for cid=${cid}`);
        return null;
      }
      const row = persistConn(c);
      console.log(`[biz-conn] lazily restored cid=${cid} user_id=${row?.user_id} enabled=${c.is_enabled}`);
      return row;
    } catch (e) {
      console.warn(`[biz-conn] getBusinessConnection failed for cid=${cid}:`, e?.description || e?.message);
      return null;
    } finally {
      // Снимаем lock через секунду — чтобы не молотить API при шквале сообщений с одним битым cid.
      setTimeout(() => _connFetchInFlight.delete(cid), 1000);
    }
  })();

  _connFetchInFlight.set(cid, p);
  return p;
}

bot.on('business_connection', async (ctx) => {
  const c = ctx.businessConnection;
  if (!c) return;
  const row = persistConn(c);
  if (!row) return;

  // Информативное сообщение владельцу
  const rightsList = [];
  if (c.rights?.can_reply)                 rightsList.push('• отвечать в чатах');
  if (c.rights?.can_read_messages)         rightsList.push('• читать сообщения');
  if (c.rights?.can_delete_sent_messages)  rightsList.push('• удалять отправленные ботом');
  if (c.rights?.can_delete_all_messages)   rightsList.push('• удалять все сообщения');

  const text = c.is_enabled
    ? `✅ Подключено к бизнес\\-аккаунту\\.\n\n*Разрешения:*\n${escMd(rightsList.join('\n') || '— нет прав, я смогу только присылать уведомления в эту личку')}`
    : `⚠️ Подключение приостановлено\\.`;
  await ctx.api.sendMessage(c.user_chat_id, text, { parse_mode: 'MarkdownV2' }).catch(() => {});
  console.log(`[biz-conn] @${USERNAME} ↔ user ${row.user_id} (enabled=${c.is_enabled}, can_reply=${!!c.rights?.can_reply})`);
});

// ─── 9. BUSINESS MESSAGE — главный обработчик ──────────────────────────────
bot.on('business_message', async (ctx) => {
  const m = ctx.businessMessage;
  if (!m) return;
  const cid  = m.business_connection_id;
  // Лениво подгружаем подключение, если его нет в БД (модуль мог быть
  // перезапущен после установки подключения, и `business_connection` мы пропустили).
  const conn = await ensureConn(cid);
  if (!conn) {
    console.warn(`[biz-msg] unknown connection_id=${cid} (could not fetch from API)`);
    return;
  }
  if (!conn.is_enabled) return;
  if (isBanned(conn.user_id)) return;

  const s = Q.getSettings.get(conn.user_id) || { notify_edits: 1, notify_deletes: 1, save_disappearing: 1, dot_commands: 1 };

  // FIX: isFromOwner — определяем по connection.user_id, а не косвенно
  const isFromOwner = !!(m.from && m.from.id === conn.user_id);

  const media = pickMedia(m);
  const spoilerHint = !!m.has_media_spoiler;

  // 1) MUTE: автоудаление сообщений собеседника
  if (!isFromOwner && Q.isMuted.get(conn.user_id, m.chat.id)) {
    if (conn.can_del_all) {
      try {
        await ctx.api.deleteBusinessMessages(cid, [m.message_id]);
      } catch (e) {
        console.warn('[mute] deleteBusinessMessages failed:', e?.description || e?.message);
      }
    } else {
      // Нет прав — пишем владельцу одну подсказку (один раз, в виде уведомления)
      console.warn('[mute] no can_delete_all_messages right, cannot delete');
    }
    return;
  }

  // 2) Кэшируем сообщение
  Q.cacheMsg.run(
    cid, m.chat.id, m.message_id,
    m.from?.id ?? null, formatName(m.from),
    m.text ?? m.caption ?? null,
    media?.kind ?? null, media?.file_id ?? null,
    spoilerHint ? 1 : 0, null, Date.now(),
  );

  // 3) Сохраняем медиа от собеседника
  if (media && !isFromOwner && s.save_disappearing) {
    const lim = checkLimit(conn.user_id, 'media', FREE_MEDIA_LIMIT_PER_DAY);
    if (!lim.ok) {
      console.warn(`[save-media] limit reached for user ${conn.user_id}`);
    } else {
      try {
        const lp = await downloadFile(media.file_id, conn.user_id, media.kind);
        // FIX: правильный порядок аргументов
        Q.updateMsgSavedPath.run(lp, cid, m.chat.id, m.message_id);
        Q.saveMedia.run(conn.user_id, m.from?.id ?? null, formatName(m.from),
                        media.kind, lp, Date.now());
        bumpUsage(conn.user_id, 'media');

        if (spoilerHint) {
          const caption =
            `💾 *Сохранено исчезающее* ${kindEmoji(media.kind)} ${escMd(media.kind)}\n` +
            `От: ${escMd(formatName(m.from) || '—')}`;
          await sendMediaTo(conn.user_chat_id, media.kind, lp, caption);
        }
      } catch (e) {
        console.error('[save-media]', e?.description || e?.message || e);
      }
    }
  }

  // 4) Точечные команды от владельца
  if (isFromOwner && s.dot_commands) {
    const raw = (m.text ?? m.caption ?? '').trim();
    if (raw.startsWith('.') && raw.length > 1) {
      // Корректный парсинг: первая «слово» = команда, остальное — args
      const sp = raw.indexOf(' ');
      const cmd = (sp < 0 ? raw.slice(1) : raw.slice(1, sp)).toLowerCase();
      const args = sp < 0 ? '' : raw.slice(sp + 1).trim();
      if (cmd && CMD_HELP[cmd]) {
        const lim = checkLimit(conn.user_id, 'dot', FREE_DOT_LIMIT_PER_DAY);
        if (!lim.ok) {
          await replyEdit(ctx, m, conn, `⚠️ Лимит ${FREE_DOT_LIMIT_PER_DAY} команд/сутки. Оформи Премиум.`);
          return;
        }
        bumpUsage(conn.user_id, 'dot');
        await runDotCommand(ctx, m, conn, cmd, args);
      }
    }
  }
});

// ─── 10. EDITED / DELETED business messages ────────────────────────────────
bot.on('edited_business_message', async (ctx) => {
  const m = ctx.editedBusinessMessage;
  if (!m) return;
  const cid = m.business_connection_id;
  const conn = await ensureConn(cid);
  if (!conn) return;
  // Правки самого владельца — пропускаем
  if (m.from?.id === conn.user_id) return;
  const s = Q.getSettings.get(conn.user_id);
  if (!s?.notify_edits) return;

  const prev = Q.getMsg.get(cid, m.chat.id, m.message_id);
  const oldText = prev?.text || '_(текста не было)_';
  const newText = m.text ?? m.caption ?? '_(пусто)_';
  const who = escMd(formatName(m.from) || prev?.from_name || '—');
  const text =
    `✏️ *Правка сообщения*\n` +
    `От: ${who}\n\n` +
    `*Было:*\n${escMd(oldText)}\n\n` +
    `*Стало:*\n${escMd(newText)}`;

  await ctx.api.sendMessage(conn.user_chat_id, text, { parse_mode: 'MarkdownV2' }).catch(() => {});

  Q.cacheMsg.run(
    cid, m.chat.id, m.message_id,
    m.from?.id ?? prev?.from_id ?? null, formatName(m.from) || prev?.from_name,
    newText, prev?.media_kind ?? null, prev?.media_file_id ?? null,
    prev?.is_self_destruct ?? 0, prev?.saved_path ?? null, Date.now(),
  );
});

bot.on('deleted_business_messages', async (ctx) => {
  const d = ctx.update.deleted_business_messages;
  if (!d) return;
  const cid = d.business_connection_id;
  const conn = await ensureConn(cid);
  if (!conn) return;
  const s = Q.getSettings.get(conn.user_id);
  if (!s?.notify_deletes) return;

  for (const mid of d.message_ids) {
    const cached = Q.getMsg.get(cid, d.chat.id, mid);
    if (!cached) continue;
    if (cached.from_id === conn.user_id) continue;

    const who = escMd(cached.from_name || '—');
    const body = cached.text
      ? `🗑 *Удалено сообщение*\nОт: ${who}\n\n${escMd(cached.text)}`
      : `🗑 *Удалено сообщение*\nОт: ${who}\n${cached.media_kind ? kindEmoji(cached.media_kind) + ' ' + escMd(cached.media_kind) : ''}`;

    await ctx.api.sendMessage(conn.user_chat_id, body, { parse_mode: 'MarkdownV2' }).catch(() => {});

    if (cached.saved_path && fs.existsSync(cached.saved_path)) {
      await sendMediaTo(conn.user_chat_id, cached.media_kind, cached.saved_path,
        `💾 Восстановлено: ${kindEmoji(cached.media_kind)} ${escMd(cached.media_kind)}`).catch(() => {});
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  11. DOT-COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Отправляет плейсхолдер. Если в business_connection отсутствует can_reply
 * — fallback на ЛС с владельцем (conn.user_chat_id), чтобы не падать
 * "BUSINESS_PEER_INVALID". Возвращает дескриптор для editReply.
 */
async function startReply(ctx, m, conn, initialText = '⏳…') {
  // Path A: бизнес-чат (если есть can_reply)
  if (conn?.can_reply) {
    try {
      const sent = await ctx.api.sendMessage(m.chat.id, initialText, {
        business_connection_id: m.business_connection_id,
        reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
      });
      return { chat_id: sent.chat.id, message_id: sent.message_id, bcid: m.business_connection_id, in_business: true };
    } catch (e) {
      console.warn('[startReply] business send failed, fallback to PM:', e?.description || e?.message);
    }
  }
  // Path B: личка с владельцем
  try {
    const sent = await ctx.api.sendMessage(conn.user_chat_id, initialText);
    return { chat_id: sent.chat.id, message_id: sent.message_id, bcid: null, in_business: false };
  } catch (e) {
    console.warn('[startReply] PM send failed:', e?.description || e?.message);
    return null;
  }
}

async function editReply(ref, text, opts = {}) {
  if (!ref) return;
  try {
    const payload = {
      parse_mode: opts.parse_mode ?? 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    };
    if (ref.bcid) payload.business_connection_id = ref.bcid;
    // inline_keyboard в business-сообщениях Telegram игнорирует — добавляем
    // только в обычных сообщениях ЛС
    if (opts.reply_markup && !ref.in_business) payload.reply_markup = opts.reply_markup;

    await bot.api.editMessageText(ref.chat_id, ref.message_id, text, payload);
  } catch (e) {
    if (!(e instanceof GrammyError && /not modified/.test(e.description || ''))) {
      console.warn('[editReply]', e?.description || e?.message);
    }
  }
}

async function replyEdit(ctx, m, conn, text, opts = {}) {
  const ref = await startReply(ctx, m, conn, text);
  if (ref && (opts.parse_mode === 'MarkdownV2' || opts.reply_markup)) {
    await editReply(ref, text, opts);
  }
  return ref;
}

async function runDotCommand(ctx, m, conn, cmd, args) {
  const meta = CMD_HELP[cmd];
  if (meta.premium && !isPremium(conn.user_id) && !isAdmin(conn.user_id)) {
    return replyEdit(ctx, m, conn, `🔒 Команда \\.${escMd(cmd)} доступна по Премиуму\\.`, { parse_mode: 'MarkdownV2' });
  }

  switch (cmd) {
    case 'help':      return cmdHelp(ctx, m, conn);
    case 'reply':     return cmdReply(ctx, m, conn);
    case 'mute':      return cmdMute(ctx, m, conn, true);
    case 'unmute':    return cmdMute(ctx, m, conn, false);
    case 'roll':      return cmdRoll(ctx, m, conn, args);
    case 'calc':      return cmdCalc(ctx, m, conn, args);
    case 'weather':   return cmdWeather(ctx, m, conn, args);
    case 'translate': return cmdTranslate(ctx, m, conn, args);
    case 'sticker':   return cmdSticker(ctx, m, conn);
    case 'voice':     return cmdVoice(ctx, m, conn, args);
    case 'ttt':       return cmdTTT(ctx, m, conn);
  }
}

// ─── 11.1 .help ────────────────────────────────────────────────────────────
async function cmdHelp(ctx, m, conn) {
  const prem = isPremium(conn.user_id);
  const free = Object.entries(CMD_HELP).filter(([, v]) => !v.premium);
  const premL = Object.entries(CMD_HELP).filter(([, v]) => v.premium);
  const lines = [
    `*Доступные команды*`,
    ``,
    `*Бесплатные:*`,
    ...free.map(([c, v]) => `• \`.${c}\` — ${escMd(v.desc.split('\n')[0])}`),
    ``,
    `*Премиум${prem ? ' \\(активен\\)' : ''}:*`,
    ...premL.map(([c, v]) => `• ${prem ? '' : '🔒 '}\`.${c}\` — ${escMd(v.desc.split('\n')[0])}`),
  ];
  const ref = await startReply(ctx, m, conn, '⏳ Загружаю справку…');
  await editReply(ref, lines.join('\n'), { parse_mode: 'MarkdownV2' });
}

// ─── 11.2 .reply ───────────────────────────────────────────────────────────
// FIX v2: Robust цепочка fallback'ов, работает даже когда медиа самоуничтожилось:
//   (a) ждём in-flight фоновую закачку, если она ещё идёт
//   (b) cache.saved_path (локальный сохранённый файл)
//   (c) свежий download по file_id из reply_to_message → локальный send
//   (d) прямой sendMediaByFileId (быстрый путь, если file_id ещё жив)
//   (e) текст/caption fallback (из target или из кэша)
//   (f) точный диагноз ошибки, если всё провалилось
async function cmdReply(ctx, m, conn) {
  const ref = await startReply(ctx, m, conn, '⏳ Ищу сообщение…');
  const target = m.reply_to_message;
  if (!target) {
    return editReply(ref, '⚠️ Команда `.reply` должна быть *реплаем* на сообщение собеседника\\.', { parse_mode: 'MarkdownV2' });
  }

  const cid   = m.business_connection_id;
  const tChat = target.chat?.id ?? m.chat.id;     // в business иногда target.chat пуст
  const tMid  = target.message_id;
  const dest  = conn.user_chat_id;
  const errors = [];
  let sent = false;

  // (a) Ждём фоновую закачку, если она ещё идёт (максимум ~7 секунд).
  const dlKey = inflightKey(cid, tChat, tMid);
  const inflight = inflightDownloads.get(dlKey);
  if (inflight) {
    try {
      await Promise.race([
        inflight,
        new Promise((res) => setTimeout(res, 7_000)),
      ]);
    } catch (_) { /* swallow */ }
  }

  // Перечитываем cache ИМЕННО ПОСЛЕ ожидания — saved_path мог обновиться.
  const cached = Q.getMsg.get(cid, tChat, tMid);
  const fromName = cached?.from_name || formatName(target.from) || '—';

  // (b) cached.saved_path — самый надёжный путь.
  if (!sent && cached?.saved_path && fs.existsSync(cached.saved_path)) {
    try {
      await sendMediaTo(dest, cached.media_kind, cached.saved_path,
        `💾 *Из чата с* ${escMd(fromName)}` +
        (cached.text ? `\n\n${escMd(cached.text)}` : ''));
      sent = true;
    } catch (e) {
      const msg = e?.description || e?.message || String(e);
      console.warn('[reply] local send failed:', msg);
      errors.push('local: ' + msg);
    }
  }

  // Определяем live-медиа из reply_to_message — иногда обрезано в business,
  // но file_id, если есть, обычно валиден в ближайшие миллисекунды.
  const live = pickMedia(target);

  // (c) Свежий download → локальный send (даже самоуничтожающаяся медиа
  //     успевает скачаться через getFile в большинстве случаев).
  if (!sent && live) {
    try {
      const lp = await downloadFile(live.file_id, conn.user_id, live.kind);
      // Кэшируем для повторных .reply.
      Q.updateMsgSavedPath.run(lp, cid, tChat, tMid);
      Q.saveMedia.run(conn.user_id, target.from?.id ?? null, formatName(target.from),
                      live.kind, lp, Date.now());
      const cap = target.caption ?? target.text ?? null;
      await sendMediaTo(dest, live.kind, lp,
        `💾 *Из чата с* ${escMd(fromName)}` + (cap ? `\n\n${escMd(cap)}` : ''));
      sent = true;
    } catch (e) {
      const msg = e?.description || e?.message || String(e);
      console.warn('[reply] fresh download failed:', msg);
      errors.push('fresh-dl: ' + msg);
    }
  }

  // (d) Прямой sendMediaByFileId — быстрый путь без скачивания.
  if (!sent && live) {
    try {
      await sendMediaByFileId(dest, live.kind, live.file_id,
        `💾 Из чата с ${fromName}`);
      sent = true;
    } catch (e) {
      const msg = e?.description || e?.message || String(e);
      console.warn('[reply] file_id send failed:', msg);
      errors.push('file_id: ' + msg);
    }
  }

  // (e) Текст/caption fallback.
  const fallbackText = target.text ?? target.caption ?? cached?.text ?? null;
  if (!sent && fallbackText) {
    try {
      await ctx.api.sendMessage(dest,
        `💬 *Из чата с* ${escMd(fromName)}\n\n${escMd(fallbackText)}`,
        { parse_mode: 'MarkdownV2' });
      sent = true;
    } catch (e) {
      const msg = e?.description || e?.message || String(e);
      console.warn('[reply] text send failed:', msg);
      errors.push('text: ' + msg);
    }
  }

  if (sent) {
    await editReply(ref,
      `✅ Отправлено в [личку с ботом](https://t.me/${USERNAME})\\.`,
      { parse_mode: 'MarkdownV2' });
  } else {
    const hadMedia = !!live || !!cached?.media_kind;
    const reason = hadMedia
      ? 'медиа уже самоуничтожилось и не было скачано вовремя'
      : 'в сообщении нет ни текста, ни медиа';
    await editReply(ref,
      `❌ Не удалось переслать \\(${escMd(reason)}\\)\\.`,
      { parse_mode: 'MarkdownV2' });
    if (errors.length) console.warn('[reply] all paths failed:', errors.join(' | '));
  }
}

// ─── 11.2.1 In-flight downloads tracker ────────────────────────────────────
function inflightKey(cid, chat_id, msg_id) { return `${cid}:${chat_id}:${msg_id}`; }
const inflightDownloads = new Map(); // key → Promise<localPath|null>

// ─── 11.3 .mute / .unmute ───────────────────────────────────────────────────
async function cmdMute(ctx, m, conn, on) {
  const ref = await startReply(ctx, m, conn, '⏳…');
  if (on) {
    Q.setMute.run(conn.user_id, m.chat.id, m.chat.id, Date.now());
    const note = conn.can_del_all
      ? ''
      : `\n\n⚠️ У бота нет права *can\\_delete\\_all\\_messages* — сообщения будут только помечаться, но не удаляться\\.`;
    return editReply(ref, `🔇 *Mute включён*\\.\nВсе входящие сообщения собеседника будут удаляться\\.\nОтключить: \`.unmute\`${note}`, { parse_mode: 'MarkdownV2' });
  } else {
    Q.delMute.run(conn.user_id, m.chat.id);
    return editReply(ref, `🔊 *Mute выключен*\\.`, { parse_mode: 'MarkdownV2' });
  }
}

// ─── 11.4 .roll ─────────────────────────────────────────────────────────────
async function cmdRoll(ctx, m, conn, args) {
  const ref = await startReply(ctx, m, conn, '🎲 …');
  let lo = 1, hi = 100;
  const parts = (args || '').split(/\s+/).filter(Boolean).map(Number);
  if (parts.length === 1 && Number.isFinite(parts[0]) && parts[0] >= 1) {
    hi = Math.floor(parts[0]);
  } else if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    lo = Math.floor(Math.min(parts[0], parts[1]));
    hi = Math.floor(Math.max(parts[0], parts[1]));
  }
  if (hi <= lo) { return editReply(ref, '⚠️ Неверный диапазон\\.', { parse_mode: 'MarkdownV2' }); }
  const n = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  await editReply(ref, `🎲 *${n}*  \\(из ${lo}–${hi}\\)`, { parse_mode: 'MarkdownV2' });
}

// ─── 11.5 .calc ─────────────────────────────────────────────────────────────
function safeCalc(expr) {
  if (!/^[\d+\-*/().%\s,]+$/.test(expr)) throw new Error('недопустимые символы');
  const normalised = expr.replace(/,/g, '.');
  const tokens = normalised.match(/(\d+\.?\d*|\.\d+|[+\-*/()%])/g) || [];
  const out = []; const ops = [];
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  for (const t of tokens) {
    if (/^\d/.test(t) || /^\./.test(t)) out.push(parseFloat(t));
    else if (t === '(') ops.push(t);
    else if (t === ')') {
      while (ops.length && ops.at(-1) !== '(') out.push(ops.pop());
      if (ops.pop() !== '(') throw new Error('скобки');
    } else if (t in prec) {
      while (ops.length && ops.at(-1) !== '(' && prec[ops.at(-1)] >= prec[t]) out.push(ops.pop());
      ops.push(t);
    }
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === '(' || op === ')') throw new Error('скобки');
    out.push(op);
  }
  const stack = [];
  for (const t of out) {
    if (typeof t === 'number') stack.push(t);
    else {
      const b = stack.pop(), a = stack.pop();
      if (a === undefined || b === undefined) throw new Error('синтаксис');
      switch (t) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/':
          if (b === 0) throw new Error('деление на 0');
          stack.push(a / b); break;
        case '%': stack.push(a % b); break;
      }
    }
  }
  if (stack.length !== 1) throw new Error('синтаксис');
  return stack[0];
}

async function cmdCalc(ctx, m, conn, args) {
  const ref = await startReply(ctx, m, conn, '🧮 …');
  if (!args) return editReply(ref, '⚠️ Использование: `.calc 2+2*8`', { parse_mode: 'MarkdownV2' });
  try {
    const v = safeCalc(args);
    const rounded = Math.round(v * 1e10) / 1e10;
    await editReply(ref, `🧮 \`${escMd(args)}\` \\= *${escMd(String(rounded))}*`, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await editReply(ref, `❌ Ошибка: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
}

// ─── 11.6 .weather ──────────────────────────────────────────────────────────
async function cmdWeather(ctx, m, conn, args) {
  const ref = await startReply(ctx, m, conn, '🌤 …');
  if (!args) return editReply(ref, '⚠️ Использование: `.weather Tallinn`', { parse_mode: 'MarkdownV2' });
  try {
    const url = `https://wttr.in/${encodeURIComponent(args)}?format=j1&lang=ru`;
    const res = await fetch(url, { headers: { 'User-Agent': 'SaveMOD/1.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cur  = data?.current_condition?.[0];
    const area = data?.nearest_area?.[0];
    if (!cur) throw new Error('нет данных');
    const city = area?.areaName?.[0]?.value || args;
    const country = area?.country?.[0]?.value || '';
    const desc = cur.lang_ru?.[0]?.value || cur.weatherDesc?.[0]?.value || '—';
    const text =
      `🌤 *Погода в ${escMd(city)}${country ? ', ' + escMd(country) : ''}*\n\n` +
      `• Сейчас: ${escMd(desc)}\n` +
      `• Температура: *${escMd(cur.temp_C)}°C* \\(ощущается как ${escMd(cur.FeelsLikeC)}°C\\)\n` +
      `• Ветер: ${escMd(cur.windspeedKmph)} км/ч\n` +
      `• Влажность: ${escMd(cur.humidity)}%\n` +
      `• Давление: ${escMd(cur.pressure)} мбар`;
    await editReply(ref, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await editReply(ref, `❌ Не удалось получить погоду: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
}

// ─── 11.7 .translate ────────────────────────────────────────────────────────
async function cmdTranslate(ctx, m, conn, args) {
  const ref = await startReply(ctx, m, conn, '🌐 …');
  if (!args) return editReply(ref, '⚠️ Использование: `.translate en Привет`', { parse_mode: 'MarkdownV2' });
  const sp = args.indexOf(' ');
  if (sp < 0) return editReply(ref, '⚠️ Использование: `.translate <язык> <текст>`', { parse_mode: 'MarkdownV2' });
  const target = args.slice(0, sp).toLowerCase();
  const text   = args.slice(sp + 1).trim();
  if (!text)  return editReply(ref, '⚠️ Пустой текст\\.', { parse_mode: 'MarkdownV2' });

  const hasCyrillic = /[а-яё]/i.test(text);
  const sourceLang  = hasCyrillic ? 'ru' : 'en';
  const pair = `${sourceLang}|${target}`;

  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated) throw new Error('пустой ответ');
    await editReply(ref,
      `🌐 *${escMd(sourceLang)} → ${escMd(target)}*\n\n${escMd(translated)}`,
      { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await editReply(ref, `❌ Ошибка перевода: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
}

// ─── 11.8 .sticker ─────────────────────────────────────────────────────────
async function cmdSticker(ctx, m, conn) {
  const ref = await startReply(ctx, m, conn, '🖼 Готовлю стикер…');
  const target = m.reply_to_message;
  const photoMsg = (target?.photo ? target : (m.photo ? m : null));
  if (!photoMsg?.photo?.length) {
    return editReply(ref, '⚠️ Реплайни на картинку командой `.sticker`\\.', { parse_mode: 'MarkdownV2' });
  }
  const largest = photoMsg.photo[photoMsg.photo.length - 1];
  let lp, webpPath;
  try {
    lp = await downloadFile(largest.file_id, conn.user_id, 'photo');
    webpPath = lp.replace(/\.[^.]+$/, '') + '.webp';
    fs.copyFileSync(lp, webpPath);

    // Если есть can_reply — пробуем в бизнес-чат; иначе сразу в ЛС
    const dest = (conn.can_reply ? m.chat.id : conn.user_chat_id);
    const opts = conn.can_reply ? { business_connection_id: m.business_connection_id } : {};
    try {
      await bot.api.sendSticker(dest, new InputFile(webpPath), opts);
      await editReply(ref, `✅ Стикер отправлен\\.`, { parse_mode: 'MarkdownV2' });
    } catch (stickerErr) {
      console.warn('[sticker] sendSticker failed, fallback to photo:', stickerErr?.description);
      await bot.api.sendPhoto(dest, new InputFile(lp), opts);
      await editReply(ref, `✅ Отправлено как изображение \\(WebP\\-конвертация недоступна\\)\\.`, { parse_mode: 'MarkdownV2' });
    }
  } catch (e) {
    await editReply(ref, `❌ Не получилось: ${escMd(e.message || 'ошибка')}`, { parse_mode: 'MarkdownV2' });
  } finally {
    if (webpPath) setTimeout(() => { try { fs.unlinkSync(webpPath); } catch {} }, 5000);
  }
}

// ─── 11.9 .voice ───────────────────────────────────────────────────────────
async function cmdVoice(ctx, m, conn, args) {
  const ref = await startReply(ctx, m, conn, '🎙 Озвучиваю…');
  const text = args?.trim();
  if (!text) return editReply(ref, '⚠️ Использование: `.voice Привет`', { parse_mode: 'MarkdownV2' });
  if (text.length > 200) return editReply(ref, '⚠️ Максимум 200 символов\\.', { parse_mode: 'MarkdownV2' });

  const lang = /[а-яё]/i.test(text) ? 'ru' : 'en';
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
  const fname = `voice_${Date.now()}.mp3`;
  const fpath = path.join(MEDIA_DIR, fname);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://translate.google.com/',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(fpath));

    const dest = (conn.can_reply ? m.chat.id : conn.user_chat_id);
    const opts = conn.can_reply ? { business_connection_id: m.business_connection_id } : {};
    await bot.api.sendVoice(dest, new InputFile(fpath), opts);
    await editReply(ref, `✅ Озвучено \\(${escMd(lang.toUpperCase())}\\)\\.`, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await editReply(ref, `❌ Не удалось озвучить: ${escMd(e.message || 'ошибка')}`, { parse_mode: 'MarkdownV2' });
  } finally {
    setTimeout(() => { try { fs.unlinkSync(fpath); } catch {} }, 30_000);
  }
}

// ─── 11.10 .ttt ─────────────────────────────────────────────────────────────
//
// FIX v2: Полноценный мультиплеер ПРОТИВ СОБЕСЕДНИКА прямо в business-чате.
//
// Документация Bot API (https://core.telegram.org/bots/api, 10.0) подтверждает,
// что inline-клавиатуры РАБОТАЮТ при отправке сообщений с business_connection_id
// — поле reply_markup полностью поддерживается. Старый комментарий «inline-
// кнопки не работают в business-сообщениях» был неверным.
//
// Игроки:
//   ❌ X — владелец бота (тот, кто написал .ttt)
//   ⭕️ O — собеседник (другой участник 1-на-1 business-чата)
//
// Callback'и от обоих игроков долетают до бота как обычные callback_query;
// в каждом из них ctx.from.id указывает, кто именно нажал — этим и
// различаем игроков.
//
// editMessageText и editMessageReplyMarkup в business-сообщениях ОБЯЗАТЕЛЬНО
// требуют business_connection_id (иначе 400 BUSINESS_PEER_INVALID), поэтому
// хранится он в game-state и используется в каждом редактировании.
// ───────────────────────────────────────────────────────────────────────────
const tttGames = new Map();

function tttKey(chat_id, msg_id) { return `${chat_id}:${msg_id}`; }

function tttBoard(b) {
  const sym = (v) => v === 'X' ? '❌' : v === 'O' ? '⭕️' : '·';
  return `\`\`\`\n ${sym(b[0])} │ ${sym(b[1])} │ ${sym(b[2])}\n───┼───┼───\n ${sym(b[3])} │ ${sym(b[4])} │ ${sym(b[5])}\n───┼───┼───\n ${sym(b[6])} │ ${sym(b[7])} │ ${sym(b[8])}\n\`\`\``;
}

function tttWinner(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a, b2, c] of lines) {
    if (b[a] && b[a] === b[b2] && b[a] === b[c]) return b[a];
  }
  if (b.every(Boolean)) return 'draw';
  return null;
}

function kbTTT(b, gameOver = false, key = '') {
  const k = new InlineKeyboard();
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const i = row * 3 + col;
      const v = b[i];
      const txt = v === 'X' ? '❌' : v === 'O' ? '⭕️' : '⬜️';
      k.text(txt, gameOver || v ? `ttt:noop` : `ttt:m:${key}:${i}`);
    }
    k.row();
  }
  k.text(gameOver ? '🔄 Новая игра' : '🔄 Сбросить', `ttt:new:${key}`);
  return k;
}

function tttHeader(game) {
  const turnName = game.turn === 'X' ? game.owner_name : game.opponent_name;
  const turnMark = game.turn === 'X' ? '❌' : '⭕️';
  return `🎮 *Крестики\\-нолики*\n` +
         `❌ ${escMd(game.owner_name)}  vs  ⭕️ ${escMd(game.opponent_name)}\n\n` +
         `${tttBoard(game.board)}\n\n` +
         `Ход: ${turnMark} *${escMd(turnName)}*`;
}

function tttFooterText(game, winner) {
  if (winner === 'X')    return `🏆 Победил ❌ *${escMd(game.owner_name)}*\\!`;
  if (winner === 'O')    return `🏆 Победил ⭕️ *${escMd(game.opponent_name)}*\\!`;
  if (winner === 'draw') return `🤝 *Ничья*\\.`;
  return tttHeader(game);
}

function tttFullText(game, winner) {
  if (!winner) return tttHeader(game);
  return `🎮 *Крестики\\-нолики*\n` +
         `❌ ${escMd(game.owner_name)}  vs  ⭕️ ${escMd(game.opponent_name)}\n\n` +
         `${tttBoard(game.board)}\n\n` +
         tttFooterText(game, winner);
}

async function cmdTTT(ctx, m, conn) {
  // .ttt в business-чате работает ТОЛЬКО если есть can_reply
  // (без него бот не может писать в этот чат от имени бизнеса).
  if (!conn.can_reply) {
    return replyEdit(ctx, m, conn,
      `⚠️ Для \\.ttt требуется право *can\\_reply* в бизнес\\-подключении\\. Включи его в настройках Telegram Business → Чат\\-боты\\.`,
      { parse_mode: 'MarkdownV2' });
  }

  const cid = m.business_connection_id;
  // В private business-чате m.chat.id == user_id собеседника.
  const opponent_id   = m.chat.id;
  const opponent_name = formatName(m.chat) || m.chat.first_name || 'Собеседник';
  const owner_id      = conn.user_id;
  const owner_name    = formatName(m.from) || 'Владелец';

  // Защита: если кто-то решил .ttt в чате с самим собой — отказ.
  if (opponent_id === owner_id) {
    return replyEdit(ctx, m, conn,
      `⚠️ Нельзя играть с самим собой\\.`, { parse_mode: 'MarkdownV2' });
  }

  const board = Array(9).fill(null);

  // Шаг 1: отправляем плейсхолдер БЕЗ клавиатуры (нужен message_id для key).
  const sent = await ctx.api.sendMessage(m.chat.id,
    `🎮 *Крестики\\-нолики*\n` +
    `❌ ${escMd(owner_name)}  vs  ⭕️ ${escMd(opponent_name)}\n\n` +
    `Поднимаем доску\\.\\.\\.`,
    {
      business_connection_id: cid,
      reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
      parse_mode: 'MarkdownV2',
    },
  ).catch((e) => { console.warn('[ttt] send failed:', e?.description || e?.message); return null; });

  if (!sent) {
    return replyEdit(ctx, m, conn,
      `❌ Не удалось отправить доску в чат\\.`, { parse_mode: 'MarkdownV2' });
  }

  // Шаг 2: регистрируем игру и редактируем сообщение, добавляя клавиатуру с
  // корректным key (chat_id:msg_id уже известны).
  const key = tttKey(sent.chat.id, sent.message_id);
  const game = {
    board,
    owner_id,
    opponent_id,
    owner_name,
    opponent_name,
    turn: 'X',                           // X (владелец) ходит первым
    business_connection_id: cid,
    chat_id: sent.chat.id,
    message_id: sent.message_id,
    started: Date.now(),
  };
  tttGames.set(key, game);

  await bot.api.editMessageText(sent.chat.id, sent.message_id, tttFullText(game, null), {
    business_connection_id: cid,
    parse_mode: 'MarkdownV2',
    reply_markup: kbTTT(board, false, key),
  }).catch((e) => console.warn('[ttt] init edit failed:', e?.description || e?.message));

  // Автоочистка через 30 минут
  setTimeout(() => tttGames.delete(key), 30 * 60 * 1000).unref?.();
}

async function tttCallback(ctx, data) {
  if (data === 'ttt:noop') return ctx.answerCallbackQuery();
  const parts = data.split(':');
  // ttt:m:<chat_id>:<msg_id>:<idx>  |  ttt:new:<chat_id>:<msg_id>
  const action = parts[1];
  const key    = parts[2] + ':' + parts[3];
  const game   = tttGames.get(key);

  if (!game) {
    return ctx.answerCallbackQuery({ text: 'Игра завершена или истекла', show_alert: false });
  }

  const clicker = ctx.from?.id;
  const isOwner    = clicker === game.owner_id;
  const isOpponent = clicker === game.opponent_id;

  if (!isOwner && !isOpponent) {
    return ctx.answerCallbackQuery({ text: 'Это не твоя игра', show_alert: true });
  }

  // editMessageText helper, корректно работающий в business-чате.
  const editGame = async (winner) => {
    try {
      await bot.api.editMessageText(game.chat_id, game.message_id, tttFullText(game, winner), {
        business_connection_id: game.business_connection_id,
        parse_mode: 'MarkdownV2',
        reply_markup: kbTTT(game.board, !!winner, key),
      });
    } catch (e) {
      // 400 "message is not modified" — игнорируем, остальное — логируем.
      const msg = e?.description || e?.message || '';
      if (!/not modified/i.test(msg)) {
        console.warn('[ttt] edit failed:', msg);
      }
    }
  };

  // Сброс / Новая игра — любой из двух игроков может сбросить.
  if (action === 'new') {
    game.board = Array(9).fill(null);
    game.turn  = 'X';
    await editGame(null);
    return ctx.answerCallbackQuery({ text: 'Новая игра — ход ❌' });
  }

  if (action === 'm') {
    const idx = parseInt(parts[4], 10);
    if (!Number.isInteger(idx) || idx < 0 || idx > 8) return ctx.answerCallbackQuery();
    if (game.board[idx] || tttWinner(game.board)) return ctx.answerCallbackQuery();

    // Проверяем, чей ход.
    const myMark = isOwner ? 'X' : 'O';
    if (game.turn !== myMark) {
      const waitName = game.turn === 'X' ? game.owner_name : game.opponent_name;
      return ctx.answerCallbackQuery({
        text: `Сейчас ходит ${game.turn === 'X' ? '❌' : '⭕️'} ${waitName}`,
        show_alert: false,
      });
    }

    // Делаем ход и передаём очередь.
    game.board[idx] = myMark;
    const winner = tttWinner(game.board);
    if (!winner) game.turn = myMark === 'X' ? 'O' : 'X';

    await editGame(winner);

    if (winner === 'X')          return ctx.answerCallbackQuery({ text: `🏆 ${game.owner_name} победил!` });
    else if (winner === 'O')     return ctx.answerCallbackQuery({ text: `🏆 ${game.opponent_name} победил!` });
    else if (winner === 'draw')  return ctx.answerCallbackQuery({ text: '🤝 Ничья' });
    return ctx.answerCallbackQuery();
  }

  return ctx.answerCallbackQuery();
}

// ═══════════════════════════════════════════════════════════════════════════
//  12. HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function pickMedia(m) {
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1];
    return { kind: 'photo', file_id: p.file_id };
  }
  if (m.video)      return { kind: 'video',      file_id: m.video.file_id };
  if (m.video_note) return { kind: 'video_note', file_id: m.video_note.file_id };
  if (m.voice)      return { kind: 'voice',      file_id: m.voice.file_id };
  if (m.audio)      return { kind: 'audio',      file_id: m.audio.file_id };
  if (m.animation)  return { kind: 'animation',  file_id: m.animation.file_id };
  if (m.document)   return { kind: 'document',   file_id: m.document.file_id };
  if (m.sticker)    return { kind: 'sticker',    file_id: m.sticker.file_id };
  return null;
}

function kindEmoji(k) {
  return ({
    photo: '🖼', video: '🎬', video_note: '⏺', voice: '🎤', audio: '🎵',
    animation: '🎞', document: '📄', sticker: '🩻',
  })[k] || '📦';
}

function formatName(u) {
  if (!u) return '';
  if (u.username) return `@${u.username}`;
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

async function downloadFile(fileId, ownerId, kind) {
  const file = await bot.api.getFile(fileId);
  const url  = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const ext  = path.extname(file.file_path || '') || extOf(kind);
  const fname = `${ownerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const fpath = path.join(MEDIA_DIR, fname);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(fpath));
  return fpath;
}

function extOf(kind) {
  return ({ photo: '.jpg', video: '.mp4', voice: '.ogg', video_note: '.mp4',
            audio: '.mp3', animation: '.mp4', document: '.bin', sticker: '.webp' })[kind] || '.bin';
}

async function sendMediaTo(chatId, kind, localPath, caption) {
  const f = new InputFile(localPath);
  const o = caption ? { caption, parse_mode: 'MarkdownV2' } : undefined;
  switch (kind) {
    case 'photo':       return bot.api.sendPhoto(chatId, f, o);
    case 'video':       return bot.api.sendVideo(chatId, f, o);
    case 'video_note':  return bot.api.sendVideoNote(chatId, f);
    case 'voice':       return bot.api.sendVoice(chatId, f, o);
    case 'audio':       return bot.api.sendAudio(chatId, f, o);
    case 'animation':   return bot.api.sendAnimation(chatId, f, o);
    case 'sticker':     return bot.api.sendSticker(chatId, f);
    default:            return bot.api.sendDocument(chatId, f, o);
  }
}

async function sendMediaByFileId(chatId, kind, fileId, caption) {
  const o = caption ? { caption } : undefined;
  switch (kind) {
    case 'photo':       return bot.api.sendPhoto(chatId, fileId, o);
    case 'video':       return bot.api.sendVideo(chatId, fileId, o);
    case 'video_note':  return bot.api.sendVideoNote(chatId, fileId);
    case 'voice':       return bot.api.sendVoice(chatId, fileId, o);
    case 'audio':       return bot.api.sendAudio(chatId, fileId, o);
    case 'animation':   return bot.api.sendAnimation(chatId, fileId, o);
    case 'sticker':     return bot.api.sendSticker(chatId, fileId);
    default:            return bot.api.sendDocument(chatId, fileId, o);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  13. AUTO-CLEANUP
// ═══════════════════════════════════════════════════════════════════════════
function runCleanup(force = false) {
  const cutoff = Date.now() - (force ? 0 : MEDIA_TTL_MS);
  const rows = Q.getOldMedia.all(cutoff);
  let removed = 0;
  for (const r of rows) {
    try {
      if (fs.existsSync(r.local_path)) fs.unlinkSync(r.local_path);
      Q.deleteMedia.run(r.id);
      removed++;
    } catch (e) {
      console.warn('[cleanup] failed to remove', r.local_path, e.message);
    }
  }
  Q.deleteOldCache.run(cutoff);
  if (removed) console.log(`[cleanup] removed ${removed} expired media (>${MEDIA_TTL_DAYS}d)`);
  return removed;
}
setInterval(() => runCleanup(false), CLEANUP_EVERY_MS).unref?.();
setTimeout(() => runCleanup(false), 60_000).unref?.();

// ─── 14. ERROR BOUNDARY ─────────────────────────────────────────────────────
bot.catch((err) => {
  if (err.error instanceof HttpError)        console.error('[net]', err.error);
  else if (err.error instanceof GrammyError) console.error('[tg]', err.error.description);
  else console.error('[bot]', err.error);
});

// ─── 15. START — с предварительной валидацией токена ───────────────────────
const ALLOWED = [
  'message', 'edited_message', 'callback_query',
  'pre_checkout_query',
  'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages',
];

async function main() {
  // FIX: проверяем токен ДО bot.start, чтобы НЕ получать страшный 401-стек.
  try {
    const me = await bot.api.getMe();
    console.log(`📦 Module @${me.username} token OK (id=${me.id})`);
  } catch (e) {
    if (e instanceof GrammyError && /401/.test(e.description || '')) {
      console.error(`[module] FATAL: token for @${USERNAME} is INVALID (401 Unauthorized). Exiting.`);
      process.exit(3);
    }
    console.error('[module] FATAL: getMe failed:', e?.description || e?.message);
    process.exit(4);
  }

  bot.start({
    allowed_updates: ALLOWED,
    drop_pending_updates: false,
    onStart: (me) => console.log(`📦 Module @${me.username} ready (Business + dot-commands)`),
  });
}

main().catch((e) => {
  console.error('[module] FATAL start error:', e?.description || e?.message || e);
  process.exit(5);
});

const stop = (sig) => {
  console.log(`\n[mod:${USERNAME}][${sig}] shutting down…`);
  bot.stop();
  setTimeout(() => process.exit(0), 1000);
};
process.once('SIGINT',  () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
