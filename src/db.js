import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "chats.json");

function ensureDbFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2));
}

function readDb() {
  ensureDbFile();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(data) {
  ensureDbFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

/** Link a Telegram chat to a deployed Governance contract address. */
export function registerChat(chatId, governanceAddress) {
  const db = readDb();
  db[chatId] = { ...db[chatId], governanceAddress, registeredAt: Date.now() };
  writeDb(db);
}

/** Get the Governance address linked to a chat, or null if unregistered. */
export function getChatDAO(chatId) {
  const db = readDb();
  return db[chatId]?.governanceAddress ?? null;
}

/** Link a chat's WelcomeDistributor address (optional, separate from Governance). */
export function registerDistributor(chatId, distributorAddress) {
  const db = readDb();
  db[chatId] = { ...db[chatId], distributorAddress };
  writeDb(db);
}

/** Get the WelcomeDistributor address linked to a chat, or null if unset. */
export function getChatDistributor(chatId) {
  const db = readDb();
  return db[chatId]?.distributorAddress ?? null;
}

export function unregisterChat(chatId) {
  const db = readDb();
  delete db[chatId];
  writeDb(db);
}
