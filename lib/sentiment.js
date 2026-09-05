// Heurística simples pra detectar quando um lead parece bravo ou frustrado,
// pra escalar direto pra um humano ao invés de deixar a IA continuar
// respondendo de forma genérica numa situação já desgastada.

const FRUSTRATION_PHRASES = [
  "ja disse que nao",
  "ja falei que nao",
  "para de me mandar",
  "pare de me mandar",
  "chega de mensagem",
  "cansei disso",
  "que saco",
  "enchendo o saco",
  "para de encher",
  "irritante",
  "nao enche",
  "va se",
  "some daqui",
  "bloqueei",
  "vou bloquear",
  "denunciar",
  "denuncia",
  "golpe",
  "picareta",
];

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Detecta se o texto tem sinais de frustração/irritação do lead. */
export function isFrustrated(text) {
  if (!text) return false;
  const normalized = normalize(text);

  if (FRUSTRATION_PHRASES.some((phrase) => normalized.includes(phrase))) return true;

  // Texto em CAIXA ALTA (mais de 10 letras, maioria maiúscula) costuma
  // indicar tom alterado.
  const letters = text.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (letters.length >= 10) {
    const upper = text.replace(/[^A-ZÀ-Þ]/g, "");
    if (upper.length / letters.length > 0.7) return true;
  }

  // Pontuação de exclamação/interrogação repetida ("???", "!!!!") costuma
  // indicar irritação.
  if (/[!?]{3,}/.test(text)) return true;

  return false;
}
