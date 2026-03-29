import { readFileSync, watchFile } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlagsBitField,
} from "discord.js";
import dotenv from "dotenv";
import {
  handleClearSurvey,
  handleGuildBosses,
  handlePing,
} from "./interactionHandlers.js";
import { restorePendingDeletions } from "./pendingMessageDeletions.js";
import { guildSlashCommands } from "./slashCommands.js";

dotenv.config();

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

function loadRemindersConfig(): RemindersConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as RemindersConfig;
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

  const channelId = process.env.CHANNEL_ID;
  if (!channelId) {
    console.error("В .env не задан CHANNEL_ID.");
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
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) {
    console.error("В .env не задан BOT_TOKEN.");
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Бот запущен: ${c.user.tag}`);
    restorePendingDeletions(client);
    startCronFromConfig(client);
    await registerGuildSlashCommands(client);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "ping") {
        await handlePing(interaction);
      } else if (interaction.commandName === "guild_bosses") {
        await handleGuildBosses(interaction);
      } else if (interaction.commandName === "clear_survey") {
        await handleClearSurvey(interaction);
      }
    } catch (err) {
      console.error("[interaction]", err);
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

  await client.login(token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
