import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { GuildMember } from "discord.js";
import {
  isTestUser,
  isClassFeatureEnabled,
  memberHasProtectedRole,
  _forTesting,
} from "../classSelect.js";

const { parseClassButtonCustomId, buildLogLine } = _forTesting;

// ── Вспомогательная функция: мок GuildMember ──────────────────────────────────

function makeMember(overrides: {
  id?: string;
  displayName?: string;
  username?: string;
  ownerId?: string;
  roleIds?: string[];
} = {}): GuildMember {
  const id = overrides.id ?? "user1";
  const roleIds = overrides.roleIds ?? [];
  return {
    id,
    displayName: overrides.displayName ?? "TestUser",
    user: { username: overrides.username ?? "testuser" },
    guild: { ownerId: overrides.ownerId ?? "owner1" },
    roles: {
      cache: {
        some: (fn: (r: { id: string }) => boolean) =>
          roleIds.some((rid) => fn({ id: rid })),
      },
    },
  } as unknown as GuildMember;
}

// ── isTestUser ────────────────────────────────────────────────────────────────

describe("isTestUser", () => {
  afterEach(() => {
    delete process.env.TEST_USER_IDS;
  });

  test("env не задан → false", () => {
    expect(isTestUser("123")).toBe(false);
  });

  test("ID совпадает → true", () => {
    process.env.TEST_USER_IDS = "282637011318472704";
    expect(isTestUser("282637011318472704")).toBe(true);
  });

  test("ID не совпадает → false", () => {
    process.env.TEST_USER_IDS = "282637011318472704";
    expect(isTestUser("999999999999999999")).toBe(false);
  });

  test("несколько ID через запятую → находит нужный", () => {
    process.env.TEST_USER_IDS = "111,282637011318472704,333";
    expect(isTestUser("282637011318472704")).toBe(true);
    expect(isTestUser("111")).toBe(true);
    expect(isTestUser("999")).toBe(false);
  });

  test("пробелы вокруг ID допустимы", () => {
    process.env.TEST_USER_IDS = " 111 , 222 ";
    expect(isTestUser("111")).toBe(true);
    expect(isTestUser("222")).toBe(true);
  });
});

// ── isClassFeatureEnabled ─────────────────────────────────────────────────────

describe("isClassFeatureEnabled", () => {
  afterEach(() => {
    delete process.env.CLASS_LOG_CHANNEL_ID;
    delete process.env.ROLE_TANK_ID;
    delete process.env.ROLE_HEALER_ID;
    delete process.env.ROLE_DAMAGER_ID;
  });

  test("все переменные заданы → true", () => {
    process.env.CLASS_LOG_CHANNEL_ID = "ch1";
    process.env.ROLE_TANK_ID = "t";
    process.env.ROLE_HEALER_ID = "h";
    process.env.ROLE_DAMAGER_ID = "d";
    expect(isClassFeatureEnabled()).toBe(true);
  });

  test("нет CLASS_LOG_CHANNEL_ID → false", () => {
    process.env.ROLE_TANK_ID = "t";
    process.env.ROLE_HEALER_ID = "h";
    process.env.ROLE_DAMAGER_ID = "d";
    expect(isClassFeatureEnabled()).toBe(false);
  });

  test("нет одной роли → false", () => {
    process.env.CLASS_LOG_CHANNEL_ID = "ch1";
    process.env.ROLE_TANK_ID = "t";
    process.env.ROLE_HEALER_ID = "h";
    // ROLE_DAMAGER_ID не задан
    expect(isClassFeatureEnabled()).toBe(false);
  });

  test("ничего не задано → false", () => {
    expect(isClassFeatureEnabled()).toBe(false);
  });
});

// ── parseClassButtonCustomId ──────────────────────────────────────────────────

describe("parseClassButtonCustomId", () => {
  test("корректный танк", () => {
    expect(parseClassButtonCustomId("class:123456789:tank")).toEqual({
      targetUserId: "123456789",
      kind: "tank",
    });
  });

  test("корректный хиллер", () => {
    expect(parseClassButtonCustomId("class:987654321:healer")).toEqual({
      targetUserId: "987654321",
      kind: "healer",
    });
  });

  test("guild-friend", () => {
    expect(parseClassButtonCustomId("class:111:guild-friend")).toEqual({
      targetUserId: "111",
      kind: "guild-friend",
    });
  });

  test("неверный префикс → null", () => {
    expect(parseClassButtonCustomId("other:123:tank")).toBeNull();
  });

  test("неверный kind → null", () => {
    expect(parseClassButtonCustomId("class:123:mage")).toBeNull();
  });

  test("нет второго двоеточия → null", () => {
    expect(parseClassButtonCustomId("class:tank")).toBeNull();
  });
});

// ── buildLogLine ──────────────────────────────────────────────────────────────

describe("buildLogLine", () => {
  test("использует displayName если задан", () => {
    const member = makeMember({ displayName: "Иван", username: "ivan123" });
    expect(buildLogLine(member, "Танк")).toBe('"Иван" — "Танк"');
  });

  test("фоллбэк на username если displayName пустой", () => {
    const member = makeMember({ displayName: "", username: "ivan123" });
    expect(buildLogLine(member, "Хиллер")).toBe('"ivan123" — "Хиллер"');
  });

  test("дамаггер", () => {
    const member = makeMember({ displayName: "Петя" });
    expect(buildLogLine(member, "Дамаггер")).toBe('"Петя" — "Дамаггер"');
  });
});

// ── memberHasProtectedRole ────────────────────────────────────────────────────

describe("memberHasProtectedRole", () => {
  beforeEach(() => {
    delete process.env.CLASS_PROTECTED_USER_IDS;
    delete process.env.CLASS_PROTECTED_ROLE_IDS;
  });

  test("владелец сервера → true", () => {
    const member = makeMember({ id: "owner1", ownerId: "owner1" });
    expect(memberHasProtectedRole(member)).toBe(true);
  });

  test("ID в CLASS_PROTECTED_USER_IDS → true", () => {
    process.env.CLASS_PROTECTED_USER_IDS = "admin1,admin2";
    const member = makeMember({ id: "admin1", ownerId: "owner1" });
    expect(memberHasProtectedRole(member)).toBe(true);
  });

  test("роль в CLASS_PROTECTED_ROLE_IDS → true", () => {
    process.env.CLASS_PROTECTED_ROLE_IDS = "mod-role";
    const member = makeMember({ id: "user1", ownerId: "owner1", roleIds: ["mod-role"] });
    expect(memberHasProtectedRole(member)).toBe(true);
  });

  test("обычный пользователь без совпадений → false", () => {
    process.env.CLASS_PROTECTED_USER_IDS = "admin1";
    process.env.CLASS_PROTECTED_ROLE_IDS = "mod-role";
    const member = makeMember({ id: "user1", ownerId: "owner1", roleIds: ["regular-role"] });
    expect(memberHasProtectedRole(member)).toBe(false);
  });
});
