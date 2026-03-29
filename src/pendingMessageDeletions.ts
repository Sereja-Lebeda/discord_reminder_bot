import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "discord.js";

const DATA_DIR = join(process.cwd(), "data");
const FILE_PATH = join(DATA_DIR, "pending-deletions.json");

export interface PendingDeletionRecord {
  id: string;
  channelId: string;
  messageId: string;
  /** Unix time (ms), когда нужно удалить сообщение */
  deleteAt: number;
}

interface FileShape {
  records: PendingDeletionRecord[];
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function makeId(channelId: string, messageId: string): string {
  return `${channelId}_${messageId}`;
}

function loadRecords(): PendingDeletionRecord[] {
  ensureDataDir();
  if (!existsSync(FILE_PATH)) return [];
  try {
    const raw = readFileSync(FILE_PATH, "utf-8");
    const data = JSON.parse(raw) as FileShape;
    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return [];
  }
}

function saveRecords(records: PendingDeletionRecord[]): void {
  ensureDataDir();
  writeFileSync(FILE_PATH, JSON.stringify({ records }, null, 2), "utf-8");
}

function removeRecordById(id: string): void {
  const next = loadRecords().filter((r) => r.id !== id);
  saveRecords(next);
}

/**
 * Снять отложенное удаление (таймер + запись в `pending-deletions.json`),
 * например если сообщение уже удалили вручную через /clear_survey.
 */
export function cancelPendingDeletion(
  channelId: string,
  messageId: string
): void {
  const id = makeId(channelId, messageId);
  const t = activeTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    activeTimers.delete(id);
  }
  removeRecordById(id);
}

const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Запланировать удаление сообщения по времени. Запись сохраняется на диск;
 * после перезапуска {@link restorePendingDeletions} восстановит таймеры.
 */
export function scheduleMessageDeletion(
  client: Client,
  channelId: string,
  messageId: string,
  deleteAtMs: number
): void {
  const id = makeId(channelId, messageId);
  const records = loadRecords();
  if (!records.some((r) => r.id === id)) {
    records.push({ id, channelId, messageId, deleteAt: deleteAtMs });
    saveRecords(records);
  }
  armTimer(client, id, channelId, messageId, deleteAtMs);
}

function armTimer(
  client: Client,
  id: string,
  channelId: string,
  messageId: string,
  deleteAtMs: number
): void {
  if (activeTimers.has(id)) return;
  const delay = Math.max(0, deleteAtMs - Date.now());
  const t = setTimeout(() => {
    activeTimers.delete(id);
    void runDelete(client, { id, channelId, messageId, deleteAt: deleteAtMs });
  }, delay);
  activeTimers.set(id, t);
}

async function runDelete(
  client: Client,
  record: PendingDeletionRecord
): Promise<void> {
  try {
    const ch = await client.channels.fetch(record.channelId);
    if (!ch?.isTextBased()) {
      console.warn(
        `[pending-delete] Канал ${record.channelId} недоступен для удаления сообщения.`
      );
      return;
    }
    await ch.messages.delete(record.messageId);
  } catch (e: unknown) {
    const code =
      e && typeof e === "object" && "code" in e ? Number((e as { code: unknown }).code) : NaN;
    if (code === 10008 || code === 10003) {
      // Unknown Message / Unknown Channel — уже удалено или нет доступа
    } else {
      console.error("[pending-delete] Ошибка удаления:", e);
    }
  } finally {
    removeRecordById(record.id);
  }
}

/**
 * Вызвать после `ClientReady`: восстановить таймеры и обработать просроченные удаления.
 */
export function restorePendingDeletions(client: Client): void {
  const records = loadRecords();
  const now = Date.now();
  for (const r of records) {
    if (r.deleteAt <= now) {
      void runDelete(client, r);
    } else {
      armTimer(client, r.id, r.channelId, r.messageId, r.deleteAt);
    }
  }
  if (records.length > 0) {
    console.log(
      `[pending-delete] Загружено отложенных удалений: ${records.length}`
    );
  }
}
