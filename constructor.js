// ════════════════════════════════════════════════════════════════════════════
//  SaveMOD — Bot Constructor  (single-file)
//  ───────────────────────────────────────────────────────────────────────────
//  • grammY 1.36+   • better-sqlite3   • Bot API 9.6 «Managed Bots»
//  • Inline-меню как на скриншотах (edit-in-place, без захламления чата)
//  • Создание управляемых ботов через t.me/newbot/<manager>/<suggested>?name=
//  • После создания — выдаём владельцу токен и записываем бота в БД,
//    откуда module.js поднимет его как «дочерний» Business-бот.
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─── 0. ENV ─────────────────────────────────────────────────────────────────
const TOKEN       = process.env.CONSTRUCTOR_BOT_TOKEN;
const MANAGER     = (process.env.CONSTRUCTOR_BOT_USERNAME || '').replace(/^@/, '');
const DB_PATH     = process.env.CONSTRUCTOR_DB     || './constructor.db';
const SUPPORT_URL = process.env.SUPPORT_CHANNEL    || 'https://t.me/savemod';
const INSTR_URL   = process.env.INSTRUCTION_URL    || 'https://telegra.ph/SaveMOD';

if (!TOKEN)   throw new Error('CONSTRUCTOR_BOT_TOKEN is missing in .env');
if (!MANAGER) throw new Error('CONSTRUCTOR_BOT_USERNAME is missing in .env');

// ─── 1. DATABASE ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id     INTEGER PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    is_premium  INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bots (
    bot_id        INTEGER PRIMARY KEY,        -- Telegram user_id of created bot
    owner_id      INTEGER NOT NULL,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL,
    token         TEXT,                       -- known after ManagedBotUpdated
    members       INTEGER DEFAULT 0,          -- connected business accounts
    enabled       INTEGER DEFAULT 1,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(user_id)
  );

  CREATE TABLE IF NOT EXISTS pending (        -- suggested-username flow
    owner_id      INTEGER PRIMARY KEY,
    suggested     TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
`);

const Q = {
  upsertUser: db.prepare(`
    INSERT INTO users (user_id, username, first_name, is_premium, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      is_premium = excluded.is_premium`),
  listBots:    db.prepare(`SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at ASC`),
  getBot:      db.prepare(`SELECT * FROM bots WHERE bot_id = ?`),
  getBotByUsername: db.prepare(`SELECT * FROM bots WHERE username = ? COLLATE NOCASE`),
  insertBot:   db.prepare(`
    INSERT INTO bots (bot_id, owner_id, username, display_name, token, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id) DO UPDATE SET
      token = excluded.token,
      display_name = excluded.display_name`),
  delBot:      db.prepare(`DELETE FROM bots WHERE bot_id = ? AND owner_id = ?`),
  toggleBot:   db.prepare(`UPDATE bots SET enabled = NOT enabled WHERE bot_id = ?`),
  setPending:  db.prepare(`
    INSERT INTO pending (owner_id, suggested, display_name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET
      suggested = excluded.suggested,
      display_name = excluded.display_name,
      created_at = excluded.created_at`),
  getPending:  db.prepare(`SELECT * FROM pending WHERE owner_id = ?`),
  delPending:  db.prepare(`DELETE FROM pending WHERE owner_id = ?`),
};

// ─── 2. UI HELPERS ──────────────────────────────────────────────────────────
const txt = {
  brand: '🤖 *SaveMOD*',
  greeting: (name) =>
    `👋 *Привет, ${name}!*\n\n` +
    `Я — *SaveMOD*, конструктор личных Telegram-ботов.\n` +
    `С их помощью ты сможешь:\n\n` +
    `• 🔔 получать уведомления, когда собеседник *удаляет* или *редактирует* сообщения;\n` +
    `• 📸 сохранять *исчезающие* фото, голосовые и видео;\n` +
    `• ⚙️ выполнять команды через точку \\(\\.help, \\.info …\\) прямо в чатах.\n\n` +
    `Нажми «🤖 Мои боты», чтобы начать.`,
  myBotsHeader: (count) =>
    count === 0
      ? `👾 *Ваши боты:*\n\n_У тебя пока нет ботов._\nНажми «➕ Добавить бота», чтобы создать первого.`
      : `👾 *Ваши боты:*`,
  botLine: (b) => `[@${escMd(b.username)}](https://t.me/${b.username}) — 👥 ${b.members}`,
  createIntro:
    `🆕 *Создание бота*\n\n` +
    `SaveMOD предложит создать чат\\-бота и управлять им от твоего имени\\.\n\n` +
    `Шаг 1️⃣ — придумай *@username* будущего бота \\(должен заканчиваться на \`bot\` или \`Bot\`, 5–32 символа\\)\\.\n\n` +
    `Просто отправь желаемый username сообщением \\(например, \`MySaveBot\`\\)\\.`,
  needUsername:
    `Username должен:\n• заканчиваться на *bot*\n• быть длиной 5–32 символа\n• содержать только латиницу, цифры и \\_\n\nПопробуй ещё раз.`,
  suggestName: (uname) =>
    `✅ Username принят: \`@${escMd(uname)}\`\n\n` +
    `Шаг 2️⃣ — напиши *отображаемое имя* бота \\(например, *SaveMOD 🤖*\\)\\.`,
  ready: (uname, dname) =>
    `🚀 *Готово к созданию*\n\n` +
    `• Username: \`@${escMd(uname)}\`\n` +
    `• Имя: *${escMd(dname)}*\n\n` +
    `Нажми кнопку ниже — откроется системное окно Telegram для подтверждения создания\\.`,
  navigationHelp:
    `📜 *Описание команд*\n\n` +
    `Команды вводятся в *обычных чатах* \\(не у меня\\) через точку\\.\n` +
    `Например, отправь \`\\.help\` в любом диалоге — и подключённый бот ответит\\.\n\n` +
    `Нажми на любую команду ниже, чтобы узнать подробности\\.`,
  profile: (u, botsCnt) =>
    `👤 *Профиль*\n\n` +
    `• ID: \`${u.user_id}\`\n` +
    `• Имя: ${escMd(u.first_name || '—')}\n` +
    `• Username: ${u.username ? '@' + escMd(u.username) : '—'}\n` +
    `• Telegram Premium: ${u.is_premium ? '✅' : '❌'}\n` +
    `• Ботов создано: *${botsCnt}*`,
  settings:
    `⚙️ *Настройки*\n\n` +
    `Здесь будут глобальные настройки уведомлений, языка и приватности\\.\n` +
    `Каждый отдельный бот настраивается из его собственного меню\\.`,
  premium:
    `⭐ *Premium\\-доступ*\n\n` +
    `Базовый функционал SaveMOD бесплатный\\.\n` +
    `Premium открывает:\n• до 10 ботов одновременно\n• приоритетную скорость уведомлений\n• расширенный архив исчезающих медиа\n• кастомные команды через точку`,
};

function escMd(s = '') { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m); }

const kb = {
  main: () =>
    new InlineKeyboard()
      .text('🤖 Мои боты', 'menu:bots').row()
      .text('👤 Профиль', 'menu:profile').text('⚙️ Настройки', 'menu:settings').row()
      .url('📢 Канал', SUPPORT_URL).url('📋 Инструкция', INSTR_URL).row()
      .text('⭐ Premium-доступ', 'menu:premium'),

  bots: (list) => {
    const k = new InlineKeyboard();
    for (const b of list) {
      k.text(`@${b.username} — 👥 ${b.members}`, `bot:${b.bot_id}`).row();
    }
    k.text('➕ Создать бота', 'bots:create').row();
    k.text('🔗 Добавить существующего', 'bots:attach').row();
    k.text('‹ Назад', 'menu:main');
    return k;
  },

  // BotAPI 9.6 «Managed bots»: t.me/newbot/<manager>/<suggested>?name=<...>
  createConfirm: (suggested, displayName) => {
    const url = `https://t.me/newbot/${encodeURIComponent(MANAGER)}/${encodeURIComponent(suggested)}` +
                `?name=${encodeURIComponent(displayName)}`;
    return new InlineKeyboard()
      .url('✨ Создать в Telegram', url).row()
      .text('🔄 Изменить username', 'bots:create').row()
      .text('‹ Отмена', 'menu:bots');
  },

  back: (to = 'menu:main') => new InlineKeyboard().text('‹ Назад', to),

  botCard: (b) =>
    new InlineKeyboard()
      .url('🔗 Открыть в Telegram', `https://t.me/${b.username}`).row()
      .text(b.enabled ? '⏸ Выключить' : '▶️ Включить', `bot:toggle:${b.bot_id}`).row()
      .text('🗑 Удалить', `bot:delete:${b.bot_id}`).row()
      .text('‹ Назад', 'menu:bots'),

  // .-команды как на скрине №4
  dotCommands: () => {
    const cmds = [
      '.afk','.clone','.crash','.cspam',
      '.dice','.dox','.doxp','.dspam',
      '.duel','.flip','.fv','.gifts',
      '.gosu','.gp','.help','.info',
      '.kawaii','.love','.lq','.mute',
      '.nk','.send','.short','.spam',
      '.status','.switch','.time','.troll',
      '.ttt','.type','.unmute','.wspam',
      '.yars','.zaebu',
    ];
    const k = new InlineKeyboard();
    for (let i = 0; i < cmds.length; i += 4) {
      const row = cmds.slice(i, i + 4);
      for (const c of row) k.text(c, `cmd:${c.slice(1)}`);
      k.row();
    }
    k.text('‹ Назад', 'menu:main');
    return k;
  },

  cmdInfo: (cmd) => new InlineKeyboard().text('‹ К командам', 'menu:cmds'),
};

// Подробности .-команд (для модуля реализуем только .help, остальные — описание)
const dotCmdDocs = {
  help:    'Показывает в текущем чате список доступных точечных команд и краткую справку.',
  afk:     'Включает режим «Отошёл» — бот авто-отвечает в чатах с указанной причиной.',
  info:    'Выводит информацию о собеседнике (id, имя, регистрация).',
  status:  'Показывает статус подключённого бизнес-бота: антиделит, сохранение медиа и т.д.',
  time:    'Отправляет текущее время в чат.',
  send:    'Отправляет в текущем чате текст от твоего имени с задержкой/анимацией.',
  mute:    'Локально (для тебя) скрывает уведомления от собеседника.',
  unmute:  'Возвращает уведомления от собеседника.',
};

// ─── 3. BOT ─────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN);

// Регистрация пользователя
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    Q.upsertUser.run(
      ctx.from.id,
      ctx.from.username || null,
      ctx.from.first_name || null,
      ctx.from.is_premium ? 1 : 0,
      Date.now(),
    );
  }
  await next();
});

// ─── 3.1 /start ─────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const name = escMd(ctx.from?.first_name || 'друг');
  await ctx.reply(txt.greeting(name), {
    parse_mode: 'MarkdownV2',
    reply_markup: kb.main(),
  });
});

// ─── 3.2 Universal callback router ──────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  try {
    if (data === 'menu:main')      return showMain(ctx);
    if (data === 'menu:bots')      return showBots(ctx);
    if (data === 'menu:profile')   return showProfile(ctx);
    if (data === 'menu:settings')  return editText(ctx, txt.settings, kb.back());
    if (data === 'menu:premium')   return editText(ctx, txt.premium,  kb.back());
    if (data === 'menu:cmds')      return editText(ctx, txt.navigationHelp, kb.dotCommands());

    if (data === 'bots:create')    return startCreateFlow(ctx);
    if (data === 'bots:attach')    return promptAttach(ctx);

    if (data.startsWith('bot:toggle:')) return toggleBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:delete:')) return deleteBot(ctx, +data.split(':')[2]);
    if (data.startsWith('bot:'))        return showBotCard(ctx, +data.split(':')[1]);

    if (data.startsWith('cmd:')) {
      const cmd = data.slice(4);
      const desc = dotCmdDocs[cmd] || 'Команда зарезервирована, описание появится позже.';
      return editText(ctx, `*\\.${escMd(cmd)}*\n\n${escMd(desc)}`, kb.cmdInfo(cmd));
    }

    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error('[callback]', err);
    await ctx.answerCallbackQuery({ text: 'Ошибка, попробуй ещё раз', show_alert: false }).catch(() => {});
  }
});

// ─── 3.3 Text handler — этапы создания бота ─────────────────────────────────
bot.on('message:text', async (ctx) => {
  if (ctx.msg.text.startsWith('/')) return; // другие команды

  const pending = Q.getPending.get(ctx.from.id);
  if (!pending) return;

  // Этап 1: ждём username
  if (!pending.suggested || pending.suggested === '__WAIT_USERNAME__') {
    const uname = ctx.msg.text.trim().replace(/^@/, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(uname) || !/bot$/i.test(uname)) {
      return ctx.reply(txt.needUsername, { parse_mode: 'MarkdownV2' });
    }
    if (Q.getBotByUsername.get(uname)) {
      return ctx.reply('⚠️ Этот username уже занят в нашей базе. Попробуй другой.');
    }
    Q.setPending.run(ctx.from.id, uname, '__WAIT_NAME__', Date.now());
    return ctx.reply(txt.suggestName(uname), { parse_mode: 'MarkdownV2' });
  }

  // Этап 2: ждём display name
  if (pending.display_name === '__WAIT_NAME__') {
    const dname = ctx.msg.text.trim().slice(0, 64);
    if (dname.length < 1) return ctx.reply('Имя слишком короткое.');
    Q.setPending.run(ctx.from.id, pending.suggested, dname, Date.now());
    return ctx.reply(txt.ready(pending.suggested, dname), {
      parse_mode: 'MarkdownV2',
      reply_markup: kb.createConfirm(pending.suggested, dname),
    });
  }
});

// ─── 3.4 Managed-bot updates (Bot API 9.6) ─────────────────────────────────
// Когда пользователь подтвердил создание в системном окне Telegram,
// нам прилетает update.managed_bot с токеном свежесозданного бота.
// grammY ещё не имеет именованного хэндлера → ловим на сыром уровне.
bot.use(async (ctx, next) => {
  const u = ctx.update;
  if (u.managed_bot) {
    await handleManagedBotUpdated(u.managed_bot, ctx);
    return;
  }
  // Также возможно сообщение типа managed_bot_created в чате-конструкторе
  if (ctx.msg && ctx.msg.managed_bot_created) {
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

  Q.insertBot.run(b.id, ownerId, b.username, b.first_name || b.username, token || null, Date.now());
  Q.delPending.run(ownerId);

  await ctx.api.sendMessage(
    ownerId,
    `🎉 *Бот создан\\!*\n\n` +
    `• [@${escMd(b.username)}](https://t.me/${b.username})\n` +
    `• Имя: *${escMd(b.first_name || b.username)}*\n\n` +
    `Я только что подключил к нему *модуль SaveMOD* — теперь он умеет всё, ` +
    `что обещано на главной\\. Перейди в @${escMd(b.username)} и нажми «Скопировать @username», ` +
    `чтобы подключить его к своему Telegram Business\\.`,
    { parse_mode: 'MarkdownV2' },
  );

  // Поднимаем дочерний процесс с модулем для этого бота
  spawnModuleFor(b.username, token);
}

async function handleManagedBotCreated(mbc, ctx) {
  // Резервный путь: запись о создании пришла как Message.managed_bot_created
  if (!mbc?.bot) return;
  Q.insertBot.run(mbc.bot.id, ctx.from.id, mbc.bot.username,
                  mbc.bot.first_name || mbc.bot.username, null, Date.now());
}

// ─── 3.5 Менеджер дочерних модулей ─────────────────────────────────────────
const children = new Map(); // username → ChildProcess
function spawnModuleFor(username, token) {
  if (!token) return;
  if (children.has(username)) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(here, 'module.js')], {
    env: { ...process.env, MODULE_BOT_TOKEN: token, MODULE_BOT_USERNAME: username },
    stdio: 'inherit',
  });
  children.set(username, child);
  child.on('exit', (code) => {
    console.log(`[module:${username}] exited with ${code}`);
    children.delete(username);
  });
}

// При старте конструктора поднимаем все ранее созданные модули
for (const b of db.prepare(`SELECT * FROM bots WHERE token IS NOT NULL AND enabled = 1`).all()) {
  spawnModuleFor(b.username, b.token);
}

// ─── 4. SCREEN BUILDERS ─────────────────────────────────────────────────────
async function editText(ctx, text, reply_markup) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup });
  } catch (err) {
    if (err instanceof GrammyError && err.description?.includes('not modified')) return;
    // Если редактировать нельзя (например, сообщение слишком старое) — отправим новое
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup });
  }
  await ctx.answerCallbackQuery().catch(() => {});
}

async function showMain(ctx) {
  const name = escMd(ctx.from?.first_name || 'друг');
  return editText(ctx, txt.greeting(name), kb.main());
}

async function showBots(ctx) {
  const list = Q.listBots.all(ctx.from.id);
  let body = txt.myBotsHeader(list.length);
  if (list.length) body += '\n\n' + list.map(txt.botLine).join('\n');
  return editText(ctx, body, kb.bots(list));
}

async function showBotCard(ctx, botId) {
  const b = Q.getBot.get(botId);
  if (!b || b.owner_id !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: 'Бот не найден', show_alert: true });
  }
  const body =
    `🤖 *${escMd(b.display_name)}*\n\n` +
    `• Username: [@${escMd(b.username)}](https://t.me/${b.username})\n` +
    `• Подключений: 👥 *${b.members}*\n` +
    `• Статус: ${b.enabled ? '🟢 активен' : '⚪️ выключен'}\n` +
    `• Токен: ${b.token ? '🔑 получен' : '⌛ ожидание'}`;
  return editText(ctx, body, kb.botCard(b));
}

async function showProfile(ctx) {
  const u = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(ctx.from.id);
  const cnt = Q.listBots.all(ctx.from.id).length;
  return editText(ctx, txt.profile(u, cnt), kb.back());
}

async function startCreateFlow(ctx) {
  Q.setPending.run(ctx.from.id, '__WAIT_USERNAME__', '__WAIT_USERNAME__', Date.now());
  return editText(ctx, txt.createIntro, new InlineKeyboard().text('‹ Отмена', 'menu:bots'));
}

async function promptAttach(ctx) {
  return editText(
    ctx,
    `🔗 *Привязка существующего бота*\n\n` +
    `Пришли мне токен бота из @BotFather одним сообщением \\(формат \`123456:AA…\`\\)\\.\n` +
    `Я подключу к нему модуль SaveMOD\\.`,
    new InlineKeyboard().text('‹ Отмена', 'menu:bots'),
  );
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

// Обработка токенов «привязки» (одним сообщением)
bot.hears(/^\d{6,}:[A-Za-z0-9_-]{20,}$/, async (ctx) => {
  const token = ctx.msg.text.trim();
  // Получаем username через getMe «временного» бота
  try {
    const probe = new Bot(token);
    const me = await probe.api.getMe();
    Q.insertBot.run(me.id, ctx.from.id, me.username, me.first_name || me.username, token, Date.now());
    spawnModuleFor(me.username, token);
    await ctx.reply(`✅ Подключено: @${me.username}`);
    await showBots(ctx).catch(() => {});
  } catch (e) {
    await ctx.reply('❌ Токен невалиден или бот недоступен.');
  }
});

// ─── 5. ERROR-BOUNDARY ─────────────────────────────────────────────────────
bot.catch((err) => {
  if (err.error instanceof HttpError)   console.error('[net]', err.error);
  else if (err.error instanceof GrammyError) console.error('[tg]', err.error.description);
  else console.error('[bot]', err.error);
});

// ─── 6. START ──────────────────────────────────────────────────────────────
const ALLOWED = [
  'message', 'edited_message', 'callback_query',
  'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages',
  'managed_bot', // BotAPI 9.6
];

bot.start({
  allowed_updates: ALLOWED,
  onStart: (me) => console.log(`🛠  Constructor @${me.username} started`),
});

// graceful shutdown
const stop = (sig) => { console.log(`\n[${sig}] shutting down…`); bot.stop(); for (const c of children.values()) c.kill(); process.exit(0); };
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
