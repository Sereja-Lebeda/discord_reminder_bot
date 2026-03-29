import type { Client, Guild, Role } from "discord.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATS_PATH = join(process.cwd(), "config", "class-stats-message.json");
const USER_MESSAGES_PATH = join(
  process.cwd(),
  "config",
  "class-user-messages.json",
);

type JsonClassKind = "tank" | "healer" | "damager";

interface StatsState {
  channelId: string | null;
  messageId: string | null;
}

function loadStatsState(): StatsState {
  try {
    const raw = readFileSync(STATS_PATH, "utf-8");
    const d = JSON.parse(raw) as { channelId?: string; messageId?: string };
    return {
      channelId: d.channelId?.trim() ?? null,
      messageId: d.messageId?.trim() ?? null,
    };
  } catch {
    return { channelId: null, messageId: null };
  }
}

function saveStatsState(state: StatsState): void {
  writeFileSync(
    STATS_PATH,
    `${JSON.stringify(
      { channelId: state.channelId, messageId: state.messageId },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

/** По умолчанию `json` — сводка по `class-user-messages.json`. Для подсчёта по ролям на сервере: CLASS_STATS_SOURCE=roles */
type StatsMode = "roles" | "json";

function statsModeFromEnv(): StatsMode {
  const v = process.env.CLASS_STATS_SOURCE?.trim().toLowerCase();
  if (v === "roles") return "roles";
  return "json";
}

/** Шаблон текста сводки — правь строки здесь. */
function buildStatsText(tank: number, healer: number, damager: number): string {
  return [
    "**📊 Состав гильди по классам**",
    "",
    `🛡️ Танк: **${tank}**`,
    `🌿 Хиллер: **${healer}**`,
    `⚔️ Дамаггер: **${damager}**`,
  ].join("\n");
}

function countRoleMembers(
  role: Role | undefined,
  excludeBots: boolean,
): number {
  if (!role) return 0;
  if (!excludeBots) return role.members.size;
  return role.members.filter((m) => !m.user.bot).size;
}

function countByRoles(
  guild: Guild,
): { tank: number; healer: number; damager: number } | null {
  const tankId = process.env.ROLE_TANK_ID?.trim();
  const healerId = process.env.ROLE_HEALER_ID?.trim();
  const damagerId = process.env.ROLE_DAMAGER_ID?.trim();
  if (!tankId || !healerId || !damagerId) return null;

  const excludeBots =
    process.env.CLASS_STATS_EXCLUDE_BOTS === "1" ||
    process.env.CLASS_STATS_EXCLUDE_BOTS?.toLowerCase() === "true";

  const tank = countRoleMembers(guild.roles.cache.get(tankId), excludeBots);
  const healer = countRoleMembers(guild.roles.cache.get(healerId), excludeBots);
  const damager = countRoleMembers(
    guild.roles.cache.get(damagerId),
    excludeBots,
  );
  return { tank, healer, damager };
}

/** Подсчёт только по `classKind` в class-user-messages.json (строки без classKind не учитываются). */
function countByJsonFile(): { tank: number; healer: number; damager: number } {
  try {
    const raw = readFileSync(USER_MESSAGES_PATH, "utf-8");
    const data = JSON.parse(raw) as {
      entries?: Record<string, { classKind?: JsonClassKind }>;
    };
    const entries = data.entries ?? {};
    let tank = 0;
    let healer = 0;
    let damager = 0;
    for (const e of Object.values(entries)) {
      const k = e?.classKind;
      if (k === "tank") tank += 1;
      else if (k === "healer") healer += 1;
      else if (k === "damager") damager += 1;
    }
    return { tank, healer, damager };
  } catch {
    return { tank: 0, healer: 0, damager: 0 };
  }
}

function getCounts(
  guild: Guild,
): { tank: number; healer: number; damager: number } | null {
  if (statsModeFromEnv() === "json") {
    return countByJsonFile();
  }
  return countByRoles(guild);
}

/**
 * Обновляет (или создаёт) одно закрепляемое по смыслу сообщение со счётчиками ролей Танк / Хиллер / Дамаггер.
 * Вызывать после смены класса и при старте бота.
 */
export async function refreshClassStatsMessage(
  client: Client,
  guild: Guild,
): Promise<void> {
  const logChannelId = process.env.CLASS_LOG_CHANNEL_ID?.trim();
  if (!logChannelId) return;

  const counts = getCounts(guild);
  if (!counts) return;

  const { tank, healer, damager } = counts;
  const content = buildStatsText(tank, healer, damager);

  const ch = await client.channels.fetch(logChannelId);
  if (!ch?.isSendable()) {
    console.warn("[class-stats] Канал лога недоступен.");
    return;
  }

  let state = loadStatsState();

  if (state.messageId && state.channelId === logChannelId) {
    try {
      const msg = await ch.messages.fetch(state.messageId);
      await msg.edit({ content });
      return;
    } catch (e: unknown) {
      const code =
        typeof e === "object" && e !== null && "code" in e
          ? Number((e as { code?: unknown }).code)
          : undefined;
      if (code === 10008) {
        console.log(
          "[class-stats] Сообщение сводки удалено или устарело — создаю новое.",
        );
      } else {
        console.warn("[class-stats] Не удалось обновить сводку:", e);
      }
      saveStatsState({ channelId: logChannelId, messageId: null });
    }
  }

  const msg = await ch.send({ content });
  state = { channelId: ch.id, messageId: msg.id };
  saveStatsState(state);
  console.log(`[class-stats] Сводка обновлена: ${msg.id}`);
}

/**
 * Подгружает участников в кеш, чтобы счётчики ролей были полными (важно при старте).
 */
export async function refreshClassStatsMessageWithMemberSync(
  client: Client,
  guild: Guild,
): Promise<void> {
  if (statsModeFromEnv() !== "json") {
    try {
      await guild.members.fetch();
    } catch (e) {
      console.warn("[class-stats] guild.members.fetch пропущен или ошибка:", e);
    }
  }
  await refreshClassStatsMessage(client, guild);
}
