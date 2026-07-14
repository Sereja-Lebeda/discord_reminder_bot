import type { Client, Message, SendableChannels } from "discord.js";

const HEADER          = "📋 Промо-коды:";
const OVERFLOW_HEADER = "📋 Промо-коды (продолжение):";
const EMPTY_NOTICE    = "*(нет кодов)*";
const MAX_LEN         = 2000;
const MAX_BATCHES     = 15;
const PROMO_MAX_AGE_DAYS = 30;

let promoSet       = new Set<string>();
let botMessageIds: string[] = [];
let promoChannelId: string | null = null;
let isInitializing = false;

function getDiscordErrorCode(e: unknown): number {
  return e && typeof e === "object" && "code" in e
    ? Number((e as { code: unknown }).code)
    : NaN;
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function extractCode(raw: string): string {
  for (const token of raw.trim().split(/\s+/)) {
    if (CODE_PATTERN.test(token)) return token.toLowerCase();
  }
  return "";
}

function buildChunks(codes: string[]): string[] {
  if (codes.length === 0) return [`${HEADER}\n${EMPTY_NOTICE}`];

  const chunks: string[] = [];
  let header  = HEADER;
  let current = header;

  for (const code of codes) {
    const line = `\n${code}`;
    if (current.length + line.length > MAX_LEN) {
      chunks.push(current);
      header  = OVERFLOW_HEADER;
      current = header + line;
    } else {
      current += line;
    }
  }
  chunks.push(current);
  return chunks;
}


async function scanAllMessages(channel: SendableChannels): Promise<Message[]> {
  const all: Message[] = [];
  let before: string | undefined;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before !== undefined ? { before } : {}),
    });
    if (batch.size === 0) break;
    for (const msg of batch.values()) all.push(msg);
    const oldest = batch.last();
    if (!oldest) break;
    before = oldest.id;
    if (batch.size < 100) break;
  }
  return all;
}

async function safeDelete(msg: Message): Promise<void> {
  try {
    await msg.delete();
  } catch (e: unknown) {
    const code = getDiscordErrorCode(e);
    if (code !== 10008 && code !== 10003) {
      console.error("[promo-codes] Не удалось удалить сообщение:", e);
    }
  }
}

async function cleanupOldPromoMessages(channel: SendableChannels): Promise<void> {
  const cutoff = Date.now() - PROMO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const keepIds: string[] = [];

  for (const id of botMessageIds) {
    try {
      const msg = await channel.messages.fetch(id);
      if (msg.pinned) { keepIds.push(id); continue; }
      if (msg.createdTimestamp < cutoff) {
        for (const line of msg.content.split(/\r?\n/)) {
          const code = extractCode(line);
          if (code) promoSet.delete(code);
        }
        await safeDelete(msg);
        console.log(`[promo-codes] Удалено сообщение ${id} (старше ${PROMO_MAX_AGE_DAYS} дней)`);
      } else {
        keepIds.push(id);
      }
    } catch (e) {
      const errCode = getDiscordErrorCode(e);
      if (errCode !== 10008 && errCode !== 10003) {
        console.error("[promo-codes] Ошибка при проверке сообщения:", e);
        keepIds.push(id);
      }
    }
  }

  botMessageIds = keepIds;
}

async function sendNewBatch(channel: SendableChannels, codes: string[]): Promise<void> {
  const chunks = buildChunks(codes);
  for (const chunk of chunks) {
    try {
      const msg = await channel.send(chunk);
      botMessageIds.push(msg.id);
    } catch (e) {
      console.error("[promo-codes] Не удалось отправить сообщение:", e);
    }
  }
}

export async function initPromoCodeChannel(client: Client): Promise<void> {
  const channelId = process.env.PROMO_CHANNEL_ID?.trim();
  if (!channelId) {
    console.warn("[promo-codes] PROMO_CHANNEL_ID не задан в .env — функция промо-кодов отключена.");
    return;
  }

  if (!client.user) {
    console.error("[promo-codes] Клиент не авторизован при инициализации.");
    return;
  }

  promoChannelId = channelId;
  isInitializing = true;

  let channel: SendableChannels;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isSendable()) {
      console.error(`[promo-codes] Канал ${channelId} недоступен для отправки сообщений.`);
      isInitializing = false;
      return;
    }
    channel = ch;
  } catch (e) {
    console.error("[promo-codes] Не удалось получить канал промо-кодов:", e);
    isInitializing = false;
    return;
  }

  console.log("[promo-codes] Сканирование канала промо-кодов...");
  let allMessages: Message[];
  try {
    allMessages = await scanAllMessages(channel);
  } catch (e) {
    console.error("[promo-codes] Ошибка сканирования канала:", e);
    isInitializing = false;
    return;
  }

  const botUserId = client.user.id;
  const botMsgs  = allMessages.filter(m => !m.pinned && m.author.id === botUserId);
  const userMsgs = allMessages.filter(m => !m.pinned && m.author.id !== botUserId);

  // Разделить сообщения бота на свежие и устаревшие
  const cutoff = Date.now() - PROMO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const freshBotMsgs: Message[] = [];
  for (const msg of botMsgs) {
    if (msg.createdTimestamp < cutoff) {
      await safeDelete(msg);
      console.log(`[promo-codes] Startup: удалено сообщение ${msg.id} (старше ${PROMO_MAX_AGE_DAYS} дней)`);
    } else {
      freshBotMsgs.push(msg);
    }
  }

  // Восстановить коды только из свежих сообщений бота
  promoSet = new Set<string>();
  for (const msg of freshBotMsgs) {
    for (const line of msg.content.split(/\r?\n/)) {
      const n = extractCode(line);
      if (n) promoSet.add(n);
    }
  }

  // Новые уникальные коды из сообщений пользователей
  const newCodes: string[] = [];
  for (const msg of userMsgs) {
    const code = extractCode(msg.content);
    if (code && !promoSet.has(code)) newCodes.push(code);
  }

  // Удалить только пользовательские сообщения
  for (const msg of userMsgs) {
    await safeDelete(msg);
  }

  botMessageIds = freshBotMsgs.sort((a, b) => (a.id < b.id ? -1 : 1)).map(m => m.id);

  if (newCodes.length === 0) {
    console.log(`[promo-codes] Инициализация завершена. Кодов: ${promoSet.size}, сообщения бота без изменений.`);
  } else {
    for (const code of newCodes) promoSet.add(code);
    await sendNewBatch(channel, newCodes);
    console.log(`[promo-codes] Инициализация завершена. Кодов: ${promoSet.size}, добавлено новых: ${newCodes.length}.`);
  }

  isInitializing = false;
}

export async function handlePromoMessage(message: Message): Promise<void> {
  if (!promoChannelId || message.channelId !== promoChannelId) return;
  if (isInitializing) return;

  const botUserId = message.client.user?.id;
  if (botUserId && message.author.id === botUserId) return;

  await safeDelete(message);

  const code = extractCode(message.content);
  if (!code || promoSet.has(code)) return;

  promoSet.add(code);

  const channel = message.channel;
  if (!channel.isSendable()) {
    console.error("[promo-codes] Канал недоступен для обновления сообщений.");
    return;
  }

  await sendNewBatch(channel, [code]);
}

export async function dailyPromoCleanup(client: Client): Promise<void> {
  if (!promoChannelId) return;
  try {
    const ch = await client.channels.fetch(promoChannelId);
    if (!ch?.isSendable()) return;
    await cleanupOldPromoMessages(ch);
  } catch (e) {
    console.error("[promo-codes] Ошибка ежедневной очистки:", e);
  }
}
