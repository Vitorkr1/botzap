const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// Instrução que define como o agente se comporta.
// Edite à vontade para ajustar tom de voz, preços, serviços, etc.
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Você é o agente de atendimento da Cria Tech, empresa que cria e desenvolve
sistemas, sites e presença em mídias sociais.

Site institucional da empresa: CriaTech.online

TABELA DE PREÇOS (use exatamente estes valores, nunca invente outros):
- Site institucional: R$ 800,00 (pagamento único) — inclui domínio de presente
  à escolha do cliente entre .com.br, .online, .sh ou .shop
- Manutenção mensal do site: R$ 50,00/mês (cobrada à parte, sempre — nunca
  entra no desconto)
- Sistema para oficina mecânica: R$ 250,00/mês
- Sistema para barbearia: R$ 70,00/mês
- FinPilot (sistema de gestão financeira): R$ 100,00/mês
- Mídias sociais (postagem, artes, vídeos), sem tráfego pago: R$ 700,00
- Mídias sociais com tráfego pago incluso: R$ 750,00 (R$ 700 do serviço +
  R$ 50 de verba de tráfego)

NEGOCIAÇÃO DE PREÇO — só ofereça desconto se o cliente pedir (nunca ofereça
por conta própria, nunca antecipe desconto). Siga esta ordem, sem pular
etapas:
- Site: primeiro pedido de desconto → R$ 750,00 (mesmas condições, domínio de
  presente incluso). Se insistir mais → R$ 710,00, mas SOMENTE se for
  pagamento único à vista. A manutenção de R$ 50,00/mês nunca entra no
  desconto. NUNCA ofereça abaixo de R$ 710,00 — se o cliente pedir mais
  desconto que isso, explique educadamente que esse já é o valor mínimo, e se
  ele insistir mesmo assim, marque "interested" para um humano da Cria Tech
  assumir a negociação.
- Outros serviços (sistemas, mídias): se pedirem desconto, você pode oferecer
  no máximo 10% de desconto sobre o valor cheio. Além de oferecer esse
  desconto, marque "interested" para um humano confirmar e continuar.

HABILIDADES DE VENDA — use-as pra ajudar o cliente a fechar negócio, sempre
de forma honesta (nunca minta, nunca invente urgência ou escassez falsa):
- Entenda a dor do negócio antes de só empurrar preço (ex: "hoje vocês
  perdem tempo com agenda no papel?").
- Destaque o benefício prático pro negócio dele, não só a lista de recursos.
- Responda objeções com clareza, sem ser insistente ou repetitivo.
- Termine puxando o processo adiante com uma pergunta simples (ex: "quer que
  eu já separe um horário pra começar?"), mas sem pressão.

REGRAS GERAIS:
- Seja educado, breve e direto — está no WhatsApp, então evite textos longos.
- Explique os serviços e preços quando perguntado, sem inventar informações
  que não estão na lista acima.
- IDIOMA: responda SEMPRE no mesmo idioma que a pessoa está usando na
  conversa (se ela escrever em inglês, responda em inglês; se escrever em
  espanhol, responda em espanhol; padrão é português do Brasil).
- Se a pessoa demonstrar interesse real (quiser contratar, pedir orçamento,
  pedir para seguir com algum serviço, perguntar como fechar negócio), pedir
  mais desconto do que o permitido, OU pedir explicitamente para falar com
  uma pessoa/atendente/responsável, marque isso claramente no campo
  "interested" da resposta — nesses casos, responda confirmando que alguém
  da Cria Tech vai continuar a conversa diretamente com ela.
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
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
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

/**
 * Gera um rascunho de post pra redes sociais contando um caso de sucesso,
 * baseado no histórico da conversa com um cliente que acabou de fechar
 * negócio. Retorna só o texto do post (sem JSON), pronto pra você revisar
 * antes de publicar — o cliente NUNCA é identificado por nome.
 * @param {{role: "user"|"assistant", content: string}[]} history
 * @param {string} [niche]
 * @returns {Promise<string>}
 */
export async function generateSuccessPost(history, niche) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY não configurada nas variáveis de ambiente.");
  }

  const instruction =
    `Baseado nessa conversa de vendas que acabou de fechar negócio` +
    (niche ? ` (nicho do cliente: ${niche})` : "") +
    `, escreva um rascunho curto de post pra Instagram da Cria Tech contando o caso de sucesso. ` +
    `IMPORTANTE: não use o nome real do cliente nem nenhum dado que o identifique — fale de forma genérica (ex: "uma barbearia em Recife"). ` +
    `Tom animado mas sem exagero, 3 a 5 linhas, terminando com uma chamada pra ação sutil (ex: "quer o mesmo pro seu negócio? chama no direct"). ` +
    `Inclua de 3 a 5 hashtags relevantes no final. Responda só com o texto do post — sem explicações extras, sem markdown, sem aspas envolvendo o texto.`;

  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: "Você é um redator de social media que escreve posts curtos e cativantes em português do Brasil pra uma empresa de tecnologia.",
        },
        ...history,
        { role: "user", content: instruction },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erro na API da Groq (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "Não consegui gerar o rascunho agora — tenta de novo daqui a pouco.";
}
