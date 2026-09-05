import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const QUEUE_FILE = path.join(DATA_DIR, "campaign-queue.json");
const SENT_FILE = path.join(DATA_DIR, "campaign-sent.json");

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

/** Fila de números pendentes de receber a mensagem de prospecção. */
export async function loadCampaignQueue() {
  return readJson(QUEUE_FILE, []);
}

export async function saveCampaignQueue(queue) {
  await writeJson(QUEUE_FILE, queue);
}

/**
 * Números que já receberam mensagem de campanha alguma vez — nunca repete.
 * Guarda também nicho e data do envio, usados pelo /relatorio.
 * Retorna um Map<jid, { niche, sentAt }> (registros antigos, salvos como
 * lista simples de strings, viram { niche: "desconhecido", sentAt: null }).
 */
export async function loadCampaignSent() {
  const raw = await readJson(SENT_FILE, []);
  const map = new Map();
  for (const item of raw) {
    if (typeof item === "string") {
      map.set(item, { niche: "desconhecido", sentAt: null });
    } else if (item?.jid) {
      map.set(item.jid, { niche: item.niche || "desconhecido", sentAt: item.sentAt || null });
    }
  }
  return map;
}

export async function saveCampaignSent(sentMap) {
  const records = Array.from(sentMap.entries()).map(([jid, info]) => ({
    jid,
    niche: info?.niche || "desconhecido",
    sentAt: info?.sentAt || null,
  }));
  await writeJson(SENT_FILE, records);
}
