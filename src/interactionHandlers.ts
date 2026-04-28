import {
  MessageFlagsBitField,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import {
  cancelPendingDeletion,
  scheduleMessageDeletion,
} from "./pendingMessageDeletions.js";

const PING_REPLY_DELETE_MS = 15 * 60 * 1000;

export async function handlePing(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({ content: "Понг" });
  const msg = (await interaction.fetchReply()) as Message;

  const deleteAt = Date.now() + PING_REPLY_DELETE_MS;
  scheduleMessageDeletion(interaction.client, msg.channelId, msg.id, deleteAt);
}

/** Сканирует историю канала пакетами и собирает сообщения-опросы от бота. */
async function collectBotPollMessages(
  channel: TextBasedChannel,
  botUserId: string,
): Promise<Message[]> {
  const found: Message[] = [];
  let before: string | undefined;
  const maxBatches = 15;

  for (let i = 0; i < maxBatches; i++) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before !== undefined ? { before } : {}),
    });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.author.id === botUserId && msg.poll !== null) {
        found.push(msg);
      }
    }

    const oldest = batch.last();
    if (!oldest) break;
    before = oldest.id;
    if (batch.size < 100) break;
  }

  return found;
}

export async function handleClearSurvey(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const ch = interaction.channel;
  if (!ch?.isTextBased()) {
    await interaction.reply({
      content:
        "Эту команду можно использовать только в канале с историей сообщений.",
      flags: MessageFlagsBitField.Flags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral });

  const botId = interaction.client.user.id;
  const pollMessages = await collectBotPollMessages(ch, botId);

  if (pollMessages.length === 0) {
    await interaction.editReply({
      content:
        "В этом канале нет опросов, созданных ботом (в проверенной истории сообщений).",
    });
    return;
  }

  let deleted = 0;
  for (const msg of pollMessages) {
    cancelPendingDeletion(msg.channelId, msg.id);
    try {
      await msg.delete();
      deleted += 1;
    } catch (e) {
      console.error("[clear_survey] Не удалось удалить сообщение:", e);
    }
  }

  await interaction.editReply({
    content: `Удалено опросов: ${deleted} из ${pollMessages.length}. Записи об отложенном удалении в файле сняты.`,
  });
}
