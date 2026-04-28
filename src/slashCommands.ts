import {
  ApplicationCommandOptionType,
  type ChatInputApplicationCommandData,
} from "discord.js";

/** Регистрация на сервере (GUILD_ID) — обновляется сразу после перезапуска */
export const guildSlashCommands: ChatInputApplicationCommandData[] = [
  {
    name: "ping",
    description: "Проверка, что бот онлайн",
  },
  {
    name: "clear_survey",
    description: "Удалить опросы бота в этом канале и снять отложенное удаление",
  },
  {
    name: "class",
    description: "Сменить основной класс (гильдия); лог обновится как при первом выборе",
    options: [
      {
        name: "class",
        description: "Класс",
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: "Танк", value: "tank" },
          { name: "Хиллер", value: "healer" },
          { name: "Дамаггер", value: "damager" },
        ],
      },
    ],
  },
];
