import express from "express";
import qrcode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import pino from "pino";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { askAI, generateSuccessPost } from "./lib/ai.js";
import {
  isHandedOff,
  markHandedOff,
  clearHandoff,
  getHistory,
  appendHistory,
  loadSavedContactsCache,
  saveSavedContactsCache,
  isBotPaused,
  setBotPaused,
  getLastFollowupRunAt,
  setLastFollowupRunAt,
  loadManualSavedContacts,
  addManualSavedContacts,
  getLastDailySummaryDate,
  setLastDailySummaryDate,
  isAutoCampaignSeeded,
  setAutoCampaignSeeded,
} from "./lib/contacts.js";
import { loadMessageIndex, saveMessageIndex, extractText, indexMessage, findFollowupCandidates } from "./lib/messageIndex.js";
import { sendAlert } from "./lib/alerts.js";
import { loadCampaignQueue, saveCampaignQueue, loadCampaignSent, saveCampaignSent } from "./lib/campaign.js";
import { setStage, getStage, getPipelineSummary, stageLabel, loadPipeline, STAGES, getStaleClosedContacts, getClosedContacts, markAnniversarySent } from "./lib/pipeline.js";
import { addReminder, getDueReminders, getPendingReminders, markReminderDone } from "./lib/reminders.js";
import { loadBlacklist, addToBlacklist, isOptOutMessage } from "./lib/blacklist.js";
import { getWarmupStatus, recordCampaignSend } from "./lib/warmup.js";
import { isFrustrated } from "./lib/sentiment.js";
import { AUTO_CAMPAIGN_LIST } from "./lib/autoCampaignList.js";

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || "./auth"; // sessão do WhatsApp (persistir em disco!)
const RESPOND_TO_GROUPS = process.env.RESPOND_TO_GROUPS === "true"; // padrão: não responde em grupos

// Tempo de segurança após conectar em que o bot NÃO responde ninguém —
// dá tempo pra sincronização da sua agenda de contatos terminar, evitando
// responder gente que já está salva logo após reconectar. Padrão: 60s.
const CONTACTS_SYNC_GRACE_MS = Number(process.env.CONTACTS_SYNC_GRACE_MS || 60000);
let connectedAt = null;

// Horário comercial: se ativado, o bot só fica conectado dentro do horário
// definido — fora disso, desconecta de verdade (sem perder a sessão salva),
// reduzindo o tempo que a conta fica "sempre online". Desativado por padrão.
const BUSINESS_HOURS_ENABLED = process.env.BUSINESS_HOURS_ENABLED === "true";
const BUSINESS_HOURS_START = Number(process.env.BUSINESS_HOURS_START || 8);
const BUSINESS_HOURS_END = Number(process.env.BUSINESS_HOURS_END || 18);
const BUSINESS_HOURS_UTC_OFFSET = Number(process.env.BUSINESS_HOURS_UTC_OFFSET || -3); // Brasília (UTC-3)

/** Hora local (fuso configurado em BUSINESS_HOURS_UTC_OFFSET), com casas decimais. */
function getLocalHour() {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (((utcHour + BUSINESS_HOURS_UTC_OFFSET) % 24) + 24) % 24;
}

function isWithinBusinessHours() {
  if (!BUSINESS_HOURS_ENABLED) return true;
  const localHour = getLocalHour();
  return localHour >= BUSINESS_HOURS_START && localHour < BUSINESS_HOURS_END;
}

/**
 * Estado "amigável" da conexão pra exibir no /status e no /dashboard —
 * diferencia "conectado mas ainda sincronizando" de "conectado e
 * respondendo de verdade", e explica o motivo de estar fora do ar.
 */
function getConnectionStatusDisplay() {
  if (connectionStatus === "iniciando") {
    return { label: "Iniciando…", color: "#9ca3af", detail: "Bot subindo, aguarde." };
  }
  if (connectionStatus === "fora_do_expediente") {
    return {
      label: "Fora do horário comercial",
      color: "#f59e0b",
      detail: `Desconectado de propósito (expediente: ${BUSINESS_HOURS_START}h–${BUSINESS_HOURS_END}h). Reconecta sozinho no horário.`,
    };
  }
  if (connectionStatus === "desconectado") {
    return {
      label: "Desconectado",
      color: "#dc2626",
      detail: isConnecting ? "Tentando reconectar agora…" : "Aguardando o watchdog tentar reconectar (a cada 2 min).",
    };
  }
  if (connectionStatus === "conectado") {
    const stillSyncing = !connectedAt || Date.now() - connectedAt < CONTACTS_SYNC_GRACE_MS;
    if (stillSyncing) {
      return {
        label: "Conectado — sincronizando agenda",
        color: "#eab308",
        detail: "Ainda não responde mensagens automaticamente até terminar de sincronizar.",
      };
    }
    return { label: "Conectado e funcionando", color: "#16a34a", detail: "Respondendo mensagens normalmente." };
  }
  return { label: connectionStatus, color: "#6b7280", detail: "" };
}

// Resumo diário automático: manda sozinho todo dia, no horário configurado
// (padrão 8h, fuso de BUSINESS_HOURS_UTC_OFFSET), um resumo do que
// aconteceu — sem precisar pedir /relatorio toda hora.
const DAILY_SUMMARY_ENABLED = process.env.DAILY_SUMMARY_ENABLED !== "false"; // ligado por padrão
const DAILY_SUMMARY_HOUR = Number(process.env.DAILY_SUMMARY_HOUR || 8);

let latestQr = null; // guardamos o QR mais recente pra exibir via /qr
let connectionStatus = "iniciando";
let isConnecting = false; // evita duas conexões simultâneas tentando reconectar ao mesmo tempo
let connectingSince = null; // timestamp de quando isConnecting virou true — usado pra detectar trava
const CONNECTING_STUCK_TIMEOUT_MS = 3 * 60 * 1000; // se ficar "conectando" mais que isso, força reset
let lastAlertAt = 0; // controla intervalo entre alertas de desconexão, pra não spammar
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MINUTES || 15) * 60 * 1000;
let botPaused = false; // controlado por /parar e /iniciar
let messageIndex = {}; // índice de conversas, usado pra achar quem não respondeu

// Configurações do follow-up automático (comando /followup)
const FOLLOWUP_MAX_PER_RUN = Number(process.env.FOLLOWUP_MAX_PER_RUN || 15); // segurança: limite por execução
const FOLLOWUP_TYPING_MIN_MS = Number(process.env.FOLLOWUP_TYPING_MIN_MS || 2000); // simula "digitando..." (mínimo)
const FOLLOWUP_TYPING_MAX_MS = Number(process.env.FOLLOWUP_TYPING_MAX_MS || 6000); // simula "digitando..." (máximo)
const FOLLOWUP_DELAY_MS = Number(process.env.FOLLOWUP_DELAY_MS || 8000); // intervalo entre envios
// Intervalo mínimo entre execuções que realmente mandam mensagem — limita
// a 1x por dia mesmo se você tentar rodar o comando várias vezes no mesmo dia.
const FOLLOWUP_RUN_COOLDOWN_HOURS = Number(process.env.FOLLOWUP_RUN_COOLDOWN_HOURS || 24);
const savedContactJids = new Set(); // números que estão salvos na sua agenda do celular (sincronização automática)
let manualSavedContactJids = new Set(); // números marcados manualmente via /salvar (garantia, independe de sincronização)

// Configurações da campanha de prospecção (comando /campanha)
const CAMPAIGN_DELAY_MIN_MS = Number(process.env.CAMPAIGN_DELAY_MIN_MS || 110 * 1000); // ~2 min (com uma pequena variação, ver comentário abaixo)
const CAMPAIGN_DELAY_MAX_MS = Number(process.env.CAMPAIGN_DELAY_MAX_MS || 130 * 1000); // ~2 min
const CAMPAIGN_TYPING_MIN_MS = Number(process.env.CAMPAIGN_TYPING_MIN_MS || 2000);
const CAMPAIGN_TYPING_MAX_MS = Number(process.env.CAMPAIGN_TYPING_MAX_MS || 6000);
let campaignQueue = []; // fila persistida: [{ jid, niche }]
let campaignBatchTotal = 0; // total de contatos do "lote" atual da campanha (pra calcular progresso: enviados/faltam)
let campaignSent = new Map(); // jid -> { niche, sentAt } — números que já receberam mensagem de campanha (nunca repete)
let campaignRunning = false; // trava contra duas filas rodando ao mesmo tempo
let campaignOwnerJid = null; // pra onde mandar o resumo final
let currentSock = null; // referência ao socket atual, usada pelo watchdog
const pendingDeliveryConfirms = new Map(); // messageId -> resolve(), usado por sendMessageWithConfirmation

let blacklistJids = new Set(); // números que pediram pra não receber mais mensagem (opt-out) — nunca mais contatados
const offlineAckedJids = new Set(); // controla o "vi sua mensagem" pra não repetir várias vezes na mesma conexão
// Se uma mensagem chegar com mais desse tempo de atraso (ex: foi mandada
// enquanto o bot estava desconectado fora do horário comercial), o bot manda
// um aviso rápido de "vi sua mensagem" antes da resposta de verdade da IA.
const OFFLINE_ACK_THRESHOLD_MS = Number(process.env.OFFLINE_ACK_THRESHOLD_MINUTES || 15) * 60 * 1000;

// Modo pânico anti-ban: além do aquecimento diário (limite por dia), essa é
// uma trava extra de curto prazo — se detectar volume alto de envio numa
// janela de 1h, pausa a campanha por precaução, mesmo que ainda esteja
// dentro do limite diário do aquecimento.
let campaignPanicPauseUntil = null; // timestamp até quando a campanha fica em pausa de segurança
const PANIC_MAX_SENDS_PER_HOUR = Number(process.env.PANIC_MAX_SENDS_PER_HOUR || 8);
const PANIC_COOLDOWN_HOURS = Number(process.env.PANIC_COOLDOWN_HOURS || 2);

// Aniversário de parceria: manda mensagem automática pro próprio cliente
// (não pra você) nesses marcos de dias desde que ele foi marcado "fechado".
const ANNIVERSARY_MILESTONES_DAYS = (process.env.ANNIVERSARY_MILESTONES_DAYS || "30,180,365")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// Lista manual extra de números que NUNCA devem receber resposta automática,
// além dos que a sincronização da agenda detectar. Útil como reforço, já que
// a sincronização automática pode demorar alguns segundos após conectar.
// Formato no .env: NEVER_AUTO_REPLY_NUMBERS=5581999999999,5581888888888
const manualExcludedJids = new Set(
  (process.env.NEVER_AUTO_REPLY_NUMBERS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => `${n}@s.whatsapp.net`)
);

const app = express();

app.get("/", (_req, res) => {
  res.send(`Status da conexão: ${connectionStatus}. Acesse /qr para escanear o QR code.`);
});

app.get("/qr", async (_req, res) => {
  if (!latestQr) {
    return res.send(
      connectionStatus === "conectado"
        ? "Já conectado — não há QR code pendente."
        : "Nenhum QR code disponível ainda. Atualize a página em alguns segundos."
    );
  }
  const dataUrl = await qrcode.toDataURL(latestQr);
  res.send(`<html><body style="text-align:center;font-family:sans-serif">
    <h2>Escaneie com o WhatsApp (Aparelhos conectados)</h2>
    <img src="${dataUrl}" />
  </body></html>`);
});

// Painel web simples: visão geral do funil e da campanha sem precisar
// mandar comando nenhum pelo WhatsApp. Só leitura, sem nenhuma ação.
app.get("/dashboard", async (_req, res) => {
  try {
    const { counts, negociando, total } = await getPipelineSummary();

    const byNiche = {};
    for (const [, info] of campaignSent) {
      const niche = info.niche || "desconhecido";
      byNiche[niche] = (byNiche[niche] || 0) + 1;
    }

    const warmup = await getWarmupStatus();
    const uptimeMin = connectedAt ? Math.floor((Date.now() - connectedAt) / 60000) : 0;
    const statusInfo = getConnectionStatusDisplay();

    // Progresso da campanha atual: quantos já foram (do lote em andamento),
    // quantos faltam, e % concluído.
    const campaignSentInBatch = campaignBatchTotal > 0 ? campaignBatchTotal - campaignQueue.length : 0;
    const campaignProgressPct =
      campaignBatchTotal > 0 ? Math.round((campaignSentInBatch / campaignBatchTotal) * 100) : 0;
    const campaignStateLabel = campaignRunning
      ? "Rodando agora"
      : botPaused
      ? "Pausada (bot em /parar)"
      : connectionStatus !== "conectado"
      ? "Aguardando conexão voltar"
      : campaignQueue.length > 0
      ? "Parada (sem worker ativo)"
      : "—";

    const stageBar = (stage) => {
      const value = counts[stage] || 0;
      const max = Math.max(1, ...STAGES.map((s) => counts[s] || 0));
      const pct = Math.round((value / max) * 100);
      return `
        <div class="stage-row">
          <span class="stage-label">${stageLabel(stage)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <span class="stage-count">${value}</span>
        </div>`;
    };

    const nicheRows = Object.entries(byNiche)
      .map(([niche, count]) => `<tr><td>${niche}</td><td>${count}</td></tr>`)
      .join("");

    const negociandoRows = negociando
      .slice(0, 15)
      .map((n) => `<li>+${n.jid.split("@")[0]}${n.niche ? ` (${n.niche})` : ""}</li>`)
      .join("");

    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Painel — Bot Cria Tech</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f5f7; margin: 0; padding: 24px; color: #1f2937; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #6b7280; margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card { background: white; border-radius: 12px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 0 0 12px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; color: white; font-size: 13px; font-weight: 600; }
  .stat { font-size: 28px; font-weight: 700; }
  .stage-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 13px; }
  .stage-label { flex: 0 0 190px; color: #374151; }
  .bar-track { flex: 1; background: #e5e7eb; border-radius: 6px; height: 10px; overflow: hidden; }
  .bar-fill { background: #4f46e5; height: 100%; }
  .stage-count { flex: 0 0 24px; text-align: right; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 4px 0; border-bottom: 1px solid #f0f0f0; }
  ul { margin: 0; padding-left: 18px; font-size: 13px; }
  li { margin-bottom: 4px; }
  .refresh { color: #9ca3af; font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
  <h1>🤖 Bot Cria Tech — Painel</h1>
  <p class="subtitle">Atualizado agora · <span class="badge" style="background:${statusInfo.color}">${statusInfo.label}</span></p>
  ${statusInfo.detail ? `<p class="subtitle" style="margin-top:-16px">${statusInfo.detail}</p>` : ""}

  <div class="grid">
    <div class="card">
      <h2>Status geral</h2>
      <p>Conectado há: <strong>${connectedAt && connectionStatus === "conectado" ? `${uptimeMin} min` : "—"}</strong></p>
      <p>Bot pausado: <strong>${botPaused ? "sim ⏸️" : "não ▶️"}</strong></p>
      <p>Blacklist: <strong>${blacklistJids.size}</strong> número(s)</p>
      <p>Aquecimento: dia <strong>${warmup.day ?? "—"}</strong>, ${warmup.sentToday}/${warmup.limit === Infinity ? "∞" : warmup.limit} hoje</p>
    </div>

    <div class="card">
      <h2>Progresso da campanha</h2>
      ${
        campaignBatchTotal > 0
          ? `
        <p><strong>${campaignSentInBatch}</strong> de <strong>${campaignBatchTotal}</strong> enviados — faltam <strong>${campaignQueue.length}</strong></p>
        <div class="bar-track" style="height:14px"><div class="bar-fill" style="width:${campaignProgressPct}%"></div></div>
        <p style="margin-top:8px;font-size:12px;color:#6b7280">${campaignStateLabel}</p>
      `
          : `<p>Nenhuma campanha em andamento.</p>`
      }
    </div>

    <div class="card">
      <h2>Funil de vendas (${total} total)</h2>
      ${STAGES.map(stageBar).join("")}
    </div>

    <div class="card">
      <h2>Campanha enviada por nicho</h2>
      <table>${nicheRows || "<tr><td>Nenhum envio ainda.</td></tr>"}</table>
    </div>

    <div class="card">
      <h2>Em negociação agora</h2>
      ${negociandoRows ? `<ul>${negociandoRows}</ul>` : "<p>Ninguém em negociação no momento.</p>"}
    </div>
  </div>

  <p class="refresh">Atualize a página pra ver dados mais recentes.</p>
</body>
</html>`);
  } catch (err) {
    console.error("Erro ao montar dashboard:", err);
    res.status(500).send("Erro ao montar o painel.");
  }
});

app.listen(PORT, () => console.log(`Servidor HTTP rodando na porta ${PORT}`));

let connectionGeneration = 0; // incrementa a cada tentativa de conexão — usado pra ignorar eventos de sockets antigos/substituídos

async function startBot() {
  if (isConnecting) {
    console.log("Já existe uma tentativa de conexão em andamento — ignorando chamada duplicada.");
    return;
  }

  if (!isWithinBusinessHours()) {
    connectionStatus = "fora_do_expediente";
    console.log(
      `Fora do horário comercial (${BUSINESS_HOURS_START}h-${BUSINESS_HOURS_END}h) — aguardando o próximo expediente pra conectar.`
    );
    return;
  }

  isConnecting = true;
  connectingSince = Date.now();
  const myGeneration = ++connectionGeneration; // esse socket só pode mexer no estado global se ainda for o mais recente

  try {
    const cached = await loadSavedContactsCache();
    for (const jid of cached) savedContactJids.add(jid);
    if (cached.size > 0) {
      console.log(`Carregados ${cached.size} contatos salvos do cache em disco.`);
    }

    botPaused = await isBotPaused();
    if (botPaused) {
      console.log("Bot iniciando em modo PAUSADO (última vez você mandou /parar). Mande /iniciar pra reativar.");
    }

    messageIndex = await loadMessageIndex();

    manualSavedContactJids = await loadManualSavedContacts();
    if (manualSavedContactJids.size > 0) {
      console.log(`Carregados ${manualSavedContactJids.size} contatos salvos manualmente (via /salvar).`);
    }

    blacklistJids = await loadBlacklist();
    if (blacklistJids.size > 0) {
      console.log(`Carregados ${blacklistJids.size} número(s) na blacklist (pediram pra não receber mais mensagem).`);
    }

    campaignQueue = await loadCampaignQueue();
    campaignSent = await loadCampaignSent();
    if (campaignQueue.length > 0) {
      console.log(`Fila de campanha carregada com ${campaignQueue.length} contato(s) pendente(s).`);
      // Restart no meio de uma campanha (deploy, crash): não sabemos qual
      // era o total original do lote, então usamos o que sobrou na fila
      // como aproximação — melhor que zerar o progresso e mostrar "nenhuma
      // campanha em andamento" com contatos pendentes de verdade.
      if (campaignBatchTotal === 0) campaignBatchTotal = campaignQueue.length;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      syncFullHistory: true, // necessário para sincronizar toda a agenda de contatos
      markOnlineOnConnect: false, // evita ficar "sempre online", que suprime notificações no celular
    });

    sock.ev.on("creds.update", saveCreds);

  // A agenda de contatos salvos vem dentro da sincronização de histórico,
  // que acontece pouco depois de conectar (pode levar alguns segundos).
  const trackContacts = (contacts, source) => {
    const total = (contacts || []).length;
    const withName = (contacts || []).filter((c) => c?.id && c.name).length;
    let added = false;
    for (const contact of contacts || []) {
      if (!contact?.id || !contact.name) continue;
      // Desde 2025 o WhatsApp passou a identificar alguns contatos por um ID
      // "oculto" (@lid) em vez do número de telefone normal (@s.whatsapp.net).
      // Quando isso acontece, o Baileys pode expor tanto o id "principal"
      // quanto o par phoneNumber/lid correspondente — guardamos os dois
      // formatos, senão uma mensagem que chega em @lid não bate com o
      // contato salvo (que foi sincronizado em @s.whatsapp.net, ou vice-versa)
      // e o bot acha, errado, que é gente estranha.
      const idsToSave = [contact.id, contact.lid, contact.phoneNumber].filter(Boolean);
      for (const id of idsToSave) {
        if (!savedContactJids.has(id)) {
          savedContactJids.add(id);
          added = true;
        }
      }
    }
    if (total > 0) {
      console.log(
        `[sync-contatos:${source}] recebidos ${total}, com nome ${withName}. Total acumulado com nome: ${savedContactJids.size}`
      );
    }
    if (added) {
      saveSavedContactsCache(savedContactJids).catch((err) =>
        console.error("Erro ao salvar cache de contatos:", err)
      );
    }
  };
  sock.ev.on("messaging-history.set", ({ contacts, messages }) => {
    trackContacts(contacts, "history");
    for (const msg of messages || []) {
      const msgJid = msg.key?.remoteJid;
      // Nunca indexa conversa com contato salvo (pessoal) — o /followup é só
      // pra leads externos, não pra família/amigos que você tenha salvo.
      if (msgJid && (savedContactJids.has(msgJid) || manualSavedContactJids.has(msgJid))) continue;
      indexMessage(messageIndex, msg);
    }
    if (messages?.length) {
      saveMessageIndex(messageIndex).catch((err) => console.error("Erro ao salvar índice de mensagens:", err));
    }
  });
  sock.ev.on("contacts.upsert", (contacts) => trackContacts(contacts, "upsert"));
  sock.ev.on("contacts.update", (contacts) => trackContacts(contacts, "update"));

  sock.ev.on("connection.update", (update) => {
    // Se essa conexão já foi substituída por uma mais nova (ex: watchdog ou
    // horário comercial já iniciaram outra tentativa), ignora qualquer
    // evento tardio dela — evita que um socket "fantasma" antigo sobrescreva
    // o estado global (connectionStatus, currentSock, isConnecting) por
    // cima de uma conexão nova que já está funcionando.
    if (myGeneration !== connectionGeneration) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      // Chegou até aqui: o socket conversou de verdade com o WhatsApp e está
      // só esperando você escanear — não é mais "travado conectando", é
      // uma espera normal (que pode legitimamente durar mais que 3 minutos).
      connectingSince = null;
      qrcodeTerminal.generate(qr, { small: true });
      console.log("QR code gerado. Escaneie pelo terminal acima ou acesse /qr no navegador.");
      sendAlert("📱 QR code precisa ser escaneado", "O bot do WhatsApp precisa que você escaneie um novo QR code. Acesse a URL do serviço + /qr.");
    }

    if (connection === "open") {
      connectionStatus = "conectado";
      latestQr = null;
      connectedAt = Date.now();
      isConnecting = false;
      connectingSince = null;
      currentSock = sock;
      offlineAckedJids.clear(); // nova conexão: libera o aviso de "vi sua mensagem" de novo se precisar
      console.log(
        `Conectado ao WhatsApp com sucesso! Aguardando ${CONTACTS_SYNC_GRACE_MS / 1000}s pra sincronizar a agenda antes de responder mensagens.`
      );

      // Marca explicitamente como "ausente" — sem isso, o socket conectado
      // faz o WhatsApp te mostrar como "online" pros contatos o tempo todo.
      sock.sendPresenceUpdate("unavailable").catch((err) =>
        console.error("Erro ao marcar presença como ausente:", err)
      );

      // Campanha automática de estreia: só roda UMA vez na vida (controlado
      // por flag persistida), depois de esperar a sincronização de contatos
      // terminar — assim ela já sabe quem está salvo antes de decidir quem
      // entra na fila.
      setTimeout(() => {
        maybeSeedAutoCampaign(sock).catch((err) => console.error("Erro ao carregar campanha automática de estreia:", err));
      }, CONTACTS_SYNC_GRACE_MS);
    }

    if (connection === "close") {
      isConnecting = false;
      connectingSince = null;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (!isWithinBusinessHours()) {
        connectionStatus = "fora_do_expediente";
        console.log("Conexão fechada — fora do horário comercial, não vai reconectar agora.");
      } else {
        connectionStatus = "desconectado";
        console.log("Conexão fechada.", shouldReconnect ? "Reconectando..." : "Sessão encerrada (logout).");
        if (shouldReconnect) {
          // Pequeno atraso (com variação) antes de tentar de novo — evita
          // bater no WhatsApp em loop muito rápido quando a conexão está
          // instável, o que pode piorar ainda mais a instabilidade.
          const retryDelay = randomBetween(3000, 8000);
          setTimeout(() => {
            startBot().catch((err) => console.error("Erro ao tentar reconectar:", err));
          }, retryDelay);
        }
      }
    }
  });

  // Confirma entrega de verdade: quando o WhatsApp confirma que uma mensagem
  // chegou ao servidor/destinatário, resolve a promessa pendente (se houver)
  // pra quem estiver esperando confirmação (ex: campanha, follow-up).
  sock.ev.on("messages.update", (updates) => {
    if (myGeneration !== connectionGeneration) return; // ignora eventos de socket antigo/substituído
    for (const u of updates || []) {
      const id = u.key?.id;
      const status = u.update?.status;
      if (id && status >= 2 && pendingDeliveryConfirms.has(id)) {
        pendingDeliveryConfirms.get(id)();
        pendingDeliveryConfirms.delete(id);
      }
    }
  });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (myGeneration !== connectionGeneration) return; // ignora eventos de socket antigo/substituído
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          await handleMessage(sock, msg);
        } catch (err) {
          console.error("Erro processando mensagem:", err);
        }
      }
    });

    // Chegou até aqui sem lançar erro: a configuração síncrona (ler sessão,
    // criar o socket, registrar os listeners) deu certo. A conexão de fato
    // (open/close/qr) ainda está em andamento — quem libera "connectingSince"
    // a partir daqui são os handlers de connection.update acima, não aqui.
  } catch (err) {
    // Qualquer erro aqui (ex: falha ao ler sessão salva, erro ao criar o
    // socket) travava "isConnecting" pra sempre, impedindo qualquer nova
    // tentativa de reconexão (watchdog e horário comercial ficavam de mãos
    // atadas). Agora resetamos o estado pra liberar a próxima tentativa.
    console.error("Erro ao iniciar conexão com o WhatsApp:", err);
    isConnecting = false;
    connectingSince = null;
    connectionStatus = "desconectado";
  }
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;

  // Indexa toda conversa 1:1 (não-grupo), independente do resto da lógica,
  // pra alimentar o comando /followup — mas NUNCA contato salvo (pessoal).
  // Isso é o que evita o bot mandar follow-up pra família/amigos por engano.
  const isSavedForIndex = savedContactJids.has(jid) || manualSavedContactJids.has(jid);
  if (!isSavedForIndex) {
    indexMessage(messageIndex, msg);
    saveMessageIndex(messageIndex).catch((err) => console.error("Erro ao salvar índice de mensagens:", err));
  }

  const text = extractText(msg);

  // Comando de reset: mande "/reset" você mesmo (do seu celular) dentro da
  // conversa com o contato de teste, e o bot volta a responder esse número
  // automaticamente, como se nunca tivesse sido repassado pra você.
  if (msg.key.fromMe && text.trim().toLowerCase() === "/reset") {
    await clearHandoff(jid);
    await sock.sendMessage(jid, { text: "✅ Reset feito — o bot volta a responder este número automaticamente." });
    return;
  }

  // Interruptor geral: mande "/parar" pra você mesmo (em qualquer conversa)
  // e o bot para de responder TODO MUNDO automaticamente. Mande "/iniciar"
  // pra ligar de novo. Funciona em qualquer chat, inclusive na sua própria
  // conversa "Você".
  const command = text.trim().toLowerCase();
  if (msg.key.fromMe && command === "/parar") {
    botPaused = true;
    await setBotPaused(true);
    await sock.sendMessage(jid, { text: "⏸️ Bot pausado — não vou mais responder ninguém automaticamente até você mandar /iniciar." });
    return;
  }
  if (msg.key.fromMe && command === "/iniciar") {
    botPaused = false;
    await setBotPaused(false);
    await sock.sendMessage(jid, { text: "▶️ Bot reativado — voltando a responder automaticamente." });
    return;
  }

  // Busca clientes que você mencionou "site" ou "sistema" e não responderam
  // depois. Mande "/followup" ou "procurar clientes" pra você mesmo.
  if (msg.key.fromMe && (command === "/followup" || command.includes("procurar cliente"))) {
    await runFollowup(sock, jid);
    return;
  }

  // Campanha de prospecção fria: mande "/campanha" na primeira linha, e nas
  // linhas seguintes "número nicho" (nicho: sistema, barbearia, oficina,
  // site ou mídia). Manda mensagem pra número que nunca falou com você,
  // sem precisar estar salvo, espaçado de 5 a 10 min entre cada envio.
  if (msg.key.fromMe && command.startsWith("/campanha")) {
    await handleCampaignCommand(sock, jid, text);
    return;
  }

  // Marca manualmente números como "contato salvo" — o bot nunca mais
  // responde automaticamente eles. Use quando a sincronização automática da
  // agenda não estiver confiável. Formato: "/salvar" na primeira linha, um
  // número por linha nas seguintes (aceita com ou sem formatação).
  if (msg.key.fromMe && command.startsWith("/salvar")) {
    await handleSalvarCommand(sock, jid, text);
    return;
  }

  // Marca um contato como "fechado" (venda concluída) ou "perdido" no funil.
  // Formato: "/fechado 5581999999999" ou "/perdido 5581999999999"
  if (msg.key.fromMe && command.startsWith("/fechado")) {
    await handleFechadoCommand(sock, jid, text);
    return;
  }
  if (msg.key.fromMe && command.startsWith("/perdido")) {
    await handlePerdidoCommand(sock, jid, text);
    return;
  }

  // Funil de vendas: quantos contatos em cada estágio, e quem está em
  // negociação agora (o que precisa da sua atenção).
  if (msg.key.fromMe && command === "/pipeline") {
    await handlePipelineCommand(sock, jid);
    return;
  }

  // Relatório da campanha: enviados por nicho, taxa de resposta, fila pendente.
  if (msg.key.fromMe && command === "/relatorio") {
    await handleRelatorioCommand(sock, jid);
    return;
  }

  // Status geral do bot: conexão, fila, pausado ou não, funil resumido.
  if (msg.key.fromMe && command === "/status") {
    await handleStatusCommand(sock, jid);
    return;
  }

  // Lembrete manual: "/lembrar 5581999999999 3 Perguntar se decidiu" —
  // manda um aviso pra você mesmo daqui a X dias. "/lembretes" lista os
  // pendentes.
  if (msg.key.fromMe && command.startsWith("/lembretes")) {
    await handleLembretesCommand(sock, jid);
    return;
  }
  if (msg.key.fromMe && command.startsWith("/lembrar")) {
    await handleLembrarCommand(sock, jid, text);
    return;
  }

  // Reengajamento: lista clientes "fechados" há muito tempo, bons candidatos
  // pra pedir indicação ou oferecer renovação/upgrade.
  if (msg.key.fromMe && command === "/reengajar") {
    await handleReengajarCommand(sock, jid);
    return;
  }

  if (msg.key.fromMe) return; // ignora as demais mensagens que você mesmo mandou
  if (!msg.message) return;

  if (jid.endsWith("@g.us") && !RESPOND_TO_GROUPS) return; // ignora grupos por padrão

  if (!text) return; // ignora áudios, figurinhas, etc. (pode expandir depois se quiser)

  if (botPaused) return; // bot pausado via /parar — não responde ninguém

  const stillSyncing = !connectedAt || Date.now() - connectedAt < CONTACTS_SYNC_GRACE_MS;
  if (stillSyncing) {
    console.log(`Ignorando mensagem de ${jid} — ainda dentro do período de sincronização da agenda.`);
    return;
  }

  // Verifica também o identificador "alternativo" da mensagem (remoteJidAlt):
  // quando o WhatsApp entrega em formato @lid, o Baileys pode informar junto
  // o @s.whatsapp.net correspondente (ou vice-versa) nesse campo — checando
  // os dois evitamos responder contato salvo que chegou num formato diferente
  // do que foi sincronizado na agenda.
  const altJid = msg.key.remoteJidAlt;
  const isKnownContact = (id) =>
    !!id && (savedContactJids.has(id) || manualExcludedJids.has(id) || manualSavedContactJids.has(id));
  if (isKnownContact(jid) || isKnownContact(altJid)) return; // já é seu contato — você mesmo conversa

  const handedOff = await isHandedOff(jid);
  if (handedOff) return; // já foi repassado pra você — bot fica quieto

  // Já pediu pra não receber mais mensagem antes — fica quieto pra sempre.
  if (blacklistJids.has(jid)) return;

  // Detecta sinais de frustração/irritação (ex: CAIXA ALTA, "pare de mandar",
  // "!!!??"). Nesse caso pula a IA de vez — melhor chamar você direto do que
  // arriscar uma resposta genérica numa situação já desgastada.
  if (isFrustrated(text)) {
    await markHandedOff(jid); // bot para de responder esse número
    await notifyOwnerFrustration(sock, jid, text);
    return;
  }

  // Detecta pedido de opt-out ("não tenho interesse", "pare de mandar"...) e
  // marca a blacklist na hora, sem gastar chamada de IA com isso.
  if (isOptOutMessage(text)) {
    blacklistJids = await addToBlacklist(jid);
    await setStage(jid, "perdido", { note: "opt-out" });
    await sock.sendMessage(jid, {
      text: "Entendido! 🙏 Você não vai mais receber mensagens da gente. Se mudar de ideia, é só chamar.",
    });
    return;
  }

  // Se a mensagem demorou muito pra ser processada (ex: o bot ficou
  // desconectado fora do horário comercial durante a noite), manda um aviso
  // rápido antes da resposta de verdade da IA, pra pessoa não achar que foi
  // ignorada.
  const msgAgeMs = Date.now() - Number(msg.messageTimestamp || 0) * 1000;
  if (msgAgeMs > OFFLINE_ACK_THRESHOLD_MS && !offlineAckedJids.has(jid)) {
    offlineAckedJids.add(jid);
    await sock.sendMessage(jid, { text: "Oi! 👋 Vi sua mensagem agora, só um instante que já te respondo!" });
  }

  await appendHistory(jid, "user", text);

  const history = await getHistory(jid);
  const { reply, interested, leadSummary } = await askAI(history);

  await appendHistory(jid, "assistant", reply);
  await sock.sendMessage(jid, { text: reply });

  // CRM: a pessoa respondeu, então avança o funil. Se ela nunca tinha
  // entrado no funil (contato orgânico, não veio de campanha), cria o
  // registro já direto em "respondeu".
  const currentStage = await getStage(jid);
  await setStage(jid, "respondeu", currentStage ? {} : { source: "organico" });

  if (interested) {
    await markHandedOff(jid); // a partir daqui, a conversa é só sua
    await setStage(jid, "negociando");
    await notifyOwner(sock, jid, leadSummary);
  }
}

/** Mensagens de prospecção por nicho — edite os textos aqui à vontade. */
// Mensagens de prospecção por nicho e idioma — edite os textos aqui à vontade.
// Idioma padrão é "pt"; pra mandar em outro idioma, acrescente "en" ou "es"
// depois do nicho na linha do /campanha (ex: "5581999999999 oficina en").
const CAMPAIGN_TEMPLATES = {
  pt: {
    barbearia:
      "Olá! 👋 Aqui é o assistente virtual (bot) da Cria Tech no WhatsApp. Desenvolvemos um sistema de gestão feito sob medida pra barbearias: agenda de horários, controle de clientes e faturamento, tudo num só lugar, por R$ 70,00/mês. Quer ver como funciona?",
    oficina:
      "Olá! 👋 Aqui é o assistente virtual (bot) da Cria Tech no WhatsApp. Temos um sistema completo pra oficinas mecânicas: ordens de serviço, histórico de clientes, controle de peças e faturamento, por R$ 250,00/mês. Posso te mostrar como funciona?",
    sistema:
      "Olá! 👋 Aqui é o assistente virtual (bot) da Cria Tech no WhatsApp — aliás, esse tipo de atendimento automático também é um dos serviços que desenvolvemos! Criamos sistemas sob medida pra pequenos negócios — como o FinPilot, nosso sistema de gestão financeira, por R$ 100,00/mês. Quer entender como pode ajudar sua empresa?",
    site:
      "Olá! 👋 Aqui é o assistente virtual (bot) da Cria Tech no WhatsApp — inclusive, esse tipo de bot de atendimento automático é um dos serviços que também desenvolvemos! Criamos sites profissionais pra empresas — a partir de R$ 600,00 (com domínio grátis) ou R$ 700,00 com domínio próprio .com.br. Quer ver alguns exemplos do nosso trabalho?",
    midia:
      "Olá! 👋 Aqui é o assistente virtual (bot) da Cria Tech no WhatsApp — e esse tipo de atendimento automático também é um serviço nosso! Cuidamos da presença da sua empresa nas redes sociais — conteúdo, identidade visual e estratégia pra atrair mais clientes. Quer entender como podemos ajudar?",
  },
  en: {
    barbearia:
      "Hi! 👋 This is Cria Tech's virtual assistant (bot) on WhatsApp. We build custom management software for barbershops: scheduling, client tracking and billing, all in one place, for $70/month (BRL). Want to see how it works?",
    oficina:
      "Hi! 👋 This is Cria Tech's virtual assistant (bot) on WhatsApp. We have a complete system for auto repair shops: work orders, client history, parts control and billing, for $250/month (BRL). Can I show you how it works?",
    sistema:
      "Hi! 👋 This is Cria Tech's virtual assistant (bot) on WhatsApp — by the way, this kind of automated customer service is one of the services we build too! We build custom software for small businesses — like FinPilot, our financial management system, for $100/month (BRL). Want to understand how it can help your business?",
    site:
      "Hi! 👋 This is Cria Tech's virtual assistant (bot) on WhatsApp — and this kind of automated attendant bot is one of our services too! We build professional websites for businesses — starting at $600 (BRL, free domain included) or $700 (BRL) with your own .com.br domain. Want to see some examples of our work?",
    midia:
      "Hi! 👋 This is Cria Tech's virtual assistant (bot) on WhatsApp — and this kind of automated service is something we build too! We handle your business's social media presence — content, visual identity and strategy to attract more customers. Want to understand how we can help?",
  },
  es: {
    barbearia:
      "¡Hola! 👋 Aquí está el asistente virtual (bot) de Cria Tech en WhatsApp. Desarrollamos un sistema de gestión hecho a medida para barberías: agenda de horarios, control de clientes y facturación, todo en un solo lugar, por R$ 70,00/mes. ¿Quieres ver cómo funciona?",
    oficina:
      "¡Hola! 👋 Aquí está el asistente virtual (bot) de Cria Tech en WhatsApp. Tenemos un sistema completo para talleres mecánicos: órdenes de servicio, historial de clientes, control de piezas y facturación, por R$ 250,00/mes. ¿Te lo muestro?",
    sistema:
      "¡Hola! 👋 Aquí está el asistente virtual (bot) de Cria Tech en WhatsApp — por cierto, este tipo de atención automática también es un servicio que ofrecemos. Desarrollamos sistemas a medida para pequeños negocios — como FinPilot, nuestro sistema de gestión financiera, por R$ 100,00/mes. ¿Quieres entender cómo puede ayudar a tu empresa?",
    site:
      "¡Hola! 👋 Aquí está el asistente virtual (bot) de Cria Tech en WhatsApp — y este tipo de bot de atención automática también es uno de nuestros servicios. Creamos sitios web profesionales para empresas — desde R$ 600,00 (con dominio gratis) o R$ 700,00 con dominio propio .com.br. ¿Quieres ver algunos ejemplos de nuestro trabajo?",
    midia:
      "¡Hola! 👋 Aquí está el asistente virtual (bot) de Cria Tech en WhatsApp — y este tipo de atención automática también es un servicio nuestro. Cuidamos la presencia de tu empresa en redes sociales — contenido, identidad visual y estrategia para atraer más clientes. ¿Quieres entender cómo podemos ayudar?",
  },
};

function normalizeNiche(rawText) {
  const lower = rawText.toLowerCase();
  if (lower.includes("barbearia")) return "barbearia";
  if (lower.includes("oficina")) return "oficina";
  if (lower.includes("site")) return "site";
  if (lower.includes("mídia") || lower.includes("midia") || lower.includes("mídias") || lower.includes("social"))
    return "midia";
  if (lower.includes("sistema")) return "sistema";
  return "sistema"; // padrão se não identificar
}

/** Detecta o idioma pedido na linha do /campanha (en/inglês, es/espanhol, ou pt por padrão). */
function normalizeLanguage(rawText) {
  const lower = rawText.toLowerCase();
  if (/\b(en|ingles|inglês|english)\b/.test(lower)) return "en";
  if (/\b(es|espanol|español|spanish)\b/.test(lower)) return "es";
  return "pt";
}

/** Extrai só os números válidos de uma lista de linhas (ignora a primeira linha, que é o comando). */
function extractNumbersFromLines(fullText) {
  const lines = fullText.split("\n").slice(1);
  const jids = [];

  for (const line of lines) {
    const digitsOnly = line.replace(/\D/g, "");
    if (digitsOnly.length < 10) continue; // ignora linhas sem número válido

    // Se vier sem código do país (DDD + número, 10 ou 11 dígitos), assume Brasil (55)
    const fullNumber = digitsOnly.length <= 11 ? `55${digitsOnly}` : digitsOnly;
    jids.push(`${fullNumber}@s.whatsapp.net`);
  }

  return jids;
}

/** Extrai "número + nicho + idioma" de cada linha do comando /campanha. */
function parseCampaignList(fullText) {
  const lines = fullText.split("\n").slice(1); // primeira linha é o comando "/campanha"
  const entries = [];

  for (const line of lines) {
    const digitsOnly = line.replace(/\D/g, "");
    if (digitsOnly.length < 10) continue; // ignora linhas sem número válido

    // Se vier sem código do país (DDD + número, 10 ou 11 dígitos), assume Brasil (55)
    const fullNumber = digitsOnly.length <= 11 ? `55${digitsOnly}` : digitsOnly;
    const niche = normalizeNiche(line);
    const lang = normalizeLanguage(line);

    entries.push({ jid: `${fullNumber}@s.whatsapp.net`, niche, lang });
  }

  return entries;
}

function buildCampaignMessage(niche, lang = "pt") {
  const templates = CAMPAIGN_TEMPLATES[lang] || CAMPAIGN_TEMPLATES.pt;
  return templates[niche] || templates.sistema;
}

/** Processa o comando /salvar: marca números como contato salvo manualmente. */
async function handleSalvarCommand(sock, ownerJid, fullText) {
  const jids = extractNumbersFromLines(fullText);

  if (jids.length === 0) {
    await sock.sendMessage(ownerJid, {
      text: "Não encontrei nenhum número válido. Formato esperado:\n/salvar\n5581999999999\n5581888888888",
    });
    return;
  }

  manualSavedContactJids = await addManualSavedContacts(jids);

  await sock.sendMessage(ownerJid, {
    text: `✅ ${jids.length} número(s) marcado(s) como contato salvo — o bot nunca mais vai responder eles automaticamente.`,
  });
}

/** Extrai um único número de telefone de dentro de um comando inline (ex: "/fechado 5581999999999"). */
function parseInlineNumberToJid(text) {
  const digitsOnly = text.replace(/\D/g, "");
  if (digitsOnly.length < 10) return null;
  const fullNumber = digitsOnly.length <= 11 ? `55${digitsOnly}` : digitsOnly;
  return `${fullNumber}@s.whatsapp.net`;
}

/** Marca um contato como "fechado" (venda concluída) no funil. Formato: /fechado 5581999999999 */
async function handleFechadoCommand(sock, ownerJid, fullText) {
  const targetJid = parseInlineNumberToJid(fullText);
  if (!targetJid) {
    await sock.sendMessage(ownerJid, { text: "Formato esperado: /fechado 5581999999999" });
    return;
  }

  const pipeline = await loadPipeline();
  const niche = pipeline[targetJid]?.niche;

  await setStage(targetJid, "fechado");
  await sock.sendMessage(ownerJid, {
    text: `✅ +${targetJid.split("@")[0]} marcado como FECHADO no funil. 🎉`,
  });

  // Gera automaticamente um rascunho de post de caso de sucesso, baseado no
  // histórico de conversa — nunca identifica o cliente por nome.
  try {
    const history = await getHistory(targetJid);
    if (history && history.length > 0) {
      const post = await generateSuccessPost(history, niche);
      await sock.sendMessage(ownerJid, {
        text: `📱 Rascunho de post pra rede social (revise antes de publicar):\n\n${post}`,
      });
    }
  } catch (err) {
    console.error(`Erro ao gerar post de sucesso pra ${targetJid}:`, err);
  }
}

/** Marca um contato como "perdido" no funil. Formato: /perdido 5581999999999 */
async function handlePerdidoCommand(sock, ownerJid, fullText) {
  const targetJid = parseInlineNumberToJid(fullText);
  if (!targetJid) {
    await sock.sendMessage(ownerJid, { text: "Formato esperado: /perdido 5581999999999" });
    return;
  }
  await setStage(targetJid, "perdido");
  await sock.sendMessage(ownerJid, {
    text: `❌ +${targetJid.split("@")[0]} marcado como PERDIDO no funil.`,
  });
}

/** Mostra o resumo do funil de vendas: contagem por estágio e quem está em negociação. */
async function handlePipelineCommand(sock, ownerJid) {
  const { counts, negociando, total } = await getPipelineSummary();
  const lines = STAGES.map((s) => `${stageLabel(s)}: ${counts[s] || 0}`);

  let text = `📊 Funil de vendas (${total} contato(s) no total):\n\n${lines.join("\n")}`;

  if (negociando.length > 0) {
    text +=
      `\n\n🤝 Em negociação agora (precisa da sua atenção):\n` +
      negociando
        .slice(0, 10)
        .map((n) => `• +${n.jid.split("@")[0]}${n.niche ? ` (${n.niche})` : ""}`)
        .join("\n");
    if (negociando.length > 10) text += `\n... e mais ${negociando.length - 10}.`;
  }

  await sock.sendMessage(ownerJid, { text });
}

/** Relatório da campanha: enviados por nicho, taxa de resposta, fila pendente. */
async function handleRelatorioCommand(sock, ownerJid) {
  const pipeline = await loadPipeline();

  const byNiche = {}; // niche -> { sent, respondeu, negociando, fechado }
  for (const [sentJid, info] of campaignSent) {
    const niche = info.niche || "desconhecido";
    if (!byNiche[niche]) byNiche[niche] = { sent: 0, respondeu: 0, negociando: 0, fechado: 0 };
    byNiche[niche].sent++;
    const stage = pipeline[sentJid]?.stage;
    if (stage === "respondeu" || stage === "negociando" || stage === "fechado") byNiche[niche].respondeu++;
    if (stage === "negociando") byNiche[niche].negociando++;
    if (stage === "fechado") byNiche[niche].fechado++;
  }

  const lines = Object.entries(byNiche).map(([niche, s]) => {
    const rate = s.sent > 0 ? Math.round((s.respondeu / s.sent) * 100) : 0;
    return `• ${niche}: ${s.sent} enviado(s) · ${s.respondeu} responderam (${rate}%) · ${s.negociando} negociando · ${s.fechado} fechado(s)`;
  });

  const text =
    `📈 Relatório da campanha\n\n` +
    (lines.length > 0 ? lines.join("\n") : "Nenhum envio de campanha registrado ainda.") +
    `\n\n📋 Fila pendente: ${campaignQueue.length} contato(s)` +
    `\n🚫 Blacklist (opt-out): ${blacklistJids.size} número(s)`;

  await sock.sendMessage(ownerJid, { text });
}

/** Status geral do bot: conexão, fila, pausado ou não, followup, funil resumido. */
async function handleStatusCommand(sock, ownerJid) {
  const { counts, total } = await getPipelineSummary();

  const lastRunAt = await getLastFollowupRunAt();
  let followupInfo = "pronto pra rodar";
  if (lastRunAt) {
    const cooldownMs = FOLLOWUP_RUN_COOLDOWN_HOURS * 60 * 60 * 1000;
    const elapsed = Date.now() - lastRunAt;
    if (elapsed < cooldownMs) {
      const hoursLeft = Math.ceil((cooldownMs - elapsed) / (60 * 60 * 1000));
      followupInfo = `próxima liberação em ~${hoursLeft}h`;
    }
  }

  const uptimeMin = connectedAt ? Math.floor((Date.now() - connectedAt) / 60000) : 0;
  const statusInfo = getConnectionStatusDisplay();

  const campaignSentInBatch = campaignBatchTotal > 0 ? campaignBatchTotal - campaignQueue.length : 0;
  let campaignInfo =
    campaignBatchTotal > 0
      ? `${campaignSentInBatch}/${campaignBatchTotal} enviados, faltam ${campaignQueue.length}${campaignRunning ? " (rodando agora)" : ""}`
      : "nenhuma campanha em andamento";
  if (campaignPanicPauseUntil && Date.now() < campaignPanicPauseUntil) {
    const minutesLeft = Math.ceil((campaignPanicPauseUntil - Date.now()) / 60000);
    campaignInfo += ` — 🚨 modo pânico ativo, retoma em ~${minutesLeft} min`;
  }

  const text =
    `🩺 Status do bot\n\n` +
    `Conexão: ${statusInfo.label}${connectedAt && connectionStatus === "conectado" ? ` (há ${uptimeMin} min)` : ""}\n` +
    (statusInfo.detail ? `↳ ${statusInfo.detail}\n` : "") +
    `Bot pausado: ${botPaused ? "sim ⏸️" : "não ▶️"}\n` +
    `Campanha: ${campaignInfo}\n` +
    `Followup: ${followupInfo}\n` +
    `Blacklist: ${blacklistJids.size} número(s)\n` +
    `Funil (${total} contato(s)): ` +
    STAGES.map((s) => `${counts[s] || 0} ${s}`).join(", ");

  await sock.sendMessage(ownerJid, { text });
}

/** Extrai { jid, days, note } do comando "/lembrar 5581999999999 3 nota livre". */
function parseReminderCommand(fullText) {
  const tokens = fullText.trim().split(/\s+/);
  if (tokens.length < 3) return null;
  const jid = parseInlineNumberToJid(tokens[1]);
  const days = Number(tokens[2]);
  if (!jid || !Number.isFinite(days) || days < 0) return null;
  const note = tokens.slice(3).join(" ");
  return { jid, days, note };
}

/** Cria um lembrete manual: /lembrar 5581999999999 3 Perguntar se decidiu sobre o site */
async function handleLembrarCommand(sock, ownerJid, fullText) {
  const parsed = parseReminderCommand(fullText);
  if (!parsed) {
    await sock.sendMessage(ownerJid, {
      text:
        "Formato esperado:\n/lembrar 5581999999999 3 Perguntar se decidiu sobre o site\n" +
        "(o número depois do telefone são os dias a partir de hoje; a nota é opcional)",
    });
    return;
  }

  const remindAt = Date.now() + parsed.days * 24 * 60 * 60 * 1000;
  await addReminder(parsed.jid, remindAt, parsed.note);
  const dateLabel = new Date(remindAt).toLocaleDateString("pt-BR");

  await sock.sendMessage(ownerJid, {
    text: `⏰ Lembrete criado pra +${parsed.jid.split("@")[0]} em ${dateLabel} (${parsed.days} dia(s))${parsed.note ? `: "${parsed.note}"` : "."}`,
  });
}

/** Lista os lembretes ainda não disparados. */
async function handleLembretesCommand(sock, ownerJid) {
  const pending = await getPendingReminders();

  if (pending.length === 0) {
    await sock.sendMessage(ownerJid, { text: "📭 Nenhum lembrete pendente." });
    return;
  }

  const lines = pending.map((r) => {
    const dateLabel = new Date(r.remindAt).toLocaleDateString("pt-BR");
    return `• +${r.jid.split("@")[0]} — ${dateLabel}${r.note ? `: ${r.note}` : ""}`;
  });

  await sock.sendMessage(ownerJid, { text: `⏰ Lembretes pendentes:\n\n${lines.join("\n")}` });
}

/** Lista clientes "fechados" há muito tempo — candidatos a reengajamento (indicação, renovação, upgrade). */
async function handleReengajarCommand(sock, ownerJid) {
  const minDays = Number(process.env.REENGAGE_MIN_DAYS || 180);
  const stale = await getStaleClosedContacts(minDays);

  if (stale.length === 0) {
    await sock.sendMessage(ownerJid, {
      text: `📭 Nenhum cliente fechado há mais de ${minDays} dias ainda. Nada pra reengajar por enquanto.`,
    });
    return;
  }

  const lines = stale.slice(0, 20).map((c) => {
    const daysAgo = Math.floor((Date.now() - (c.updatedAt || 0)) / (24 * 60 * 60 * 1000));
    return `• +${c.jid.split("@")[0]}${c.niche ? ` (${c.niche})` : ""} — fechado há ${daysAgo} dia(s)`;
  });

  let text =
    `🔄 ${stale.length} cliente(s) fechado(s) há mais de ${minDays} dias — bons candidatos pra pedir indicação ou oferecer renovação/upgrade:\n\n` +
    lines.join("\n");
  if (stale.length > 20) text += `\n... e mais ${stale.length - 20}.`;

  await sock.sendMessage(ownerJid, { text });
}

/** Processa o comando /campanha: valida a lista, adiciona na fila e inicia o envio. */
/**
 * Carrega a lista fixa de 100 contatos de estreia na fila de campanha,
 * automaticamente, sem precisar de comando manual — só roda UMA vez na vida
 * do bot (controlado por flag persistida em disco). Reaproveita as mesmas
 * regras de exclusão do /campanha manual (contato salvo, blacklist, já
 * enviado antes, já na fila).
 */
async function maybeSeedAutoCampaign(sock) {
  const alreadySeeded = await isAutoCampaignSeeded();
  if (alreadySeeded) return;

  // Marca como "já rodou" ANTES de processar — evita reprocessar a lista
  // inteira de novo se o bot cair no meio da própria função.
  await setAutoCampaignSeeded(true);

  const newEntries = AUTO_CAMPAIGN_LIST.filter(
    (e) =>
      !campaignSent.has(e.jid) &&
      !savedContactJids.has(e.jid) &&
      !manualSavedContactJids.has(e.jid) &&
      !blacklistJids.has(e.jid) &&
      !campaignQueue.some((q) => q.jid === e.jid)
  );

  if (newEntries.length === 0) {
    console.log("Campanha automática de estreia: nada pra adicionar (lista vazia após os filtros).");
    return;
  }

  const wasEmpty = campaignQueue.length === 0;
  campaignBatchTotal = wasEmpty ? newEntries.length : campaignBatchTotal + newEntries.length;

  campaignQueue.push(...newEntries);
  await saveCampaignQueue(campaignQueue);

  for (const entry of newEntries) {
    setStage(entry.jid, "novo", { niche: entry.niche, source: "campanha-automatica" }).catch((err) =>
      console.error(`Erro ao registrar ${entry.jid} no funil:`, err)
    );
  }

  console.log(`Campanha automática de estreia: ${newEntries.length} contato(s) carregado(s) na fila.`);

  const ownerJid = getOwnerJid(sock);
  if (ownerJid) {
    campaignOwnerJid = ownerJid;
    sock
      .sendMessage(ownerJid, {
        text:
          `🚀 Campanha automática de estreia iniciada!\n\n` +
          `${newEntries.length} contato(s) carregado(s) sozinho — nenhuma ação sua foi necessária. ` +
          `Respeitando o aquecimento diário e o intervalo de ~2 min entre mensagens. Acompanhe com /status ou /dashboard.`,
      })
      .catch((err) => console.error("Erro ao avisar sobre campanha automática:", err));
  }

  if (!campaignRunning) {
    processCampaignQueue().catch((err) => console.error("Erro na fila de campanha automática:", err));
  }
}

async function handleCampaignCommand(sock, ownerJid, fullText) {
  campaignOwnerJid = ownerJid;
  const parsed = parseCampaignList(fullText);

  if (parsed.length === 0) {
    await sock.sendMessage(ownerJid, {
      text: 'Não encontrei nenhum número válido. Formato esperado:\n/campanha\n5581999999999 barbearia\n5581888888888 site en',
    });
    return;
  }

  // Detecta duplicidade entre nichos: número já contatado antes numa
  // abordagem diferente (ex: já recebeu campanha de "oficina" e agora está
  // tentando mandar como "site"). Esses continuam sendo pulados pela regra
  // de "nunca repetir contato", mas aqui a gente avisa o motivo específico.
  const nicheDuplicates = [];

  // OBS: a pré-checagem em lote (sock.onWhatsApp com vários números de uma
  // vez) foi removida — em mais de uma ocasião ela voltou com os
  // identificadores num formato que não batia com os números enviados
  // (mesmo problema do @lid do WhatsApp) e acabou descartando contatos 100%
  // válidos, derrubando a fila inteira sem avisar direito. A checagem
  // individual, feita durante o envio de cada mensagem (mais abaixo, em
  // processCampaignQueue), é suficiente e não tem esse problema.

  const newEntries = parsed.filter((e) => {
    if (campaignSent.has(e.jid)) {
      const prevNiche = campaignSent.get(e.jid)?.niche;
      if (prevNiche && prevNiche !== e.niche) {
        nicheDuplicates.push({ jid: e.jid, prevNiche, newNiche: e.niche });
      }
      return false;
    }
    return (
      !savedContactJids.has(e.jid) &&
      !manualSavedContactJids.has(e.jid) &&
      !blacklistJids.has(e.jid) && // pediu pra não receber mais mensagem — nunca entra em campanha de novo
      !campaignQueue.some((q) => q.jid === e.jid)
    );
  });
  const skipped = parsed.length - newEntries.length;

  // Se a fila estava vazia, é um lote novo (progresso zera e recomeça do 0).
  // Se já tinha gente na fila, é reforço do mesmo lote em andamento.
  const wasEmpty = campaignQueue.length === 0;
  campaignBatchTotal = wasEmpty ? newEntries.length : campaignBatchTotal + newEntries.length;

  campaignQueue.push(...newEntries);
  await saveCampaignQueue(campaignQueue);

  for (const entry of newEntries) {
    setStage(entry.jid, "novo", { niche: entry.niche, source: "campanha" }).catch((err) =>
      console.error(`Erro ao registrar ${entry.jid} no funil:`, err)
    );
  }

  let summary =
    `📋 ${newEntries.length} contato(s) adicionado(s) à fila de prospecção` +
    (skipped > 0 ? ` (${skipped} ignorado(s): já salvos, já contatados antes, na blacklist, ou já na fila)` : "") +
    `.\nVou mandar um de cada vez, com intervalo de ${CAMPAIGN_DELAY_MIN_MS / 60000} a ${CAMPAIGN_DELAY_MAX_MS / 60000} minutos entre cada envio. Números sem WhatsApp são detectados e pulados individualmente durante o envio.`;

  if (nicheDuplicates.length > 0) {
    summary +=
      `\n\n⚠️ Possível duplicidade entre nichos (não reenviados):\n` +
      nicheDuplicates
        .slice(0, 10)
        .map((d) => `• +${d.jid.split("@")[0]}: já contatado como "${d.prevNiche}", tentando "${d.newNiche}" agora`)
        .join("\n");
  }

  await sock.sendMessage(ownerJid, { text: summary });

  if (!campaignRunning) {
    processCampaignQueue().catch((err) => console.error("Erro na fila de campanha:", err));
  }
}

/** Conta quantas mensagens de campanha foram confirmadas como enviadas desde um timestamp — usado pelo modo pânico anti-ban. */
function countCampaignSendsSince(sinceTimestamp) {
  let count = 0;
  for (const [, info] of campaignSent) {
    if (info.sentAt && info.sentAt >= sinceTimestamp) count++;
  }
  return count;
}

/**
 * Loop em segundo plano: manda um contato da fila por vez, espaçado, sem
 * travar o resto do bot. IMPORTANTE: usa sempre `currentSock` (a conexão
 * viva mais recente), nunca uma referência fixa capturada no início — se a
 * conexão cair e reconectar no meio da campanha (comum, dado que ela roda
 * por horas), continuar usando a conexão antiga fazia todo envio falhar
 * silenciosamente até alguém reiniciar a campanha na mão.
 */
async function processCampaignQueue() {
  if (campaignRunning) return;
  campaignRunning = true;

  try {
    while (campaignQueue.length > 0) {
      if (botPaused) {
        console.log("Campanha pausada (bot em /parar) — aguardando 1 min pra checar de novo.");
        await sleep(60 * 1000);
        continue;
      }
      if (connectionStatus !== "conectado" || !currentSock) {
        console.log("Campanha aguardando conexão voltar...");
        await sleep(60 * 1000);
        continue;
      }

      // Modo pânico anti-ban: trava extra de curto prazo, além do
      // aquecimento diário — se já foi ativado, fica em espera até o
      // cooldown passar.
      if (campaignPanicPauseUntil && Date.now() < campaignPanicPauseUntil) {
        const minutesLeft = Math.ceil((campaignPanicPauseUntil - Date.now()) / 60000);
        console.log(`Modo pânico anti-ban ativo — aguardando mais ~${minutesLeft} min antes de retomar.`);
        await sleep(5 * 60 * 1000);
        continue;
      }

      // Verifica volume de envio na última hora. Se estourar o limite de
      // segurança, ativa o modo pânico e avisa você, mesmo que o
      // aquecimento diário ainda permitisse mandar mais.
      const sentLastHour = countCampaignSendsSince(Date.now() - 60 * 60 * 1000);
      if (sentLastHour >= PANIC_MAX_SENDS_PER_HOUR) {
        campaignPanicPauseUntil = Date.now() + PANIC_COOLDOWN_HOURS * 60 * 60 * 1000;
        console.warn(
          `🚨 Modo pânico anti-ban: ${sentLastHour} envios na última hora (limite ${PANIC_MAX_SENDS_PER_HOUR}) — pausando por ${PANIC_COOLDOWN_HOURS}h de precaução.`
        );
        const ownerJid = getOwnerJid(currentSock);
        if (ownerJid) {
          currentSock
            .sendMessage(ownerJid, {
              text:
                `🚨 Modo pânico anti-ban ativado\n\n` +
                `${sentLastHour} mensagens de campanha na última hora (acima do limite de segurança de ${PANIC_MAX_SENDS_PER_HOUR}/h). ` +
                `Pausei a campanha por ${PANIC_COOLDOWN_HOURS}h por precaução, mesmo estando dentro do limite diário do aquecimento. ` +
                `Isso é só uma camada extra de segurança — retoma sozinha depois.`,
            })
            .catch(() => {});
        }
        sendAlert(
          "🚨 Modo pânico anti-ban ativado",
          `${sentLastHour} envios na última hora — campanha pausada por ${PANIC_COOLDOWN_HOURS}h de precaução.`,
          { priority: "high", tags: "rotating_light" }
        ).catch(() => {});
        continue;
      }

      // Aquecimento automático: número novo (ou recém-voltado de restrição)
      // manda poucas mensagens por dia no início, aumentando aos poucos —
      // reduz bastante o risco de bloqueio por "excesso de automação".
      const warmup = await getWarmupStatus();
      if (!warmup.allowed) {
        console.log(
          `Aquecimento: limite do dia ${warmup.day ?? "?"} atingido (${warmup.sentToday}/${warmup.limit}) — aguardando 30 min.`
        );
        await sleep(30 * 60 * 1000);
        continue;
      }

      const next = campaignQueue[0];
      let requeue = false;

      try {
        // "hasWhatsApp" só vira false com uma confirmação explícita de que o
        // número não existe. Resposta vazia/ambígua não é tratada como "não
        // tem WhatsApp" — já vimos essa checagem falhar sem motivo real
        // (mesmo problema de formato corrigido na pré-checagem em lote), e
        // silenciosamente pular um contato válido é pior do que só tentar
        // mandar e deixar o próprio envio confirmar.
        let hasWhatsApp = true;
        try {
          const results = await currentSock.onWhatsApp(next.jid);
          if (results && results.length > 0) {
            hasWhatsApp = results.some((r) => r?.exists !== false);
          }
        } catch (checkErr) {
          console.warn(`Checagem de WhatsApp falhou pra ${next.jid}, vou tentar mandar mesmo assim:`, checkErr?.message || checkErr);
        }

        if (!hasWhatsApp) {
          console.log(`Número sem WhatsApp, pulando: ${next.jid}`);
        } else {
          const text = buildCampaignMessage(next.niche, next.lang);
          const delivered = await sendWithTypingSimulation(currentSock, next.jid, text, CAMPAIGN_TYPING_MIN_MS, CAMPAIGN_TYPING_MAX_MS);
          if (delivered) {
            campaignSent.set(next.jid, { niche: next.niche, sentAt: Date.now() });
            await saveCampaignSent(campaignSent);
            await setStage(next.jid, "contatado", { niche: next.niche, source: "campanha" });
            await recordCampaignSend();
            console.log(`Campanha: mensagem (${next.niche}/${next.lang || "pt"}) CONFIRMADA pra ${next.jid}`);
          } else {
            console.log(`Campanha: entrega NÃO confirmada pra ${next.jid} — voltando pro fim da fila.`);
            requeue = true;
          }
        }
      } catch (err) {
        console.error(`Erro ao mandar campanha pra ${next.jid}:`, err);
        requeue = true;
      }

      campaignQueue.shift();
      if (requeue) campaignQueue.push(next);
      await saveCampaignQueue(campaignQueue);

      if (campaignQueue.length > 0) {
        const delay = randomBetween(CAMPAIGN_DELAY_MIN_MS, CAMPAIGN_DELAY_MAX_MS);
        await sleep(delay);
      }
    }

    if (campaignOwnerJid && currentSock) {
      await currentSock.sendMessage(campaignOwnerJid, { text: "✅ Campanha de prospecção concluída — fila zerada." }).catch(() => {});
    }
    campaignBatchTotal = 0; // lote concluído — próximo /campanha começa um progresso novo
  } finally {
    campaignRunning = false;
  }
}

/** Monta uma mensagem de follow-up baseada no que foi mencionado (site ou sistema). */
function buildFollowupMessage() {
  return `Oi! Passando aqui pra saber se você conseguiu bater o olho na proposta que te mandei — ficou alguma dúvida ou posso seguir com o fechamento? 😊`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Mostra "digitando..." por um tempo aleatório antes de mandar a mensagem, pra parecer mais humano. */
async function sendWithTypingSimulation(sock, jid, text, typingMinMs = FOLLOWUP_TYPING_MIN_MS, typingMaxMs = FOLLOWUP_TYPING_MAX_MS) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
  } catch {
    // se não conseguir mostrar "digitando", segue o fluxo normalmente
  }

  const typingMs = randomBetween(typingMinMs, typingMaxMs);
  await sleep(typingMs);

  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {
    // idem
  }

  return sendMessageWithConfirmation(sock, jid, text);
}

/**
 * Manda a mensagem e espera confirmação real de entrega (status >= 2 do
 * WhatsApp). Se não confirmar dentro do prazo, tenta de novo (até maxRetries
 * vezes) — proteção contra envios que "somem" por causa de instabilidade de
 * conexão (sessão de criptografia dessincronizada).
 * Retorna true se confirmou entrega, false se esgotou as tentativas.
 */
async function sendMessageWithConfirmation(sock, jid, text, { timeoutMs = 20000, maxRetries = 2 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let sent;
    try {
      sent = await sock.sendMessage(jid, { text });
    } catch (err) {
      console.error(`Erro ao enviar (tentativa ${attempt + 1}) pra ${jid}:`, err);
      sent = null;
    }

    const id = sent?.key?.id;
    if (!id) {
      // não conseguimos nem obter o ID da mensagem — espera um pouco e tenta de novo
      await sleep(3000);
      continue;
    }

    const confirmed = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDeliveryConfirms.delete(id);
        resolve(false);
      }, timeoutMs);
      pendingDeliveryConfirms.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    if (confirmed) return true;

    console.log(`Sem confirmação de entrega pra ${jid} (tentativa ${attempt + 1}/${maxRetries + 1}) — tentando de novo...`);
  }

  console.error(`Falha real ao entregar mensagem pra ${jid} após ${maxRetries + 1} tentativas.`);
  return false;
}

/** Varre as conversas, acha quem não respondeu depois de você mencionar "proposta", e manda follow-up. */
async function runFollowup(sock, ownerReplyJid) {
  const lastRunAt = await getLastFollowupRunAt();
  const cooldownMs = FOLLOWUP_RUN_COOLDOWN_HOURS * 60 * 60 * 1000;
  if (lastRunAt && Date.now() - lastRunAt < cooldownMs) {
    const releasesAt = new Date(lastRunAt + cooldownMs);
    const hoursLeft = Math.ceil((releasesAt.getTime() - Date.now()) / (60 * 60 * 1000));
    await sock.sendMessage(ownerReplyJid, {
      text: `⏳ Calma lá! Pra manter o número seguro, o /followup só roda 1x por dia. Faltam ~${hoursLeft}h pra próxima execução liberar.`,
    });
    return;
  }

  const candidates = findFollowupCandidates(messageIndex).filter(
    (c) =>
      !blacklistJids.has(c.jid) &&
      !savedContactJids.has(c.jid) && // trava de segurança extra: nunca manda pra contato salvo, mesmo que já estivesse indexado de antes
      !manualSavedContactJids.has(c.jid)
  );

  if (candidates.length === 0) {
    await sock.sendMessage(ownerReplyJid, {
      text: "🔎 Não achei ninguém pendente agora — todo mundo que recebeu proposta já respondeu, ou já recebeu follow-up antes.",
    });
    return;
  }

  const batch = candidates.slice(0, FOLLOWUP_MAX_PER_RUN);
  await sock.sendMessage(ownerReplyJid, {
    text: `🔎 Achei ${candidates.length} cliente(s) sem resposta. Mandando follow-up pra ${batch.length} agora (limite de segurança por execução), simulando digitação e com intervalo entre cada envio...`,
  });

  const sentTo = [];
  const failed = [];
  for (const candidate of batch) {
    try {
      const followupText = buildFollowupMessage();
      const delivered = await sendWithTypingSimulation(sock, candidate.jid, followupText);
      if (delivered) {
        candidate.followedUpAt = Date.now();
        messageIndex[candidate.jid] = candidate;
        sentTo.push(candidate.jid.split("@")[0]);
      } else {
        failed.push(candidate.jid.split("@")[0]);
      }
      await sleep(FOLLOWUP_DELAY_MS);
    } catch (err) {
      console.error(`Erro ao mandar follow-up pra ${candidate.jid}:`, err);
      failed.push(candidate.jid.split("@")[0]);
    }
  }

  if (sentTo.length > 0) {
    await setLastFollowupRunAt(Date.now());
  }

  await saveMessageIndex(messageIndex);

  const remaining = candidates.length - batch.length;
  const summary =
    `✅ Follow-up confirmado pra ${sentTo.length} contato(s):\n` +
    sentTo.map((n) => `+${n}`).join("\n") +
    (failed.length > 0
      ? `\n\n❌ Falha na entrega (não confirmada, será tentado de novo depois): ${failed.map((n) => `+${n}`).join(", ")}`
      : "") +
    (remaining > 0 ? `\n\n⚠️ Ainda tem ${remaining} pendente(s) — mande /followup de novo pra continuar.` : "");

  await sock.sendMessage(ownerReplyJid, { text: summary });
}

/** Normaliza o JID do próprio dono do bot (o número onde ele está logado). */
function getOwnerJid(sock) {
  if (!sock?.user?.id) return null;
  return sock.user.id.split(":")[0] + "@s.whatsapp.net";
}

/** Manda um aviso para o próprio número (chat "Você") quando alguém demonstra interesse. */
async function notifyOwner(sock, contactJid, leadSummary) {
  const ownerJid = getOwnerJid(sock);
  const contactNumber = contactJid.split("@")[0];
  const waLink = `https://wa.me/${contactNumber}`;
  const alertText =
    `🔔 Lead pronto pra falar com você!\n` +
    `Contato: +${contactNumber}\n` +
    (leadSummary ? `Resumo: ${leadSummary}\n` : "") +
    `Abrir conversa: ${waLink}\n` +
    `O bot já parou de responder esse número — a conversa é sua a partir de agora.`;

  try {
    await sock.sendMessage(ownerJid, { text: alertText });
  } catch (err) {
    console.error("Não foi possível notificar o dono:", err);
  }

  // Notificação push (ntfy) também, com prioridade máxima e link direto pro
  // WhatsApp do lead — toca no celular mesmo com o app fechado.
  sendAlert(
    "🔥 Novo lead quente!",
    `+${contactNumber} está pronto pra fechar.${leadSummary ? ` ${leadSummary}` : ""}`,
    { click: waLink, priority: "urgent", tags: "moneybag" }
  ).catch((err) => console.error("Erro ao mandar alerta push de lead:", err));
}

/** Manda um aviso urgente pro dono quando um lead parece frustrado/irritado — precisa de atenção humana já. */
async function notifyOwnerFrustration(sock, contactJid, lastText) {
  const ownerJid = getOwnerJid(sock);
  const contactNumber = contactJid.split("@")[0];
  const waLink = `https://wa.me/${contactNumber}`;
  const alertText =
    `⚠️ Lead parece incomodado — melhor você assumir a conversa.\n` +
    `Contato: +${contactNumber}\n` +
    `Última mensagem: "${lastText.slice(0, 200)}"\n` +
    `Abrir conversa: ${waLink}\n` +
    `O bot já parou de responder esse número.`;

  try {
    await sock.sendMessage(ownerJid, { text: alertText });
  } catch (err) {
    console.error("Não foi possível notificar o dono sobre lead frustrado:", err);
  }

  sendAlert(
    "⚠️ Lead parece frustrado",
    `+${contactNumber} pode estar incomodado — dá uma olhada.`,
    { click: waLink, priority: "urgent", tags: "warning" }
  ).catch((err) => console.error("Erro ao mandar alerta push de frustração:", err));
}

startBot().catch((err) => {
  console.error("Erro fatal ao iniciar o bot:", err);
  process.exit(1);
});

// Rede de segurança: se por qualquer motivo a reconexão automática falhar
// silenciosamente e o bot ficar "preso" desconectado, essa checagem força
// uma nova tentativa a cada 2 minutos.
setInterval(() => {
  // Trava de segurança extra: se "isConnecting" ficou preso em true por
  // tempo demais (ex: o socket travou no meio do handshake sem nunca
  // disparar "open" nem "close"), ninguém mais consegue reconectar — nem
  // esse watchdog, nem o gatilho de horário comercial, porque ambos
  // esperam "!isConnecting". Força um reset aqui pra destravar.
  if (isConnecting && connectingSince && Date.now() - connectingSince > CONNECTING_STUCK_TIMEOUT_MS) {
    console.log("Watchdog: conexão ficou travada em 'conectando' por tempo demais — resetando trava.");
    isConnecting = false;
    connectingSince = null;
    connectionStatus = "desconectado";
  }

  if (connectionStatus === "desconectado" && !isConnecting) {
    console.log("Watchdog: bot está desconectado há um tempo — forçando nova tentativa de conexão.");
    startBot().catch((err) => console.error("Erro na tentativa de reconexão via watchdog:", err));

    if (Date.now() - lastAlertAt > ALERT_COOLDOWN_MS) {
      lastAlertAt = Date.now();
      sendAlert(
        "🔴 Bot do WhatsApp desconectado",
        "O bot está desconectado do WhatsApp e tentando reconectar sozinho. Se continuar assim por muito tempo, pode ser necessário escanear o QR code de novo."
      );
    }
  }
}, 2 * 60 * 1000);

// Retoma a fila de campanha automaticamente se o bot reiniciar no meio do
// processo (ex: caiu, deploy novo) e ainda houver contatos pendentes.
setInterval(() => {
  if (campaignQueue.length > 0 && !campaignRunning && currentSock && connectionStatus === "conectado" && !botPaused) {
    console.log("Retomando fila de campanha pendente após reinício.");
    processCampaignQueue().catch((err) => console.error("Erro ao retomar fila de campanha:", err));
  }
}, 2 * 60 * 1000);

// Checa lembretes manuais (/lembrar) vencidos e manda o aviso pra você.
setInterval(async () => {
  if (connectionStatus !== "conectado" || !currentSock) return;
  try {
    const due = await getDueReminders();
    if (due.length === 0) return;

    const ownerJid = getOwnerJid(currentSock);
    if (!ownerJid) return;

    for (const reminder of due) {
      await currentSock.sendMessage(ownerJid, {
        text: `⏰ Lembrete: falar com +${reminder.jid.split("@")[0]}${reminder.note ? ` — ${reminder.note}` : ""}`,
      });
      await markReminderDone(reminder.id);
    }
  } catch (err) {
    console.error("Erro ao checar lembretes pendentes:", err);
  }
}, 5 * 60 * 1000);

/** Monta o texto do resumo diário automático, baseado no funil e nos envios das últimas 24h. */
async function buildDailySummaryText() {
  const { counts, negociando, total } = await getPipelineSummary();
  const since = Date.now() - 24 * 60 * 60 * 1000;

  let sentLast24h = 0;
  for (const [, info] of campaignSent) {
    if (info.sentAt && info.sentAt >= since) sentLast24h++;
  }

  const pipeline = await loadPipeline();
  let novosUltimas24h = 0;
  let fechadosUltimas24h = 0;
  for (const entry of Object.values(pipeline)) {
    if (!entry.updatedAt || entry.updatedAt < since) continue;
    if (entry.stage === "fechado") fechadosUltimas24h++;
  }
  // "Novo" é aproximado pelo primeiro registro no funil dentro da janela —
  // como não guardamos createdAt separado, usamos updatedAt de quem está
  // hoje em "novo" ou "contatado" como proxy razoável.
  for (const entry of Object.values(pipeline)) {
    if (entry.updatedAt && entry.updatedAt >= since && (entry.stage === "novo" || entry.stage === "contatado")) {
      novosUltimas24h++;
    }
  }

  let text =
    `☀️ Resumo do dia\n\n` +
    `📤 Campanha: ${sentLast24h} mensagem(ns) enviada(s) nas últimas 24h\n` +
    `🆕 Contatos novos/contatados: ${novosUltimas24h}\n` +
    `✅ Fechados: ${fechadosUltimas24h}\n` +
    `📋 Fila pendente: ${campaignQueue.length}\n` +
    `🤝 Em negociação agora: ${counts.negociando || 0}\n` +
    `📊 Funil total: ${total} contato(s)`;

  if (negociando.length > 0) {
    text +=
      `\n\nContatos em negociação:\n` +
      negociando
        .slice(0, 8)
        .map((n) => `• +${n.jid.split("@")[0]}${n.niche ? ` (${n.niche})` : ""}`)
        .join("\n");
  }

  return text;
}

// Resumo diário automático: todo dia, no horário configurado, manda um
// resumo do que aconteceu — sem precisar pedir /relatorio na mão.
if (DAILY_SUMMARY_ENABLED) {
  setInterval(async () => {
    if (connectionStatus !== "conectado" || !currentSock) return;

    const localHour = getLocalHour();
    if (localHour < DAILY_SUMMARY_HOUR || localHour >= DAILY_SUMMARY_HOUR + 1) return;

    const todayKey = new Date().toISOString().slice(0, 10);
    const lastSent = await getLastDailySummaryDate();
    if (lastSent === todayKey) return; // já mandou hoje

    try {
      const ownerJid = getOwnerJid(currentSock);
      if (!ownerJid) return;
      const text = await buildDailySummaryText();
      await currentSock.sendMessage(ownerJid, { text });
      await setLastDailySummaryDate(todayKey);
    } catch (err) {
      console.error("Erro ao mandar resumo diário:", err);
    }
  }, 5 * 60 * 1000);
}

// Aniversário de parceria automatizado: manda mensagem direto pro cliente
// (não pra você) quando bate 1 mês, 6 meses, 1 ano (configurável) desde que
// ele foi marcado "fechado" no funil. Nunca repete o mesmo marco duas vezes.
setInterval(async () => {
  if (connectionStatus !== "conectado" || !currentSock || botPaused) return;

  try {
    const closed = await getClosedContacts();
    const now = Date.now();

    for (const contact of closed) {
      if (blacklistJids.has(contact.jid)) continue; // pediu pra não receber mais mensagem
      if (!contact.updatedAt) continue;

      const daysSinceClosed = Math.floor((now - contact.updatedAt) / (24 * 60 * 60 * 1000));
      const alreadySent = new Set(contact.anniversariesSent || []);

      for (const milestone of ANNIVERSARY_MILESTONES_DAYS) {
        if (daysSinceClosed < milestone || alreadySent.has(milestone)) continue;

        const label = milestone >= 365 ? `${Math.round(milestone / 365)} ano(s)` : milestone >= 30 ? `${Math.round(milestone / 30)} mês(es)` : `${milestone} dia(s)`;
        const text = `Oi! 🎉 Faz ${label} que a gente trabalha junto${contact.niche ? ` no seu ${contact.niche}` : ""}! Como está sendo a experiência? Qualquer coisa que precisar, é só chamar 😊`;

        try {
          await currentSock.sendMessage(contact.jid, { text });
          await markAnniversarySent(contact.jid, milestone);
          console.log(`Aniversário de parceria (${label}) enviado pra ${contact.jid}.`);
        } catch (err) {
          console.error(`Erro ao mandar aniversário de parceria pra ${contact.jid}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("Erro ao checar aniversários de parceria:", err);
  }
}, 60 * 60 * 1000); // checa a cada hora — não precisa ser mais frequente que isso

// Liga/desliga automaticamente no horário comercial configurado (se ativado).
// Fora do expediente, desconecta de verdade (sem perder a sessão salva) —
// reduz o tempo que a conta fica "sempre online" pros seus contatos.
if (BUSINESS_HOURS_ENABLED) {
  console.log(`Horário comercial ativado: ${BUSINESS_HOURS_START}h às ${BUSINESS_HOURS_END}h (Brasília).`);
  setInterval(() => {
    const withinHours = isWithinBusinessHours();

    if (withinHours && connectionStatus !== "conectado" && connectionStatus !== "iniciando" && !isConnecting) {
      console.log("Início do horário comercial — conectando...");
      startBot().catch((err) => console.error("Erro ao conectar no início do expediente:", err));
    }

    if (!withinHours && connectionStatus === "conectado" && currentSock) {
      console.log(`Fora do horário comercial (${BUSINESS_HOURS_START}h-${BUSINESS_HOURS_END}h) — desconectando até o próximo expediente.`);
      connectionStatus = "fora_do_expediente";
      connectionGeneration++; // invalida os listeners dessa conexão — qualquer evento tardio dela é ignorado
      try {
        currentSock.ev.removeAllListeners();
        currentSock.end(undefined);
      } catch (err) {
        console.error("Erro ao encerrar conexão fora do expediente:", err);
      }
      currentSock = null;
    }
  }, 60 * 1000);
}
