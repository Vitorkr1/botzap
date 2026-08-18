import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const INDEX_FILE = path.join(DATA_DIR, "message-index.json");

const KEYWORDS = ["site", "sistema"];

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function loadMessageIndex() {
  try {
    const raw = await readFile(INDEX_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveMessageIndex(index) {
  await ensureDataDir();
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

/** Extrai o texto simples de uma mensagem do Baileys, ou string vazia se não houver. */
export function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ""
  );
}

/**
 * Atualiza o índice em memória com uma mensagem (histórica ou em tempo real).
 * Marca quando você (fromMe) menciona "site" ou "sistema" pra alguém, e
 * sempre guarda quem mandou a última mensagem daquela conversa.
 */
export function indexMessage(index, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;

  const text = extractText(msg);
  if (!text) return;

  const timestamp = Number(msg.messageTimestamp || 0);
  const entry = index[jid] || {
    lastFromMe: false,
    lastText: "",
    lastTimestamp: 0,
    mentionedKeyword: false,
    keywordText: "",
    followedUpAt: null,
  };

  // Só atualiza "última mensagem" se essa for mais recente que a que já temos
  if (timestamp >= entry.lastTimestamp) {
    entry.lastFromMe = Boolean(msg.key.fromMe);
    entry.lastText = text;
    entry.lastTimestamp = timestamp;
  }

  if (msg.key.fromMe) {
    const lower = text.toLowerCase();
    const matched = KEYWORDS.find((kw) => lower.includes(kw));
    if (matched) {
      entry.mentionedKeyword = true;
      entry.keywordText = text;
    }
  }

  index[jid] = entry;
}

/**
 * Retorna os candidatos a follow-up: conversas onde você mencionou site/sistema,
 * a última mensagem foi sua (a pessoa não respondeu depois), e o bot NUNCA
 * mandou follow-up pra esse número antes (não repete, nem depois de um tempo).
 */
export function findFollowupCandidates(index) {
  return Object.entries(index)
    .filter(([, entry]) => {
      if (!entry.mentionedKeyword || !entry.lastFromMe) return false;
      if (entry.followedUpAt) return false; // já recebeu follow-up uma vez — nunca de novo
      return true;
    })
    .map(([jid, entry]) => ({ jid, ...entry }));
}
