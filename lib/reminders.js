import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const REMINDERS_FILE = path.join(DATA_DIR, "reminders.json");

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDataDir();
  await writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

/** Lista completa de lembretes: [{ id, jid, note, remindAt, createdAt, done }] */
export async function loadReminders() {
  return readJson(REMINDERS_FILE, []);
}

export async function saveReminders(reminders) {
  await writeJson(REMINDERS_FILE, reminders);
}

export async function addReminder(jid, remindAt, note) {
  const reminders = await loadReminders();
  const reminder = {
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    jid,
    note: note || "",
    remindAt,
    createdAt: Date.now(),
    done: false,
  };
  reminders.push(reminder);
  await saveReminders(reminders);
  return reminder;
}

/** Retorna lembretes vencidos (remindAt <= agora) e ainda não marcados como feitos. */
export async function getDueReminders(now = Date.now()) {
  const reminders = await loadReminders();
  return reminders.filter((r) => !r.done && r.remindAt <= now);
}

/** Retorna lembretes futuros, ordenados por data — pra listar com /lembretes. */
export async function getPendingReminders() {
  const reminders = await loadReminders();
  return reminders.filter((r) => !r.done).sort((a, b) => a.remindAt - b.remindAt);
}

export async function markReminderDone(id) {
  const reminders = await loadReminders();
  const updated = reminders.map((r) => (r.id === id ? { ...r, done: true } : r));
  await saveReminders(updated);
}
