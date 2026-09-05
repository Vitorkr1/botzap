import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const PIPELINE_FILE = path.join(DATA_DIR, "pipeline.json");

// Ordem dos estágios do funil — usada só pra exibir /pipeline sempre na
// mesma ordem (não é uma trava, você pode ir e voltar de estágio).
export const STAGES = ["novo", "contatado", "respondeu", "negociando", "fechado", "perdido"];

const STAGE_LABELS = {
  novo: "🆕 Novo",
  contatado: "📤 Contatado (aguardando resposta)",
  respondeu: "💬 Respondeu",
  negociando: "🤝 Negociando",
  fechado: "✅ Fechado",
  perdido: "❌ Perdido",
};

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage;
}

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

/** Carrega o funil inteiro: { [jid]: { stage, niche, source, updatedAt, note } } */
export async function loadPipeline() {
  return readJson(PIPELINE_FILE, {});
}

export async function savePipeline(pipeline) {
  await writeJson(PIPELINE_FILE, pipeline);
}

/**
 * Move um contato pra um novo estágio do funil. Cria o registro se ainda
 * não existir. `extra` pode incluir { niche, source, note }.
 */
export async function setStage(jid, stage, extra = {}) {
  const pipeline = await loadPipeline();
  const existing = pipeline[jid] || {};
  pipeline[jid] = {
    ...existing,
    ...extra,
    stage,
    updatedAt: Date.now(),
  };
  await savePipeline(pipeline);
  return pipeline[jid];
}

export async function getStage(jid) {
  const pipeline = await loadPipeline();
  return pipeline[jid]?.stage || null;
}

/**
 * Contatos "fechados" há muito tempo (padrão: 180 dias / ~6 meses) — bons
 * candidatos pra pedir indicação ou oferecer upgrade/renovação.
 */
export async function getStaleClosedContacts(minDays = 180) {
  const pipeline = await loadPipeline();
  const cutoff = Date.now() - minDays * 24 * 60 * 60 * 1000;

  return Object.entries(pipeline)
    .filter(([, entry]) => entry.stage === "fechado" && (entry.updatedAt || 0) < cutoff)
    .map(([jid, entry]) => ({ jid, ...entry }))
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
}

/** Todos os contatos marcados como "fechado" — usado pelo aniversário de parceria automatizado. */
export async function getClosedContacts() {
  const pipeline = await loadPipeline();
  return Object.entries(pipeline)
    .filter(([, entry]) => entry.stage === "fechado")
    .map(([jid, entry]) => ({ jid, ...entry }));
}

/** Marca um marco de aniversário (em dias) como já enviado, pra nunca mandar duas vezes o mesmo. */
export async function markAnniversarySent(jid, milestoneDays) {
  const pipeline = await loadPipeline();
  const entry = pipeline[jid];
  if (!entry) return;
  const sent = new Set(entry.anniversariesSent || []);
  sent.add(milestoneDays);
  pipeline[jid] = { ...entry, anniversariesSent: Array.from(sent) };
  await savePipeline(pipeline);
}

/** Resumo com contagem por estágio + lista de quem está "negociando" (o que precisa de ação sua). */
export async function getPipelineSummary() {
  const pipeline = await loadPipeline();
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const negociando = [];

  for (const [jid, entry] of Object.entries(pipeline)) {
    if (counts[entry.stage] === undefined) counts[entry.stage] = 0;
    counts[entry.stage]++;
    if (entry.stage === "negociando") negociando.push({ jid, ...entry });
  }

  negociando.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return { counts, negociando, total: Object.keys(pipeline).length };
}
