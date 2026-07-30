import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("node:fs");

import { readFileSync, writeFileSync } from "node:fs";
import { isPublishOverdue, publishBossResults } from "../bossPolls.js";

// ── Вспомогательные функции ───────────────────────────────────────────────────

/** MSK = UTC+3. Возвращает unix ms для указанного дня/часа МСК */
function mskTime(day: number, hour: number, minute = 0): number {
  // Понедельник 1 недели 2000 года = UTC 2000-01-03 (день 1)
  // Проще: берём конкретную дату и корректируем до нужного дня недели.
  // Используем Date.UTC для точности.
  // 2026-07-27 — понедельник (day=1), время в UTC = (hour - 3)
  const baseMonday = Date.UTC(2026, 6, 27); // понедельник
  const dayOffset = (day === 0 ? 6 : day - 1) * 86_400_000; // 0=Вс → 6 дней от пн
  return baseMonday + dayOffset + (hour - 3) * 3_600_000 + minute * 60_000;
}

function mockData(overrides: {
  thursdayPollMessageId?: string | null;
  resultsMessageId?: string | null;
  preRead?: object | null;
} = {}) {
  vi.mocked(readFileSync).mockReturnValue(
    JSON.stringify({
      channelId: "chan1",
      thursdayPollMessageId: overrides.thursdayPollMessageId ?? "poll-thu",
      saturdayPollMessageId: "poll-sat",
      resultsMessageId: overrides.resultsMessageId ?? null,
      ...(overrides.preRead !== undefined ? { preRead: overrides.preRead } : {}),
    }),
  );
}

// ── isPublishOverdue ──────────────────────────────────────────────────────────

describe("isPublishOverdue", () => {
  const baseData = {
    channelId: "chan1",
    thursdayPollMessageId: "poll-thu",
    saturdayPollMessageId: "poll-sat",
    resultsMessageId: null as string | null,
  };

  test("нет thursdayPollMessageId → false", () => {
    expect(isPublishOverdue({ ...baseData, thursdayPollMessageId: null })).toBe(false);
  });

  test("resultsMessageId уже есть → false", () => {
    expect(isPublishOverdue({ ...baseData, resultsMessageId: "msg1" })).toBe(false);
  });

  test("четверг 11:59 МСК → false (ещё рано)", () => {
    expect(isPublishOverdue(baseData, mskTime(4, 11, 59))).toBe(false);
  });

  test("четверг 12:00 МСК → true", () => {
    expect(isPublishOverdue(baseData, mskTime(4, 12, 0))).toBe(true);
  });

  test("четверг 13:00 МСК → true", () => {
    expect(isPublishOverdue(baseData, mskTime(4, 13, 0))).toBe(true);
  });

  test("пятница → true", () => {
    expect(isPublishOverdue(baseData, mskTime(5, 10, 0))).toBe(true);
  });

  test("суббота → true", () => {
    expect(isPublishOverdue(baseData, mskTime(6, 18, 0))).toBe(true);
  });

  test("воскресенье → false (день очистки, не публикации)", () => {
    expect(isPublishOverdue(baseData, mskTime(0, 10, 0))).toBe(false);
  });

  test("понедельник → false", () => {
    expect(isPublishOverdue(baseData, mskTime(1, 10, 0))).toBe(false);
  });
});

// ── publishBossResults — устойчивость к ошибкам ───────────────────────────────

describe("publishBossResults", () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeChannel(sendImpl: () => Promise<unknown>) {
    const deleteThursday = vi.fn().mockResolvedValue(undefined);
    const deleteSaturday = vi.fn().mockResolvedValue(undefined);

    return {
      channel: {
        isSendable: () => true,
        isTextBased: () => true,
        id: "chan1",
        send: vi.fn().mockImplementation(sendImpl),
        messages: {
          fetch: vi.fn().mockImplementation(
            (opts: string | { message?: string; limit?: number; force?: boolean }) => {
              // ch.messages.fetch(msgId) — строка при удалении poll из цикла
              if (typeof opts === "string") {
                if (opts === "poll-thu") return Promise.resolve({ delete: deleteThursday });
                return Promise.resolve({ delete: deleteSaturday });
              }
              // ch.messages.fetch({ limit: 20 }) — в deletePollResultMessage
              if (opts?.limit) {
                return Promise.resolve({ find: () => undefined, size: 0 });
              }
              // ch.messages.fetch({ message, force }) — fetchFinalizedPollMessage (fallback)
              return Promise.resolve({ delete: deleteThursday, poll: null });
            },
          ),
        },
      },
      deleteThursday,
      deleteSaturday,
    };
  }

  function makeClient(channel: object): Client {
    return {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as unknown as Client;
  }

  test("ch.send падает → опросы всё равно удаляются", async () => {
    mockData({
      preRead: {
        thursdayWinnerText: "19:00",
        saturdayWinnerText: "18:00",
        thursdayVoterLines: [],
        saturdayVoterLines: [],
      },
    });

    const { channel, deleteThursday, deleteSaturday } = makeChannel(() =>
      Promise.reject(new Error("ConnectTimeout")),
    );
    const client = makeClient(channel);

    const promise = publishBossResults(client);
    await vi.runAllTimersAsync();
    await promise;

    expect(deleteThursday).toHaveBeenCalled();
    expect(deleteSaturday).toHaveBeenCalled();

    const saved = JSON.parse(vi.mocked(writeFileSync).mock.calls.at(-1)![1] as string);
    expect(saved.resultsMessageId).toBeNull();
  });

  test("ch.send успешен → результаты сохраняются с правильным ID", async () => {
    mockData({
      preRead: {
        thursdayWinnerText: "19:00",
        saturdayWinnerText: null,
        thursdayVoterLines: [],
        saturdayVoterLines: [],
      },
    });

    const { channel, deleteThursday, deleteSaturday } = makeChannel(() =>
      Promise.resolve({ id: "results-msg-id" }),
    );
    const client = makeClient(channel);

    const promise = publishBossResults(client);
    await vi.runAllTimersAsync();
    await promise;

    expect(deleteThursday).toHaveBeenCalled();
    expect(deleteSaturday).toHaveBeenCalled();

    const saved = JSON.parse(vi.mocked(writeFileSync).mock.calls.at(-1)![1] as string);
    expect(saved.resultsMessageId).toBe("results-msg-id");
  });

  test("нет channelId → ранний выход без ошибок", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ channelId: null, thursdayPollMessageId: null, saturdayPollMessageId: null, resultsMessageId: null }),
    );
    const client = makeClient({});
    await expect(publishBossResults(client)).resolves.toBeUndefined();
  });
});
