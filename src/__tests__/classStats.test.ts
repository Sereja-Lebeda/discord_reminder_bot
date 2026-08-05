import { describe, test, expect, vi, afterEach } from "vitest";

vi.mock("node:fs");

import { readFileSync } from "node:fs";
import { _forTesting } from "../classStats.js";

const { buildStatsText, statsModeFromEnv, countByJsonFile } = _forTesting;

// ── buildStatsText ────────────────────────────────────────────────────────────

describe("buildStatsText", () => {
  test("формирует текст с нулями", () => {
    const text = buildStatsText(0, 0, 0);
    expect(text).toContain("🛡️ Танк: **0**");
    expect(text).toContain("🌿 Хиллер: **0**");
    expect(text).toContain("⚔️ Дамаггер: **0**");
    expect(text).toContain("📊 Состав");
  });

  test("подставляет правильные числа", () => {
    const text = buildStatsText(3, 5, 12);
    expect(text).toContain("🛡️ Танк: **3**");
    expect(text).toContain("🌿 Хиллер: **5**");
    expect(text).toContain("⚔️ Дамаггер: **12**");
  });
});

// ── statsModeFromEnv ──────────────────────────────────────────────────────────

describe("statsModeFromEnv", () => {
  afterEach(() => {
    delete process.env.CLASS_STATS_SOURCE;
  });

  test("env не задан → json", () => {
    expect(statsModeFromEnv()).toBe("json");
  });

  test("CLASS_STATS_SOURCE=roles → roles", () => {
    process.env.CLASS_STATS_SOURCE = "roles";
    expect(statsModeFromEnv()).toBe("roles");
  });

  test("CLASS_STATS_SOURCE=json → json", () => {
    process.env.CLASS_STATS_SOURCE = "json";
    expect(statsModeFromEnv()).toBe("json");
  });

  test("неизвестное значение → json (default)", () => {
    process.env.CLASS_STATS_SOURCE = "something-else";
    expect(statsModeFromEnv()).toBe("json");
  });
});

// ── countByJsonFile ───────────────────────────────────────────────────────────

describe("countByJsonFile", () => {
  test("считает по classKind из JSON", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        entries: {
          user1: { classKind: "tank" },
          user2: { classKind: "healer" },
          user3: { classKind: "damager" },
          user4: { classKind: "tank" },
          user5: {}, // нет classKind — не считается
        },
      }),
    );
    expect(countByJsonFile()).toEqual({ tank: 2, healer: 1, damager: 1 });
  });

  test("пустой файл → нули", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ entries: {} }));
    expect(countByJsonFile()).toEqual({ tank: 0, healer: 0, damager: 0 });
  });

  test("файл не существует (ошибка чтения) → нули", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(countByJsonFile()).toEqual({ tank: 0, healer: 0, damager: 0 });
  });

  test("нет поля entries → нули", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
    expect(countByJsonFile()).toEqual({ tank: 0, healer: 0, damager: 0 });
  });
});
