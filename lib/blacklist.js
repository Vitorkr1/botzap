import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const BLACKLIST_FILE = path.join(DATA_DIR, "blacklist.json");

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

/** Números que pediram pra não receber mais mensagens — nunca mais recebem campanha, followup ou resposta automática. */
export async function loadBlacklist() {
  const list = await readJson(BLACKLIST_FILE, []);
  return new Set(list);
}

export async function addToBlacklist(jid) {
  const current = await loadBlacklist();
  current.add(jid);
  await writeJson(BLACKLIST_FILE, Array.from(current));
  return current;
}

// Frases comuns de "pare de mandar mensagem" em português — heurística
// simples, sem acento (o texto é normalizado antes de comparar).
const OPT_OUT_PHRASES = [
  "nao tenho interesse",
  "sem interesse",
  "nao quero",
  "pare de mandar",
  "para de mandar",
  "pare de enviar",
  "para de enviar",
  "remove meu numero",
  "tira meu numero",
  "descadastr",
  "nao me add",
  "nao me adicion",
  "nao mandem mais",
  "nao manda mais",
  "unsubscribe",
];

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // remove acentos
}

/** Detecta se o texto de uma mensagem recebida indica pedido de opt-out. */
export function isOptOutMessage(text) {
  if (!text) return false;
  const normalized = normalize(text);
  return OPT_OUT_PHRASES.some((phrase) => normalized.includes(phrase));
}
