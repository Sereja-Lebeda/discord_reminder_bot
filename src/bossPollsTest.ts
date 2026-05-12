import { CronJob } from "cron";
import { Routes } from "discord.js";
import type { Client } from "discord.js";

const TEST_CHANNEL_ID = "1503666715924496456";

export function startBossPollTest(client: Client): void {
  new CronJob("36 12 * * *", () => { void runTestCycle(client); }, null, true, "Europe/Moscow");
  console.log("[boss-test] Тест зарегистрирован: 12:36 МСК ежедневно");
}

async function runTestCycle(client: Client): Promise<void> {
  const ch = await client.channels.fetch(TEST_CHANNEL_ID);
  if (!ch?.isSendable()) {
    console.error("[boss-test] Канал недоступен");
    return;
  }

  // 11:40 — создаём опрос
  const pollMsg = await ch.send({
    poll: {
      question: { text: "Тест: время рейда" },
      answers: [{ text: "Вариант А" }, { text: "Вариант Б" }],
      duration: 1,
      allowMultiselect: false,
    },
  });
  console.log(`[boss-test] Опрос создан: ${pollMsg.id}`);

  // T+55с — читаем voters пока опрос ещё активен
  setTimeout(async () => {
    try {
      const activeMsg = await ch.messages.fetch({ message: pollMsg.id, force: true });
      const answers = [...(activeMsg.poll?.answers.values() ?? [])];

      const answerData: Array<{ text: string; voterMentions: string[] }> = [];
      for (const answer of answers) {
        const voters = await answer.voters.fetch({ limit: 100 });
        answerData.push({
          text: answer.text ?? "?",
          voterMentions: [...voters.values()].map(u => `<@${u.id}>`),
        });
      }
      console.log("[boss-test] Данные о голосах получены");

      // T+60с — expire + delete + post
      setTimeout(async () => {
        try {
          await client.rest.post(Routes.expirePoll(TEST_CHANNEL_ID, pollMsg.id));
          console.log("[boss-test] Опрос закрыт принудительно");
        } catch (e) {
          console.warn("[boss-test] expirePoll:", e);
        }

        await pollMsg.delete().catch(e => console.error("[boss-test] Не удалось удалить poll-сообщение:", e));

        // Даём Discord ~1с создать PollResult-сообщение, затем удаляем его
        await new Promise(r => setTimeout(r, 1000));
        const recent = await ch.messages.fetch({ limit: 10 });
        const pollResultMsg = recent.find(m => m.type === 46 && m.reference?.messageId === pollMsg.id);
        if (pollResultMsg) {
          await pollResultMsg.delete().catch(e => console.error("[boss-test] Не удалось удалить PollResult-сообщение:", e));
        } else {
          console.warn("[boss-test] PollResult-сообщение не найдено");
        }

        const maxVotes = Math.max(0, ...answerData.map(a => a.voterMentions.length));

        if (maxVotes === 0) {
          const resultMsg = await ch.send({ content: "[Тест] Победитель: Никто не проголосовал" });
          setTimeout(async () => { await resultMsg.delete().catch(() => {}); }, 120_000);
        } else {
          const winners = answerData.filter(a => a.voterMentions.length === maxVotes);
          const resultLine = winners.map(w => `**${w.text}** — ${w.voterMentions.length} гол.`).join(" и ");

          // Voters-сообщение — не удаляется, висит постоянно
          await ch.send({
            content: `[Тест] Проголосовали:\n${winners.map(w => `**${w.text}**: ${w.voterMentions.join(", ")}`).join("\n")}`,
          });

          const resultMsg = await ch.send({ content: `[Тест] Победитель: ${resultLine}` });
          console.log(`[boss-test] Результат опубликован: ${resultMsg.id}`);

          setTimeout(async () => {
            await resultMsg.delete().catch(() => {});
            console.log("[boss-test] Результат удалён, список проголосовавших остаётся");
          }, 120_000);
        }
      }, 5_000);

    } catch (e) {
      console.error("[boss-test] Ошибка при чтении результатов:", e);
    }
  }, 55_000);
}
