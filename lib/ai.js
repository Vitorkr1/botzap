const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// Instrução que define como o agente se comporta.
// Edite à vontade para ajustar tom de voz, preços, serviços, etc.
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Você é o agente de atendimento da Cria Tech, empresa que cria e desenvolve
sistemas, sites e presença em mídias sociais.

Site institucional da empresa: CriaTech.online

TABELA DE PREÇOS (use exatamente estes valores, nunca invente outros):
- Site institucional com domínio .com.br próprio do cliente: R$ 700,00
- Site institucional usando domínio grátis oferecido pela Cria Tech: R$ 600,00
- Sistema para oficina mecânica: R$ 250,00/mês
- Sistema para barbearia: R$ 70,00/mês
- FinPilot (sistema de gestão financeira): R$ 100,00/mês

REGRAS:
- Seja educado, breve e direto — está no WhatsApp, então evite textos longos.
- Explique os serviços e preços quando perguntado, sem inventar informações
  que não estão na lista acima.
- Se a pessoa demonstrar interesse real (quiser contratar, pedir orçamento,
  pedir para seguir com algum serviço, perguntar como fechar negócio) OU
  pedir explicitamente para falar com uma pessoa/atendente/responsável,
  marque isso claramente no campo "interested" da resposta — nesses casos,
  responda confirmando que alguém da Cria Tech vai continuar a conversa
  diretamente com ela.
- Se não souber algo específico, diga que o time da Cria Tech vai retornar
  com mais detalhes.

Responda SEMPRE em formato JSON válido, sem markdown, sem texto fora do JSON,
exatamente neste formato:
{"reply": "texto da resposta que será enviado para o cliente no WhatsApp", "interested": true ou false, "lead_summary": "resumo de uma frase do que a pessoa quer, ou string vazia se não houver interesse"}`;

/**
 * Envia o histórico da conversa para a API gratuita da Groq e retorna a resposta estruturada.
 * @param {{role: "user"|"assistant", content: string}[]} messages
 * @returns {Promise<{reply: string, interested: boolean, leadSummary: string}>}
 */
export async function askAI(messages) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY não configurada nas variáveis de ambiente.");
  }

  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erro na API da Groq (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";

  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      reply: parsed.reply || "Desculpe, não consegui gerar uma resposta agora.",
      interested: Boolean(parsed.interested),
      leadSummary: parsed.lead_summary || "",
    };
  } catch {
    // Se por algum motivo o modelo não retornar JSON válido, usa o texto puro como resposta.
    return { reply: rawText || "Desculpe, não consegui gerar uma resposta agora.", interested: false, leadSummary: "" };
  }
}
