// ════════════════════════════════════════════════════════════════════════════
//  SaveMOD — Universal Business Module (single-file, minimal)
//  ───────────────────────────────────────────────────────────────────────────
//  Дочерний бот, запускаемый конструктором. Реализует:
//    • Inline-меню (профиль, настройки, премиум, описание команд, инструкция)
//    • Уведомления о редактировании/удалении сообщений собеседника
//    • Сохранение исчезающих фото/голосовых/video_note
//    • Точечные команды (сейчас только .help — заготовка)
//    • Премиум (200⭐ / 30 дней) — лимиты команд / ботов
//    • Админ-панель (ADMIN_IDS)
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Bot, InlineKeyboard, GrammyError, HttpError, InputFile } from 'grammy';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// ─── 0. ENV ─────────────────────────────────────────────────────────────────
const TOKEN     = process.env.MODULE_BOT_TOKEN;
const USERNAME  = process.env.MODULE_BOT_USERNAME || '';
const DB_PATH   = process.env.MODULE_DB || `./module-${USERNAME || 'default'}.db`;
const CDB_PATH  = process.env.CONSTRUCTOR_DB || './constructor.db';
const MEDIA_DIR = process.env.MEDIA_DIR || './saved_media';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);

if (!TOKEN) throw new Error('MODULE_BOT_TOKEN is missing');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const PREMIUM_PRICE = 200;
const PREMIUM_DAYS  = 30;

// Команды: free vs premium
const FREE_COMMANDS    = ['help'];
const PREMIUM_COMMANDS = []; // позже сюда добавим: 'info','time','afk', и т.д.

const DOT_DOCS = {
  help: 'Показывает список доступных точечных команд.',
};

// ─── 1. DATABASE (модульная) ────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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

  CREATE TABLE IF NOT EXISTS payments (
    payload     TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    charge_id   TEXT,
    stars       INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

const Q = {
  saveConn: db.prepare(`
    INSERT INTO connections (connection_id, user_id, user_chat_id, is_enabled,
                             can_reply, can_read, can_del_sent, can_del_all, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id) DO UPDATE SET
      is_enabled   = excluded.is_enabled,
      can_reply    = excluded.can_reply,
      can_read     = excluded.can_read,
      can_del_sent = excluded.can_del_sent,
      can_del_all  = excluded.can_del_all,
      updated_at   = excluded.updated_at`),
  getConn:        db.prepare(`SELECT * FROM connections WHERE connection_id = ?`),
  getConnByUser:  db.prepare(`SELECT * FROM connections WHERE user_id = ? LIMIT 1`),
  cacheMsg: db.prepare(`
    INSERT OR REPLACE INTO msg_cache
      (connection_id, chat_id, message_id, from_id, from_name,
       text, media_kind, media_file_id, is_self_destruct, saved_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getMsg: db.prepare(`SELECT * FROM msg_cache
                      WHERE connection_id = ? AND chat_id = ? AND message_id = ?`),
  saveMedia: db.prepare(`
    INSERT INTO saved_media (owner_id, from_id, from_name, kind, local_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  ensureSettings: db.prepare(`INSERT OR IGNORE INTO settings (user_id) VALUES (?)`),
  getSettings:    db.prepare(`SELECT * FROM settings WHERE user_id = ?`),
  setSetting:     (k) => db.prepare(`UPDATE settings SET ${k} = ? WHERE user_id = ?`),

  addPayment: db.prepare(`
    INSERT OR IGNORE INTO payments (payload, user_id, charge_id, stars, created_at)
    VALUES (?, ?, ?, ?, ?)`),

  countConns: db.prepare(`SELECT COUNT(*) AS c FROM connections WHERE is_enabled = 1`),
  countMedia: db.prepare(`SELECT COUNT(*) AS c FROM saved_media`),
};

// ─── 1.1 Конструкторская БД (read-only): премиум-статус и общие настройки ──
let cdb = null;
try {
  cdb = new Database(CDB_PATH, { fileMustExist: false, readonly: false });
  cdb.pragma('journal_mode = WAL');
  // На случай ручного запуска модуля без конструктора — создадим таблицы
  cdb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
      premium_until INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
} catch (e) {
  console.warn('[module] constructor DB unavailable:', e.message);
}

const CQ = cdb ? {
  getUser:    cdb.prepare(`SELECT * FROM users WHERE user_id = ?`),
  setPremium: cdb.prepare(`UPDATE users SET premium_until = ? WHERE user_id = ?`),
  upsertUser: cdb.prepare(`
    INSERT INTO users (user_id, username, first_name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name`),
  getSetting: cdb.prepare(`SELECT value FROM settings WHERE key = ?`),
} : null;

function isPremium(uid) {
  if (!CQ) return false;
  const u = CQ.getUser.get(uid);
  return (u?.premium_until ?? 0) > Date.now();
}
function constructorSetting(key, fallback = '') {
  return CQ?.getSetting.get(key)?.value ?? fallback;
}
const isAdmin = (id) => ADMIN_IDS.includes(id);

// ─── 2. UI ──────────────────────────────────────────────────────────────────
function escMd(s = '') { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m); }

const INTRO =
  `Этот бот делает Telegram удобнее:\n` +
  `• уведомляет об *удалении* и *редактировании* сообщений;\n` +
  `• сохраняет *исчезающие* фото, голосовые и видео\\.\n\n` +
  `Нажми «Скопировать @username» и подключи бота в Telegram Business\\.`;

const kbMain = (uname, admin) => {
  const k = new InlineKeyboard()
    .switchInlineCurrent('📋 Скопировать @username', `@${uname}`).row()
    .text('❓ Команды', 'nav:cmds').text('👤 Профиль', 'nav:profile').row()
    .text('⚙️ Настройки', 'nav:settings').text('⭐ Премиум', 'nav:premium').row();
  const instr   = constructorSetting('instruction_url', 'https://telegra.ph/SaveMOD');
  const support = constructorSetting('support_url',     'https://t.me/savemod');
  k.url('📖 Инструкция', instr).url('📢 Канал', support).row();
  if (admin) k.text('🛠 Админ-панель', 'nav:admin');
  return k;
};

const kbCmds = (premium) => {
  const free = FREE_COMMANDS;
  const prem = PREMIUM_COMMANDS;
  const k = new InlineKeyboard();
  for (const c of free) k.text(`.${c}`, `cmd:${c}`);
  if (free.length) k.row();
  for (const c of prem) k.text(`${premium ? '' : '🔒 '}.${c}`, `cmd:${c}`);
  if (prem.length) k.row();
  k.text('‹ Назад', 'nav:main');
  return k;
};

const kbSettings = (s) =>
  new InlineKeyboard()
    .text(`${s.notify_edits     ? '✅' : '⬜️'} Уведомления о правках`,    'set:notify_edits').row()
    .text(`${s.notify_deletes   ? '✅' : '⬜️'} Уведомления об удалениях`, 'set:notify_deletes').row()
    .text(`${s.save_disappearing? '✅' : '⬜️'} Сохранять исчезающее`,    'set:save_disappearing').row()
    .text(`${s.dot_commands     ? '✅' : '⬜️'} Команды через точку`,      'set:dot_commands').row()
    .text('‹ Назад', 'nav:main');

const kbPremium = (premium) => {
  const k = new InlineKeyboard();
  if (!premium) k.text(`Купить за ${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн.`, 'premium:buy').row();
  k.text('‹ Назад', 'nav:main');
  return k;
};

const kbAdmin = () => new InlineKeyboard()
  .text('📊 Статистика модуля', 'admin:stats').row()
  .text('‹ Назад', 'nav:main');

const backTo = (to) => new InlineKeyboard().text('‹ Назад', to);

// ─── 3. BOT ─────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot && CQ) {
    try {
      CQ.upsertUser.run(ctx.from.id, ctx.from.username || null,
                        ctx.from.first_name || null, Date.now());
    } catch {}
  }
  await next();
});

bot.command('start', async (ctx) => {
  Q.ensureSettings.run(ctx.from.id);
  const me = await ctx.api.getMe();
  await ctx.reply(INTRO, {
    parse_mode: 'MarkdownV2',
    reply_markup: kbMain(me.username, isAdmin(ctx.from.id)),
    link_preview_options: { is_disabled: true },
  });
});

// ─── 3.1 Callback router ────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const d = ctx.callbackQuery.data;
  try {
    if (d === 'nav:main') {
      const me = await ctx.api.getMe();
      return edit(ctx, INTRO, kbMain(me.username, isAdmin(ctx.from.id)));
    }
    if (d === 'nav:cmds') {
      return edit(ctx, navHeader(isPremium(ctx.from.id)), kbCmds(isPremium(ctx.from.id)));
    }
    if (d === 'nav:profile')  return edit(ctx, profileText(ctx.from.id), backTo('nav:main'));
    if (d === 'nav:premium')  return edit(ctx, premiumText(ctx.from.id), kbPremium(isPremium(ctx.from.id)));
    if (d === 'nav:settings') {
      Q.ensureSettings.run(ctx.from.id);
      const s = Q.getSettings.get(ctx.from.id);
      return edit(ctx, '⚙️ *Настройки*', kbSettings(s));
    }
    if (d === 'nav:admin' && isAdmin(ctx.from.id)) {
      return edit(ctx, '🛠 *Админ\\-панель*', kbAdmin());
    }
    if (d === 'admin:stats' && isAdmin(ctx.from.id)) {
      return edit(ctx, adminStatsText(), backTo('nav:admin'));
    }

    if (d.startsWith('set:')) {
      const key = d.slice(4);
      const allowed = ['notify_edits', 'notify_deletes', 'save_disappearing', 'dot_commands'];
      if (!allowed.includes(key)) return ctx.answerCallbackQuery();
      const s = Q.getSettings.get(ctx.from.id);
      Q.setSetting(key).run(s[key] ? 0 : 1, ctx.from.id);
      const updated = Q.getSettings.get(ctx.from.id);
      return edit(ctx, '⚙️ *Настройки*', kbSettings(updated));
    }

    if (d.startsWith('cmd:')) {
      const c = d.slice(4);
      const isPrem = PREMIUM_COMMANDS.includes(c);
      const locked = isPrem && !isPremium(ctx.from.id);
      const desc   = DOT_DOCS[c] || 'Команда зарезервирована, описание появится позже.';
      const body   = `*\\.${escMd(c)}*${locked ? ' 🔒' : ''}\n\n${escMd(desc)}` +
                     (locked ? `\n\n_Доступно с Премиумом\\._` : '');
      return edit(ctx, body, new InlineKeyboard().text('‹ К командам', 'nav:cmds'));
    }

    if (d === 'premium:buy') return sendInvoice(ctx);

    await ctx.answerCallbackQuery();
  } catch (e) {
    console.error('[cb]', e);
    await ctx.answerCallbackQuery().catch(() => {});
  }
});

function navHeader(prem) {
  return `*Команды бота*\n\n` +
         (prem
           ? `У тебя ⭐ Премиум — доступны все команды\\.`
           : `Без премиума доступны базовые команды\\.\nЗначок 🔒 — премиум\\-команды\\.`);
}

function profileText(uid) {
  const s = Q.getSettings.get(uid) || {};
  const c = Q.getConnByUser.get(uid);
  const prem = isPremium(uid);
  const u = CQ?.getUser.get(uid);
  const premLine = prem && u?.premium_until
    ? `⭐ до ${escMd(new Date(u.premium_until).toLocaleDateString('ru-RU'))}`
    : '❌';
  return `👤 *Профиль*\n\n` +
         `• ID: \`${uid}\`\n` +
         `• Премиум: ${premLine}\n` +
         `• Бизнес\\-подключение: ${c ? '🟢' : '⚪️'}\n` +
         `• Уведомления о правках: ${s.notify_edits ? '✅' : '❌'}\n` +
         `• Уведомления об удалениях: ${s.notify_deletes ? '✅' : '❌'}\n` +
         `• Сохранение исчезающего: ${s.save_disappearing ? '✅' : '❌'}`;
}

function premiumText(uid) {
  const u = CQ?.getUser.get(uid);
  const prem = isPremium(uid);
  if (prem) {
    const left = Math.ceil((u.premium_until - Date.now()) / 86_400_000);
    return `⭐ *Премиум активен*\n\nОсталось дней: *${left}*`;
  }
  return `⭐ *Премиум*\n\n` +
         `• Без премиума: до *5* ботов, базовые команды\n` +
         `• С премиумом: до *10* ботов, все команды\n\n` +
         `Стоимость: *${PREMIUM_PRICE} ⭐ / ${PREMIUM_DAYS} дн\\.*`;
}

function adminStatsText() {
  return `📊 *Статистика модуля*\n\n` +
         `• Активных подключений: *${Q.countConns.get().c}*\n` +
         `• Сохранённых медиа: *${Q.countMedia.get().c}*\n` +
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

// ─── 4. PREMIUM (Stars) ────────────────────────────────────────────────────
async function sendInvoice(ctx) {
  const payload = `prem_${ctx.from.id}_${Date.now()}`;
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.api.sendInvoice(
    ctx.from.id,
    'SaveMOD Премиум',
    `Премиум на ${PREMIUM_DAYS} дней: до 10 ботов и все команды.`,
    payload,
    'XTR',
    [{ label: 'Премиум', amount: PREMIUM_PRICE }],
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
    const until = base + PREMIUM_DAYS * 86_400_000;
    CQ.setPremium.run(until, uid);
  }
  Q.addPayment.run(sp.invoice_payload, uid, sp.telegram_payment_charge_id, sp.total_amount, Date.now());
  await ctx.reply(`✅ Премиум активирован на ${PREMIUM_DAYS} дней.`);
});

// ─── 5. BUSINESS CONNECTION ────────────────────────────────────────────────
bot.on('business_connection', async (ctx) => {
  const c = ctx.businessConnection;
  Q.saveConn.run(
    c.id, c.user.id, c.user_chat_id,
    c.is_enabled ? 1 : 0,
    c.rights?.can_reply ? 1 : 0,
    c.rights?.can_read_messages ? 1 : 0,
    c.rights?.can_delete_sent_messages ? 1 : 0,
    c.rights?.can_delete_all_messages ? 1 : 0,
    Date.now(),
  );
  Q.ensureSettings.run(c.user.id);

  const text = c.is_enabled
    ? `✅ Подключено к бизнес\\-аккаунту\\.`
    : `⚠️ Подключение приостановлено\\.`;
  await ctx.api.sendMessage(c.user_chat_id, text, { parse_mode: 'MarkdownV2' }).catch(() => {});
});

// ─── 6. BUSINESS MESSAGE ───────────────────────────────────────────────────
bot.on('business_message', async (ctx) => {
  const m = ctx.businessMessage;
  if (!m) return;
  const cid  = m.business_connection_id;
  const conn = Q.getConn.get(cid);
  if (!conn) return;
  const s = Q.getSettings.get(conn.user_id) || {};

  const media = pickMedia(m);
  Q.cacheMsg.run(
    cid, m.chat.id, m.message_id,
    m.from?.id ?? null, formatName(m.from),
    m.text ?? m.caption ?? null,
    media?.kind ?? null, media?.file_id ?? null,
    media?.self_destruct ? 1 : 0, null, Date.now(),
  );

  if (s.save_disappearing && media?.self_destruct) {
    try {
      const lp = await downloadFile(media.file_id, conn.user_id, media.kind);
      Q.saveMedia.run(conn.user_id, m.from?.id ?? null, formatName(m.from),
                      media.kind, lp, Date.now());
      const caption =
        `💾 *Сохранено исчезающее* ${kindEmoji(media.kind)} ${escMd(media.kind)}\n` +
        `От: ${escMd(formatName(m.from) || '—')}`;
      await sendMediaTo(conn.user_chat_id, media.kind, lp, caption);
    } catch (err) {
      console.error('[save-media]', err.message);
    }
  }

  if (s.dot_commands && m.from?.id === conn.user_id && m.text) {
    await handleDotCommand(m.text.trim(), { ctx, conn, msg: m });
  }
});

// ─── 7. EDITED ─────────────────────────────────────────────────────────────
bot.on('edited_business_message', async (ctx) => {
  const m = ctx.editedBusinessMessage;
  if (!m) return;
  const cid  = m.business_connection_id;
  const conn = Q.getConn.get(cid);
  if (!conn) return;
  const s = Q.getSettings.get(conn.user_id) || {};
  if (!s.notify_edits || m.from?.id === conn.user_id) { refreshCache(cid, m); return; }

  const before = Q.getMsg.get(cid, m.chat.id, m.message_id);
  const newText = m.text ?? m.caption ?? '';
  const oldText = before?.text ?? '';

  const notice =
    `✏️ *Сообщение отредактировано*\n\n` +
    `От: ${escMd(formatName(m.from) || '—')}\n\n` +
    `*Было:*\n${quote(oldText)}\n\n` +
    `*Стало:*\n${quote(newText)}`;
  await ctx.api.sendMessage(conn.user_chat_id, notice, { parse_mode: 'MarkdownV2' })
    .catch((e) => console.error('[edit-notify]', e.description));

  refreshCache(cid, m);
});

function refreshCache(cid, m) {
  const media = pickMedia(m);
  Q.cacheMsg.run(
    cid, m.chat.id, m.message_id,
    m.from?.id ?? null, formatName(m.from),
    m.text ?? m.caption ?? null,
    media?.kind ?? null, media?.file_id ?? null,
    media?.self_destruct ? 1 : 0, null, Date.now(),
  );
}

// ─── 8. DELETED ────────────────────────────────────────────────────────────
bot.on('deleted_business_messages', async (ctx) => {
  const d = ctx.deletedBusinessMessages;
  if (!d) return;
  const cid  = d.business_connection_id;
  const conn = Q.getConn.get(cid);
  if (!conn) return;
  const s = Q.getSettings.get(conn.user_id) || {};
  if (!s.notify_deletes) return;

  for (const mid of d.message_ids) {
    const cached = Q.getMsg.get(cid, d.chat.id, mid);
    if (!cached || cached.from_id === conn.user_id) continue;

    const lines = [
      `🗑 *Сообщение удалено*`,
      ``,
      `От: ${escMd(cached.from_name || '—')}`,
    ];
    if (cached.text)       lines.push('', '*Текст:*', quote(cached.text));
    if (cached.media_kind) lines.push('', `*Медиа:* ${kindEmoji(cached.media_kind)} ${escMd(cached.media_kind)}`);

    await ctx.api.sendMessage(conn.user_chat_id, lines.join('\n'),
      { parse_mode: 'MarkdownV2' }).catch((e) => console.error('[del-notify]', e.description));

    if (cached.media_file_id && !cached.saved_path) {
      try {
        const lp = await downloadFile(cached.media_file_id, conn.user_id, cached.media_kind);
        await sendMediaTo(conn.user_chat_id, cached.media_kind, lp,
          `📥 Восстановлено удалённое ${kindEmoji(cached.media_kind)}`);
      } catch { /* expired */ }
    }
  }
});

// ─── 9. DOT COMMANDS ───────────────────────────────────────────────────────
async function handleDotCommand(text, { ctx, conn, msg }) {
  if (!text.startsWith('.')) return;
  const [raw] = text.slice(1).split(/\s+/);
  const cmd = raw.toLowerCase();
  if (!cmd) return;

  const isPrem = PREMIUM_COMMANDS.includes(cmd);
  const free   = FREE_COMMANDS.includes(cmd);
  if (!isPrem && !free) return; // неизвестная команда — игнор

  if (isPrem && !isPremium(conn.user_id)) {
    return replyInChat(ctx, conn, msg,
      `🔒 Команда \\.${escMd(cmd)} доступна только с Премиумом\\.`);
  }

  if (cmd === 'help') {
    const lines = ['*SaveMOD — команды*', ''];
    for (const c of FREE_COMMANDS) {
      lines.push(`• \`\\.${escMd(c)}\` — ${escMd(DOT_DOCS[c] || '')}`);
    }
    if (PREMIUM_COMMANDS.length) {
      lines.push('', '_Премиум:_');
      for (const c of PREMIUM_COMMANDS) {
        lines.push(`• \`\\.${escMd(c)}\` 🔒 — ${escMd(DOT_DOCS[c] || '')}`);
      }
    }
    return replyInChat(ctx, conn, msg, lines.join('\n'));
  }
}

async function replyInChat(ctx, conn, msg, text) {
  const opts = {
    business_connection_id: conn.connection_id,
    parse_mode: 'MarkdownV2',
  };
  if (conn.can_reply) {
    try {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, opts);
      return;
    } catch { /* fallback */ }
  }
  await ctx.api.sendMessage(msg.chat.id, text, opts).catch((e) =>
    console.error('[dot-reply]', e.description));
}

// ─── 10. UTILS ─────────────────────────────────────────────────────────────
function formatName(u) {
  if (!u) return '';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') +
         (u.username ? ` (@${u.username})` : '');
}
function quote(s = '') {
  const t = s.length > 800 ? s.slice(0, 800) + '…' : s;
  return t.split('\n').map((l) => '>' + escMd(l)).join('\n');
}
function kindEmoji(kind) {
  return { photo: '📷', voice: '🎙', video_note: '🎥', video: '🎬', document: '📎' }[kind] || '📦';
}
function pickMedia(m) {
  if (m.photo?.length) {
    const best = m.photo.at(-1);
    return { kind: 'photo', file_id: best.file_id,
             self_destruct: !!m.has_media_spoiler || !!m.self_destruct_time };
  }
  if (m.voice)      return { kind: 'voice',      file_id: m.voice.file_id,      self_destruct: !!m.self_destruct_time };
  if (m.video_note) return { kind: 'video_note', file_id: m.video_note.file_id, self_destruct: !!m.self_destruct_time };
  if (m.video)      return { kind: 'video',      file_id: m.video.file_id,      self_destruct: !!m.self_destruct_time };
  return null;
}
async function downloadFile(fileId, ownerId, kind) {
  const file = await bot.api.getFile(fileId);
  const url  = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const ext  = path.extname(file.file_path) || extFor(kind);
  const dir  = path.join(MEDIA_DIR, String(ownerId));
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, `${Date.now()}_${kind}${ext}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  await pipeline(res.body, fs.createWriteStream(local));
  return local;
}
function extFor(kind) {
  return ({ photo: '.jpg', voice: '.ogg', video_note: '.mp4', video: '.mp4' })[kind] || '.bin';
}
async function sendMediaTo(chatId, kind, localPath, caption) {
  const file = new InputFile(localPath);
  const opts = { caption, parse_mode: 'MarkdownV2' };
  if (kind === 'photo')      return bot.api.sendPhoto(chatId, file, opts);
  if (kind === 'voice')      return bot.api.sendVoice(chatId, file, opts);
  if (kind === 'video_note') return bot.api.sendVideoNote(chatId, file);
  if (kind === 'video')      return bot.api.sendVideo(chatId, file, opts);
  return bot.api.sendDocument(chatId, file, opts);
}

// ─── 11. ERRORS & START ────────────────────────────────────────────────────
bot.catch((err) => {
  if (err.error instanceof HttpError)        console.error('[net]', err.error);
  else if (err.error instanceof GrammyError) console.error('[tg]', err.error.description);
  else console.error('[bot]', err.error);
});

const ALLOWED = [
  'message', 'edited_message', 'callback_query',
  'pre_checkout_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
];

bot.start({
  allowed_updates: ALLOWED,
  onStart: (me) => console.log(`📦 Module @${me.username} started (db: ${DB_PATH})`),
});

const stop = (sig) => {
  console.log(`\n[${sig}] module stopping…`);
  bot.stop();
  process.exit(0);
};
process.once('SIGINT',  () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
