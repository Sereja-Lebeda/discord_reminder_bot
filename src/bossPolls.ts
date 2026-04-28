import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Routes } from "discord.js";
import type { Client } from "discord.js";

const DATA_PATH = join(process.cwd(), "data", "boss-polls.json");

/** Длительность опросов: Пн 09:00 → Чт 12:00 = 75 часов */
const POLL_DURATION_HOURS = 75;

interface BossPollsData {
  channelId: string | null;
  thursdayPollMessageId: string | null;
  saturdayPollMessageId: string | null;
  resultsMessageId: string | null;
}

function loadData(): BossPollsData {
  try {
    return JSON.parse(readFileSync(DATA_PATH, "utf-8")) as BossPollsData;
  } catch {
    return { channelId: null, thursdayPollMessageId: null, saturdayPollMessageId: null, resultsMessageId: null };
  }
}

function saveData(data: BossPollsData): void {
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Понедельник 09:00 МСК — создаёт два опроса и сохраняет их ID */
export async function createBossPolls(client: Client): Promise<void> {
  const channelId = process.env.REMINDER_CHANNEL_ID?.trim();
  if (!channelId) {
    console.error("[boss-polls] REMINDER_CHANNEL_ID не задан в .env");
    return;
  }

  const ch = await client.channels.fetch(channelId);
  if (!ch?.isSendable()) {
    console.error(`[boss-polls] Канал ${channelId} недоступен для отправки`);
    return;
  }

  const poll1 = await ch.send({
    poll: {
      question: { text: "На босса в четверг" },
      answers: [
        { text: "19.00 - 20.00" },
        { text: "После вечеринки в 20.30" },
        { text: "21.00 - 22.00" },
      ],
      duration: POLL_DURATION_HOURS,
      allowMultiselect: true,
    },
  });

  const poll2 = await ch.send({
    poll: {
      question: { text: "На босса в субботу" },
      answers: [
        { text: "18.00 - 19.00" },
        { text: "19.00 - 20.00" },
      ],
      duration: POLL_DURATION_HOURS,
      allowMultiselect: true,
    },
  });

  saveData({
    channelId,
    thursdayPollMessageId: poll1.id,
    saturdayPollMessageId: poll2.id,
    resultsMessageId: null,
  });

  console.log(`[boss-polls] Опросы созданы: четверг=${poll1.id}, суббота=${poll2.id}`);
}

interface AnswerEntry {
  text: string;
  voteCount: number;
}

/** Возвращает текст победителей (или нескольких при ничьей), либо null если 0 голосов */
function getWinners(answers: AnswerEntry[]): string | null {
  const total = answers.reduce((sum, a) => sum + a.voteCount, 0);
  if (total === 0) return null;
  let maxVotes = 0;
  for (const a of answers) {
    if (a.voteCount > maxVotes) maxVotes = a.voteCount;
  }
  return answers
    .filter((a) => a.voteCount === maxVotes)
    .map((a) => a.text)
    .join(" и ");
}

function pollAnswersToEntries(poll: { answers: { forEach: (fn: (a: { text: string | null; voteCount: number }) => void) => void } } | null | undefined): AnswerEntry[] {
  if (!poll) return [];
  const entries: AnswerEntry[] = [];
  poll.answers.forEach((a) => {
    entries.push({ text: a.text ?? "", voteCount: a.voteCount });
  });
  return entries;
}

/** Четверг 12:00 МСК — закрывает опросы, публикует результаты */
export async function publishBossResults(client: Client): Promise<void> {
  const data = loadData();
  if (!data.channelId || !data.thursdayPollMessageId || !data.saturdayPollMessageId) {
    console.warn("[boss-polls] Нет сохранённых ID опросов — пропускаем публикацию результатов");
    return;
  }

  const ch = await client.channels.fetch(data.channelId);
  if (!ch?.isSendable()) {
    console.error(`[boss-polls] Канал ${data.channelId} недоступен`);
    return;
  }

  // Принудительно закрываем оба опроса
  for (const messageId of [data.thursdayPollMessageId, data.saturdayPollMessageId]) {
    try {
      await client.rest.post(Routes.expirePoll(data.channelId, messageId));
    } catch (e) {
      console.warn(`[boss-polls] Не удалось закрыть опрос ${messageId}:`, e);
    }
  }

  // Получаем актуальные данные с vote counts
  let msg1, msg2;
  try {
    msg1 = await ch.messages.fetch(data.thursdayPollMessageId);
    msg2 = await ch.messages.fetch(data.saturdayPollMessageId);
  } catch (e) {
    console.error("[boss-polls] Не удалось получить сообщения опросов — возможно, были удалены вручную:", e);
    saveData({ channelId: null, thursdayPollMessageId: null, saturdayPollMessageId: null, resultsMessageId: null });
    return;
  }

  const thursdayResult = getWinners(pollAnswersToEntries(msg1.poll));
  const saturdayResult = getWinners(pollAnswersToEntries(msg2.poll));

  const thursdayLine = thursdayResult
    ? `По решению большинства голосов, поход на босса в **__четверг__** - ${thursdayResult}`
    : "Поход на босса в **__четверг__** отменяется, так как никто не хочет идти";
  const saturdayLine = saturdayResult
    ? `По решению большинства голосов, поход на босса в **__субботу__** - ${saturdayResult}`
    : "Поход на босса в **__субботу__** отменяется, так как никто не хочет идти";

  const resultsContent = [thursdayLine, saturdayLine].join("\n");

  const resultsMsg = await ch.send({ content: resultsContent });

  // Удаляем poll-сообщения
  for (const msg of [msg1, msg2]) {
    try {
      await msg.delete();
    } catch (e) {
      console.error(`[boss-polls] Не удалось удалить опрос ${msg.id}:`, e);
    }
  }

  saveData({ ...data, resultsMessageId: resultsMsg.id });
  console.log(`[boss-polls] Результаты опубликованы (${resultsMsg.id}), опросы удалены`);
}

/** Воскресенье 00:00 МСК — удаляет сообщение с результатами */
export async function cleanupBossResults(client: Client): Promise<void> {
  const data = loadData();
  if (!data.channelId || !data.resultsMessageId) {
    console.warn("[boss-polls] Нет сохранённого ID сообщения с результатами — пропускаем");
    return;
  }

  try {
    const ch = await client.channels.fetch(data.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(data.resultsMessageId);
      await msg.delete();
      console.log(`[boss-polls] Сообщение с результатами ${data.resultsMessageId} удалено`);
    }
  } catch (e) {
    console.error("[boss-polls] Не удалось удалить сообщение с результатами:", e);
  }

  saveData({ channelId: null, thursdayPollMessageId: null, saturdayPollMessageId: null, resultsMessageId: null });
}
