// ════════════════════════════════════════════════════════════════════════════
//  SaveMOD — Universal Business Module (single-file)
//  ───────────────────────────────────────────────────────────────────────────
//  Подключается к любому боту, созданному конструктором, и реализует:
//    • Меню «Как подключить бота» с инструкцией и кнопками (как на скрине 3)
//    • Уведомления о редактировании сообщений собеседника
//    • Уведомления об удалении сообщений собеседника
//    • Сохранение исчезающих (one-time) фото / голосовых / video_note
//    • Команды через точку в чатах с Business-аккаунтом   (сейчас: .help)
//    • Меню «Описание команд» (скрин 4)
//  ───────────────────────────────────────────────────────────────────────────
//  Запускается двумя способами:
//    1) конструктором как дочерний процесс (env MODULE_BOT_TOKEN / _USERNAME)
//    2) вручную:  MODULE_BOT_TOKEN=... node module.js
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Bot, InlineKeyboard, GrammyError, HttpError, InputFile } from 'grammy';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// ─── 0. ENV ─────────────────────────────────────────────────────────────────
const TOKEN     = process.env.MODULE_BOT_TOKEN;
const USERNAME  = process.env.MODULE_BOT_USERNAME || ''; // optional, для UI
const DB_PATH   = process.env.MODULE_DB || `./module-${USERNAME || 'default'}.db`;
const MEDIA_DIR = process.env.MEDIA_DIR || './saved_media';
const SUPPORT   = process.env.SUPPORT_CHANNEL || 'https://t.me/savemod';
const INSTR     = process.env.INSTRUCTION_URL || 'https://telegra.ph/SaveMOD';

if (!TOKEN) throw new Error('MODULE_BOT_TOKEN is missing');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ─── 1. DATABASE ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  -- активные business-подключения этого бота
  CREATE TABLE IF NOT EXISTS connections (
    connection_id TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,      -- владелец бизнес-аккаунта
    user_chat_id  INTEGER NOT NULL,      -- личка владельца с этим ботом
    is_enabled    INTEGER DEFAULT 1,
    can_reply     INTEGER DEFAULT 0,
    can_read      INTEGER DEFAULT 0,
    can_del_sent  INTEGER DEFAULT 0,
    can_del_all   INTEGER DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );

  -- кеш сообщений для антиделит / антиэдит
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

  -- сохранённые исчезающие медиа
  CREATE TABLE IF NOT EXISTS saved_media (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL,
    from_id    INTEGER,
    from_name  TEXT,
    kind       TEXT NOT NULL,          -- photo|voice|video_note
    local_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- настройки на одного владельца
  CREATE TABLE IF NOT EXISTS settings (
    user_id           INTEGER PRIMARY KEY,
    notify_edits      INTEGER DEFAULT 1,
    notify_deletes    INTEGER DEFAULT 1,
    save_disappearing INTEGER DEFAULT 1,
    dot_commands      INTEGER DEFAULT 1
  );
`);

const Q = {
  saveConn: db.prepare(`
    INSERT INTO connections (connection_id, user_id, user_chat_id, is_enabled,
                             can_reply, can_read, can_del_sent, can_del_all, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id) DO UPDATE SET
      is_enabled = excluded.is_enabled,
      can_reply  = excluded.can_reply,
      can_read   = excluded.can_read,
      can_del_sent = excluded.can_del_sent,
      can_del_all  = excluded.can_del_all,
      updated_at   = excluded.updated_at`),
  getConn:   db.prepare(`SELECT * FROM connections WHERE connection_id = ?`),
  getConnByUser: db.prepare(`SELECT * FROM connections WHERE user_id = ? LIMIT 1`),
  cacheMsg:  db.prepare(`
    INSERT OR REPLACE INTO msg_cache
      (connection_id, chat_id, message_id, from_id, from_name,
       text, media_kind, media_file_id, is_self_destruct, saved_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getMsg:    db.prepare(`SELECT * FROM msg_cache
                         WHERE connection_id = ? AND chat_id = ? AND message_id = ?`),
  saveMedia: db.prepare(`
    INSERT INTO saved_media (owner_id, from_id, from_name, kind, local_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  ensureSettings: db.prepare(`INSERT OR IGNORE INTO settings (user_id) VALUES (?)`),
  getSettings:    db.prepare(`SELECT * FROM settings WHERE user_id = ?`),
  setSetting:     (k) => db.prepare(`UPDATE settings SET ${k} = ? WHERE user_id = ?`),
};

// ─── 2. UI ──────────────────────────────────────────────────────────────────
function escMd(s = '') { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m); }

const INTRO =
  `Этот бот создан, чтобы *облегчить вам жизнь* в Telegram\\.\n\n` +
  `• Я присылаю уведомления, когда собеседник *удаляет* или *редактирует* сообщения\\.\n` +
  `• Могу сохранять *сгорающие* фото, голосовые и видео\\.\n\n` +
  `Чтобы подключить бота, нажми кнопку «Скопировать @username» и следуй инструкции ниже\\.`;

const NAV_HEADER =
  `*Навигация по командам бизнес\\-бота*\n\n` +
  `Нажми на кнопку, чтобы узнать информацию о команде`;

const dotDocs = {
  help:    'Показывает в текущем чате список доступных точечных команд и краткую справку.',
  afk:     'Включает режим «Отошёл» — авто-ответ собеседникам с указанной причиной.',
  info:    'Возвращает информацию о собеседнике (id, имя, регистрация).',
  status:  'Состояние подключённого бота: антиделит, сохранение медиа и т.д.',
  time:    'Текущее время.',
  mute:    'Локально (для тебя) скрывает уведомления от собеседника.',
  unmute:  'Возвращает уведомления.',
  send:    'Отправляет в чате текст от твоего имени с анимацией набора.',
};

const kbMain = (uname) =>
  new InlineKeyboard()
    .switchInlineCurrent('Скопировать @username', `@${uname}`).row()
    .text('❓ Описание команд', 'nav:cmds').row()
    .text('⚙️ Профиль', 'nav:profile').row()
    .url('📋 Инструкция', INSTR).row()
    .url('📢 Канал', SUPPORT).row()
    .text('⭐ Premium-доступ', 'nav:premium').row()
    .text('⚙️ Настройки', 'nav:settings');

const kbCmds = () => {
  const list = [
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
  for (let i = 0; i < list.length; i += 4) {
    for (const c of list.slice(i, i + 4)) k.text(c, `cmd:${c.slice(1)}`);
    k.row();
  }
  return k.text('‹ Назад', 'nav:main');
};

const kbSettings = (s) =>
  new InlineKeyboard()
    .text(`${s.notify_edits   ? '✅' : '⬜️'} Уведомления о правках`,   'set:notify_edits').row()
    .text(`${s.notify_deletes ? '✅' : '⬜️'} Уведомления об удалениях`, 'set:notify_deletes').row()
    .text(`${s.save_disappearing ? '✅' : '⬜️'} Сохранять исчезающее`,  'set:save_disappearing').row()
    .text(`${s.dot_commands  ? '✅' : '⬜️'} Команды через точку`,      'set:dot_commands').row()
    .text('‹ Назад', 'nav:main');

// ─── 3. BOT ─────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN);

bot.command('start', async (ctx) => {
  Q.ensureSettings.run(ctx.from.id);
  const me = await ctx.api.getMe();
  await ctx.reply(INTRO, {
    parse_mode: 'MarkdownV2',
    reply_markup: kbMain(me.username),
  });
});

// ─── 3.1 inline-меню ───────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const d = ctx.callbackQuery.data;
  try {
    if (d === 'nav:main') {
      const me = await ctx.api.getMe();
      return edit(ctx, INTRO, kbMain(me.username));
    }
    if (d === 'nav:cmds')     return edit(ctx, NAV_HEADER, kbCmds());
    if (d === 'nav:profile')  return edit(ctx, profileText(ctx.from.id), backTo('nav:main'));
    if (d === 'nav:premium')  return edit(ctx, premiumText(),            backTo('nav:main'));
    if (d === 'nav:settings') {
      Q.ensureSettings.run(ctx.from.id);
      const s = Q.getSettings.get(ctx.from.id);
      return edit(ctx, '⚙️ *Настройки*', kbSettings(s));
    }
    if (d.startsWith('set:')) {
      const key = d.slice(4);
      const s = Q.getSettings.get(ctx.from.id);
      Q.setSetting(key).run(s[key] ? 0 : 1, ctx.from.id);
      const updated = Q.getSettings.get(ctx.from.id);
      return edit(ctx, '⚙️ *Настройки*', kbSettings(updated));
    }
    if (d.startsWith('cmd:')) {
      const c = d.slice(4);
      const desc = dotDocs[c] || 'Команда зарезервирована, описание появится позже.';
      return edit(ctx,
        `*\\.${escMd(c)}*\n\n${escMd(desc)}`,
        new InlineKeyboard().text('‹ К командам', 'nav:cmds'));
    }
    await ctx.answerCallbackQuery();
  } catch (e) {
    console.error('[cb]', e);
    await ctx.answerCallbackQuery().catch(() => {});
  }
});

function backTo(to) { return new InlineKeyboard().text('‹ Назад', to); }
function profileText(uid) {
  const s = Q.getSettings.get(uid) || {};
  const c = Q.getConnByUser.get(uid);
  return `👤 *Профиль*\n\n` +
         `• ID: \`${uid}\`\n` +
         `• Подключение: ${c ? '🟢 активно' : '⚪️ не подключено'}\n` +
         `• Уведомления о правках: ${s.notify_edits ? '✅' : '❌'}\n` +
         `• Уведомления об удалениях: ${s.notify_deletes ? '✅' : '❌'}\n` +
         `• Сохранение исчезающего: ${s.save_disappearing ? '✅' : '❌'}`;
}
function premiumText() {
  return `⭐ *Premium\\-доступ*\n\nБазовые функции бесплатны\\.\nPremium даёт:\n` +
         `• безлимитный архив исчезающих медиа\n• кастомные точечные команды\n• приоритет уведомлений`;
}

async function edit(ctx, text, reply_markup) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup,
      link_preview_options: { is_disabled: true } });
  } catch (e) {
    if (!(e instanceof GrammyError && e.description?.includes('not modified'))) {
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup });
    }
  }
  await ctx.answerCallbackQuery().catch(() => {});
}

// ─── 4. BUSINESS CONNECTION ────────────────────────────────────────────────
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

  if (c.is_enabled) {
    await ctx.api.sendMessage(
      c.user_chat_id,
      `✅ *SaveMOD подключён к твоему бизнес\\-аккаунту\\!*\n\n` +
      `Что я уже умею в фоне:\n` +
      `• ${c.rights?.can_read_messages ? '🟢' : '🔴'} читать сообщения\n` +
      `• ${c.rights?.can_reply ? '🟢' : '🔴'} отвечать в чатах\n` +
      `• ${c.rights?.can_delete_all_messages ? '🟢' : '🔴'} удалять любые сообщения\n\n` +
      `Если каких\\-то прав не хватает — добавь их в *Telegram → Настройки → Telegram для бизнеса → Чат\\-боты*\\.`,
      { parse_mode: 'MarkdownV2' },
    ).catch(() => {});
  } else {
    await ctx.api.sendMessage(
      c.user_chat_id,
      `⚠️ Подключение к бизнес\\-аккаунту приостановлено\\.`,
      { parse_mode: 'MarkdownV2' },
    ).catch(() => {});
  }
});

// ─── 5. BUSINESS MESSAGE — кэш + сохранение исчезающих + .-команды ─────────
bot.on('business_message', async (ctx) => {
  const m = ctx.businessMessage;
  const cid = m.business_connection_id;
  const conn = Q.getConn.get(cid);
  if (!conn) return;
  const settings = Q.getSettings.get(conn.user_id) || {};

  // ── 5.1 Кэшируем для будущих edited/deleted ─────────────────────────────
  const media = pickMedia(m);
  Q.cacheMsg.run(
    cid, m.chat.id, m.message_id,
    m.from?.id ?? null,
    formatName(m.from),
    m.text ?? m.caption ?? null,
    media?.kind ?? null,
    media?.file_id ?? null,
    media?.self_destruct ? 1 : 0,
    null,
    Date.now(),
  );

  // ── 5.2 Сохраняем исчезающее (one-time) медиа ────────────────────────────
  if (settings.save_disappearing && media?.self_destruct) {
    try {
      const localPath = await downloadFile(media.file_id, conn.user_id, media.kind);
      Q.saveMedia.run(conn.user_id, m.from?.id ?? null, formatName(m.from),
                      media.kind, localPath, Date.now());
      const caption =
        `💾 *Сохранено исчезающее* ${kindEmoji(media.kind)} ${escMd(media.kind)}\n` +
        `От: ${escMd(formatName(m.from) || '—')}\n` +
        `Чат: \`${m.chat.id}\``;
      // Шлём владельцу копию из локального файла
      await sendMediaTo(conn.user_chat_id, media.kind, localPath, caption);
    } catch (err) {
      console.error('[save-media]', err.message);
    }
  }

  // ── 5.3 Точечные команды (отправляет сам владелец) ─────────────────────
  if (settings.dot_commands && m.from?.id === conn.user_id && m.text) {
    await handleDotCommand(m.text.trim(), { ctx, conn, msg: m });
  }
});

// ─── 6. EDITED business message ─────────────────────────────────────────────
bot.on('edited_business_message', async (ctx) => {
  const m = ctx.editedBusinessMessage;
  const cid = m.business_connection_id;
  const conn = Q.getConn.get(cid);
  if (!conn) return;
  const settings = Q.getSettings.get(conn.user_id) || {};
  if (!settings.notify_edits) {
    refreshCache(cid, m); return;
  }
  if (m.from?.id === conn.user_id) {       // владелец редактирует сам себя — игнор
    refreshCache(cid, m); return;
  }

  const before = Q.getMsg.get(cid, m.chat.id, m.message_id);
  const newText = m.text ?? m.caption ?? '';
  const oldText = before?.text ?? '';

  const notice =
    `✏️ *Собеседник отредактировал сообщение*\n\n` +
    `Кто: ${escMd(formatName(m.from))}\n` +
    `Чат: \`${m.chat.id}\`\n\n` +
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
    m.from?.id ?? null,
    formatName(m.from),
    m.text ?? m.caption ?? null,
    media?.kind ?? null,
    media?.file_id ?? null,
    media?.self_destruct ? 1 : 0,
    null,
    Date.now(),
  );
}

// ─── 7. DELETED business messages ──────────────────────────────────────────
bot.on('deleted_business_messages', async (ctx) => {
  const d = ctx.deletedBusinessMessages;
  const cid = d.business_connection_id;
  const conn = Q.getConn.get(cid);
  if (!conn) return;
  const settings = Q.getSettings.get(conn.user_id) || {};
  if (!settings.notify_deletes) return;

  for (const mid of d.message_ids) {
    const cached = Q.getMsg.get(cid, d.chat.id, mid);
    if (!cached) continue;
    if (cached.from_id === conn.user_id) continue; // не сообщаем о своих удалениях

    const lines = [
      `🗑 *Собеседник удалил сообщение*`,
      ``,
      `Кто: ${escMd(cached.from_name || '—')}`,
      `Чат: \`${d.chat.id}\``,
    ];
    if (cached.text)        lines.push('', '*Текст:*', quote(cached.text));
    if (cached.media_kind)  lines.push('', `*Медиа:* ${kindEmoji(cached.media_kind)} ${escMd(cached.media_kind)}`);

    await ctx.api.sendMessage(conn.user_chat_id, lines.join('\n'),
      { parse_mode: 'MarkdownV2' }).catch((e) => console.error('[del-notify]', e.description));

    // если медиа у нас в кэше и нет в архиве — попробуем восстановить
    if (cached.media_file_id && !cached.saved_path) {
      try {
        const lp = await downloadFile(cached.media_file_id, conn.user_id, cached.media_kind);
        await sendMediaTo(conn.user_chat_id, cached.media_kind, lp,
          `📥 Восстановлено удалённое ${kindEmoji(cached.media_kind)}`);
      } catch (e) { /* file expired */ }
    }
  }
});

// ─── 8. DOT-COMMANDS ───────────────────────────────────────────────────────
async function handleDotCommand(text, { ctx, conn, msg }) {
  if (!text.startsWith('.')) return;
  const [raw, ...rest] = text.slice(1).split(/\s+/);
  const cmd = raw.toLowerCase();
  const args = rest.join(' ');

  if (cmd === 'help') {
    const known = Object.keys(dotDocs);
    const lines = [
      '🤖 *SaveMOD — точечные команды*',
      '',
      'Доступные сейчас:',
      ...known.map((k) => `• \`\\.${escMd(k)}\` — ${escMd(dotDocs[k])}`),
      '',
      '_Команды вводятся в любом чате на твоём бизнес\\-аккаунте\\._',
    ];
    if (!conn.can_reply) return;
    try {
      await ctx.api.editMessageText(
        msg.chat.id, msg.message_id, lines.join('\n'),
        { business_connection_id: conn.connection_id, parse_mode: 'MarkdownV2' },
      );
    } catch {
      // если редактировать нельзя — отправим новое сообщение в этот же чат
      await ctx.api.sendMessage(msg.chat.id, lines.join('\n'),
        { business_connection_id: conn.connection_id, parse_mode: 'MarkdownV2' });
    }
  }
  // Заготовки для будущих команд:
  // if (cmd === 'time')   { ... }
  // if (cmd === 'info')   { ... }
}

// ─── 9. UTILITIES ──────────────────────────────────────────────────────────
function formatName(u) {
  if (!u) return '';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') +
         (u.username ? ` (@${u.username})` : '');
}

function quote(s = '') {
  const trimmed = s.length > 800 ? s.slice(0, 800) + '…' : s;
  return trimmed.split('\n').map((l) => '>' + escMd(l)).join('\n');
}

function kindEmoji(kind) {
  return { photo: '📷', voice: '🎙', video_note: '🎥', video: '🎬', document: '📎' }[kind] || '📦';
}

function pickMedia(m) {
  if (m.photo?.length) {
    const best = m.photo.at(-1);
    return { kind: 'photo', file_id: best.file_id, self_destruct: !!m.has_media_spoiler || !!m.self_destruct_time };
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
function extFor(kind) { return ({ photo: '.jpg', voice: '.ogg', video_note: '.mp4', video: '.mp4' })[kind] || '.bin'; }

async function sendMediaTo(chatId, kind, localPath, caption) {
  const file = new InputFile(localPath);
  const opts = { caption, parse_mode: 'MarkdownV2' };
  if (kind === 'photo')      return bot.api.sendPhoto(chatId, file, opts);
  if (kind === 'voice')      return bot.api.sendVoice(chatId, file, opts);
  if (kind === 'video_note') return bot.api.sendVideoNote(chatId, file);
  if (kind === 'video')      return bot.api.sendVideo(chatId, file, opts);
  return bot.api.sendDocument(chatId, file, opts);
}

// ─── 10. ERRORS & START ────────────────────────────────────────────────────
bot.catch((err) => {
  if (err.error instanceof HttpError)       console.error('[net]', err.error);
  else if (err.error instanceof GrammyError) console.error('[tg]', err.error.description);
  else console.error('[bot]', err.error);
});

const ALLOWED = [
  'message', 'edited_message', 'callback_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
];

bot.start({
  allowed_updates: ALLOWED,
  onStart: (me) => console.log(`📦 Module @${me.username} started (db: ${DB_PATH})`),
});

const stop = (sig) => { console.log(`\n[${sig}] module stopping…`); bot.stop(); process.exit(0); };
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
