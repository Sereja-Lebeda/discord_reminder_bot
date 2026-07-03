import type { Client, Message, SendableChannels } from "discord.js";

const HEADER          = "📋 Промо-коды:";
const OVERFLOW_HEADER = "📋 Промо-коды (продолжение):";
const EMPTY_NOTICE    = "*(нет кодов)*";
const MAX_LEN         = 2000;
const MAX_BATCHES     = 15;

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

function extractCodesFromMessages(messages: Message[], botUserId: string): Set<string> {
  const codes = new Set<string>();

  for (const msg of messages) {
    if (msg.pinned) continue;
    if (!msg.content) continue;

    if (msg.author.id === botUserId) {
      for (const line of msg.content.split(/\r?\n/)) {
        const n = extractCode(line);
        if (n) codes.add(n);
      }
    } else {
      const n = extractCode(msg.content);
      if (n) codes.add(n);
    }
  }
  return codes;
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

async function rebuildBotMessages(channel: SendableChannels, chunks: string[]): Promise<void> {
  for (const id of botMessageIds) {
    try {
      const msg = await channel.messages.fetch(id);
      await safeDelete(msg);
    } catch (e: unknown) {
      const code = getDiscordErrorCode(e);
      if (code !== 10008 && code !== 10003) {
        console.error("[promo-codes] Не удалось получить сообщение бота для удаления:", e);
      }
    }
  }

  const newIds: string[] = [];
  for (const chunk of chunks) {
    try {
      const msg = await channel.send(chunk);
      newIds.push(msg.id);
    } catch (e) {
      console.error("[promo-codes] Не удалось отправить сообщение:", e);
    }
  }
  botMessageIds = newIds;
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

  promoSet = extractCodesFromMessages(allMessages, client.user.id);
  console.log(`[promo-codes] Найдено уникальных кодов: ${promoSet.size}`);

  for (const msg of allMessages) {
    if (!msg.pinned) await safeDelete(msg);
  }

  botMessageIds = [];
  const chunks = buildChunks([...promoSet]);
  for (const chunk of chunks) {
    try {
      const msg = await channel.send(chunk);
      botMessageIds.push(msg.id);
    } catch (e) {
      console.error("[promo-codes] Не удалось отправить консолидированное сообщение:", e);
    }
  }

  console.log(
    `[promo-codes] Инициализация завершена. Кодов: ${promoSet.size}, сообщений бота: ${botMessageIds.length}.`
  );
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

  const chunks = buildChunks([...promoSet]);
  await rebuildBotMessages(channel, chunks);
}
