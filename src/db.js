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

/**
 * Link a Telegram chat to a deployed governance contract, and record
 * which governance model it uses - the shared adapter registry in
 * src/governance/index.js needs this to know which contract shape it's
 * actually talking to. Defaults to "tokenWeighted" for any chat that
 * doesn't specify one, matching the model every chat used before this
 * field existed.
 */
export function registerChat(chatId, governanceAddress, model = "tokenWeighted") {
  const db = readDb();
  db[chatId] = { ...db[chatId], governanceAddress, model, registeredAt: Date.now() };
  writeDb(db);
}

/** Get the Governance address linked to a chat, or null if unregistered. */
export function getChatDAO(chatId) {
  const db = readDb();
  return db[chatId]?.governanceAddress ?? null;
}

/**
 * Get the governance model linked to a chat. Defaults to "tokenWeighted"
 * if a chat was registered before this field existed (or somehow has no
 * value set) - this was the only model the bot supported until now, so
 * that's the only correct default for pre-existing registrations.
 */
export function getChatModel(chatId) {
  const db = readDb();
  return db[chatId]?.model ?? "tokenWeighted";
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
