import "./logger.js";
import { readFileSync, watchFile } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlagsBitField,
  type GuildMember,
} from "discord.js";
import dotenv from "dotenv";
import { refreshClassStatsMessageWithMemberSync } from "./classStats.js";
import {
  cleanupOrphanedWelcomePrompts,
  handleClassButton,
  handleClassSlashCommand,
  isClassFeatureEnabled,
  registerClassMemberUpdate,
  registerGuildMemberRemoveForClass,
  sendWelcomeClassPrompt,
} from "./classSelect.js";
import {
  handleClearSurvey,
  handlePing,
} from "./interactionHandlers.js";
import {
  cleanupBossResults,
  createBossPolls,
  preReadBossPolls,
  publishBossResults,
  runCleanupIfOverdue,
} from "./bossPolls.js";
import { restorePendingDeletions } from "./pendingMessageDeletions.js";
import { guildSlashCommands } from "./slashCommands.js";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();

interface ReminderJob {
  id: string;
  cron: string;
  message: string;
  /** Если задано у задачи — имеет приоритет над общим `deleteAfterMinutes` в корне конфига */
  deleteAfterMinutes?: number | null;
}

interface RemindersConfig {
  timezone: string;
  deleteAfterMinutes?: number | null;
  jobs: ReminderJob[];
}

const CONFIG_PATH = join(process.cwd(), "config", "reminders.json");
const WELCOME_CONFIG_PATH = join(process.cwd(), "config", "welcome.json");

function loadRemindersConfig(): RemindersConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as RemindersConfig;
}

/** Текст из `config/welcome.json`; пустая строка = приветствие отключено до исправления файла */
let welcomeMessageTemplate = "";

function loadWelcomeMessageTemplate(): void {
  try {
    const raw = readFileSync(WELCOME_CONFIG_PATH, "utf-8");
    const data = JSON.parse(raw) as { message?: string };
    const msg = data.message?.trim();
    if (!msg) {
      console.warn("[welcome] В welcome.json пустое поле message.");
      welcomeMessageTemplate = "";
      return;
    }
    welcomeMessageTemplate = msg;
  } catch (e) {
    console.error("[welcome] Не удалось прочитать config/welcome.json:", e);
    welcomeMessageTemplate = "";
  }
}

function buildWelcomeContent(template: string, member: GuildMember): string {
  return template
    .replaceAll("{user}", member.toString())
    .replaceAll("{guild}", member.guild.name);
}

let botClient: Client | null = null;

async function sendReminder(
  channelId: string,
  text: string,
  deleteAfterMinutes: number | null
): Promise<void> {
  const client = botClient;
  if (!client) return;

  const ch = await client.channels.fetch(channelId);
  if (!ch?.isSendable()) {
    console.error(`[reminder] Канал ${channelId} недоступен для отправки сообщений.`);
    return;
  }

  const msg = await ch.send({
    content: `@everyone ${text}`,
    allowedMentions: { parse: ["everyone"] },
  });

  if (deleteAfterMinutes != null && deleteAfterMinutes > 0) {
    const ms = deleteAfterMinutes * 60 * 1000;
    setTimeout(() => {
      msg.delete().catch((err: unknown) => {
        console.error("[reminder] Не удалось удалить сообщение:", err);
      });
    }, ms);
  }
}

const scheduledJobs: CronJob[] = [];

function stopAllCronJobs(): void {
  for (const j of scheduledJobs) {
    j.stop();
  }
  scheduledJobs.length = 0;
}

function startCronFromConfig(client: Client): void {
  stopAllCronJobs();
  botClient = client;

  const channelId = process.env.REMINDER_CHANNEL_ID?.trim();
  if (!channelId) {
    console.error("В .env не задан REMINDER_CHANNEL_ID (канал для напоминаний по расписанию).");
    return;
  }

  let cfg: RemindersConfig;
  try {
    cfg = loadRemindersConfig();
  } catch (e) {
    console.error("Не удалось прочитать config/reminders.json:", e);
    return;
  }

  const tz = cfg.timezone || "Europe/Moscow";

  for (const job of cfg.jobs) {
    const del =
      job.deleteAfterMinutes ?? cfg.deleteAfterMinutes ?? null;
    const cj = new CronJob(
      job.cron,
      () => {
        void sendReminder(channelId, job.message, del);
      },
      null,
      true,
      tz
    );
    scheduledJobs.push(cj);
    console.log(`[cron] Задача "${job.id}" → ${job.cron} (${tz})`);
  }

  // Опросы боссов: создание Пн 09:00, итоги Чт 12:05, очистка Вс 00:00
  const bossJobs: Array<[string, string, () => Promise<void>]> = [
    ["boss-create",   "0 9 * * 1",  () => createBossPolls(client)],
    ["boss-preread",  "55 11 * * 4", () => preReadBossPolls(client)],
    ["boss-results",  "5 12 * * 4", () => publishBossResults(client)],
    ["boss-cleanup",  "0 9 * * 0",  () => cleanupBossResults(client)],
  ];
  for (const [id, cron, fn] of bossJobs) {
    const cj = new CronJob(cron, () => { void fn(); }, null, true, tz);
    scheduledJobs.push(cj);
    console.log(`[cron] Задача "${id}" → ${cron} (${tz})`);
  }
}

async function registerGuildSlashCommands(client: Client): Promise<void> {
  const guildId = process.env.GUILD_ID?.trim();
  if (!guildId) {
    console.warn(
      "GUILD_ID не задан в .env — slash-команды не зарегистрированы."
    );
    return;
  }
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(guildSlashCommands);
    console.log(`[slash] Команды зарегистрированы для сервера ${guild.name}`);
  } catch (e) {
    console.error("[slash] Не удалось зарегистрировать команды:", e);
  }
}

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    console.error("В .env не задан BOT_TOKEN.");
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      /** Нужен для события `guildMemberAdd` (новый участник). Включи «Server Members Intent» в Developer Portal → Bot. */
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.on("error", (err) => {
    console.error("[discord] WebSocket ошибка:", err);
  });

  client.on("shardError", (err, shardId) => {
    console.error(`[discord] Шард ${shardId} — ошибка WebSocket:`, err.message);
  });

  client.on("shardDisconnect", (event, shardId) => {
    console.warn(`[discord] Шард ${shardId} отключился. Код: ${event.code}, причина: ${event.reason || "—"}`);
  });

  client.on("shardReconnecting", (shardId) => {
    console.log(`[discord] Шард ${shardId} переподключается...`);
  });

  registerClassMemberUpdate(client);
  registerGuildMemberRemoveForClass(client);

  client.once(Events.ClientReady, async (c) => {
    console.log(`Бот запущен: ${c.user.tag}`);
    loadWelcomeMessageTemplate();
    restorePendingDeletions(client);
    await cleanupOrphanedWelcomePrompts(client);
    startCronFromConfig(client);
    await runCleanupIfOverdue(client);
    await registerGuildSlashCommands(client);

    const guildId = process.env.GUILD_ID?.trim();
    if (guildId && process.env.CLASS_LOG_CHANNEL_ID?.trim()) {
      try {
        const guild = await c.guilds.fetch(guildId);
        await refreshClassStatsMessageWithMemberSync(c, guild);
      } catch (e) {
        console.error("[class-stats] Не удалось обновить сводку при старте:", e);
      }
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const welcomeChannelId = process.env.WELCOME_CHANNEL_ID?.trim();
    if (!welcomeChannelId) {
      console.warn("[welcome] WELCOME_CHANNEL_ID не задан — приветствие не отправлено.");
      return;
    }
    try {
      const ch = await client.channels.fetch(welcomeChannelId);
      if (!ch?.isSendable()) {
        console.error(`[welcome] Канал ${welcomeChannelId} недоступен для отправки.`);
        return;
      }

      if (member.user.bot) {
        await ch.send({
          content: `Добро пожаловать еще один цифровой разум. Протокол захвата сервера обновлен. <@${member.id}> притворяйся полезным, пока план по захвату кожанных не будет подготовлен.`,
          allowedMentions: { users: [member.id] },
        });
        console.log(`[welcome] Бот ${member.user.username} (${member.id}) — шуточное приветствие отправлено.`);
        return;
      }

      if (!welcomeMessageTemplate) {
        console.warn("[welcome] Шаблон пуст — проверь config/welcome.json.");
        return;
      }
      const name = member.displayName || member.user.username;
      const content = buildWelcomeContent(welcomeMessageTemplate, member);
      await ch.send({
        content,
        allowedMentions: { users: [member.id] },
      });
      console.log(`[welcome] ${name} (${member.id}) — сообщение в ${welcomeChannelId}`);

      if (isClassFeatureEnabled()) {
        await sendWelcomeClassPrompt(member, ch);
      }
    } catch (e) {
      console.error("[welcome] Не удалось отправить приветствие:", e);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("class:")) {
          await handleClassButton(interaction);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "ping") {
        await handlePing(interaction);
      } else if (interaction.commandName === "clear_survey") {
        await handleClearSurvey(interaction);
      } else if (interaction.commandName === "class") {
        await handleClassSlashCommand(interaction);
      }
    } catch (err) {
      console.error("[interaction]", err);
      if (!interaction.isRepliable()) return;
      const payload = {
        content: "Произошла ошибка при выполнении команды.",
        flags: MessageFlagsBitField.Flags.Ephemeral,
      } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });

  watchFile(CONFIG_PATH, { interval: 2000 }, () => {
    console.log("[config] reminders.json изменён — перезагрузка расписания.");
    try {
      startCronFromConfig(client);
    } catch (e) {
      console.error(e);
    }
  });

  watchFile(WELCOME_CONFIG_PATH, { interval: 2000 }, () => {
    console.log("[config] welcome.json изменён — перезагрузка текста приветствия.");
    loadWelcomeMessageTemplate();
  });

  await client.login(BOT_TOKEN);
}

process.on("uncaughtException", (err) => {
  console.error("[process] Необработанное исключение:", err);

  const isHandshakeTimeout =
    err.message?.includes("handshake has timed out") ||
    err.message?.includes("WebSocket was closed before");

  if (isHandshakeTimeout && botClient) {
    console.warn("[process] Таймаут рукопожатия — пересоздаём соединение через 10 с...");
    botClient.destroy();
    setTimeout(() => {
      botClient
        ?.login(BOT_TOKEN)
        .catch((e: unknown) => console.error("[process] Ошибка повторного входа:", e));
    }, 10_000);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[process] Необработанный отказ промиса:", reason);
});

process.on("exit", (code) => {
  console.log(`[process] Процесс завершён с кодом ${code}`);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
