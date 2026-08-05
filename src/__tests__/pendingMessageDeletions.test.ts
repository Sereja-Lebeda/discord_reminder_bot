import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("node:fs");

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  scheduleMessageDeletion,
  cancelPendingDeletion,
  restorePendingDeletions,
  _forTesting,
} from "../pendingMessageDeletions.js";

// ── Вспомогательные функции ───────────────────────────────────────────────────

function makeClient(deleteResult: "ok" | "error" | "unknown-message" = "ok"): Client {
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        messages: {
          delete: vi.fn().mockImplementation(() => {
            if (deleteResult === "error") return Promise.reject(new Error("Network error"));
            if (deleteResult === "unknown-message") {
              const e = Object.assign(new Error("Unknown Message"), { code: 10008 });
              return Promise.reject(e);
            }
            return Promise.resolve();
          }),
        },
      }),
    },
  } as unknown as Client;
}

function mockEmptyFile(): void {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ records: [] }));
}

// ── scheduleMessageDeletion ───────────────────────────────────────────────────

describe("scheduleMessageDeletion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _forTesting.resetTimers();
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(writeFileSync).mockImplementation(() => {});
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ records: [] }));
  });

  afterEach(() => {
    vi.useRealTimers();
    _forTesting.resetTimers();
  });

  test("сохраняет запись в файл", () => {
    const client = makeClient();
    const deleteAt = Date.now() + 60_000;
    scheduleMessageDeletion(client, "ch1", "msg1", deleteAt);

    const saved = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]).toMatchObject({
      channelId: "ch1",
      messageId: "msg1",
      deleteAt,
    });
  });

  test("не дублирует запись при повторном вызове", () => {
    const client = makeClient();
    const deleteAt = Date.now() + 60_000;
    // Первый вызов — файла нет, запись добавляется
    scheduleMessageDeletion(client, "ch1", "msg1", deleteAt);
    // Имитируем что файл теперь существует и содержит запись
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ records: [{ id: "ch1_msg1", channelId: "ch1", messageId: "msg1", deleteAt }] }),
    );
    // Второй вызов — запись уже есть, saveRecords не вызывается
    scheduleMessageDeletion(client, "ch1", "msg1", deleteAt);

    // writeFileSync вызван только один раз (при первом scheduleMessageDeletion)
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1);
  });

  test("таймер срабатывает в нужное время и удаляет сообщение", async () => {
    const client = makeClient();
    const deleteAt = Date.now() + 5_000;
    mockEmptyFile();
    scheduleMessageDeletion(client, "ch1", "msg1", deleteAt);

    // Имитируем прошедшее время
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ records: [{ id: "ch1_msg1", channelId: "ch1", messageId: "msg1", deleteAt }] }),
    );
    await vi.advanceTimersByTimeAsync(5_001);

    const ch = await (client.channels.fetch as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(ch.messages.delete).toHaveBeenCalledWith("msg1");
  });
});

// ── cancelPendingDeletion ─────────────────────────────────────────────────────

describe("cancelPendingDeletion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _forTesting.resetTimers();
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(writeFileSync).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    _forTesting.resetTimers();
  });

  test("отменяет таймер и удаляет запись из файла", () => {
    const client = makeClient();
    const deleteAt = Date.now() + 60_000;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ records: [] }));
    scheduleMessageDeletion(client, "ch1", "msg1", deleteAt);

    // Теперь в файле есть запись
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ records: [{ id: "ch1_msg1", channelId: "ch1", messageId: "msg1", deleteAt }] }),
    );
    cancelPendingDeletion("ch1", "msg1");

    // Последний writeFileSync — пустой массив
    const lastSave = JSON.parse(vi.mocked(writeFileSync).mock.calls.at(-1)![1] as string);
    expect(lastSave.records).toHaveLength(0);
  });

  test("cancel без предварительного schedule — не падает", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ records: [] }));
    expect(() => cancelPendingDeletion("ch1", "msg-nonexistent")).not.toThrow();
  });
});

// ── restorePendingDeletions ───────────────────────────────────────────────────

describe("restorePendingDeletions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _forTesting.resetTimers();
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(writeFileSync).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    _forTesting.resetTimers();
  });

  test("пустой файл → ничего не происходит", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ records: [] }));
    const client = makeClient();
    expect(() => restorePendingDeletions(client)).not.toThrow();
  });

  test("просроченная запись → сразу запускает удаление", async () => {
    const now = Date.now();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        records: [{ id: "ch1_msg1", channelId: "ch1", messageId: "msg1", deleteAt: now - 1000 }],
      }),
    );
    const client = makeClient();
    restorePendingDeletions(client);
    // runDelete вызывается асинхронно через void — ждём микрозадачи
    await vi.runAllTimersAsync();
    expect(vi.mocked(client.channels.fetch)).toHaveBeenCalled();
  });

  test("будущая запись → ставит таймер, не удаляет сразу", async () => {
    const now = Date.now();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        records: [{ id: "ch1_msg1", channelId: "ch1", messageId: "msg1", deleteAt: now + 60_000 }],
      }),
    );
    const client = makeClient();
    restorePendingDeletions(client);

    // Без продвижения времени — удаления нет
    expect(vi.mocked(client.channels.fetch)).not.toHaveBeenCalled();

    // После продвижения — удаление срабатывает
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ records: [{ id: "ch1_msg1", channelId: "ch1", messageId: "msg1", deleteAt: now + 60_000 }] }),
    );
    await vi.advanceTimersByTimeAsync(60_001);
    expect(vi.mocked(client.channels.fetch)).toHaveBeenCalled();
  });
});
