import express from "express";
import qrcode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import pino from "pino";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { askAI } from "./lib/ai.js";
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
} from "./lib/contacts.js";
import { loadMessageIndex, saveMessageIndex, extractText, indexMessage, findFollowupCandidates } from "./lib/messageIndex.js";
import { sendAlert } from "./lib/alerts.js";

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || "./auth"; // sessão do WhatsApp (persistir em disco!)
const RESPOND_TO_GROUPS = process.env.RESPOND_TO_GROUPS === "true"; // padrão: não responde em grupos

// Tempo de segurança após conectar em que o bot NÃO responde ninguém —
// dá tempo pra sincronização da sua agenda de contatos terminar, evitando
// responder gente que já está salva logo após reconectar. Padrão: 60s.
const CONTACTS_SYNC_GRACE_MS = Number(process.env.CONTACTS_SYNC_GRACE_MS || 60000);
let connectedAt = null;

let latestQr = null; // guardamos o QR mais recente pra exibir via /qr
let connectionStatus = "iniciando";
let isConnecting = false; // evita duas conexões simultâneas tentando reconectar ao mesmo tempo
let lastAlertAt = 0; // controla intervalo entre alertas de desconexão, pra não spammar
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MINUTES || 15) * 60 * 1000;
let botPaused = false; // controlado por /parar e /iniciar
let messageIndex = {}; // índice de conversas, usado pra achar quem não respondeu

// Configurações do follow-up automático (comando /followup)
const FOLLOWUP_MAX_PER_RUN = Number(process.env.FOLLOWUP_MAX_PER_RUN || 15); // segurança: limite por execução
const FOLLOWUP_TYPING_MIN_MS = Number(process.env.FOLLOWUP_TYPING_MIN_MS || 2000); // simula "digitando..." (mínimo)
const FOLLOWUP_TYPING_MAX_MS = Number(process.env.FOLLOWUP_TYPING_MAX_MS || 6000); // simula "digitando..." (máximo)
const FOLLOWUP_DELAY_MS = Number(process.env.FOLLOWUP_DELAY_MS || 8000); // intervalo entre envios
// Intervalo mínimo entre execuções que realmente mandam mensagem — força
// "um dia sim, um dia não" mesmo se você tentar rodar o comando todo dia.
const FOLLOWUP_RUN_COOLDOWN_HOURS = Number(process.env.FOLLOWUP_RUN_COOLDOWN_HOURS || 36);
const savedContactJids = new Set(); // números que estão salvos na sua agenda do celular

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

app.listen(PORT, () => console.log(`Servidor HTTP rodando na porta ${PORT}`));

async function startBot() {
  if (isConnecting) {
    console.log("Já existe uma tentativa de conexão em andamento — ignorando chamada duplicada.");
    return;
  }
  isConnecting = true;

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
      if (contact?.id && contact.name && !savedContactJids.has(contact.id)) {
        savedContactJids.add(contact.id);
        added = true;
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
      indexMessage(messageIndex, msg);
    }
    if (messages?.length) {
      saveMessageIndex(messageIndex).catch((err) => console.error("Erro ao salvar índice de mensagens:", err));
    }
  });
  sock.ev.on("contacts.upsert", (contacts) => trackContacts(contacts, "upsert"));
  sock.ev.on("contacts.update", (contacts) => trackContacts(contacts, "update"));

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      qrcodeTerminal.generate(qr, { small: true });
      console.log("QR code gerado. Escaneie pelo terminal acima ou acesse /qr no navegador.");
      sendAlert("📱 QR code precisa ser escaneado", "O bot do WhatsApp precisa que você escaneie um novo QR code. Acesse a URL do serviço + /qr.");
    }

    if (connection === "open") {
      connectionStatus = "conectado";
      latestQr = null;
      connectedAt = Date.now();
      isConnecting = false;
      console.log(
        `Conectado ao WhatsApp com sucesso! Aguardando ${CONTACTS_SYNC_GRACE_MS / 1000}s pra sincronizar a agenda antes de responder mensagens.`
      );
    }

    if (connection === "close") {
      connectionStatus = "desconectado";
      isConnecting = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Conexão fechada.", shouldReconnect ? "Reconectando..." : "Sessão encerrada (logout).");
      if (shouldReconnect) {
        startBot().catch((err) => console.error("Erro ao tentar reconectar:", err));
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error("Erro processando mensagem:", err);
      }
    }
  });
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;

  // Indexa toda conversa 1:1 (não-grupo), independente do resto da lógica,
  // pra alimentar o comando /followup.
  indexMessage(messageIndex, msg);
  saveMessageIndex(messageIndex).catch((err) => console.error("Erro ao salvar índice de mensagens:", err));

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

  if (savedContactJids.has(jid) || manualExcludedJids.has(jid)) return; // já é seu contato — você mesmo conversa

  const handedOff = await isHandedOff(jid);
  if (handedOff) return; // já foi repassado pra você — bot fica quieto

  await appendHistory(jid, "user", text);

  const history = await getHistory(jid);
  const { reply, interested, leadSummary } = await askAI(history);

  await appendHistory(jid, "assistant", reply);
  await sock.sendMessage(jid, { text: reply });

  if (interested) {
    await markHandedOff(jid); // a partir daqui, a conversa é só sua
    await notifyOwner(sock, jid, leadSummary);
  }
}

/** Monta uma mensagem de follow-up baseada no que foi mencionado (site ou sistema). */
function buildFollowupMessage(entry) {
  const mentionsSite = entry.keywordText.toLowerCase().includes("site");
  const mentionsSistema = entry.keywordText.toLowerCase().includes("sistema");
  const item = mentionsSite && mentionsSistema ? "site ou sistema" : mentionsSite ? "site" : "sistema";
  return `Oi! Passando aqui pra saber se você conseguiu bater o olho na proposta do ${item} que conversamos — ficou alguma dúvida ou posso seguir com o fechamento? 😊`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Mostra "digitando..." por um tempo aleatório antes de mandar a mensagem, pra parecer mais humano. */
async function sendWithTypingSimulation(sock, jid, text) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
  } catch {
    // se não conseguir mostrar "digitando", segue o fluxo normalmente
  }

  const typingMs = randomBetween(FOLLOWUP_TYPING_MIN_MS, FOLLOWUP_TYPING_MAX_MS);
  await sleep(typingMs);

  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {
    // idem
  }

  await sock.sendMessage(jid, { text });
}

/** Varre as conversas, acha quem não respondeu depois de mencionar site/sistema, e manda follow-up. */
async function runFollowup(sock, ownerReplyJid) {
  const lastRunAt = await getLastFollowupRunAt();
  const cooldownMs = FOLLOWUP_RUN_COOLDOWN_HOURS * 60 * 60 * 1000;
  if (lastRunAt && Date.now() - lastRunAt < cooldownMs) {
    const releasesAt = new Date(lastRunAt + cooldownMs);
    const hoursLeft = Math.ceil((releasesAt.getTime() - Date.now()) / (60 * 60 * 1000));
    await sock.sendMessage(ownerReplyJid, {
      text: `⏳ Calma lá! Pra manter o número seguro, o /followup só roda em dias alternados. Faltam ~${hoursLeft}h pra próxima execução liberar.`,
    });
    return;
  }

  const candidates = findFollowupCandidates(messageIndex);

  if (candidates.length === 0) {
    await sock.sendMessage(ownerReplyJid, {
      text: "🔎 Não achei ninguém pendente agora — todo mundo que mencionei site/sistema já respondeu, ou já recebeu follow-up antes.",
    });
    return;
  }

  const batch = candidates.slice(0, FOLLOWUP_MAX_PER_RUN);
  await sock.sendMessage(ownerReplyJid, {
    text: `🔎 Achei ${candidates.length} cliente(s) sem resposta. Mandando follow-up pra ${batch.length} agora (limite de segurança por execução), simulando digitação e com intervalo entre cada envio...`,
  });

  const sentTo = [];
  for (const candidate of batch) {
    try {
      const followupText = buildFollowupMessage(candidate);
      await sendWithTypingSimulation(sock, candidate.jid, followupText);
      candidate.followedUpAt = Date.now();
      messageIndex[candidate.jid] = candidate;
      sentTo.push(candidate.jid.split("@")[0]);
      await sleep(FOLLOWUP_DELAY_MS);
    } catch (err) {
      console.error(`Erro ao mandar follow-up pra ${candidate.jid}:`, err);
    }
  }

  if (sentTo.length > 0) {
    await setLastFollowupRunAt(Date.now());
  }

  await saveMessageIndex(messageIndex);

  const remaining = candidates.length - batch.length;
  const summary =
    `✅ Follow-up enviado pra ${sentTo.length} contato(s):\n` +
    sentTo.map((n) => `+${n}`).join("\n") +
    (remaining > 0 ? `\n\n⚠️ Ainda tem ${remaining} pendente(s) — mande /followup de novo pra continuar.` : "");

  await sock.sendMessage(ownerReplyJid, { text: summary });
}

/** Manda um aviso para o próprio número (chat "Você") quando alguém demonstra interesse. */
async function notifyOwner(sock, contactJid, leadSummary) {
  const ownerJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net"; // normaliza o próprio JID
  const contactNumber = contactJid.split("@")[0];
  const alertText =
    `🔔 Lead pronto pra falar com você!\n` +
    `Contato: +${contactNumber}\n` +
    (leadSummary ? `Resumo: ${leadSummary}\n` : "") +
    `O bot já parou de responder esse número — a conversa é sua a partir de agora.`;

  try {
    await sock.sendMessage(ownerJid, { text: alertText });
  } catch (err) {
    console.error("Não foi possível notificar o dono:", err);
  }
}

startBot().catch((err) => {
  console.error("Erro fatal ao iniciar o bot:", err);
  process.exit(1);
});

// Rede de segurança: se por qualquer motivo a reconexão automática falhar
// silenciosamente e o bot ficar "preso" desconectado, essa checagem força
// uma nova tentativa a cada 2 minutos.
setInterval(() => {
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
