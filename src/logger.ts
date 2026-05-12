import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "bot.log");

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // already exists
}

function timestamp(): string {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function writeToFile(level: string, args: unknown[]): void {
  const line = `[${timestamp()}] [${level}] ${args.map(String).join(" ")}\n`;
  try {
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // ignore file write errors to not crash the bot
  }
}

const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
const _info = console.info.bind(console);

console.log = (...args: unknown[]) => {
  _log(`[${timestamp()}]`, ...args);
  writeToFile("INFO", args);
};

console.info = (...args: unknown[]) => {
  _info(`[${timestamp()}]`, ...args);
  writeToFile("INFO", args);
};

console.warn = (...args: unknown[]) => {
  _warn(`[${timestamp()}]`, ...args);
  writeToFile("WARN", args);
};

console.error = (...args: unknown[]) => {
  _error(`[${timestamp()}]`, ...args);
  writeToFile("ERROR", args);
};
