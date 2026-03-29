import type { ChatInputApplicationCommandData } from "discord.js";

/** Регистрация на сервере (GUILD_ID) — обновляется сразу после перезапуска */
export const guildSlashCommands: ChatInputApplicationCommandData[] = [
  {
    name: "ping",
    description: "Проверка, что бот онлайн",
  },
  {
    name: "guild_bosses",
    description: "Создать два опроса о походе на боссов",
  },
  {
    name: "clear_survey",
    description: "Удалить опросы бота в этом канале и снять отложенное удаление",
  },
];
