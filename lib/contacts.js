import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

// Em produção (Render), monte um Persistent Disk e aponte DATA_DIR pra ele,
// senão esses arquivos somem a cada deploy/restart.
const DATA_DIR = process.env.DATA_DIR || "./data";
const CONTACTS_FILE = path.join(DATA_DIR, "handed-off-contacts.json");
const HISTORY_FILE = path.join(DATA_DIR, "conversations.json");
const SAVED_CONTACTS_FILE = path.join(DATA_DIR, "saved-contacts-cache.json");
const STATE_FILE = path.join(DATA_DIR, "bot-state.json");
const MANUAL_SAVED_FILE = path.join(DATA_DIR, "manual-saved-contacts.json");

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

/** Retorna true se este contato já foi "repassado" para você (não deve mais receber respostas automáticas). */
export async function isHandedOff(jid) {
  const handedOff = await readJson(CONTACTS_FILE, []);
  return handedOff.includes(jid);
}

/** Marca que a conversa foi repassada para você — o bot para de responder automaticamente esse número. */
export async function markHandedOff(jid) {
  const handedOff = await readJson(CONTACTS_FILE, []);
  if (!handedOff.includes(jid)) {
    handedOff.push(jid);
    await writeJson(CONTACTS_FILE, handedOff);
  }
}

/** Remove o handoff de um contato — o bot volta a responder esse número automaticamente. */
export async function clearHandoff(jid) {
  const handedOff = await readJson(CONTACTS_FILE, []);
  const updated = handedOff.filter((id) => id !== jid);
  await writeJson(CONTACTS_FILE, updated);
}

/** Histórico curto por contato, pra dar contexto pra IA (últimas N trocas). */
export async function getHistory(jid) {
  const all = await readJson(HISTORY_FILE, {});
  return all[jid] || [];
}

export async function appendHistory(jid, role, content) {
  const all = await readJson(HISTORY_FILE, {});
  const conv = all[jid] || [];
  conv.push({ role, content });
  // mantém só as últimas 20 mensagens por contato
  all[jid] = conv.slice(-20);
  await writeJson(HISTORY_FILE, all);
}

/**
 * Cache em disco da lista de contatos já sincronizados da sua agenda.
 * Sobrevive a "sono/despertar" do plano Free do Render (não sobrevive a um
 * deploy novo, que sempre limpa o disco). Evita depender só da memória, que
 * some sempre que o processo reinicia.
 */
export async function loadSavedContactsCache() {
  const list = await readJson(SAVED_CONTACTS_FILE, []);
  return new Set(list);
}

export async function saveSavedContactsCache(jidSet) {
  await writeJson(SAVED_CONTACTS_FILE, Array.from(jidSet));
}

/** Retorna true se o bot está pausado (não deve responder ninguém automaticamente). */
export async function isBotPaused() {
  const state = await readJson(STATE_FILE, { paused: false });
  return Boolean(state.paused);
}

export async function setBotPaused(paused) {
  const state = await readJson(STATE_FILE, {});
  state.paused = paused;
  await writeJson(STATE_FILE, state);
}

/** Retorna quando (timestamp) o /followup mandou mensagens de verdade pela última vez, ou null. */
export async function getLastFollowupRunAt() {
  const state = await readJson(STATE_FILE, {});
  return state.lastFollowupRunAt || null;
}

export async function setLastFollowupRunAt(timestamp) {
  const state = await readJson(STATE_FILE, {});
  state.lastFollowupRunAt = timestamp;
  await writeJson(STATE_FILE, state);
}

/** Data (YYYY-MM-DD) do último resumo diário automático já enviado — evita mandar duas vezes no mesmo dia. */
export async function getLastDailySummaryDate() {
  const state = await readJson(STATE_FILE, {});
  return state.lastDailySummaryDate || null;
}

export async function setLastDailySummaryDate(dateKey) {
  const state = await readJson(STATE_FILE, {});
  state.lastDailySummaryDate = dateKey;
  await writeJson(STATE_FILE, state);
}

/**
 * Controla se a campanha automática de estreia (lista fixa de contatos que
 * roda sozinha na primeira conexão, sem precisar de /campanha manual) já
 * foi carregada alguma vez. Uma vez true, nunca mais roda de novo sozinha
 * — mesmo que o bot reconecte dezenas de vezes — pra não ficar reprocessando
 * a mesma lista fixa a cada reinício.
 */
export async function isAutoCampaignSeeded() {
  const state = await readJson(STATE_FILE, {});
  return Boolean(state.autoCampaignSeeded);
}

export async function setAutoCampaignSeeded(seeded) {
  const state = await readJson(STATE_FILE, {});
  state.autoCampaignSeeded = seeded;
  await writeJson(STATE_FILE, state);
}

/**
 * Lista MANUAL de contatos salvos, controlada por você via comando
 * (/salvar). Existe porque a sincronização automática da agenda do
 * WhatsApp pode falhar silenciosamente em alguns números/contas — essa
 * lista funciona como garantia, independente disso.
 */
export async function loadManualSavedContacts() {
  const list = await readJson(MANUAL_SAVED_FILE, []);
  return new Set(list);
}

export async function addManualSavedContacts(jids) {
  const current = await loadManualSavedContacts();
  for (const jid of jids) current.add(jid);
  await writeJson(MANUAL_SAVED_FILE, Array.from(current));
  return current;
}
