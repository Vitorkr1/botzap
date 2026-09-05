// Manda notificação push pro celular via ntfy.sh — gratuito, sem precisar
// criar conta. Só funciona se NTFY_TOPIC estiver configurado no .env.
//
// Como usar:
// 1. Baixe o app "ntfy" (Android/iOS) ou acesse ntfy.sh no navegador
// 2. Escolha um nome de tópico único e difícil de adivinhar (ex: criatech-bot-x7k2)
// 3. Se inscreva nesse tópico no app
// 4. Coloque o mesmo nome na variável NTFY_TOPIC no .env / Render

const NTFY_TOPIC = process.env.NTFY_TOPIC;

export async function sendAlert(title, message, { click, priority = "high", tags = "warning" } = {}) {
  if (!NTFY_TOPIC) {
    console.log(`[alerta ignorado, NTFY_TOPIC não configurado] ${title}: ${message}`);
    return;
  }

  // Headers HTTP só aceitam caracteres ASCII — emoji no título quebraria o
  // envio, então tiramos aqui e deixamos só no corpo da mensagem, que aceita.
  const asciiTitle = title.replace(/[^\x00-\x7F]/g, "").trim();

  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: asciiTitle,
        Priority: priority,
        Tags: tags,
        // "Click": ao tocar na notificação, abre direto esse link (ex: a
        // conversa do lead no WhatsApp) — opcional, só manda se informado.
        ...(click ? { Click: click } : {}),
      },
      body: message,
    });
  } catch (err) {
    console.error("Erro ao mandar alerta via ntfy:", err);
  }
}
