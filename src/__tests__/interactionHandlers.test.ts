import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, Message, TextBasedChannel } from "discord.js";

vi.mock("../pendingMessageDeletions.js", () => ({
  scheduleMessageDeletion: vi.fn(),
  cancelPendingDeletion: vi.fn(),
}));

import { scheduleMessageDeletion, cancelPendingDeletion } from "../pendingMessageDeletions.js";
import { handlePing, handleClearSurvey, _forTesting } from "../interactionHandlers.js";

const { collectBotPollMessages } = _forTesting;

// ── Вспомогательные фабрики ───────────────────────────────────────────────────

/** Создаёт мок сообщения. hasPoll=true → msg.poll !== null (опрос бота) */
function makeMsg(
  id: string,
  authorId: string,
  opts: { hasPoll?: boolean; pinned?: boolean } = {},
): Message {
  return {
    id,
    channelId: "ch1",
    author: { id: authorId },
    poll: opts.hasPoll ? { question: { text: "?" } } : null,
    pinned: opts.pinned ?? false,
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as Message;
}

/**
 * Создаёт мок TextBasedChannel с фиксированной историей.
 *
 * `batches` — массив «страниц» сообщений. Каждый вызов `channel.messages.fetch`
 * возвращает следующую страницу. Discord возвращает Map-образный объект
 * с методами `values()`, `last()` и свойством `size`.
 */
function makeChannel(batches: Message[][]): TextBasedChannel {
  let callIndex = 0;
  return {
    isTextBased: () => true,
    messages: {
      fetch: vi.fn().mockImplementation(() => {
        const batch = batches[callIndex] ?? [];
        callIndex++;
        return Promise.resolve({
          size: batch.length,
          values: () => batch[Symbol.iterator](),
          last: () => batch[batch.length - 1],
        });
      }),
    },
  } as unknown as TextBasedChannel;
}

// ── collectBotPollMessages ────────────────────────────────────────────────────

describe("collectBotPollMessages", () => {
  const BOT_ID = "bot-user";

  test("пустой канал → пустой массив", async () => {
    const ch = makeChannel([[]]);
    expect(await collectBotPollMessages(ch, BOT_ID)).toEqual([]);
  });

  test("единственное сообщение бота с опросом → возвращает его", async () => {
    const poll = makeMsg("m1", BOT_ID, { hasPoll: true });
    const ch = makeChannel([[poll], []]);
    const result = await collectBotPollMessages(ch, BOT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  test("сообщение бота без опроса игнорируется", async () => {
    const botNoPoll = makeMsg("m1", BOT_ID, { hasPoll: false });
    const ch = makeChannel([[botNoPoll], []]);
    expect(await collectBotPollMessages(ch, BOT_ID)).toHaveLength(0);
  });

  test("сообщение другого пользователя с опросом игнорируется", async () => {
    const userPoll = makeMsg("m1", "user-456", { hasPoll: true });
    const ch = makeChannel([[userPoll], []]);
    expect(await collectBotPollMessages(ch, BOT_ID)).toHaveLength(0);
  });

  test("смешанный батч: возвращает только сообщения бота с опросом", async () => {
    const msgs = [
      makeMsg("m1", BOT_ID, { hasPoll: true }),   // ✓
      makeMsg("m2", BOT_ID, { hasPoll: false }),  // бот, нет опроса
      makeMsg("m3", "user", { hasPoll: true }),   // юзер, есть опрос
      makeMsg("m4", BOT_ID, { hasPoll: true }),   // ✓
    ];
    const ch = makeChannel([msgs, []]);
    const result = await collectBotPollMessages(ch, BOT_ID);
    expect(result.map((m) => m.id)).toEqual(["m1", "m4"]);
  });

  test("два батча: опросы из обоих попадают в результат", async () => {
    const batch1 = Array.from({ length: 100 }, (_, i) =>
      makeMsg(`b1-${i}`, i % 2 === 0 ? BOT_ID : "user", { hasPoll: i % 2 === 0 }),
    );
    const batch2 = [makeMsg("b2-0", BOT_ID, { hasPoll: true })];

    const ch = makeChannel([batch1, batch2, []]);
    const result = await collectBotPollMessages(ch, BOT_ID);

    // 50 из batch1 (чётные) + 1 из batch2
    expect(result).toHaveLength(51);
  });

  test("батч меньше 100 → останавливается, не запрашивает следующий", async () => {
    const smallBatch = Array.from({ length: 42 }, (_, i) =>
      makeMsg(`m${i}`, BOT_ID, { hasPoll: true }),
    );
    const fetchFn = vi.fn().mockResolvedValue({
      size: smallBatch.length,
      values: () => smallBatch[Symbol.iterator](),
      last: () => smallBatch.at(-1),
    });
    const ch = { isTextBased: () => true, messages: { fetch: fetchFn } } as unknown as TextBasedChannel;

    await collectBotPollMessages(ch, BOT_ID);

    // Запрошен ровно один батч — маленький батч остановил пагинацию
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("первый батч ровно 100 и второй пустой → два запроса, второй останавливает", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      makeMsg(`m${i}`, BOT_ID, { hasPoll: true }),
    );
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ size: 100, values: () => full[Symbol.iterator](), last: () => full.at(-1) })
      .mockResolvedValueOnce({ size: 0,   values: () => [][Symbol.iterator](),  last: () => undefined });

    const ch = { isTextBased: () => true, messages: { fetch: fetchFn } } as unknown as TextBasedChannel;
    const result = await collectBotPollMessages(ch, BOT_ID);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(100);
  });

  test("cursor 'before' передаётся при пагинации", async () => {
    const lastMsg = makeMsg("cursor-id", BOT_ID, { hasPoll: false });
    const full = Array.from({ length: 100 }, (_, i) =>
      makeMsg(`m${i}`, "user"),
    );
    // Последнее сообщение в батче — тот, чей id станет cursor
    full[99] = lastMsg;

    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ size: 100, values: () => full[Symbol.iterator](), last: () => lastMsg })
      .mockResolvedValueOnce({ size: 0,   values: () => [][Symbol.iterator](),  last: () => undefined });

    const ch = { isTextBased: () => true, messages: { fetch: fetchFn } } as unknown as TextBasedChannel;
    await collectBotPollMessages(ch, BOT_ID);

    // Второй вызов должен содержать { before: "cursor-id" }
    expect(fetchFn).toHaveBeenNthCalledWith(2, expect.objectContaining({ before: "cursor-id" }));
  });

  test("максимум 15 батчей — после 15-го пагинация прекращается", async () => {
    // Каждый батч полный (100), всегда есть ещё — проверяем что fetch вызывается не > 15 раз
    const full = Array.from({ length: 100 }, (_, i) => makeMsg(`m${i}`, "user"));
    const fetchFn = vi.fn().mockResolvedValue({
      size: 100,
      values: () => full[Symbol.iterator](),
      last: () => full.at(-1),
    });

    const ch = { isTextBased: () => true, messages: { fetch: fetchFn } } as unknown as TextBasedChannel;
    await collectBotPollMessages(ch, BOT_ID);

    expect(fetchFn).toHaveBeenCalledTimes(15);
  });
});

// ── handlePing ────────────────────────────────────────────────────────────────

describe("handlePing", () => {
  beforeEach(() => {
    vi.mocked(scheduleMessageDeletion).mockClear();
  });

  test("отвечает 'Понг' и планирует удаление через 15 минут", async () => {
    const replyMsg = { id: "reply-id", channelId: "ch1" } as Message;
    const interaction = {
      reply: vi.fn().mockResolvedValue(undefined),
      fetchReply: vi.fn().mockResolvedValue(replyMsg),
      client: { channels: {} },
    } as unknown as ChatInputCommandInteraction;

    const before = Date.now();
    await handlePing(interaction);
    const after = Date.now();

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Понг" });
    expect(scheduleMessageDeletion).toHaveBeenCalledOnce();

    const [, chId, msgId, deleteAt] = vi.mocked(scheduleMessageDeletion).mock.calls[0];
    expect(chId).toBe("ch1");
    expect(msgId).toBe("reply-id");
    // deleteAt ≈ now + 15 мин (± 1 с погрешности)
    expect(deleteAt).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(deleteAt).toBeLessThanOrEqual(after  + 15 * 60 * 1000);
  });
});

// ── handleClearSurvey ─────────────────────────────────────────────────────────

describe("handleClearSurvey", () => {
  beforeEach(() => {
    vi.mocked(cancelPendingDeletion).mockClear();
  });

  /** Создаёт мок ChatInputCommandInteraction */
  function makeInteraction(channel: TextBasedChannel | null = null, botId = "bot-user") {
    return {
      channel,
      deferReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      client: { user: { id: botId } },
    } as unknown as ChatInputCommandInteraction;
  }

  test("channel = null → ephemeral ответ 'только в канале'", async () => {
    const interaction = makeInteraction(null);
    await handleClearSurvey(interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("только в канале") }),
    );
  });

  test("channel не isTextBased → ephemeral ответ", async () => {
    const ch = { isTextBased: () => false } as unknown as TextBasedChannel;
    const interaction = makeInteraction(ch);
    await handleClearSurvey(interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
  });

  test("нет опросов в канале → сообщение 'нет опросов'", async () => {
    const ch = makeChannel([[]]);
    const interaction = makeInteraction(ch);
    await handleClearSurvey(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("нет опросов") }),
    );
  });

  test("два опроса бота → оба удаляются, cancelPendingDeletion вызван дважды", async () => {
    const poll1 = makeMsg("p1", "bot-user", { hasPoll: true });
    const poll2 = makeMsg("p2", "bot-user", { hasPoll: true });
    const ch = makeChannel([[poll1, poll2], []]);
    const interaction = makeInteraction(ch);

    await handleClearSurvey(interaction);

    expect(poll1.delete).toHaveBeenCalledOnce();
    expect(poll2.delete).toHaveBeenCalledOnce();
    expect(cancelPendingDeletion).toHaveBeenCalledTimes(2);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("2 из 2") }),
    );
  });

  test("удаление одного опроса падает → deleted < total, editReply содержит оба числа", async () => {
    const good = makeMsg("p1", "bot-user", { hasPoll: true });
    const bad = makeMsg("p2", "bot-user", { hasPoll: true });
    (bad.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Missing Permissions"));

    const ch = makeChannel([[good, bad], []]);
    const interaction = makeInteraction(ch);

    await handleClearSurvey(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("1 из 2") }),
    );
  });
});
