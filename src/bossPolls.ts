import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client, Message, SendableChannels } from "discord.js";

const DATA_PATH = join(process.cwd(), "data", "boss-polls.json");

/** Длительность опросов: Пн 09:00 → Чт 12:00 = 75 часов */
const POLL_DURATION_HOURS = 75;

interface PreReadData {
  thursdayVoterLines: string[];
  saturdayVoterLines: string[];
  thursdayWinnerText: string | null;
  saturdayWinnerText: string | null;
}

interface BossPollsData {
  channelId: string | null;
  thursdayPollMessageId: string | null;
  saturdayPollMessageId: string | null;
  resultsMessageId: string | null;
  preRead?: PreReadData;
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

// ─── Fallback-хелперы (используются если бот был офлайн в 11:55) ───────────

interface AnswerEntry {
  text: string;
  voteCount: number;
}

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

async function fetchFinalizedPollMessage(ch: SendableChannels, messageId: string): Promise<Message> {
  const MAX_ATTEMPTS = 10;
  const DELAY_MS = 3000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const msg = await ch.messages.fetch({ message: messageId, force: true });
    if (msg.poll?.resultsFinalized) return msg;
    console.log(`[boss-polls] Ожидаем финализации опроса ${messageId} (попытка ${attempt + 1}/${MAX_ATTEMPTS})...`);
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  return ch.messages.fetch({ message: messageId, force: true });
}

// ─── Основной поток ──────────────────────────────────────────────────────────

async function readActivePollData(
  ch: SendableChannels,
  msgId: string,
  dayLabel: string,
): Promise<{ voterLines: string[]; winnerText: string | null }> {
  const msg = await ch.messages.fetch({ message: msgId, force: true });
  if (!msg.poll) return { voterLines: [], winnerText: null };

  const answerData: Array<{ text: string; voterMentions: string[]; count: number }> = [];
  for (const answer of msg.poll.answers.values()) {
    const voters = await answer.voters.fetch({ limit: 100 });
    answerData.push({
      text: answer.text ?? "?",
      voterMentions: [...voters.values()].map(u => `<@${u.id}>`),
      count: voters.size,
    });
  }

  const maxVotes = Math.max(0, ...answerData.map(a => a.count));
  if (maxVotes === 0) return { voterLines: [], winnerText: null };

  const winners = answerData.filter(a => a.count === maxVotes);
  return {
    voterLines: winners.map(w => `**${dayLabel} — ${w.text}:** ${w.voterMentions.join(", ")}`),
    winnerText: winners.map(w => w.text).join(" и "),
  };
}

/** Четверг 11:55 МСК — читает voters пока опросы ещё активны, сохраняет в JSON */
export async function preReadBossPolls(client: Client): Promise<void> {
  const data = loadData();
  if (!data.channelId || !data.thursdayPollMessageId || !data.saturdayPollMessageId) {
    console.warn("[boss-polls] preRead: нет сохранённых ID опросов — пропускаем");
    return;
  }

  const ch = await client.channels.fetch(data.channelId);
  if (!ch?.isSendable()) {
    console.error(`[boss-polls] preRead: канал ${data.channelId} недоступен`);
    return;
  }

  try {
    const thursday = await readActivePollData(ch, data.thursdayPollMessageId, "Четверг");
    const saturday = await readActivePollData(ch, data.saturdayPollMessageId, "Суббота");

    saveData({
      ...data,
      preRead: {
        thursdayVoterLines: thursday.voterLines,
        saturdayVoterLines: saturday.voterLines,
        thursdayWinnerText: thursday.winnerText,
        saturdayWinnerText: saturday.winnerText,
      },
    });
    console.log("[boss-polls] Предварительное чтение голосов завершено");
  } catch (e) {
    console.error("[boss-polls] Не удалось выполнить preRead:", e);
  }
}

/** Ищет и удаляет системное PollResult-сообщение Discord (тип 46) для данного опроса */
async function deletePollResultMessage(ch: SendableChannels, pollMsgId: string): Promise<void> {
  // Даём Discord время создать PollResult-сообщение, если оно ещё не появилось
  await new Promise(r => setTimeout(r, 2000));
  try {
    const recent = await ch.messages.fetch({ limit: 20 });
    const pollResultMsg = recent.find(
      (m: Message) => m.type === 46 && m.reference?.messageId === pollMsgId
    );
    if (pollResultMsg) {
      await pollResultMsg.delete();
      console.log(`[boss-polls] PollResult-сообщение для ${pollMsgId} удалено`);
    } else {
      console.warn(`[boss-polls] PollResult-сообщение для ${pollMsgId} не найдено`);
    }
  } catch (e) {
    console.error(`[boss-polls] Не удалось удалить PollResult-сообщение для ${pollMsgId}:`, e);
  }
}

/** Четверг 12:05 МСК — публикует результаты опросов */
export async function publishBossResults(client: Client): Promise<void> {
  const data = loadData();
  if (!data.channelId) {
    console.warn("[boss-polls] Нет сохранённого channelId — пропускаем публикацию результатов");
    return;
  }

  const ch = await client.channels.fetch(data.channelId);
  if (!ch?.isSendable()) {
    console.error(`[boss-polls] Канал ${data.channelId} недоступен`);
    return;
  }

  let thursdayWinner: string | null;
  let saturdayWinner: string | null;
  let allVoterLines: string[] = [];

  if (data.preRead) {
    thursdayWinner = data.preRead.thursdayWinnerText;
    saturdayWinner = data.preRead.saturdayWinnerText;
    allVoterLines = [...data.preRead.thursdayVoterLines, ...data.preRead.saturdayVoterLines];
  } else {
    // Fallback: бот был офлайн в 11:55 — берём voteCount из завершённых опросов (без списка voters)
    console.warn("[boss-polls] preRead отсутствует, используем fallback через voteCount (список проголосовавших недоступен)");
    if (!data.thursdayPollMessageId || !data.saturdayPollMessageId) {
      console.warn("[boss-polls] Нет ID опросов — пропускаем");
      return;
    }
    try {
      const msg1 = await fetchFinalizedPollMessage(ch, data.thursdayPollMessageId);
      const msg2 = await fetchFinalizedPollMessage(ch, data.saturdayPollMessageId);
      thursdayWinner = getWinners(pollAnswersToEntries(msg1.poll));
      saturdayWinner = getWinners(pollAnswersToEntries(msg2.poll));
    } catch (e) {
      console.error("[boss-polls] Fallback: не удалось получить данные опросов:", e);
      saveData({ channelId: null, thursdayPollMessageId: null, saturdayPollMessageId: null, resultsMessageId: null });
      return;
    }
  }

  // Список проголосовавших → VOTERS_CHANNEL_ID (постоянное сообщение)
  if (allVoterLines.length > 0) {
    const votersChannelId = process.env.VOTERS_CHANNEL_ID?.trim();
    if (votersChannelId) {
      try {
        const votersCh = await client.channels.fetch(votersChannelId);
        if (votersCh?.isSendable()) {
          await votersCh.send({ content: allVoterLines.join("\n") });
          console.log("[boss-polls] Список проголосовавших отправлен");
        }
      } catch (e) {
        console.error("[boss-polls] Не удалось отправить список проголосовавших:", e);
      }
    } else {
      console.warn("[boss-polls] VOTERS_CHANNEL_ID не задан — список проголосовавших не отправлен");
    }
  }

  // Итоговое сообщение → REMINDER_CHANNEL_ID
  const thursdayLine = thursdayWinner
    ? `По решению большинства голосов, поход на босса в **__четверг__** - ${thursdayWinner}`
    : "Поход на босса в **__четверг__** отменяется, так как никто не хочет идти";
  const saturdayLine = saturdayWinner
    ? `По решению большинства голосов, поход на босса в **__субботу__** - ${saturdayWinner}`
    : "Поход на босса в **__субботу__** отменяется, так как никто не хочет идти";

  const resultsMsg = await ch.send({ content: [thursdayLine, saturdayLine].join("\n") });

  // Удаляем poll-сообщения и системные PollResult-сообщения Discord (тип 46)
  for (const msgId of [data.thursdayPollMessageId, data.saturdayPollMessageId]) {
    if (!msgId) continue;
    try {
      const msg = await ch.messages.fetch(msgId);
      await msg.delete();
      console.log(`[boss-polls] Poll-сообщение ${msgId} удалено`);
    } catch (e) {
      console.error(`[boss-polls] Не удалось удалить poll-сообщение ${msgId}:`, e);
    }
    await deletePollResultMessage(ch, msgId);
  }

  saveData({
    channelId: data.channelId,
    thursdayPollMessageId: data.thursdayPollMessageId,
    saturdayPollMessageId: data.saturdayPollMessageId,
    resultsMessageId: resultsMsg.id,
  });
  console.log(`[boss-polls] Результаты опубликованы (${resultsMsg.id})`);
}

/** Воскресенье 09:00 МСК — удаляет сообщение с результатами и poll-сообщения (если остались) */
export async function cleanupBossResults(client: Client): Promise<void> {
  const data = loadData();
  if (!data.channelId) {
    console.warn("[boss-polls] Нет сохранённого channelId — пропускаем");
    saveData({ channelId: null, thursdayPollMessageId: null, saturdayPollMessageId: null, resultsMessageId: null });
    return;
  }

  let ch;
  try {
    ch = await client.channels.fetch(data.channelId);
  } catch {
    ch = null;
  }

  if (ch?.isTextBased()) {
    if (data.resultsMessageId) {
      try {
        const msg = await ch.messages.fetch(data.resultsMessageId);
        await msg.delete();
        console.log(`[boss-polls] Сообщение с результатами ${data.resultsMessageId} удалено`);
      } catch {
        // уже удалено вручную — норма
      }
    }

    for (const msgId of [data.thursdayPollMessageId, data.saturdayPollMessageId]) {
      if (!msgId) continue;
      try {
        const msg = await ch.messages.fetch(msgId);
        await msg.delete();
        console.log(`[boss-polls] Fallback: удалено poll-сообщение ${msgId}`);
      } catch {
        // уже удалено — норма
      }
    }
  }

  saveData({ channelId: null, thursdayPollMessageId: null, saturdayPollMessageId: null, resultsMessageId: null });
}

/** При старте бота проверяет наличие системных PollResult-сообщений Discord (тип 46) в канале */
export async function logPollResultMessages(client: Client): Promise<void> {
  const data = loadData();
  const pollIds = [data.thursdayPollMessageId, data.saturdayPollMessageId].filter(Boolean) as string[];
  if (!data.channelId || pollIds.length === 0) return;

  let ch;
  try {
    ch = await client.channels.fetch(data.channelId);
  } catch {
    ch = null;
  }
  if (!ch?.isTextBased()) return;

  try {
    const recent = await ch.messages.fetch({ limit: 100 });
    for (const pollMsgId of pollIds) {
      const found = recent.filter((m: Message) => m.type === 46 && m.reference?.messageId === pollMsgId);
      if (found.size > 0) {
        for (const m of found.values()) {
          console.log(`[boss-polls] Startup: найдено PollResult-сообщение (тип 46) id=${m.id} для poll=${pollMsgId}`);
          try {
            await m.delete();
            console.log(`[boss-polls] Startup: PollResult-сообщение ${m.id} удалено`);
          } catch (e) {
            console.error(`[boss-polls] Startup: не удалось удалить PollResult-сообщение ${m.id}:`, e);
          }
        }
      } else {
        console.log(`[boss-polls] Startup: PollResult-сообщение для poll=${pollMsgId} не найдено в последних 100 сообщениях`);
      }
    }
  } catch (e) {
    console.error("[boss-polls] Startup: ошибка при поиске PollResult-сообщений:", e);
  }
}

/** Запускает очистку при старте бота, если cron пропустил воскресное удаление */
export async function runCleanupIfOverdue(client: Client): Promise<void> {
  const data = loadData();
  if (!data.resultsMessageId) return;
  // МСК = UTC+3
  const mskDate = new Date(Date.now() + 3 * 3_600_000);
  const day = mskDate.getUTCDay();   // 0=Вс, 1=Пн
  const hour = mskDate.getUTCHours();
  if (day === 0 || (day === 1 && hour < 9)) {
    console.log("[boss-polls] Пропущенная очистка обнаружена при старте, запускаем...");
    await cleanupBossResults(client);
  }
}

/** Создаёт опросы при старте бота, если cron пропустил понедельничное создание (пн–ср) */
export async function runCreateIfOverdue(client: Client): Promise<void> {
  const data = loadData();
  if (data.thursdayPollMessageId) return;
  // МСК = UTC+3
  const mskDate = new Date(Date.now() + 3 * 3_600_000);
  const day = mskDate.getUTCDay(); // 0=Вс, 1=Пн, 2=Вт, 3=Ср
  if (day >= 1 && day <= 3) {
    console.log("[boss-polls] Пропущенное создание опросов обнаружено при старте, запускаем...");
    await createBossPolls(client);
  }
}
