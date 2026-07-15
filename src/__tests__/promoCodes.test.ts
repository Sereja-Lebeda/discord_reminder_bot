import { describe, test, expect, beforeEach, vi } from "vitest";
import type { SendableChannels } from "discord.js";
import { extractCode, buildChunks, _forTesting } from "../promoCodes.js";

// ── Константы ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const HEADER = "📋 Промо-коды:";
const OVERFLOW_HEADER = "📋 Промо-коды (продолжение):";

// ── Вспомогательные фабрики ──────────────────────────────────────────────────

function makeMessage(
  id: string,
  content: string,
  createdTimestamp: number,
  pinned = false,
) {
  const deleteFn = vi.fn().mockResolvedValue(undefined);
  return { id, content, createdTimestamp, pinned, delete: deleteFn };
}

function makeChannel(messages: ReturnType<typeof makeMessage>[]) {
  const map = new Map(messages.map((m) => [m.id, m]));
  return {
    messages: {
      fetch: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(map.get(id)),
      ),
    },
  } as unknown as SendableChannels;
}

// ── extractCode ───────────────────────────────────────────────────────────────

describe("extractCode", () => {
  test("возвращает первый валидный токен в нижнем регистре", () => {
    expect(extractCode("ABC123")).toBe("abc123");
  });

  test("переводит результат в нижний регистр", () => {
    expect(extractCode("MyCode")).toBe("mycode");
  });

  test("пропускает токены с невалидным первым символом", () => {
    expect(extractCode("!invalid @skip valid123")).toBe("valid123");
  });

  test("принимает дефисы и подчёркивания внутри токена", () => {
    expect(extractCode("my-code_v2")).toBe("my-code_v2");
  });

  test("находит код в строке с текстом перед ним", () => {
    expect(extractCode("вот промо-код: PROMO-2025")).toBe("promo-2025");
  });

  test("возвращает пустую строку если нет валидных токенов", () => {
    expect(extractCode("!!!! ???? ###")).toBe("");
  });

  test("возвращает пустую строку для пустой строки", () => {
    expect(extractCode("")).toBe("");
  });

  test("возвращает пустую строку для строк с пробелами", () => {
    expect(extractCode("   ")).toBe("");
  });

  test("не возвращает токен из заголовка сообщения бота", () => {
    // Заголовки содержат кириллицу — не должны парситься как коды
    expect(extractCode("📋 Промо-коды:")).toBe("");
    expect(extractCode("*(нет кодов)*")).toBe("");
  });
});

// ── buildChunks ───────────────────────────────────────────────────────────────

describe("buildChunks", () => {
  test("пустой массив → одно сообщение с заглушкой", () => {
    const chunks = buildChunks([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("*(нет кодов)*");
    expect(chunks[0]).toMatch(HEADER);
  });

  test("один код → одно сообщение", () => {
    const chunks = buildChunks(["code1"]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(HEADER);
    expect(chunks[0]).toContain("code1");
  });

  test("несколько кодов в пределах лимита → одно сообщение", () => {
    const chunks = buildChunks(["alpha", "beta", "gamma"]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("alpha");
    expect(chunks[0]).toContain("beta");
    expect(chunks[0]).toContain("gamma");
  });

  test("превышение 2000 символов → несколько сообщений", () => {
    // Каждый код ~14 символов с переносом строки, 150 кодов ~ 2100 символов
    const codes = Array.from({ length: 150 }, (_, i) =>
      `code${String(i).padStart(9, "0")}`,
    );
    const chunks = buildChunks(codes);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  test("первый чанк начинается с основного заголовка", () => {
    const codes = Array.from({ length: 150 }, (_, i) =>
      `code${String(i).padStart(9, "0")}`,
    );
    const chunks = buildChunks(codes);
    expect(chunks[0]).toMatch(HEADER);
    expect(chunks[1]).toMatch(OVERFLOW_HEADER);
  });

  test("все коды присутствуют в чанках ровно по одному разу", () => {
    const codes = ["alpha", "beta", "gamma", "delta"];
    const combined = buildChunks(codes).join("\n");
    for (const code of codes) {
      const count = (combined.match(new RegExp(`\\b${code}\\b`, "g")) ?? []).length;
      expect(count, `код '${code}' должен встречаться ровно 1 раз`).toBe(1);
    }
  });
});

// ── cleanupOldPromoMessages ───────────────────────────────────────────────────

describe("cleanupOldPromoMessages", () => {
  beforeEach(() => _forTesting.reset());

  test("удаляет сообщения старше 30 дней и их коды из promoSet", async () => {
    const oldMsg = makeMessage(
      "old1",
      `${HEADER}\noldcode`,
      Date.now() - 31 * DAY_MS,
    );
    const freshMsg = makeMessage(
      "fresh1",
      `${HEADER}\nfreshcode`,
      Date.now() - 5 * DAY_MS,
    );

    _forTesting.setBotMessageIds(["old1", "fresh1"]);
    _forTesting.setPromoSet(["oldcode", "freshcode"]);

    await _forTesting.runCleanup(makeChannel([oldMsg, freshMsg]));

    expect(oldMsg.delete).toHaveBeenCalledOnce();
    expect(freshMsg.delete).not.toHaveBeenCalled();
    expect(_forTesting.getBotMessageIds()).toEqual(["fresh1"]);
    expect(_forTesting.getPromoSet().has("oldcode")).toBe(false);
    expect(_forTesting.getPromoSet().has("freshcode")).toBe(true);
  });

  test("не удаляет закреплённые сообщения даже если они старше 30 дней", async () => {
    const pinnedMsg = makeMessage(
      "pinned1",
      `${HEADER}\npinnedcode`,
      Date.now() - 45 * DAY_MS,
      true, // pinned
    );

    _forTesting.setBotMessageIds(["pinned1"]);
    _forTesting.setPromoSet(["pinnedcode"]);

    await _forTesting.runCleanup(makeChannel([pinnedMsg]));

    expect(pinnedMsg.delete).not.toHaveBeenCalled();
    expect(_forTesting.getBotMessageIds()).toEqual(["pinned1"]);
    expect(_forTesting.getPromoSet().has("pinnedcode")).toBe(true);
  });

  test("убирает ID из массива если сообщение уже удалено (ошибка 10008)", async () => {
    const channel = {
      messages: {
        fetch: vi.fn().mockRejectedValue({ code: 10008 }),
      },
    } as unknown as SendableChannels;

    _forTesting.setBotMessageIds(["gone1"]);
    _forTesting.setPromoSet(["somecode"]);

    await _forTesting.runCleanup(channel);

    expect(_forTesting.getBotMessageIds()).toEqual([]);
  });

  test("оставляет ID при неожиданной ошибке (не 10008/10003)", async () => {
    const channel = {
      messages: {
        fetch: vi.fn().mockRejectedValue({ code: 500 }),
      },
    } as unknown as SendableChannels;

    _forTesting.setBotMessageIds(["err1"]);

    await _forTesting.runCleanup(channel);

    expect(_forTesting.getBotMessageIds()).toEqual(["err1"]);
  });

  test("сообщения ровно на границе 30 дней остаются", async () => {
    // 30 дней минус 1 минута — ещё не истекло
    const borderMsg = makeMessage(
      "border1",
      `${HEADER}\nbordercode`,
      Date.now() - 30 * DAY_MS + 60_000,
    );

    _forTesting.setBotMessageIds(["border1"]);
    _forTesting.setPromoSet(["bordercode"]);

    await _forTesting.runCleanup(makeChannel([borderMsg]));

    expect(borderMsg.delete).not.toHaveBeenCalled();
    expect(_forTesting.getBotMessageIds()).toEqual(["border1"]);
  });

  test("пустой массив botMessageIds — ничего не делает", async () => {
    const channel = makeChannel([]);
    await _forTesting.runCleanup(channel);
    expect(_forTesting.getBotMessageIds()).toEqual([]);
  });
});
