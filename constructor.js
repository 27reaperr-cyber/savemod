// ════════════════════════════════════════════════════════════════════════════
//  SaveMOD — Bot Constructor (Bot API 10.0, May 2026) — FIXED build
//  ───────────────────────────────────────────────────────────────────────────
//  ИСПРАВЛЕНИЯ В ЭТОЙ ВЕРСИИ:
//   • getManagedBotToken теперь вызывается через bot.api.raw с правильным
//     payload-объектом { user_id: ... } — grammY автогенерирует методы как
//     payload-only, передавать голое число НЕЛЬЗЯ (это и было причиной 401).
//   • Перед сохранением токен валидируется вызовом getMe — если токен битый,
//     модуль не спавнится, в БД мусор не пишется.
//   • Авторестарт при 401 теперь НЕ перезапускает бесконечно: токен помечается
//     как невалидный, владельцу шлётся уведомление с кнопкой «🔁 Запросить
//     токен».
//   • spawnModuleFor больше не пишет в БД невалидный токен.
//   • Удалены битые символы в текстах, добавлены прочие мелкие фиксы.
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Bot, InlineKeyboard, GrammyError, HttpError, InputFile } from 'grammy';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// ─── 0. ENV ─────────────────────────────────────────────────────────────────
const TOKEN     = process.env.CONSTRUCTOR_BOT_TOKEN;
const MANAGER   = (process.env.CONSTRUCTOR_BOT_USERNAME || '').replace(/^@/, '');
const DB_PATH   = process.env.CONSTRUCTOR_DB || './constructor.db';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);

if (!TOKEN)   throw new Error('CONSTRUCTOR_BOT_TOKEN is missing in .env');
if (!MANAGER) throw new Error('CONSTRUCTOR_BOT_USERNAME is missing in .env');

const FREE_LIMIT    = 5;
const PREMIUM_LIMIT = 10;
const PREMIUM_PRICE = 200; // XTR
const PREMIUM_DAYS  = 30;

const DEFAULT_BOT_NAME     = 'SaveBot';
const DEFAULT_BOT_USERNAME = 'SaveBot';

// Telegram token format (used for "attach by token" path)
const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

// ─── 1. DATABASE ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id        INTEGER PRIMARY KEY,
    username       TEXT,
    first_name     TEXT,
    premium_until  INTEGER DEFAULT 0,
    is_banned      INTEGER DEFAULT 0,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bots (
    bot_id        INTEGER PRIMARY KEY,
    owner_id      INTEGER NOT NULL,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL,
    token         TEXT,
    members       INTEGER DEFAULT 0,
    enabled       INTEGER DEFAULT 1,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS payments (
    payload     TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    charge_id   TEXT,
    stars       INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bots_owner    ON bots(owner_id);
  CREATE INDEX IF NOT EXISTS idx_bots_enabled  ON bots(enabled);
  CREATE INDEX IF NOT EXISTS idx_users_premium ON users(premium_until);
`);
try { db.exec(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`); } catch {}

const Q = {
  upsertUser: db.prepare(`
    INSERT INTO users (user_id, username, first_name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username   = excluded.username,
      first_name = excluded.first_name`),
  getUser:     db.prepare(`SELECT * FROM users WHERE user_id = ?`),
  setPremium:  db.prepare(`UPDATE users SET premium_until = ? WHERE user_id = ?`),
  setBan:      db.prepare(`UPDATE users SET is_banned = ? WHERE user_id = ?`),
  allUsers:    db.prepare(`SELECT * FROM users ORDER BY created_at DESC`),
  allActiveUsers: db.prepare(`SELECT user_id FROM users WHERE is_banned = 0`),
  searchUsers: db.prepare(`
    SELECT * FROM users
    WHERE CAST(user_id AS TEXT) LIKE ? OR username LIKE ? OR first_name LIKE ?
    ORDER BY created_at DESC LIMIT 20`),
  countUsers:   db.prepare(`SELECT COUNT(*) AS c FROM users`),
  countPremium: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE premium_until > ?`),
  countBanned:  db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_banned = 1`),
  countNew24h:  db.prepare(`SELECT COUNT(*) AS c FROM users WHERE created_at > ?`),

  listBots:        db.prepare(`SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at ASC`),
  countBots:       db.prepare(`SELECT COUNT(*) AS c FROM bots WHERE owner_id = ?`),
  countAllBots:    db.prepare(`SELECT COUNT(*) AS c FROM bots`),
  countActiveBots: db.prepare(`SELECT COUNT(*) AS c FROM bots WHERE enabled = 1 AND token IS NOT NULL`),
  getBot:            db.prepare(`SELECT * FROM bots WHERE bot_id = ?`),
  getBotByUsername:  db.prepare(`SELECT * FROM bots WHERE username = ? COLLATE NOCASE`),
  insertBot: db.prepare(`
    INSERT INTO bots (bot_id, owner_id, username, display_name, token, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id) DO UPDATE SET
      owner_id     = excluded.owner_id,
      username     = excluded.username,
      display_name = excluded.display_name,
      token        = COALESCE(excluded.token, bots.token)`),
  updateBotToken:  db.prepare(`UPDATE bots SET token = ? WHERE bot_id = ?`),
  clearBotToken:   db.prepare(`UPDATE bots SET token = NULL WHERE bot_id = ?`),
  updateBotMeta:   db.prepare(`UPDATE bots SET username = ?, display_name = ? WHERE bot_id = ?`),
  delBot:          db.prepare(`DELETE FROM bots WHERE bot_id = ? AND owner_id = ?`),
  toggleBot:       db.prepare(`UPDATE bots SET enabled = NOT enabled WHERE bot_id = ?`),
  countPaymentsSum: db.prepare(`SELECT COALESCE(SUM(stars),0) AS s FROM payments`),

  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

  addPayment: db.prepare(`
    INSERT OR IGNORE INTO payments (payload, user_id, charge_id, stars, created_at)
    VALUES (?, ?, ?, ?, ?)`),
};

function getSet(key, fallback = '') {
  return Q.getSetting.get(key)?.value ?? fallback;
}
function setSet(key, value) { Q.setSetting.run(key, String(value ?? '')); }

const DEFAULTS = {
  required_channel:     '',
  required_channel_url: '',
  instruction_url:      process.env.INSTRUCTION_URL || 'https://telegra.ph/SaveMOD',
  support_url:          process.env.SUPPORT_CHANNEL || 'https://t.me/savemod',
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (Q.getSetting.get(k) == null) setSet(k, v);
}

// ─── 2. UTILS ───────────────────────────────────────────────────────────────
function escMd(s = '') { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m); }
const isAdmin   = (id) => ADMIN_IDS.includes(id);
const isPremium = (u)  => (u?.premium_until ?? 0) > Date.now();
const limitOf   = (u)  => (isPremium(u) ? PREMIUM_LIMIT : FREE_LIMIT);
const fmtDate   = (ts) => ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—';

/**
 * Универсальная вытяжка токена из ответа Telegram API:
 * методы getManagedBotToken / replaceManagedBotToken возвращают строку
 * (по доке Bot API 9.6). Некоторые промежуточные версии grammY/HTTP клиента
 * могут обернуть в { token: "..." } — поддерживаем оба варианта.
 */
function extractToken(res) {
  if (!res) return null;
  if (typeof res === 'string' && TOKEN_RE.test(res.trim())) return res.trim();
  if (typeof res === 'object') {
    const cand = res.token || res.bot_token || res.result;
    if (typeof cand === 'string' && TOKEN_RE.test(cand.trim())) return cand.trim();
  }
  return null;
}

/**
 * Запрос токена управляемого бота. Использует bot.api.raw — это самый
 * надёжный путь для методов, которые могут отсутствовать в типах grammY,
 * либо если версия grammY старее Bot API 9.6. Передаём именно объект
 * { user_id }, как требует Bot API.
 */
async function callGetManagedBotToken(api, userId) {
  return api.raw.getManagedBotToken({ user_id: userId });
}

/** Проверка валидности токена через getMe. Возвращает me или бросает. */
async function verifyToken(token) {
  const probe = new Bot(token);
  return probe.api.getMe(); // бросит на 401
}

// ─── 3. KEYBOARDS ───────────────────────────────────────────────────────────
const kb = {
  start: (admin) => {
    const k = new InlineKeyboard().text('🤖 Мои боты', 'menu:bots').row();
    if (admin) k.text('🛠 Админ-панель', 'admin:home').row();
    return k;
  },

  bots: (list, user) => {
    const k = new InlineKeyboard();
    for (const b of list) {
      const dot = b.token ? (b.enabled ? '🟢' : '⚪️') : '⚠️';
      k.text(`${dot} @${b.username}`, `bot:${b.bot_id}`).row();
    }
    const lim = limitOf(user);
    if (list.length < lim) {
      k.text('✨ Создать бота', 'bots:create')
       .text('➕ Добавить токеном', 'bots:attach').row();
    }
    k.text(`⭐ Премиум${isPremium(user) ? ' ✅' : ''}`, 'menu:premium').row();
    k.text('‹ Назад', 'menu:home');
    return k;
  },

  createConfirm: () => {
    const safeUser = encodeURIComponent(DEFAULT_BOT_USERNAME);
    const safeName = encodeURIComponent(DEFAULT_BOT_NAME);
    const url = `https://t.me/newbot/${MANAGER}/${safeUser}?name=${safeName}`;
    return new InlineKeyboard()
      .url('✨ Открыть окно создания', url).row()
      .text('🔄 Обновить', 'menu:bots').row()
      .text('‹ Назад', 'menu:bots');
  },

  attachInstr: () => new InlineKeyboard()
    .url('🤖 Открыть @BotFather', 'https://t.me/BotFather').row()
    .text('‹ Назад', 'menu:bots'),

  botCard: (b) => {
    const k = new InlineKeyboard().url('🔗 Открыть', `https://t.me/${b.username}`).row();
    if (!b.token) k.text('🔁 Запросить токен', `bot:retoken:${b.bot_id}`).row();
    else          k.text('🔄 Перезапустить модуль', `bot:restart:${b.bot_id}`).row();
    k.text(b.enabled ? '⏸ Выключить' : '▶️ Включить', `bot:toggle:${b.bot_id}`).row()
     .text('🗑 Удалить', `bot:delete:${b.bot_id}`).row()
     .text('‹ Назад', 'menu:bots');
    return k;
  },

  premium: (user) => {
    const k = new InlineKeyboard();
    if (!isPremium(user)) k.text(`Купить за ${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн.`, 'premium:buy').row();
    k.text('‹ Назад', 'menu:home');
    return k;
  },

  subscribe: () => {
    const url = getSet('required_channel_url') || (() => {
      const ch = getSet('required_channel');
      return ch.startsWith('@') ? `https://t.me/${ch.slice(1)}` : '';
    })();
    const k = new InlineKeyboard();
    if (url) k.url('📢 Подписаться', url).row();
    k.text('✅ Я подписался', 'sub:check');
    return k;
  },

  admin: () => new InlineKeyboard()
    .text('📊 Статистика',     'admin:stats').row()
    .text('📢 Канал подписки', 'admin:channel')
    .text('🔗 Ссылки',         'admin:links').row()
    .text('📣 Рассылка',       'admin:broadcast')
    .text('⭐ Премиум юзеру',  'admin:grant').row()
    .text('👥 Список юзеров',  'admin:users')
    .text('🚫 Бан / разбан',   'admin:ban').row()
    .text('🤖 Все боты',       'admin:allbots')
    .text('🔄 Перезапуск всех','admin:restartall').row()
    .text('📥 Экспорт CSV',    'admin:export').row()
    .text('‹ Назад',           'menu:home'),

  adminBack:   () => new InlineKeyboard().text('‹ Назад', 'admin:home'),
  cancelInput: () => new InlineKeyboard().text('✖️ Отмена', 'admin:home'),

  channelMenu: (hasChannel) => {
    const k = new InlineKeyboard();
    if (hasChannel) k.text('🔌 Отключить подписку', 'admin:channel:off').row();
    k.text('✏️ Ввести вручную', 'admin:channel:input').row();
    k.text('‹ Назад', 'admin:home');
    return k;
  },

  banMenu: () => new InlineKeyboard()
    .text('🚫 Забанить', 'admin:ban:doban')
    .text('✅ Разбанить', 'admin:ban:unban').row()
    .text('‹ Назад', 'admin:home'),

  grantMenu: () => new InlineKeyboard()
    .text('+7 дн', 'admin:grant:7')
    .text('+30 дн', 'admin:grant:30')
    .text('+90 дн', 'admin:grant:90').row()
    .text('+365 дн', 'admin:grant:365')
    .text('🚫 Отозвать', 'admin:grant:-1').row()
    .text('‹ Назад', 'admin:home'),

  usersMenu: () => new InlineKeyboard()
    .text('🔍 Поиск', 'admin:users:search')
    .text('🔄 Обновить', 'admin:users').row()
    .text('‹ Назад', 'admin:home'),

  linksMenu: () => new InlineKeyboard()
    .text('📖 Инструкция', 'admin:links:instruction')
    .text('📢 Поддержка',  'admin:links:support').row()
    .text('‹ Назад', 'admin:home'),

  broadcastPreview: () => new InlineKeyboard()
    .text('🚀 Запустить рассылку', 'admin:bc:send').row()
    .text('✖️ Отмена',             'admin:home'),
};

// ─── 4. TEXTS ───────────────────────────────────────────────────────────────
const ATTACH_TEXT =
  `*Подключение бота по токену*\n\n` +
  `1\\. Открой @BotFather → \`/newbot\`\n` +
  `2\\. Задай имя и юзернейм \\(должен оканчиваться на \`bot\`\\)\n` +
  `3\\. \`/mybots\` → твой бот → *Bot Settings* → *Business Mode* → *Enable*\n` +
  `4\\. Скопируй токен и пришли его сюда сообщением\\.\n\n` +
  `⚠️ Не используй один и тот же бот в нескольких сервисах\\.`;

const T = {
  start: `Нажми «🤖 Мои боты», чтобы начать\\.`,
  bots: (list, user) => {
    const lim = limitOf(user);
    if (!list.length) return `*Мои боты* \\(0/${lim}\\)\n\n_Ботов пока нет_`;
    const lines = list.map((b) => {
      const dot = b.token ? (b.enabled ? '🟢' : '⚪️') : '⚠️';
      return `• [@${escMd(b.username)}](https://t.me/${b.username}) — ${dot} 👥 ${b.members}`;
    });
    return `*Мои боты* \\(${list.length}/${lim}\\)\n\n` + lines.join('\n');
  },
  createReady:
    `*Создание бота*\n\n` +
    `Нажми кнопку — откроется системное окно Telegram\\.\n` +
    `После создания токен подтянется автоматически и модуль запустится\\.`,
  attach: ATTACH_TEXT,
  botCard: (b) =>
    `*${escMd(b.display_name)}*\n\n` +
    `• [@${escMd(b.username)}](https://t.me/${b.username})\n` +
    `• Статус: ${b.enabled ? '🟢 активен' : '⚪️ выключен'}\n` +
    `• Токен: ${b.token ? '✅ привязан' : '⚠️ нет'}\n` +
    `• Подключений: ${b.members}`,
  premium: (user) => {
    if (isPremium(user)) {
      const left = Math.ceil((user.premium_until - Date.now()) / 86_400_000);
      return `⭐ *Премиум активен*\n\nОсталось дней: *${left}*\nЛимит ботов: *${PREMIUM_LIMIT}*`;
    }
    return `⭐ *Премиум*\n\n` +
           `• Без премиума: до *${FREE_LIMIT}* ботов\n` +
           `• С премиумом: до *${PREMIUM_LIMIT}* ботов, все команды модуля\n\n` +
           `Стоимость: *${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн\\.*`;
  },
  needSub:       `Чтобы пользоваться ботом, подпишись на наш канал\\.`,
  banned:        `🚫 Вы заблокированы\\.`,
  limitReached:  (lim) => `Лимит ботов исчерпан \\(${lim}\\)\\.\nОформи ⭐ Премиум для расширения\\.`,
  admin:         `🛠 *Админ\\-панель*\n\nВыбери раздел:`,
};

// ─── 5. BOT ─────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    Q.upsertUser.run(ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, Date.now());
    const u = Q.getUser.get(ctx.from.id);
    if (u?.is_banned && !isAdmin(ctx.from.id)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '🚫 Вы заблокированы', show_alert: true }).catch(() => {});
      else                   await ctx.reply(T.banned, { parse_mode: 'MarkdownV2' }).catch(() => {});
      return;
    }
  }
  await next();
});

const adminInput     = new Map();
const broadcastDraft = new Map();

async function isSubscribed(ctx, uid) {
  const ch = getSet('required_channel');
  if (!ch) return true;
  if (isAdmin(uid)) return true;
  try {
    const m = await ctx.api.getChatMember(ch, uid);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch (e) {
    const desc = e?.description || e?.message || '';
    if (/chat not found|bot is not a member|not enough rights|member list is inaccessible/i.test(desc)) {
      console.warn(`[sub-check] Bot is not admin of ${ch}: ${desc}`);
      return true;
    }
    return false;
  }
}

// ─── 5.1 /start ─────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  if (!(await isSubscribed(ctx, ctx.from.id))) {
    return ctx.reply(T.needSub, { parse_mode: 'MarkdownV2', reply_markup: kb.subscribe() });
  }
  await ctx.reply(T.start, { parse_mode: 'MarkdownV2', reply_markup: kb.start(isAdmin(ctx.from.id)) });
});

// ─── 5.2 Callback router ────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  try {
    if (data !== 'sub:check' && !(await isSubscribed(ctx, ctx.from.id))) {
      return editText(ctx, T.needSub, kb.subscribe());
    }
    if (data === 'sub:check') {
      if (await isSubscribed(ctx, ctx.from.id)) {
        return editText(ctx, T.start, kb.start(isAdmin(ctx.from.id)));
      }
      return ctx.answerCallbackQuery({ text: 'Подписка не найдена', show_alert: true });
    }

    if (data === 'menu:home') {
      adminInput.delete(ctx.from.id);
      return editText(ctx, T.start, kb.start(isAdmin(ctx.from.id)));
    }
    if (data === 'menu:bots')    return showBots(ctx);
    if (data === 'menu:premium') return showPremium(ctx);

    if (data === 'bots:create') return startCreate(ctx);
    if (data === 'bots:attach') return showAttachInstr(ctx);
    if (data === 'premium:buy') return sendInvoice(ctx);

    if (data.startsWith('bot:retoken:')) return retokenBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:restart:')) return restartBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:toggle:'))  return toggleBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:delete:'))  return deleteBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:'))         return showBotCard(ctx, +data.split(':')[1]);

    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();

    if (data === 'admin:home') {
      adminInput.delete(ctx.from.id);
      broadcastDraft.delete(ctx.from.id);
      return editText(ctx, T.admin, kb.admin());
    }
    if (data === 'admin:stats')             return showAdminStats(ctx);
    if (data === 'admin:channel')           return showAdminChannel(ctx);
    if (data === 'admin:channel:off')       return adminChannelOff(ctx);
    if (data === 'admin:channel:input')     return adminChannelInput(ctx);
    if (data === 'admin:links')             return showAdminLinks(ctx);
    if (data === 'admin:links:instruction') return adminLinksEdit(ctx, 'instruction');
    if (data === 'admin:links:support')     return adminLinksEdit(ctx, 'support');
    if (data === 'admin:broadcast')         return startBroadcast(ctx);
    if (data === 'admin:bc:send')           return sendBroadcast(ctx);
    if (data === 'admin:grant')             return showAdminGrant(ctx);
    if (data.startsWith('admin:grant:'))    return adminGrantStart(ctx, +data.split(':')[2]);
    if (data === 'admin:users')             return showAdminUsers(ctx);
    if (data === 'admin:users:search')      return adminUsersSearch(ctx);
    if (data === 'admin:ban')               return showAdminBan(ctx);
    if (data === 'admin:ban:doban')         return adminBanStart(ctx, 'ban');
    if (data === 'admin:ban:unban')         return adminBanStart(ctx, 'unban');
    if (data === 'admin:allbots')           return showAdminAllBots(ctx);
    if (data === 'admin:restartall')        return showAdminRestartAll(ctx);
    if (data === 'admin:restartall:go')     return doAdminRestartAll(ctx);
    if (data === 'admin:export')            return doExport(ctx);

    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error('[callback]', err);
    await ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте ещё раз' }).catch(() => {});
  }
});

// ─── 5.3 Broadcast capture ──────────────────────────────────────────────────
bot.on('message', async (ctx, next) => {
  const uid  = ctx.from?.id;
  if (!uid) return next();
  const mode = adminInput.get(uid);

  if (mode?.mode === 'bc_message' && isAdmin(uid)) {
    broadcastDraft.set(uid, {
      from_chat_id: ctx.chat.id,
      message_id:   ctx.msg.message_id,
      buttons:      null,
    });
    adminInput.set(uid, { mode: 'bc_buttons' });
    return ctx.reply(
      '✅ Сообщение сохранено\\.\n\n' +
      '*Шаг 2/2 — Кнопки* \\(опционально\\)\n' +
      'Отправь кнопки в формате \\(каждая строка — ряд, кнопки через `|`\\):\n' +
      '`Текст1 \\- https://t\\.me/url1`\n' +
      '`Текст2 \\- https://example\\.com | Текст3 \\- https://t\\.me/url3`\n\n' +
      'Или отправь `-` чтобы оставить без кнопок\\.',
      { parse_mode: 'MarkdownV2', reply_markup: kb.cancelInput() },
    );
  }

  if (mode?.mode === 'bc_buttons' && isAdmin(uid) && ctx.msg.text) {
    const draft = broadcastDraft.get(uid);
    if (!draft) { adminInput.delete(uid); return; }
    const raw = ctx.msg.text.trim();
    if (raw === '-' || raw.toLowerCase() === 'нет') {
      draft.buttons = null;
    } else {
      const rows = [];
      for (const line of raw.split(/\r?\n/)) {
        const row = [];
        for (const part of line.split('|')) {
          const m = part.trim().match(/^(.+?)\s+[-—]\s+(https?:\/\/\S+)$/);
          if (m) row.push({ text: m[1].trim(), url: m[2].trim() });
        }
        if (row.length) rows.push(row);
      }
      draft.buttons = rows.length ? rows : null;
    }
    adminInput.set(uid, { mode: 'bc_confirm' });
    const total = Q.allActiveUsers.all().length;
    await ctx.reply(
      `📣 *Предпросмотр*\n\nПолучателей: *${total}*\n` +
      (draft.buttons ? `Кнопок: *${draft.buttons.flat().length}*` : '_Без кнопок_'),
      { parse_mode: 'MarkdownV2' },
    );
    await ctx.api.copyMessage(uid, draft.from_chat_id, draft.message_id, {
      reply_markup: draft.buttons ? { inline_keyboard: draft.buttons } : undefined,
    }).catch(() => {});
    await ctx.reply('Запустить рассылку?', { reply_markup: kb.broadcastPreview() });
    return;
  }

  return next();
});

// ─── 5.4 Text inputs (admin forms + token attach) ──────────────────────────
bot.on('message:text', async (ctx) => {
  if (ctx.msg.text.startsWith('/')) return;

  const uid  = ctx.from.id;
  const mode = adminInput.get(uid);
  const text = ctx.msg.text.trim();

  // Привязка бота по токену (если выглядит как токен — обрабатываем приоритетно)
  if (TOKEN_RE.test(text)) {
    return attachByToken(ctx, text);
  }

  if (!mode) return;

  if (mode.mode === 'channel' && isAdmin(uid)) {
    if (text.toLowerCase() === 'off') {
      setSet('required_channel', '');
      setSet('required_channel_url', '');
      adminInput.delete(uid);
      return ctx.reply('✅ Обязательная подписка отключена.');
    }
    const parts = text.split('|').map((s) => s.trim());
    const ch  = parts[0];
    const url = parts[1] || (ch.startsWith('@') ? `https://t.me/${ch.slice(1)}` : '');
    if (!ch) return ctx.reply('Неверный формат. Пример: @channel | https://t.me/channel');
    setSet('required_channel', ch);
    setSet('required_channel_url', url);
    adminInput.delete(uid);
    try {
      await ctx.api.getChat(ch);
      return ctx.reply(`✅ Канал установлен: ${ch}\nСсылка: ${url || '—'}`);
    } catch (e) {
      return ctx.reply(`⚠️ Канал ${ch} сохранён, но бот не видит его. Добавь бота админом в канал.\n\nОшибка: ${e.description || e.message}`);
    }
  }

  if (mode.mode === 'links_quick' && isAdmin(uid)) {
    if (!/^https?:\/\/\S+$/i.test(text)) {
      return ctx.reply('Это не похоже на URL. Пример: https://t.me/savemod');
    }
    const key = mode.payload.which === 'instruction' ? 'instruction_url' : 'support_url';
    setSet(key, text);
    adminInput.delete(uid);
    const label = mode.payload.which === 'instruction' ? 'Инструкция' : 'Поддержка';
    return ctx.reply(`✅ ${label}: ${text}`, {
      reply_markup: new InlineKeyboard().text('‹ В админку', 'admin:home'),
    });
  }

  if (mode.mode === 'grant_quick' && isAdmin(uid)) {
    const targetId = parseInt(text.replace(/\D/g, ''), 10);
    if (!targetId) return ctx.reply('Не похоже на user_id. Пришли только число.');
    return applyGrant(ctx, targetId, mode.payload.days);
  }

  if (mode.mode === 'ban_quick' && isAdmin(uid)) {
    const targetId = parseInt(text.replace(/\D/g, ''), 10);
    if (!targetId) return ctx.reply('Не похоже на user_id. Пришли только число.');
    return applyBan(ctx, targetId, mode.payload.action);
  }

  if (mode.mode === 'usersearch' && isAdmin(uid)) {
    const q = `%${text}%`;
    const found = Q.searchUsers.all(q, q, q);
    adminInput.delete(uid);
    if (!found.length) {
      return ctx.reply('Никого не найдено.', { reply_markup: new InlineKeyboard().text('‹ В админку', 'admin:home') });
    }
    const lines = found.map(u => {
      const uname = u.username ? `@${escMd(u.username)}` : '';
      const name  = escMd((u.first_name || '').slice(0, 25));
      const flags = `${isPremium(u) ? ' ⭐' : ''}${u.is_banned ? ' 🚫' : ''}`;
      return `• \`${u.user_id}\` ${uname} ${name}${flags}`.replace(/\s+/g, ' ').trim();
    });
    return ctx.reply(`*Найдено ${found.length}:*\n\n` + lines.join('\n'), {
      parse_mode: 'MarkdownV2',
      reply_markup: new InlineKeyboard().text('‹ В админку', 'admin:home'),
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. MANAGED BOTS — главная логика (Bot API 9.6, апрель 2026)
// ═══════════════════════════════════════════════════════════════════════════

bot.on('managed_bot', async (ctx) => {
  const mbu = ctx.update.managed_bot;
  if (!mbu?.bot) { console.warn('[managed_bot] empty payload'); return; }
  const ownerId = mbu.user?.id ?? ctx.from?.id;
  await onManagedBot(ctx, mbu.bot, ownerId, 'updated');
});

// Сервисное сообщение «бот создан» внутри чата с конструктором
bot.on('message', async (ctx, next) => {
  const mbc = ctx.msg?.managed_bot_created;
  if (mbc?.bot) {
    await onManagedBot(ctx, mbc.bot, ctx.from?.id, 'created');
    return;
  }
  return next();
});

/**
 * Единая обработка управляемого бота:
 *  1) проверка лимита (для НОВОГО бота)
 *  2) запись метаданных (без токена)
 *  3) запрос токена через getManagedBotToken (raw API + правильный payload)
 *  4) ВАЛИДАЦИЯ токена через getMe ДО записи в БД и спавна
 *  5) запись токена и запуск module.js
 */
async function onManagedBot(ctx, botUser, ownerId, source) {
  if (!ownerId) { console.warn(`[managed_bot:${source}] no owner_id`); return; }

  const existing = Q.getBot.get(botUser.id);
  const isNew = !existing;

  if (isNew) {
    const owner = Q.getUser.get(ownerId);
    const cnt = Q.countBots.get(ownerId).c;
    if (cnt >= limitOf(owner)) {
      await ctx.api.sendMessage(ownerId,
        `⚠️ Лимит ботов исчерпан (${limitOf(owner)}). Оформи Премиум для расширения.`,
      ).catch(() => {});
      return;
    }
  }

  // 1) Сохраняем мета (без токена)
  Q.insertBot.run(
    botUser.id, ownerId,
    botUser.username,
    botUser.first_name || botUser.username,
    null,
    Date.now(),
  );
  Q.updateBotMeta.run(botUser.username, botUser.first_name || botUser.username, botUser.id);

  console.log(`[managed_bot:${source}] @${botUser.username} (id=${botUser.id}) owner=${ownerId}, isNew=${isNew}`);

  // 2) Запрашиваем токен
  let raw;
  try {
    raw = await callGetManagedBotToken(ctx.api, botUser.id);
  } catch (e) {
    console.error(`[managed_bot:${source}] getManagedBotToken failed:`, e?.description || e?.message);
    await ctx.api.sendMessage(ownerId,
      `⚠️ Бот @${botUser.username} зарегистрирован, но токен не удалось получить:\n` +
      `${e?.description || e?.message || 'неизвестная ошибка'}\n\n` +
      `Открой карточку бота → «🔁 Запросить токен».`,
    ).catch(() => {});
    return;
  }

  const token = extractToken(raw);
  if (!token) {
    console.error(`[managed_bot:${source}] empty/invalid token shape:`, JSON.stringify(raw).slice(0, 200));
    await ctx.api.sendMessage(ownerId,
      `⚠️ Бот @${botUser.username} зарегистрирован, но Telegram вернул пустой/нестандартный токен.\n` +
      `Попробуй кнопку «🔁 Запросить токен» в карточке бота через минуту.`,
    ).catch(() => {});
    return;
  }

  // 3) Валидация токена
  try {
    const me = await verifyToken(token);
    if (me.id !== botUser.id) {
      console.warn(`[managed_bot:${source}] token belongs to bot ${me.id}, expected ${botUser.id}`);
    }
  } catch (e) {
    console.error(`[managed_bot:${source}] token verify failed:`, e?.description || e?.message);
    await ctx.api.sendMessage(ownerId,
      `⚠️ Telegram вернул токен, но он не проходит валидацию (${e?.description || e?.message}).\n` +
      `Подожди 10-30 секунд и нажми «🔁 Запросить токен» в карточке бота.`,
    ).catch(() => {});
    return;
  }

  // 4) Запись + спавн
  Q.updateBotToken.run(token, botUser.id);
  spawnModuleFor(botUser.username, token);

  // FIX (UX): при создании бота через BotFather (source='created') Telegram САМ
  // присылает в чат с конструктором сервисное сообщение `managed_bot_created`
  // вида «Бот @xxx создан». Наше отдельное «🎉 Бот создан!» выглядело как дубль.
  // Поэтому при source='created' отправляем ОДНО лаконичное сообщение с
  // инструкцией (без повторного «бот создан»). При перевыпуске токена/привязке
  // существующего бота шлём короткое «обновлён».
  const text = source === 'created'
    ? `✅ Модуль запущен для [@${escMd(botUser.username)}](https://t.me/${botUser.username})\\.\n\n` +
      `Открой [@${escMd(botUser.username)}](https://t.me/${botUser.username}) → /start, ` +
      `затем подключи его в *Telegram Business* \\(Настройки → Чат\\-боты\\)\\.`
    : `🔄 *Бот обновлён*\n\n` +
      `• [@${escMd(botUser.username)}](https://t.me/${botUser.username})\n` +
      `• Имя: *${escMd(botUser.first_name || botUser.username)}*\n\n` +
      `Модуль перезапущен\\.`;

  await ctx.api.sendMessage(
    ownerId, text,
    { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } },
  ).catch(() => {});
}

// Ручной перезапрос токена из карточки бота
async function retokenBot(ctx, botId) {
  const b = Q.getBot.get(botId);
  if (!b || (b.owner_id !== ctx.from.id && !isAdmin(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: '⛔️', show_alert: true });
  }
  await ctx.answerCallbackQuery({ text: 'Запрашиваю токен…' });
  try {
    const raw = await callGetManagedBotToken(ctx.api, botId);
    const token = extractToken(raw);
    if (!token) throw new Error('Telegram вернул пустой токен');

    // верификация
    const me = await verifyToken(token);
    if (me.id !== botId) {
      console.warn(`[retoken] token belongs to ${me.id}, expected ${botId}`);
    }

    Q.updateBotToken.run(token, botId);
    spawnModuleFor(b.username, token);
    return showBotCard(ctx, botId);
  } catch (e) {
    console.error('[retoken]', e?.description || e?.message);
    return ctx.api.sendMessage(ctx.from.id,
      `❌ Не удалось получить токен: ${e?.description || e?.message || 'unknown'}\n\n` +
      `Можно вручную: открой @BotFather → /mybots → ${b.username} → API Token, скопируй и пришли сюда сообщением.`,
    ).catch(() => {});
  }
}

// Ручной перезапуск модуля (на случай если процесс упал/завис)
async function restartBot(ctx, botId) {
  const b = Q.getBot.get(botId);
  if (!b || (b.owner_id !== ctx.from.id && !isAdmin(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: '⛔️', show_alert: true });
  }
  if (!b.token) {
    return ctx.answerCallbackQuery({ text: 'Нет токена', show_alert: true });
  }
  await ctx.answerCallbackQuery({ text: 'Перезапускаю…' });

  try {
    await verifyToken(b.token);
  } catch (e) {
    Q.clearBotToken.run(botId);
    return ctx.api.sendMessage(ctx.from.id,
      `❌ Текущий токен бота @${b.username} невалиден (${e?.description || e?.message}). Запроси новый: «🔁 Запросить токен».`,
    ).catch(() => {});
  }

  spawnModuleFor(b.username, b.token);
  return showBotCard(ctx, botId);
}

// ─── 7. CHILD PROCESS MANAGER ──────────────────────────────────────────────
const children       = new Map(); // username → ChildProcess
const restartAttempt = new Map(); // username → { count, lastAt }

function spawnModuleFor(username, token) {
  if (!token) { console.warn(`[spawn] skipped @${username}: no token`); return; }
  if (!TOKEN_RE.test(token)) {
    console.warn(`[spawn] skipped @${username}: token format invalid`);
    return;
  }

  // Если процесс уже запущен — перезапускаем (на случай нового токена).
  const prev = children.get(username);
  if (prev) {
    console.log(`[spawn] @${username} already running, restarting…`);
    try { prev.kill('SIGTERM'); } catch {}
    children.delete(username);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const modulePath = path.join(here, 'module.js');
  if (!fs.existsSync(modulePath)) {
    console.error(`[spawn] module.js not found at ${modulePath}`);
    return;
  }

  console.log(`[spawn] starting module for @${username}…`);
  const child = spawn(process.execPath, [modulePath], {
    env: {
      ...process.env,
      MODULE_BOT_TOKEN:    token,
      MODULE_BOT_USERNAME: username,
      CONSTRUCTOR_DB:      DB_PATH,
      MODULE_DB:           path.join(path.dirname(DB_PATH), `module-${username}.db`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Накопление stderr для анализа причины падения
  let lastErr = '';
  child.stdout.on('data', (d) => process.stdout.write(`[mod:${username}] ${d}`));
  child.stderr.on('data', (d) => {
    const s = d.toString();
    lastErr += s;
    if (lastErr.length > 4000) lastErr = lastErr.slice(-4000);
    process.stderr.write(`[mod:${username}][ERR] ${s}`);
  });

  children.set(username, child);
  child.on('exit', (code, sig) => {
    console.log(`[mod:${username}] exited code=${code} sig=${sig}`);
    children.delete(username);

    // Если упало с 401 Unauthorized — токен битый, НЕ перезапускаем
    if (/401:?\s*Unauthorized/i.test(lastErr) || /Unauthorized/i.test(lastErr)) {
      console.warn(`[mod:${username}] token is INVALID (401). Marking as detached, NOT restarting.`);
      const row = db.prepare(`SELECT bot_id, owner_id FROM bots WHERE username = ?`).get(username);
      if (row) {
        Q.clearBotToken.run(row.bot_id);
        bot.api.sendMessage(row.owner_id,
          `⚠️ Модуль бота @${username} остановлен: токен невалиден (401 Unauthorized).\n\n` +
          `Открой карточку бота → «🔁 Запросить токен» (либо пришли новый токен сообщением).`,
        ).catch(() => {});
      }
      restartAttempt.delete(username);
      return;
    }

    // Auto-restart, но с backoff — максимум 5 попыток в течение 5 минут
    const stillActive = db.prepare(`SELECT enabled, token FROM bots WHERE username = ?`).get(username);
    if (!stillActive?.enabled || !stillActive?.token) {
      restartAttempt.delete(username);
      return;
    }
    if (sig === 'SIGTERM') {
      restartAttempt.delete(username);
      return;
    }
    if (code === 0) {
      restartAttempt.delete(username);
      return;
    }

    const att = restartAttempt.get(username) || { count: 0, lastAt: 0 };
    if (Date.now() - att.lastAt > 5 * 60_000) att.count = 0;
    att.count++; att.lastAt = Date.now();
    restartAttempt.set(username, att);

    if (att.count > 5) {
      console.warn(`[mod:${username}] too many restarts (${att.count}); cooling down.`);
      return;
    }

    const delay = Math.min(5000 * att.count, 60_000);
    console.log(`[mod:${username}] auto-restart in ${delay / 1000}s (attempt ${att.count})…`);
    setTimeout(() => spawnModuleFor(username, stillActive.token), delay);
  });
  child.on('error', (e) => console.error(`[mod:${username}] spawn error:`, e));
}

// Поднимаем модули при старте конструктора, валидируя каждый токен
(async function bootSpawn() {
  const rows = db.prepare(`SELECT * FROM bots WHERE token IS NOT NULL AND enabled = 1`).all();
  for (const b of rows) {
    try {
      await verifyToken(b.token);
      spawnModuleFor(b.username, b.token);
    } catch (e) {
      console.warn(`[boot] @${b.username} token verify failed: ${e?.description || e?.message}. Clearing.`);
      Q.clearBotToken.run(b.bot_id);
    }
  }
})();

// ─── 8. SCREENS ─────────────────────────────────────────────────────────────
async function editText(ctx, text, reply_markup) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      reply_markup,
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof GrammyError && /not modified/.test(err.description || '')) { /* ok */ }
    else {
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup,
        link_preview_options: { is_disabled: true } }).catch(() => {});
    }
  }
  await ctx.answerCallbackQuery().catch(() => {});
}

async function showBots(ctx) {
  const user = Q.getUser.get(ctx.from.id);
  const list = Q.listBots.all(ctx.from.id);
  return editText(ctx, T.bots(list, user), kb.bots(list, user));
}

async function showBotCard(ctx, botId) {
  const b = Q.getBot.get(botId);
  if (!b || (b.owner_id !== ctx.from.id && !isAdmin(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: 'Бот не найден', show_alert: true });
  }
  return editText(ctx, T.botCard(b), kb.botCard(b));
}

async function startCreate(ctx) {
  const user = Q.getUser.get(ctx.from.id);
  const cnt  = Q.countBots.get(ctx.from.id).c;
  const lim  = limitOf(user);
  if (cnt >= lim) {
    return editText(ctx, T.limitReached(lim), new InlineKeyboard()
      .text('⭐ Премиум', 'menu:premium').row()
      .text('‹ Назад', 'menu:bots'));
  }
  return editText(ctx, T.createReady, kb.createConfirm());
}

async function showAttachInstr(ctx) {
  const user = Q.getUser.get(ctx.from.id);
  const cnt  = Q.countBots.get(ctx.from.id).c;
  const lim  = limitOf(user);
  if (cnt >= lim) {
    return editText(ctx, T.limitReached(lim), new InlineKeyboard()
      .text('⭐ Премиум', 'menu:premium').row()
      .text('‹ Назад', 'menu:bots'));
  }
  return editText(ctx, T.attach, kb.attachInstr());
}

async function toggleBot(ctx, id) {
  const b = Q.getBot.get(id);
  if (!b || (b.owner_id !== ctx.from.id && !isAdmin(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: '⛔️', show_alert: true });
  }
  Q.toggleBot.run(id);
  const upd = Q.getBot.get(id);
  if (upd.enabled && upd.token) spawnModuleFor(upd.username, upd.token);
  else children.get(upd.username)?.kill('SIGTERM');
  return showBotCard(ctx, id);
}

async function deleteBot(ctx, id) {
  const b = Q.getBot.get(id);
  if (!b || (b.owner_id !== ctx.from.id && !isAdmin(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: '⛔️', show_alert: true });
  }
  children.get(b.username)?.kill('SIGTERM');
  Q.delBot.run(id, b.owner_id);
  await ctx.answerCallbackQuery({ text: 'Удалён' });
  return showBots(ctx);
}

async function attachByToken(ctx, token) {
  let me;
  try {
    me = await verifyToken(token);
  } catch (e) {
    console.error('[attach]', e?.description || e?.message);
    return ctx.reply(`❌ Токен невалиден или Telegram недоступен: ${e?.description || e?.message}`);
  }
  const user = Q.getUser.get(ctx.from.id);
  const existing = Q.getBot.get(me.id);
  if (!existing) {
    const cnt = Q.countBots.get(ctx.from.id).c;
    if (cnt >= limitOf(user)) {
      return ctx.reply(`Лимит ${limitOf(user)} ботов исчерпан.`);
    }
    Q.insertBot.run(me.id, ctx.from.id, me.username, me.first_name || me.username, token, Date.now());
  } else {
    if (existing.owner_id !== ctx.from.id && !isAdmin(ctx.from.id)) {
      return ctx.reply('❌ Этот бот уже принадлежит другому пользователю.');
    }
    Q.updateBotToken.run(token, me.id);
    Q.updateBotMeta.run(me.username, me.first_name || me.username, me.id);
  }
  spawnModuleFor(me.username, token);
  await ctx.reply(`✅ Подключён: @${me.username}\n📦 Модуль запущен.`,
    { reply_markup: new InlineKeyboard().url('🔗 Открыть', `https://t.me/${me.username}`) });
}

// ─── 9. PREMIUM (Stars) ─────────────────────────────────────────────────────
async function showPremium(ctx) {
  const user = Q.getUser.get(ctx.from.id);
  return editText(ctx, T.premium(user), kb.premium(user));
}

async function sendInvoice(ctx) {
  const payload = `prem_${ctx.from.id}_${Date.now()}`;
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.api.sendInvoice(
    ctx.from.id,
    'SaveMOD Премиум',
    `Премиум-доступ на ${PREMIUM_DAYS} дней: до ${PREMIUM_LIMIT} ботов и все команды.`,
    payload,
    'XTR',
    [{ label: 'Премиум', amount: PREMIUM_PRICE }],
  ).catch((e) => {
    console.error('[invoice]', e);
    ctx.reply('Не удалось создать счёт, попробуйте позже.').catch(() => {});
  });
}

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true).catch(() => {});
});

bot.on('message:successful_payment', async (ctx) => {
  const sp = ctx.msg.successful_payment;
  const uid = ctx.from.id;
  const user = Q.getUser.get(uid);
  const base = Math.max(user?.premium_until ?? 0, Date.now());
  const newUntil = base + PREMIUM_DAYS * 86_400_000;
  Q.setPremium.run(newUntil, uid);
  Q.addPayment.run(sp.invoice_payload, uid, sp.telegram_payment_charge_id, sp.total_amount, Date.now());
  await ctx.reply(`✅ Премиум активирован до ${new Date(newUntil).toLocaleDateString('ru-RU')}.`);
});

// ─── 10. ADMIN PANEL ────────────────────────────────────────────────────────
async function showAdminStats(ctx) {
  const day = Date.now() - 86_400_000;
  const text =
    `📊 *Статистика*\n\n` +
    `👥 Пользователей: *${Q.countUsers.get().c}*\n` +
    `🆕 За 24ч: *${Q.countNew24h.get(day).c}*\n` +
    `⭐ Премиум активных: *${Q.countPremium.get(Date.now()).c}*\n` +
    `🚫 Забанено: *${Q.countBanned.get().c}*\n\n` +
    `🤖 Ботов всего: *${Q.countAllBots.get().c}*\n` +
    `▶️ Активных ботов: *${Q.countActiveBots.get().c}*\n` +
    `⚙️ Запущенных процессов: *${children.size}*\n\n` +
    `⭐ Всего получено звёзд: *${Q.countPaymentsSum.get().s}*`;
  return editText(ctx, text, kb.adminBack());
}

async function showAdminChannel(ctx) {
  adminInput.delete(ctx.from.id);
  const ch = getSet('required_channel');
  const url = getSet('required_channel_url');
  const text =
    `📢 *Канал обязательной подписки*\n\n` +
    `Текущий: ${ch ? `\`${escMd(ch)}\`` : '_не задан_'}\n` +
    `Ссылка: ${url ? `\`${escMd(url)}\`` : '_не задана_'}\n\n` +
    `❗️ Бот должен быть *админом* в канале\\.`;
  return editText(ctx, text, kb.channelMenu(!!ch));
}

async function adminChannelOff(ctx) {
  setSet('required_channel', '');
  setSet('required_channel_url', '');
  await ctx.answerCallbackQuery({ text: '✅ Подписка отключена' });
  return showAdminChannel(ctx);
}

async function adminChannelInput(ctx) {
  adminInput.set(ctx.from.id, { mode: 'channel' });
  return editText(ctx,
    `📢 *Установка канала*\n\n` +
    `Отправь сообщением:\n` +
    `\`@channel\` или \`@channel | https://t.me/channel\``,
    kb.cancelInput());
}

async function showAdminLinks(ctx) {
  adminInput.delete(ctx.from.id);
  const i = getSet('instruction_url'), s = getSet('support_url');
  const text =
    `🔗 *Ссылки*\n\n` +
    `• Инструкция: ${i ? `\`${escMd(i)}\`` : '_—_'}\n` +
    `• Канал/Поддержка: ${s ? `\`${escMd(s)}\`` : '_—_'}\n\n` +
    `Выбери, что изменить:`;
  return editText(ctx, text, kb.linksMenu());
}

async function adminLinksEdit(ctx, which) {
  adminInput.set(ctx.from.id, { mode: 'links_quick', payload: { which } });
  const label = which === 'instruction' ? 'инструкции' : 'поддержки';
  return editText(ctx,
    `🔗 *Новая ссылка ${escMd(label)}*\n\n` +
    `Пришли URL одним сообщением \\(например: \`https://t\\.me/savemod\`\\)\\.`,
    kb.cancelInput());
}

async function startBroadcast(ctx) {
  adminInput.set(ctx.from.id, { mode: 'bc_message' });
  broadcastDraft.delete(ctx.from.id);
  const text =
    `📣 *Рассылка* — Шаг 1/2\n\n` +
    `Пришли *любое сообщение* \\(текст, фото, видео, стикер и т\\.д\\.\\)\\.\n` +
    `Сообщение пересылается через copyMessage — форматирование сохраняется\\.`;
  return editText(ctx, text, kb.cancelInput());
}

async function sendBroadcast(ctx) {
  const adminId = ctx.from.id;
  const draft = broadcastDraft.get(adminId);
  if (!draft) {
    await ctx.answerCallbackQuery({ text: 'Черновик не найден', show_alert: true });
    return editText(ctx, T.admin, kb.admin());
  }
  await ctx.answerCallbackQuery({ text: 'Поехали…' });
  await editText(ctx, '📣 *Рассылка запущена\\.\\.\\.*', kb.adminBack());

  const users = Q.allActiveUsers.all();
  let ok = 0, fail = 0, blocked = 0;
  const reply_markup = draft.buttons ? { inline_keyboard: draft.buttons } : undefined;

  for (let i = 0; i < users.length; i += 25) {
    const slice = users.slice(i, i + 25);
    await Promise.all(slice.map(async ({ user_id }) => {
      try {
        await ctx.api.copyMessage(user_id, draft.from_chat_id, draft.message_id, { reply_markup });
        ok++;
      } catch (e) {
        const d = e?.description || '';
        if (/blocked|deactivated|chat not found|user is deactivated/i.test(d)) blocked++;
        else fail++;
      }
    }));
    await new Promise(r => setTimeout(r, 1100));
  }

  adminInput.delete(adminId);
  broadcastDraft.delete(adminId);
  await ctx.api.sendMessage(adminId,
    `📣 *Рассылка завершена*\n\n` +
    `✅ Доставлено: *${ok}*\n` +
    `🚫 Заблокировали бота: *${blocked}*\n` +
    `❌ Прочие ошибки: *${fail}*\n` +
    `📦 Всего: *${users.length}*`,
    { parse_mode: 'MarkdownV2' },
  ).catch(() => {});
}

async function showAdminGrant(ctx) {
  adminInput.delete(ctx.from.id);
  return editText(ctx,
    `⭐ *Выдача / отзыв премиума*\n\n` +
    `Выбери срок \\(или «Отозвать»\\) — затем пришли \`<user_id>\`\\.`,
    kb.grantMenu());
}

async function adminGrantStart(ctx, days) {
  adminInput.set(ctx.from.id, { mode: 'grant_quick', payload: { days } });
  const label = days > 0 ? `+${days} дн.` : 'Отозвать';
  return editText(ctx,
    `⭐ *${escMd(label)}*\n\nПришли \`user_id\` пользователя одним сообщением\\.`,
    kb.cancelInput());
}

async function showAdminBan(ctx) {
  adminInput.delete(ctx.from.id);
  return editText(ctx,
    `🚫 *Бан / разбан*\n\nВыбери действие, затем пришли \`<user_id>\`\\.`,
    kb.banMenu());
}

async function adminBanStart(ctx, action) {
  adminInput.set(ctx.from.id, { mode: 'ban_quick', payload: { action } });
  const label = action === 'ban' ? '🚫 Забанить' : '✅ Разбанить';
  return editText(ctx,
    `${escMd(label)}\n\nПришли \`user_id\` пользователя одним сообщением\\.`,
    kb.cancelInput());
}

async function adminUsersSearch(ctx) {
  adminInput.set(ctx.from.id, { mode: 'usersearch' });
  return editText(ctx,
    `🔍 *Поиск пользователя*\n\nОтправь часть имени, юзернейма или ID одним сообщением\\.`,
    kb.cancelInput());
}

async function showAdminUsers(ctx) {
  adminInput.delete(ctx.from.id);
  const total = Q.countUsers.get().c;
  const last  = Q.allUsers.all().slice(0, 15);

  if (!last.length) {
    return editText(ctx, `👥 *Пользователи* \\(всего 0\\)\n\n_Пока никого нет\\._`, kb.usersMenu());
  }

  const lines = last.map(u => {
    const tag = [
      isPremium(u) ? '⭐' : '',
      u.is_banned ? '🚫' : '',
    ].filter(Boolean).join(' ');
    const uname = u.username ? `@${escMd(u.username)}` : '';
    const name  = escMd((u.first_name || '').slice(0, 20));
    const parts = [`• \`${u.user_id}\``, uname, name, tag].filter(Boolean);
    return parts.join(' ');
  });

  const text =
    `👥 *Пользователи* \\(всего ${total}\\)\n\n` +
    `_Последние 15:_\n` +
    lines.join('\n');
  return editText(ctx, text, kb.usersMenu());
}

async function applyGrant(ctx, targetId, days) {
  const target = Q.getUser.get(targetId);
  if (!target) {
    adminInput.delete(ctx.from.id);
    return ctx.reply(`❌ Пользователь ${targetId} не найден.`, {
      reply_markup: new InlineKeyboard().text('‹ В админку', 'admin:home'),
    });
  }
  const base  = days > 0 ? Math.max(target.premium_until ?? 0, Date.now()) : 0;
  const until = days > 0 ? base + days * 86_400_000 : 0;
  Q.setPremium.run(until, targetId);
  adminInput.delete(ctx.from.id);
  await ctx.reply(
    days > 0
      ? `✅ Выдано ${days} дн. премиума юзеру ${targetId}. Действует до ${fmtDate(until)}.`
      : `✅ Премиум юзера ${targetId} отозван.`,
    { reply_markup: new InlineKeyboard().text('‹ В админку', 'admin:home') },
  );
  await ctx.api.sendMessage(targetId,
    days > 0 ? `🎉 Тебе выдан Премиум на ${days} дн.!` : `ℹ️ Твой Премиум был отозван.`,
  ).catch(() => {});
}

async function applyBan(ctx, targetId, action) {
  if (!Q.getUser.get(targetId)) {
    adminInput.delete(ctx.from.id);
    return ctx.reply(`❌ Пользователь ${targetId} не найден.`, {
      reply_markup: new InlineKeyboard().text('‹ В админку', 'admin:home'),
    });
  }
  Q.setBan.run(action === 'ban' ? 1 : 0, targetId);
  adminInput.delete(ctx.from.id);
  return ctx.reply(
    `✅ ${action === 'ban' ? '🚫 Забанен' : '✅ Разбанен'}: ${targetId}`,
    { reply_markup: new InlineKeyboard().text('‹ В админку', 'admin:home') },
  );
}

/**
 * Перезапуск всех подключённых модулей.
 * Сбрасывает backoff (restartAttempt), убивает живые дочерние процессы
 * (spawnModuleFor сам корректно обработает это вызовом kill+respawn),
 * валидирует каждый токен через verifyToken — невалидные очищает.
 */
async function showAdminRestartAll(ctx) {
  const rows = db.prepare(
    `SELECT bot_id, username, token, enabled FROM bots WHERE token IS NOT NULL AND enabled = 1`,
  ).all();
  const text = rows.length
    ? `⚠️ Будет перезапущено *${rows.length}* модуля\\(ей\\):\n\n` +
      rows.map(b => `• [@${escMd(b.username)}](https://t.me/${b.username})`).join('\n') +
      `\n\nНажми «Перезапустить все» — процессы будут поочерёдно убиты и запущены заново\\.`
    : `_Нет подключённых модулей с валидными токенами\\._`;
  const k = new InlineKeyboard();
  if (rows.length) k.text('🔄 Перезапустить все', 'admin:restartall:go').row();
  k.text('‹ Назад', 'admin:home');
  return editText(ctx, text, k);
}

async function doAdminRestartAll(ctx) {
  await ctx.answerCallbackQuery({ text: 'Перезапускаю модули…' }).catch(() => {});
  const rows = db.prepare(
    `SELECT bot_id, username, token FROM bots WHERE token IS NOT NULL AND enabled = 1`,
  ).all();

  let ok = 0, fail = 0;
  const failed = [];

  for (const b of rows) {
    // сбрасываем счётчик авторестарта (ручной перезапуск — чистый старт)
    restartAttempt.delete(b.username);
    try {
      await verifyToken(b.token);
    } catch (e) {
      console.warn(`[restart-all] @${b.username} token verify failed: ${e?.description || e?.message}. Clearing token.`);
      Q.clearBotToken.run(b.bot_id);
      fail++; failed.push(b.username);
      continue;
    }
    try {
      spawnModuleFor(b.username, b.token);
      ok++;
    } catch (e) {
      console.error(`[restart-all] spawn @${b.username} failed:`, e);
      fail++; failed.push(b.username);
    }
  }

  const skip = db.prepare(`SELECT COUNT(*) AS c FROM bots WHERE token IS NULL OR enabled = 0`).get().c;

  const failedList = failed.length
    ? ` \\(${failed.slice(0, 5).map(u => '@' + escMd(u)).join(', ')}${failed.length > 5 ? '…' : ''}\\)`
    : '';
  const text =
    `✅ *Перезапуск завершён*\n\n` +
    `• Успешно: *${ok}*\n` +
    `• Ошибки: *${fail}*${failedList}\n` +
    `• Пропущено \\(без токена / выкл\\): *${skip}*`;

  return editText(ctx, text, new InlineKeyboard().text('‹ В админку', 'admin:home'));
}

async function showAdminAllBots(ctx) {
  const bots = db.prepare(`
    SELECT b.*, u.username AS owner_username
    FROM bots b LEFT JOIN users u ON b.owner_id = u.user_id
    ORDER BY b.created_at DESC LIMIT 30
  `).all();
  if (!bots.length) return editText(ctx, '_Ботов нет_', kb.adminBack());
  const lines = bots.map(b =>
    `• ${b.enabled ? '🟢' : '⚪️'} [@${escMd(b.username)}](https://t.me/${b.username}) — ` +
    `${b.token ? '✅' : '⚠️'} — owner \`${b.owner_id}\`${b.owner_username ? ' @' + escMd(b.owner_username) : ''}`,
  );
  const text = `🤖 *Все боты* \\(последние 30 из ${Q.countAllBots.get().c}\\)\n\n` + lines.join('\n');
  return editText(ctx, text, kb.adminBack());
}

async function doExport(ctx) {
  await ctx.answerCallbackQuery({ text: 'Готовлю CSV…' });
  try {
    const users = Q.allUsers.all();
    const rows = ['user_id,username,first_name,premium_until,is_banned,created_at'];
    for (const u of users) {
      rows.push([
        u.user_id,
        (u.username || '').replace(/,/g, ' '),
        (u.first_name || '').replace(/,/g, ' '),
        u.premium_until || 0,
        u.is_banned || 0,
        u.created_at,
      ].join(','));
    }
    const csv = rows.join('\n');
    const tmp = path.join(path.dirname(DB_PATH), `users_${Date.now()}.csv`);
    fs.writeFileSync(tmp, csv);
    await ctx.api.sendDocument(ctx.from.id, new InputFile(tmp), {
      caption: `📥 Экспорт: ${users.length} пользователей`,
    });
    fs.unlink(tmp, () => {});
  } catch (e) {
    console.error('[export]', e);
    await ctx.reply('❌ Ошибка экспорта: ' + (e.message || e));
  }
}

// ─── 11. ERROR BOUNDARY ─────────────────────────────────────────────────────
bot.catch((err) => {
  if (err.error instanceof HttpError)        console.error('[net]', err.error);
  else if (err.error instanceof GrammyError) console.error('[tg]', err.error.description);
  else console.error('[bot]', err.error);
});

// ─── 12. START ──────────────────────────────────────────────────────────────
const ALLOWED = [
  'message', 'edited_message', 'callback_query',
  'pre_checkout_query',
  'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages',
  'managed_bot',
];

bot.start({
  allowed_updates: ALLOWED,
  drop_pending_updates: false,
  onStart: (me) => console.log(`🛠  Constructor @${me.username} started (Bot API 10.0, managed bots ready)`),
});

// graceful shutdown
const stop = (sig) => {
  console.log(`\n[${sig}] shutting down…`);
  bot.stop();
  for (const c of children.values()) { try { c.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(0), 1500);
};
process.once('SIGINT',  () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
