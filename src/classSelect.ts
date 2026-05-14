import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlagsBitField,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type PartialGuildMember,
  type SendableChannels,
} from "discord.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  refreshClassStatsMessage,
  refreshClassStatsMessageWithMemberSync,
} from "./classStats.js";

const USER_MESSAGES_PATH = join(
  process.cwd(),
  "config",
  "class-user-messages.json",
);
const WELCOME_PROMPTS_PATH = join(
  process.cwd(),
  "config",
  "class-welcome-prompts.json",
);

export const CLASS_BUTTON_PREFIX = "class:" as const;

export type ClassKind = "tank" | "healer" | "damager";

const LABELS: Record<ClassKind, string> = {
  tank: "Танк",
  healer: "Хиллер",
  damager: "Дамаггер",
};

function envRoleIds(): Record<ClassKind, string | undefined> {
  return {
    tank: process.env.ROLE_TANK_ID?.trim(),
    healer: process.env.ROLE_HEALER_ID?.trim(),
    damager: process.env.ROLE_DAMAGER_ID?.trim(),
  };
}

function roleIdsFromEnv(): string[] {
  const ids = envRoleIds();
  return [ids.tank, ids.healer, ids.damager].filter((id): id is string =>
    Boolean(id),
  );
}

function classKindFromMember(
  member: GuildMember | PartialGuildMember,
): ClassKind | undefined {
  const ids = envRoleIds();
  return (["tank", "healer", "damager"] as const).find(
    (k) => member.roles.cache.has(ids[k] ?? ""),
  );
}

export function isClassFeatureEnabled(): boolean {
  const log = process.env.CLASS_LOG_CHANNEL_ID?.trim();
  const ids = roleIdsFromEnv();
  return Boolean(log && ids.length === 3);
}

function getLogChannelId(): string | null {
  return process.env.CLASS_LOG_CHANNEL_ID?.trim() ?? null;
}

function loadWelcomePromptMap(): Record<string, UserMessageEntry> {
  try {
    const raw = readFileSync(WELCOME_PROMPTS_PATH, "utf-8");
    const data = JSON.parse(raw) as {
      entries?: Record<string, UserMessageEntry>;
    };
    return data.entries && typeof data.entries === "object" ? data.entries : {};
  } catch {
    return {};
  }
}

function saveWelcomePromptMap(map: Record<string, UserMessageEntry>): void {
  writeFileSync(
    WELCOME_PROMPTS_PATH,
    `${JSON.stringify({ entries: map }, null, 2)}\n`,
    "utf-8",
  );
}

function setWelcomePromptForUser(
  userId: string,
  entry: UserMessageEntry,
): void {
  const map = loadWelcomePromptMap();
  map[userId] = entry;
  saveWelcomePromptMap(map);
}

function clearWelcomePromptForUser(userId: string): void {
  const map = loadWelcomePromptMap();
  if (!map[userId]) return;
  delete map[userId];
  saveWelcomePromptMap(map);
}

export type UserMessageEntry = {
  messageId: string;
  channelId: string;
  /** Для строки лога при смене ника, если игровые роли не выданы (например модераторы). */
  classKind?: ClassKind;
};

function protectedRoleIdsFromEnv(): string[] {
  const raw = process.env.CLASS_PROTECTED_ROLE_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Доп. user ID (через запятую), если нужно вручную — владелец определяется автоматически. */
function protectedUserIdsFromEnv(): string[] {
  const raw = process.env.CLASS_PROTECTED_USER_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Участник «защищён»: только строка в логе, игровые роли Танк/Хиллер/Дамаггер не трогаем.
 * — владелец сервера (ownerId, роль не нужна);
 * — ID из CLASS_PROTECTED_USER_IDS;
 * — любая роль из CLASS_PROTECTED_ROLE_IDS.
 */
export function memberHasProtectedRole(member: GuildMember): boolean {
  if (member.id === member.guild.ownerId) return true;
  if (protectedUserIdsFromEnv().includes(member.id)) return true;
  const roleIds = protectedRoleIdsFromEnv();
  if (roleIds.length === 0) return false;
  return member.roles.cache.some((r) => roleIds.includes(r.id));
}

function loadUserMessageMap(): Record<string, UserMessageEntry> {
  try {
    const raw = readFileSync(USER_MESSAGES_PATH, "utf-8");
    const data = JSON.parse(raw) as {
      entries?: Record<string, UserMessageEntry>;
    };
    return data.entries && typeof data.entries === "object" ? data.entries : {};
  } catch {
    return {};
  }
}

function saveUserMessageMap(map: Record<string, UserMessageEntry>): void {
  writeFileSync(
    USER_MESSAGES_PATH,
    `${JSON.stringify({ entries: map }, null, 2)}\n`,
    "utf-8",
  );
}

/**
 * Сначала правим существующую строку лога. В Discord у ботов нет «срока годности» редактирования
 * как в Telegram, но edit может упасть (сообщение удалено, нет прав). Тогда удаляем старое
 * при возможности и отправляем новое в канал лога.
 */
async function upsertClassLogMessage(
  client: Client,
  userId: string,
  line: string,
  kind: ClassKind,
  logCh: SendableChannels,
): Promise<void> {
  const map = loadUserMessageMap();
  const existing = map[userId];

  if (existing) {
    const ch = await client.channels.fetch(existing.channelId);
    if (ch?.isSendable()) {
      try {
        const msg = await ch.messages.fetch(existing.messageId);
        await msg.edit({ content: line });
        map[userId] = {
          messageId: existing.messageId,
          channelId: existing.channelId,
          classKind: kind,
        };
        saveUserMessageMap(map);
        return;
      } catch (e) {
        console.warn(
          "[class] Редактирование лога не удалось — удаляю старое сообщение и создаю новое:",
          e,
        );
        try {
          const stale = await ch.messages.fetch(existing.messageId);
          await stale.delete();
        } catch {
          /* уже удалено или недоступно */
        }
      }
    }
  }

  const msg = await logCh.send({ content: line });
  map[userId] = {
    messageId: msg.id,
    channelId: logCh.id,
    classKind: kind,
  };
  saveUserMessageMap(map);
}

function buildLogLine(member: GuildMember, classLabel: string): string {
  const name = member.displayName || member.user.username;
  return `"${name}" — "${classLabel}"`;
}

function parseClass(kind: string): ClassKind | null {
  if (kind === "tank" || kind === "healer" || kind === "damager") return kind;
  return null;
}

/** Кнопки привязаны к userId, чтобы нельзя было нажать чужой выбор в общем канале. */
function buildClassRowForMember(
  targetUserId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CLASS_BUTTON_PREFIX}${targetUserId}:tank`)
      .setLabel(LABELS.tank)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CLASS_BUTTON_PREFIX}${targetUserId}:healer`)
      .setLabel(LABELS.healer)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CLASS_BUTTON_PREFIX}${targetUserId}:damager`)
      .setLabel(LABELS.damager)
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Второе сообщение в канале приветствия: выбор класса. Сохраняем id, чтобы удалить после нажатия.
 */
export async function sendWelcomeClassPrompt(
  member: GuildMember,
  welcomeChannel: SendableChannels,
): Promise<void> {
  if (!isClassFeatureEnabled()) return;

  const row = buildClassRowForMember(member.id);
  const msg = await welcomeChannel.send({
    content: `${member} Укажи основной класс — нажми кнопку ниже.`,
    components: [row],
    allowedMentions: { users: [member.id] },
  });

  setWelcomePromptForUser(member.id, {
    messageId: msg.id,
    channelId: welcomeChannel.id,
  });
  console.log(`[class] Промпт выбора класса для ${member.id} → ${msg.id}`);
}

/** Разбор `class:<snowflake>:tank|healer|damager` */
function parseClassButtonCustomId(
  customId: string,
): { targetUserId: string; kind: ClassKind } | null {
  if (!customId.startsWith(CLASS_BUTTON_PREFIX)) return null;
  const rest = customId.slice(CLASS_BUTTON_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const targetUserId = rest.slice(0, lastColon);
  const kind = parseClass(rest.slice(lastColon + 1));
  if (!kind) return null;
  return { targetUserId, kind };
}

/** Удаляет второе сообщение с кнопками в приветствии и снимает запись из файла. */
export async function deleteWelcomePromptMessage(
  client: Client,
  userId: string,
): Promise<void> {
  const map = loadWelcomePromptMap();
  const entry = map[userId];
  if (!entry) return;
  try {
    const ch = await client.channels.fetch(entry.channelId);
    if (ch?.isSendable()) {
      const msg = await ch.messages.fetch(entry.messageId);
      await msg.delete();
    }
  } catch (e) {
    console.error("[class] Не удалось удалить промпт в канале приветствия:", e);
  }
  clearWelcomePromptForUser(userId);
}

async function syncClassLogForMember(
  member: GuildMember,
  kind: ClassKind,
  client: Client,
): Promise<void> {
  const logChannelId = getLogChannelId();
  if (!logChannelId) return;
  const logCh = await client.channels.fetch(logChannelId);
  if (!logCh?.isSendable()) return;
  const line = buildLogLine(member, LABELS[kind]);
  try {
    await upsertClassLogMessage(client, member.id, line, kind, logCh);
    await deleteWelcomePromptMessage(client, member.id);
    try {
      await refreshClassStatsMessage(client, member.guild);
    } catch (e) {
      console.error("[class-stats] Не удалось обновить сводку:", e);
    }
    console.log(`[class] Лог синхронизирован: ${member.id} → ${kind}`);
  } catch (e) {
    console.error("[class] Не удалось синхронизировать лог:", e);
  }
}

export type ApplyClassResult =
  | { ok: true; label: string; protectedUser: boolean }
  | { ok: false; userMessage: string };

/**
 * Обновляет игровые роли (если не «защищённая» роль) и строку в логе; сохраняет classKind для смены ника.
 */
export async function applyClassForMember(
  member: GuildMember,
  kind: ClassKind,
  client: Client,
  options: { deleteWelcomePrompt: boolean },
): Promise<ApplyClassResult> {
  if (!isClassFeatureEnabled()) {
    return {
      ok: false,
      userMessage:
        "Выбор класса не настроен (CLASS_LOG_CHANNEL_ID / ROLE_*_ID).",
    };
  }

  const logChannelId = getLogChannelId();
  const ids = envRoleIds();
  const selectedRoleId = ids[kind];
  if (!logChannelId || !selectedRoleId) {
    return {
      ok: false,
      userMessage:
        "Выбор класса не настроен (CLASS_LOG_CHANNEL_ID / ROLE_*_ID).",
    };
  }

  const label = LABELS[kind];
  const protectedUser = memberHasProtectedRole(member);
  const allClassRoleIds = roleIdsFromEnv();

  if (!protectedUser) {
    try {
      const toRemove = member.roles.cache.filter((r) =>
        allClassRoleIds.includes(r.id),
      );
      if (toRemove.size > 0) {
        await member.roles.remove(toRemove);
      }
      await member.roles.add(selectedRoleId);
    } catch (e) {
      console.error("[class] Не удалось выдать роли:", e);
      return {
        ok: false,
        userMessage:
          "Не удалось выдать роль. Проверь: роль бота выше Танк/Хиллер/Дамаггер, у бота есть «Управлять ролями».",
      };
    }
  }

  const line = buildLogLine(member, label);
  const logCh = await client.channels.fetch(logChannelId);
  if (!logCh?.isSendable()) {
    return {
      ok: false,
      userMessage: "Канал лога недоступен для записи.",
    };
  }

  try {
    await upsertClassLogMessage(client, member.id, line, kind, logCh);
    if (options.deleteWelcomePrompt) {
      await deleteWelcomePromptMessage(client, member.id);
    }
    try {
      await refreshClassStatsMessage(client, member.guild);
    } catch (e) {
      console.error("[class-stats] Не удалось обновить сводку:", e);
    }
    return { ok: true, label, protectedUser };
  } catch (e) {
    console.error("[class] Ошибка лога:", e);
    return {
      ok: false,
      userMessage: "Не удалось записать или обновить строку в логе.",
    };
  }
}

export async function handleClassSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({
      content: "Эту команду можно использовать только на сервере.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  const raw = interaction.options.getString("class", true);
  const kind = parseClass(raw);
  if (!kind) {
    await interaction.reply({
      content: "Неверный класс.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  if (!isClassFeatureEnabled()) {
    await interaction.reply({
      content: "Выбор класса не настроен на боте.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral });
  } catch (err: any) {
    if (err?.code === 10062) {
      console.warn(
        `[classSelect] Interaction ${interaction.id} истёк до deferReply — пользователь не получит ответ.`,
      );
      return;
    }
    throw err;
  }

  const member = interaction.member as GuildMember;
  const result = await applyClassForMember(member, kind, interaction.client, {
    deleteWelcomePrompt: true,
  });

  if (!result.ok) {
    await interaction.editReply({ content: result.userMessage });
    return;
  }

  const staffNote = result.protectedUser
    ? "Игровые роли не менялись (у тебя роль модератора/админа из списка защищённых). "
    : "Игровая роль на сервере обновлена. ";
  await interaction.editReply({
    content: `${staffNote}Строка в логе классов обновлена: «${result.label}».`,
  });
}

export async function handleClassButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith(CLASS_BUTTON_PREFIX)) return;

  const parsed = parseClassButtonCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: "Неизвестный формат кнопки.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  const { targetUserId, kind } = parsed;

  if (!interaction.guild || !interaction.member) {
    await interaction.reply({
      content: "Эту кнопку можно нажать только на сервере.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== targetUserId) {
    await interaction.reply({
      content:
        "Это приглашение выбрать класс не для тебя — нажми кнопки под своим сообщением.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral });
  } catch (err: any) {
    if (err?.code === 10062) {
      console.warn(
        `[classSelect] Interaction ${interaction.id} истёк до deferReply — пользователь не получит ответ.`,
      );
      return;
    }
    throw err;
  }

  const member = interaction.member as GuildMember;
  const result = await applyClassForMember(member, kind, interaction.client, {
    deleteWelcomePrompt: true,
  });

  if (!result.ok) {
    await interaction.editReply({ content: result.userMessage });
    return;
  }

  const extra = result.protectedUser
    ? " Игровые роли не менялись (роль модератора/админа в списке защищённых)."
    : "";
  await interaction.editReply({
    content: `«${result.label}» записано в лог.${extra} Сообщение с выбором в приветствии удалено.`,
  });
}

export async function handleClassMemberDisplayNameUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember | PartialGuildMember,
): Promise<void> {
  if (!isClassFeatureEnabled()) return;

  const guildId = process.env.GUILD_ID?.trim();
  if (guildId && newMember.guild.id !== guildId) return;

  const member = await newMember.guild.members.fetch(newMember.id);

  const oldClass = classKindFromMember(oldMember);
  const newClass = classKindFromMember(member);

  // Классовая роль изменилась — синхронизируем лог (ник тоже актуальный)
  if (newClass !== oldClass && newClass !== undefined) {
    await syncClassLogForMember(member, newClass, member.client);
    return;
  }

  // Только смена ника — обновляем лог если класс известен
  if (oldMember.displayName === newMember.displayName) return;

  const map = loadUserMessageMap();
  const entry = map[member.id];
  if (!entry) return;

  const kind = entry.classKind ?? newClass;
  if (!kind) return;

  const line = buildLogLine(member, LABELS[kind]);
  const logChannelId = getLogChannelId();
  if (!logChannelId) return;
  const logCh = await member.client.channels.fetch(logChannelId);
  if (!logCh?.isSendable()) return;

  try {
    await upsertClassLogMessage(member.client, member.id, line, kind, logCh);
    console.log(`[class] Лог обновлён после смены ника: ${member.id}`);
  } catch (e) {
    console.error("[class] Не удалось обновить лог при смене ника:", e);
  }
}

export function registerClassMemberUpdate(client: Client): void {
  client.on(Events.GuildMemberUpdate, (oldM, newM) => {
    void handleClassMemberDisplayNameUpdate(oldM, newM);
  });
}

async function removeUserLogLineOnLeave(
  client: Client,
  userId: string,
): Promise<void> {
  const map = loadUserMessageMap();
  const entry = map[userId];
  if (!entry) return;
  try {
    const ch = await client.channels.fetch(entry.channelId);
    if (ch?.isSendable()) {
      const msg = await ch.messages.fetch(entry.messageId);
      await msg.delete();
    }
  } catch (e) {
    console.warn("[class] Не удалось удалить строку лога при выходе:", e);
  }
  delete map[userId];
  saveUserMessageMap(map);
}

async function handleGuildMemberLeaveForClass(
  client: Client,
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  if (!isClassFeatureEnabled()) return;
  const guildId = process.env.GUILD_ID?.trim();
  if (guildId && member.guild.id !== guildId) return;

  await removeUserLogLineOnLeave(client, member.id);
  await deleteWelcomePromptMessage(client, member.id);

  try {
    await refreshClassStatsMessageWithMemberSync(client, member.guild);
  } catch (e) {
    console.error("[class-stats] Не удалось обновить сводку после выхода:", e);
  }
  const displayName = member.displayName ?? member.user?.username ?? "неизвестно";
  console.log(`[class] Пользователь ${member.id} (${displayName}) вышел — лог очищен, сводка пересчитана.`);
}

export function registerGuildMemberRemoveForClass(client: Client): void {
  client.on(Events.GuildMemberRemove, (member) => {
    void handleGuildMemberLeaveForClass(client, member);
  });
}

export async function cleanupOrphanedWelcomePrompts(client: Client): Promise<void> {
  if (!isClassFeatureEnabled()) return;

  // Шаг 1: сверяем роли участников с логом, синхронизируем расхождения
  const guildId = process.env.GUILD_ID?.trim();
  if (guildId) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const members = await guild.members.fetch();
      const classMap = loadUserMessageMap();
      console.log(`[class] Startup: сверяю роли ${members.size} участников...`);
      for (const [, member] of members) {
        const kind = classKindFromMember(member);
        if (!kind) continue;
        const logEntry = classMap[member.id];
        if (!logEntry || logEntry.classKind !== kind) {
          await syncClassLogForMember(member, kind, client);
        }
      }
    } catch (e) {
      console.error("[class] Startup: ошибка сверки ролей:", e);
    }
  }

  // Шаг 2: удаляем оставшиеся мёртвые кнопки (класс в логе, промпт ещё висит)
  const promptMap = loadWelcomePromptMap();
  const classMap = loadUserMessageMap();
  const userIds = Object.keys(promptMap);
  if (userIds.length === 0) return;
  console.log(`[class] Cleanup: проверяю ${userIds.length} промпт(ов) приветствия...`);
  for (const userId of userIds) {
    if (classMap[userId]) {
      await deleteWelcomePromptMessage(client, userId);
      console.log(`[class] Cleanup: удалён мёртвый промпт для ${userId}`);
    }
  }
}
