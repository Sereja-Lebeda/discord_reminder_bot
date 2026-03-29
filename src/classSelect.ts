import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlagsBitField,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type PartialGuildMember,
  type SendableChannels,
} from "discord.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USER_MESSAGES_PATH = join(process.cwd(), "config", "class-user-messages.json");
const WELCOME_PROMPTS_PATH = join(process.cwd(), "config", "class-welcome-prompts.json");

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
  return [ids.tank, ids.healer, ids.damager].filter(
    (id): id is string => Boolean(id)
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
    const data = JSON.parse(raw) as { entries?: Record<string, UserMessageEntry> };
    return data.entries && typeof data.entries === "object" ? data.entries : {};
  } catch {
    return {};
  }
}

function saveWelcomePromptMap(map: Record<string, UserMessageEntry>): void {
  writeFileSync(
    WELCOME_PROMPTS_PATH,
    `${JSON.stringify({ entries: map }, null, 2)}\n`,
    "utf-8"
  );
}

function setWelcomePromptForUser(userId: string, entry: UserMessageEntry): void {
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

export type UserMessageEntry = { messageId: string; channelId: string };

function loadUserMessageMap(): Record<string, UserMessageEntry> {
  try {
    const raw = readFileSync(USER_MESSAGES_PATH, "utf-8");
    const data = JSON.parse(raw) as { entries?: Record<string, UserMessageEntry> };
    return data.entries && typeof data.entries === "object" ? data.entries : {};
  } catch {
    return {};
  }
}

function saveUserMessageMap(map: Record<string, UserMessageEntry>): void {
  writeFileSync(
    USER_MESSAGES_PATH,
    `${JSON.stringify({ entries: map }, null, 2)}\n`,
    "utf-8"
  );
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
function buildClassRowForMember(targetUserId: string): ActionRowBuilder<ButtonBuilder> {
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
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Второе сообщение в канале приветствия: выбор класса. Сохраняем id, чтобы удалить после нажатия.
 */
export async function sendWelcomeClassPrompt(
  member: GuildMember,
  welcomeChannel: SendableChannels
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
  customId: string
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

async function deleteWelcomePromptMessage(client: Client, userId: string): Promise<void> {
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

export async function handleClassButton(interaction: ButtonInteraction): Promise<void> {
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
      content: "Это приглашение выбрать класс не для тебя — нажми кнопки под своим сообщением.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  const logChannelId = getLogChannelId();
  const ids = envRoleIds();
  const selectedRoleId = ids[kind];
  if (!logChannelId || !selectedRoleId) {
    await interaction.reply({
      content: "Выбор класса не настроен на боте (CLASS_LOG_CHANNEL_ID / роли).",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral });

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const allClassRoleIds = roleIdsFromEnv();

  try {
    const toRemove = member.roles.cache.filter((r) => allClassRoleIds.includes(r.id));
    if (toRemove.size > 0) {
      await member.roles.remove(toRemove);
    }
    await member.roles.add(selectedRoleId);
  } catch (e) {
    console.error("[class] Не удалось выдать роли:", e);
    await interaction.editReply({
      content:
        "Не удалось выдать роль. Проверь: роль бота выше Танк/Хиллер/Дамаггер, у бота есть «Управлять ролями».",
    });
    return;
  }

  const label = LABELS[kind];
  const line = buildLogLine(member, label);

  const logCh = await interaction.client.channels.fetch(logChannelId);
  if (!logCh?.isSendable()) {
    await deleteWelcomePromptMessage(interaction.client, member.id);
    await interaction.editReply({
      content: `Роль «${label}» выдана, но канал лога недоступен. Сообщение с выбором в приветствии убрано.`,
    });
    return;
  }

  let map = loadUserMessageMap();
  const existing = map[member.id];

  try {
    if (existing) {
      const existingCh = await interaction.client.channels.fetch(existing.channelId);
      if (existingCh?.isSendable()) {
        try {
          const msg = await existingCh.messages.fetch(existing.messageId);
          await msg.edit({ content: line });
          await deleteWelcomePromptMessage(interaction.client, member.id);
          await interaction.editReply({
            content: `Роль «${label}» установлена. Запись в логе обновлена. Сообщение с выбором в канале приветствия удалено.`,
          });
          return;
        } catch {
          /* сообщение удалено — создаём новое */
        }
      }
    }

    const msg = await logCh.send({ content: line });
    map = { ...map, [member.id]: { messageId: msg.id, channelId: logCh.id } };
    saveUserMessageMap(map);
    await deleteWelcomePromptMessage(interaction.client, member.id);
    await interaction.editReply({
      content: `Роль «${label}» установлена. Строка добавлена в лог. Сообщение с выбором в канале приветствия удалено.`,
    });
  } catch (e) {
    console.error("[class] Ошибка лога:", e);
    await deleteWelcomePromptMessage(interaction.client, member.id);
    await interaction.editReply({
      content: `Роль «${label}» выдана, но не удалось записать в лог. Сообщение с выбором в приветствии убрано.`,
    });
  }
}

export async function handleClassMemberDisplayNameUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember | PartialGuildMember
): Promise<void> {
  if (!isClassFeatureEnabled()) return;

  const guildId = process.env.GUILD_ID?.trim();
  if (guildId && newMember.guild.id !== guildId) return;

  if (oldMember.displayName === newMember.displayName) return;

  const member = await newMember.guild.members.fetch(newMember.id);

  const map = loadUserMessageMap();
  const entry = map[member.id];
  if (!entry) return;

  const hasClassRole = roleIdsFromEnv().some((id) => member.roles.cache.has(id));
  if (!hasClassRole) return;

  const kind = (["tank", "healer", "damager"] as const).find((k) =>
    member.roles.cache.has(envRoleIds()[k] ?? "")
  );
  if (!kind) return;

  const label = LABELS[kind];
  const line = buildLogLine(member, label);

  try {
    const ch = await member.client.channels.fetch(entry.channelId);
    if (!ch?.isSendable()) return;
    const msg = await ch.messages.fetch(entry.messageId);
    await msg.edit({ content: line });
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
