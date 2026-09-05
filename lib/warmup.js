import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const WARMUP_FILE = path.join(DATA_DIR, "warmup.json");

// Quantas mensagens de campanha o número pode mandar por dia, contando a
// partir do primeiro envio de campanha que ele já fez na vida. Depois que a
// lista acaba, o último valor vale pros dias seguintes (sem limite artificial).
// Configurável via WARMUP_SCHEDULE="10" no .env — um valor só (como o padrão
// abaixo) significa "sempre esse número por dia", sem rampa de aquecimento.
const DEFAULT_SCHEDULE = [10];

function loadSchedule() {
  const raw = process.env.WARMUP_SCHEDULE;
  if (!raw) return DEFAULT_SCHEDULE;
  const parsed = raw
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : DEFAULT_SCHEDULE;
}

const SCHEDULE = loadSchedule();
const WARMUP_ENABLED = process.env.WARMUP_ENABLED !== "false"; // ligado por padrão

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

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC, só precisa ser consistente)
}

async function loadState() {
  return readJson(WARMUP_FILE, { startedAt: null, dailyCounts: {} });
}

async function saveState(state) {
  await writeJson(WARMUP_FILE, state);
}

/** Quantas mensagens de campanha ainda cabem hoje, e o limite do dia. */
export async function getWarmupStatus() {
  if (!WARMUP_ENABLED) return { allowed: true, limit: Infinity, sentToday: 0, day: null };

  const state = await loadState();
  const today = todayKey();
  const sentToday = state.dailyCounts?.[today] || 0;

  if (!state.startedAt) {
    // Ainda não mandou nenhuma campanha na vida — hoje é o dia 1 do aquecimento.
    return { allowed: sentToday < SCHEDULE[0], limit: SCHEDULE[0], sentToday, day: 1 };
  }

  const dayNumber = Math.floor((Date.now() - state.startedAt) / (24 * 60 * 60 * 1000)) + 1;
  const limit = SCHEDULE[Math.min(dayNumber, SCHEDULE.length) - 1] ?? SCHEDULE[SCHEDULE.length - 1];

  return { allowed: sentToday < limit, limit, sentToday, day: dayNumber };
}

/** Registra que uma mensagem de campanha foi mandada agora (conta pro limite do dia). */
export async function recordCampaignSend() {
  const state = await loadState();
  if (!state.startedAt) state.startedAt = Date.now();

  const today = todayKey();
  state.dailyCounts = state.dailyCounts || {};
  state.dailyCounts[today] = (state.dailyCounts[today] || 0) + 1;

  // Mantém só os últimos 30 dias de histórico, pra não crescer pra sempre.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(state.dailyCounts)) {
    if (new Date(key).getTime() < cutoff) delete state.dailyCounts[key];
  }

  await saveState(state);
}
