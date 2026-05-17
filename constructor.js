// ════════════════════════════════════════════════════════════════════════════
//  SaveMOD — Bot Constructor  (single-file, minimal)
//  ───────────────────────────────────────────────────────────────────────────
//  • grammY 1.36+ • better-sqlite3 • Bot API 9.6 «Managed Bots»
//  • Минимализм: на /start — одна кнопка «🤖 Мои боты»
//  • Премиум: 200⭐/мес — лимит до 10 ботов (без премиума — 5)
//  • Обязательная подписка (настраивается в админ-панели)
//  • Админ-панель: канал подписки, ссылки, статистика
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─── 0. ENV ─────────────────────────────────────────────────────────────────
const TOKEN    = process.env.CONSTRUCTOR_BOT_TOKEN;
const MANAGER  = (process.env.CONSTRUCTOR_BOT_USERNAME || '').replace(/^@/, '');
const DB_PATH  = process.env.CONSTRUCTOR_DB || './constructor.db';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);

if (!TOKEN)   throw new Error('CONSTRUCTOR_BOT_TOKEN is missing in .env');
if (!MANAGER) throw new Error('CONSTRUCTOR_BOT_USERNAME is missing in .env');

// Лимиты ботов
const FREE_LIMIT    = 5;
const PREMIUM_LIMIT = 10;
const PREMIUM_PRICE = 200; // XTR (звёзды)
const PREMIUM_DAYS  = 30;

// Дефолты при создании бота
const DEFAULT_BOT_NAME     = 'Save Bot';
const DEFAULT_BOT_USERNAME = 'SaveBot';

// ─── 1. DATABASE ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id        INTEGER PRIMARY KEY,
    username       TEXT,
    first_name     TEXT,
    premium_until  INTEGER DEFAULT 0,
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
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(user_id)
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
`);

const Q = {
  upsertUser: db.prepare(`
    INSERT INTO users (user_id, username, first_name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username   = excluded.username,
      first_name = excluded.first_name`),
  getUser:     db.prepare(`SELECT * FROM users WHERE user_id = ?`),
  setPremium:  db.prepare(`UPDATE users SET premium_until = ? WHERE user_id = ?`),
  countUsers:  db.prepare(`SELECT COUNT(*) AS c FROM users`),
  countPremium: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE premium_until > ?`),

  listBots:    db.prepare(`SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at ASC`),
  countBots:   db.prepare(`SELECT COUNT(*) AS c FROM bots WHERE owner_id = ?`),
  countAllBots: db.prepare(`SELECT COUNT(*) AS c FROM bots`),
  getBot:      db.prepare(`SELECT * FROM bots WHERE bot_id = ?`),
  getBotByUsername: db.prepare(`SELECT * FROM bots WHERE username = ? COLLATE NOCASE`),
  insertBot:   db.prepare(`
    INSERT INTO bots (bot_id, owner_id, username, display_name, token, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id) DO UPDATE SET
      token        = excluded.token,
      display_name = excluded.display_name`),
  delBot:      db.prepare(`DELETE FROM bots WHERE bot_id = ? AND owner_id = ?`),
  toggleBot:   db.prepare(`UPDATE bots SET enabled = NOT enabled WHERE bot_id = ?`),

  getSetting:  db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting:  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

  addPayment:  db.prepare(`
    INSERT OR IGNORE INTO payments (payload, user_id, charge_id, stars, created_at)
    VALUES (?, ?, ?, ?, ?)`),
};

// ─── 1.1 SETTINGS helpers ───────────────────────────────────────────────────
function getSet(key, fallback = '') {
  const r = Q.getSetting.get(key);
  return r?.value ?? fallback;
}
function setSet(key, value) { Q.setSetting.run(key, String(value ?? '')); }

// Инициализация дефолтных настроек
const DEFAULTS = {
  required_channel: '',                                  // напр. @savemod_channel или -100...
  required_channel_url: '',                              // для кнопки «Подписаться»
  instruction_url: 'https://telegra.ph/SaveMOD',
  support_url:     'https://t.me/savemod',
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (Q.getSetting.get(k) == null) setSet(k, v);
}

// ─── 2. UTILS ───────────────────────────────────────────────────────────────
function escMd(s = '') { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m); }
const isAdmin = (id) => ADMIN_IDS.includes(id);
const isPremium = (u) => (u?.premium_until ?? 0) > Date.now();
const limitOf   = (u) => (isPremium(u) ? PREMIUM_LIMIT : FREE_LIMIT);

// ─── 3. KEYBOARDS ───────────────────────────────────────────────────────────
const kb = {
  start: (admin) => {
    const k = new InlineKeyboard().text('🤖 Мои боты', 'menu:bots');
    if (admin) k.row().text('🛠 Админ-панель', 'admin:home');
    return k;
  },

  bots: (list, user) => {
    const k = new InlineKeyboard();
    for (const b of list) {
      k.text(`${b.enabled ? '🟢' : '⚪️'} @${b.username}`, `bot:${b.bot_id}`).row();
    }
    const lim = limitOf(user);
    if (list.length < lim) k.text('➕ Создать бота', 'bots:create').row();
    k.text(`⭐ Премиум${isPremium(user) ? ' ✅' : ''}`, 'menu:premium').row();
    k.text('‹ Назад', 'menu:home');
    return k;
  },

  createConfirm: () => {
    const url = `https://t.me/newbot/${encodeURIComponent(MANAGER)}/${encodeURIComponent(DEFAULT_BOT_USERNAME)}` +
                `?name=${encodeURIComponent(DEFAULT_BOT_NAME)}`;
    return new InlineKeyboard()
      .url('✨ Создать бота', url).row()
      .text('‹ Назад', 'menu:bots');
  },

  botCard: (b) => new InlineKeyboard()
    .url('🔗 Открыть', `https://t.me/${b.username}`).row()
    .text(b.enabled ? '⏸ Выключить' : '▶️ Включить', `bot:toggle:${b.bot_id}`).row()
    .text('🗑 Удалить', `bot:delete:${b.bot_id}`).row()
    .text('‹ Назад', 'menu:bots'),

  premium: (user) => {
    const k = new InlineKeyboard();
    if (!isPremium(user)) k.text(`Купить за ${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн.`, 'premium:buy').row();
    k.text('‹ Назад', 'menu:home');
    return k;
  },

  subscribe: () => {
    const url = getSet('required_channel_url') || getSet('required_channel');
    const k = new InlineKeyboard();
    if (url) k.url('📢 Подписаться', url).row();
    k.text('✅ Я подписался', 'sub:check');
    return k;
  },

  admin: () => new InlineKeyboard()
    .text('📊 Статистика', 'admin:stats').row()
    .text('📢 Канал подписки', 'admin:channel').row()
    .text('🔗 Ссылки (инструкция / канал)', 'admin:links').row()
    .text('‹ Назад', 'menu:home'),

  adminBack: () => new InlineKeyboard().text('‹ Назад', 'admin:home'),
};

// ─── 4. TEXTS ───────────────────────────────────────────────────────────────
const T = {
  start: `Нажми «🤖 Мои боты», чтобы начать\\.`,
  bots:  (list, user) => {
    const lim = limitOf(user);
    if (!list.length) return `*Мои боты* \\(0/${lim}\\)\n\n_Ботов пока нет_`;
    const lines = list.map((b) => `• [@${escMd(b.username)}](https://t.me/${b.username}) — 👥 ${b.members}`);
    return `*Мои боты* \\(${list.length}/${lim}\\)\n\n` + lines.join('\n');
  },
  createReady: `Нажми кнопку ниже — откроется системное окно Telegram\\.`,
  botCard: (b) =>
    `*${escMd(b.display_name)}*\n\n` +
    `• [@${escMd(b.username)}](https://t.me/${b.username})\n` +
    `• Статус: ${b.enabled ? '🟢 активен' : '⚪️ выключен'}\n` +
    `• Подключений: ${b.members}`,
  premium: (user) => {
    if (isPremium(user)) {
      const left = Math.ceil((user.premium_until - Date.now()) / 86_400_000);
      return `⭐ *Премиум активен*\n\nОсталось дней: *${left}*\nЛимит ботов: *${PREMIUM_LIMIT}*`;
    }
    return `⭐ *Премиум*\n\n` +
           `• Без премиума: до *${FREE_LIMIT}* ботов\n` +
           `• С премиумом: до *${PREMIUM_LIMIT}* ботов, все команды\n\n` +
           `Стоимость: *${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн\\.*`;
  },
  needSub: `Чтобы пользоваться ботом, подпишись на наш канал\\.`,
  limitReached: (lim) => `Лимит ботов исчерпан \\(${lim}\\)\\.\nОформи ⭐ Премиум для расширения\\.`,
  admin: `🛠 *Админ\\-панель*`,
  adminStats: (s) =>
    `📊 *Статистика*\n\n` +
    `• Пользователей: *${s.users}*\n` +
    `• Премиум: *${s.premium}*\n` +
    `• Создано ботов: *${s.bots}*\n` +
    `• Запущенных модулей: *${s.children}*`,
  adminChannel: (ch, url) =>
    `📢 *Канал обязательной подписки*\n\n` +
    `Текущий: ${ch ? `\`${escMd(ch)}\`` : '_не задан_'}\n` +
    `Ссылка: ${url ? `\`${escMd(url)}\`` : '_не задана_'}\n\n` +
    `Отправь сообщение в формате:\n` +
    `\`@channel | https://t.me/channel\`\n\n` +
    `Чтобы отключить — отправь \`off\`\\.`,
  adminLinks: (i, s) =>
    `🔗 *Ссылки*\n\n` +
    `• Инструкция: ${i ? `\`${escMd(i)}\`` : '_—_'}\n` +
    `• Канал/Поддержка: ${s ? `\`${escMd(s)}\`` : '_—_'}\n\n` +
    `Отправь сообщение в формате:\n` +
    `\`instruction https://example.com\` или\n` +
    `\`support https://t.me/channel\``,
};

// ─── 5. BOT ─────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN);

// Регистрация / обновление пользователя
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    Q.upsertUser.run(ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, Date.now());
  }
  await next();
});

// In-memory состояние ввода для админа
const adminInput = new Map(); // user_id → 'channel' | 'links'

// ─── 5.1 Проверка подписки ─────────────────────────────────────────────────
async function isSubscribed(ctx, uid) {
  const ch = getSet('required_channel');
  if (!ch) return true;
  if (isAdmin(uid)) return true;
  try {
    const m = await ctx.api.getChatMember(ch, uid);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch {
    return true; // если бот не админ канала — не блокируем
  }
}

// ─── 5.2 /start ─────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  if (!(await isSubscribed(ctx, ctx.from.id))) {
    return ctx.reply(T.needSub, { parse_mode: 'MarkdownV2', reply_markup: kb.subscribe() });
  }
  await ctx.reply(T.start, { parse_mode: 'MarkdownV2', reply_markup: kb.start(isAdmin(ctx.from.id)) });
});

// ─── 5.3 Callback router ────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  try {
    // Проверка подписки на всех роутах кроме самой проверки
    if (data !== 'sub:check' && !(await isSubscribed(ctx, ctx.from.id))) {
      return editText(ctx, T.needSub, kb.subscribe());
    }

    if (data === 'sub:check') {
      if (await isSubscribed(ctx, ctx.from.id)) {
        return editText(ctx, T.start, kb.start(isAdmin(ctx.from.id)));
      }
      return ctx.answerCallbackQuery({ text: 'Подписка не найдена', show_alert: true });
    }

    if (data === 'menu:home')    return editText(ctx, T.start, kb.start(isAdmin(ctx.from.id)));
    if (data === 'menu:bots')    return showBots(ctx);
    if (data === 'menu:premium') return showPremium(ctx);

    if (data === 'bots:create') return startCreate(ctx);
    if (data === 'premium:buy') return sendInvoice(ctx);

    if (data.startsWith('bot:toggle:')) return toggleBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:delete:')) return deleteBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:'))        return showBotCard(ctx, +data.split(':')[1]);

    if (data === 'admin:home' && isAdmin(ctx.from.id))    return editText(ctx, T.admin, kb.admin());
    if (data === 'admin:stats' && isAdmin(ctx.from.id))   return showAdminStats(ctx);
    if (data === 'admin:channel' && isAdmin(ctx.from.id)) return showAdminChannel(ctx);
    if (data === 'admin:links' && isAdmin(ctx.from.id))   return showAdminLinks(ctx);

    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error('[callback]', err);
    await ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте ещё раз' }).catch(() => {});
  }
});

// ─── 5.4 Admin text input ───────────────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  if (ctx.msg.text.startsWith('/')) return;

  const uid = ctx.from.id;
  const mode = adminInput.get(uid);

  // Привязка существующего бота по токену
  if (/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(ctx.msg.text.trim())) {
    return attachByToken(ctx, ctx.msg.text.trim());
  }

  if (!mode || !isAdmin(uid)) return;

  const text = ctx.msg.text.trim();

  if (mode === 'channel') {
    if (text.toLowerCase() === 'off') {
      setSet('required_channel', '');
      setSet('required_channel_url', '');
      adminInput.delete(uid);
      return ctx.reply('✅ Обязательная подписка отключена.');
    }
    const parts = text.split('|').map((s) => s.trim());
    const ch  = parts[0];
    const url = parts[1] || '';
    if (!ch) return ctx.reply('Неверный формат. Пример: @channel | https://t.me/channel');
    setSet('required_channel', ch);
    setSet('required_channel_url', url);
    adminInput.delete(uid);
    return ctx.reply(`✅ Канал установлен: ${ch}`);
  }

  if (mode === 'links') {
    const [key, ...rest] = text.split(/\s+/);
    const val = rest.join(' ').trim();
    if (key === 'instruction' && val) {
      setSet('instruction_url', val);
      adminInput.delete(uid);
      return ctx.reply(`✅ Инструкция: ${val}`);
    }
    if (key === 'support' && val) {
      setSet('support_url', val);
      adminInput.delete(uid);
      return ctx.reply(`✅ Поддержка/канал: ${val}`);
    }
    return ctx.reply('Неверный формат. Пример: instruction https://example.com');
  }
});

// ─── 5.5 Managed-bot updates (Bot API 9.6) ─────────────────────────────────
bot.use(async (ctx, next) => {
  const u = ctx.update;
  if (u.managed_bot) {
    await handleManagedBotUpdated(u.managed_bot, ctx);
    return;
  }
  if (ctx.msg?.managed_bot_created) {
    await handleManagedBotCreated(ctx.msg.managed_bot_created, ctx);
    return;
  }
  await next();
});

async function handleManagedBotUpdated(mbu, ctx) {
  const ownerId = mbu.owner_user_id || ctx.from?.id;
  const b       = mbu.bot;
  const token   = mbu.token;
  if (!b || !ownerId) return;

  // Проверяем лимит на момент создания
  const user = Q.getUser.get(ownerId);
  const cnt  = Q.countBots.get(ownerId).c;
  if (cnt >= limitOf(user)) {
    return ctx.api.sendMessage(ownerId,
      `⚠️ Лимит ботов исчерпан (${limitOf(user)}). Оформи Премиум для расширения.`).catch(() => {});
  }

  Q.insertBot.run(b.id, ownerId, b.username, b.first_name || b.username, token || null, Date.now());

  await ctx.api.sendMessage(
    ownerId,
    `🎉 *Бот создан\\!*\n\n` +
    `• [@${escMd(b.username)}](https://t.me/${b.username})\n` +
    `• Имя: *${escMd(b.first_name || b.username)}*\n\n` +
    `Перейди в [@${escMd(b.username)}](https://t.me/${b.username}) и нажми \\/start\\.`,
    { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } },
  ).catch(() => {});

  spawnModuleFor(b.username, token);
}

async function handleManagedBotCreated(mbc, ctx) {
  if (!mbc?.bot) return;
  Q.insertBot.run(mbc.bot.id, ctx.from.id, mbc.bot.username,
                  mbc.bot.first_name || mbc.bot.username, null, Date.now());
}

// ─── 5.6 Children processes manager ─────────────────────────────────────────
const children = new Map(); // username → ChildProcess
function spawnModuleFor(username, token) {
  if (!token) return;
  if (children.has(username)) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(here, 'module.js')], {
    env: {
      ...process.env,
      MODULE_BOT_TOKEN: token,
      MODULE_BOT_USERNAME: username,
      CONSTRUCTOR_DB: DB_PATH,        // модуль читает премиум-статус из общей БД
    },
    stdio: 'inherit',
  });
  children.set(username, child);
  child.on('exit', (code) => {
    console.log(`[module:${username}] exited with ${code}`);
    children.delete(username);
  });
}

// Поднимаем при старте
for (const b of db.prepare(`SELECT * FROM bots WHERE token IS NOT NULL AND enabled = 1`).all()) {
  spawnModuleFor(b.username, b.token);
}

// ─── 6. SCREENS ─────────────────────────────────────────────────────────────
async function editText(ctx, text, reply_markup) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      reply_markup,
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof GrammyError && /not modified/.test(err.description || '')) {
      // ok
    } else {
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
  if (!b || b.owner_id !== ctx.from.id) {
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

async function toggleBot(ctx, id) {
  const b = Q.getBot.get(id);
  if (!b || b.owner_id !== ctx.from.id) return ctx.answerCallbackQuery({ text: '⛔️', show_alert: true });
  Q.toggleBot.run(id);
  const updated = Q.getBot.get(id);
  if (updated.enabled && updated.token) spawnModuleFor(updated.username, updated.token);
  else children.get(updated.username)?.kill();
  return showBotCard(ctx, id);
}

async function deleteBot(ctx, id) {
  const b = Q.getBot.get(id);
  if (!b || b.owner_id !== ctx.from.id) return ctx.answerCallbackQuery({ text: '⛔️', show_alert: true });
  children.get(b.username)?.kill();
  Q.delBot.run(id, ctx.from.id);
  await ctx.answerCallbackQuery({ text: 'Удалён' });
  return showBots(ctx);
}

async function attachByToken(ctx, token) {
  try {
    const probe = new Bot(token);
    const me = await probe.api.getMe();
    const user = Q.getUser.get(ctx.from.id);
    const cnt  = Q.countBots.get(ctx.from.id).c;
    if (cnt >= limitOf(user)) {
      return ctx.reply(`Лимит ${limitOf(user)} ботов исчерпан.`);
    }
    Q.insertBot.run(me.id, ctx.from.id, me.username, me.first_name || me.username, token, Date.now());
    spawnModuleFor(me.username, token);
    await ctx.reply(`✅ Подключён: @${me.username}`);
  } catch {
    await ctx.reply('❌ Токен невалиден.');
  }
}

// ─── 7. PREMIUM (Telegram Stars) ───────────────────────────────────────────
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
    'XTR',                                       // Telegram Stars
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

// ─── 8. ADMIN PANEL ────────────────────────────────────────────────────────
async function showAdminStats(ctx) {
  const stats = {
    users:    Q.countUsers.get().c,
    premium:  Q.countPremium.get(Date.now()).c,
    bots:     Q.countAllBots.get().c,
    children: children.size,
  };
  return editText(ctx, T.adminStats(stats), kb.adminBack());
}

async function showAdminChannel(ctx) {
  adminInput.set(ctx.from.id, 'channel');
  return editText(
    ctx,
    T.adminChannel(getSet('required_channel'), getSet('required_channel_url')),
    kb.adminBack(),
  );
}

async function showAdminLinks(ctx) {
  adminInput.set(ctx.from.id, 'links');
  return editText(
    ctx,
    T.adminLinks(getSet('instruction_url'), getSet('support_url')),
    kb.adminBack(),
  );
}

// ─── 9. ERROR BOUNDARY ─────────────────────────────────────────────────────
bot.catch((err) => {
  if (err.error instanceof HttpError)        console.error('[net]', err.error);
  else if (err.error instanceof GrammyError) console.error('[tg]', err.error.description);
  else console.error('[bot]', err.error);
});

// ─── 10. START ─────────────────────────────────────────────────────────────
const ALLOWED = [
  'message', 'edited_message', 'callback_query',
  'pre_checkout_query',
  'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages',
  'managed_bot',
];

bot.start({
  allowed_updates: ALLOWED,
  onStart: (me) => console.log(`🛠  Constructor @${me.username} started`),
});

// graceful shutdown
const stop = (sig) => {
  console.log(`\n[${sig}] shutting down…`);
  bot.stop();
  for (const c of children.values()) { try { c.kill(); } catch {} }
  process.exit(0);
};
process.once('SIGINT',  () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
