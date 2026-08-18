# WhatsApp + IA gratuita (Groq) — agente de vendas da Cria Tech

Bot que conecta ao seu WhatsApp normal (via QR code, como o WhatsApp Web) e
responde automaticamente **só quem NÃO está salvo na sua agenda**,
apresentando os serviços e preços da Cria Tech. Contatos salvos nunca
recebem resposta automática — você já os conhece, então essas conversas
ficam por sua conta, como sempre.

**Handoff automático:** quando a IA percebe que a pessoa quer mesmo
contratar, pedir orçamento, ou pede explicitamente para falar com uma
pessoa/atendente, o bot:
1. Manda essa última resposta confirmando que alguém vai continuar com ela
2. **Para de responder automaticamente esse número** — a conversa passa a
   ser 100% sua, manual
3. Te avisa na sua própria conversa "Você" no WhatsApp, com o número do
   contato e um resumo do que a pessoa quer

Tabela de preços configurada em `lib/ai.js` (`SYSTEM_PROMPT`):
- Site institucional com domínio .com.br próprio: R$ 700,00
- Site institucional com domínio grátis da Cria Tech: R$ 600,00
- Sistema para oficina: R$ 250,00/mês
- Sistema para barbearia: R$ 70,00/mês
- FinPilot (gestão financeira): R$ 100,00/mês
- Site: CriaTech.online

Pra mudar preços ou adicionar serviços, edite direto o `SYSTEM_PROMPT` em
`lib/ai.js`.

⚠️ **Sobre a sincronização de contatos:** o WhatsApp manda a lista de
contatos salvos como parte da sincronização de histórico, que acontece
pouco depois de conectar — não instantaneamente, pode levar alguns
segundos (ou minutos, em contas com muitos contatos/conversas). Enquanto
isso não termina, o bot pode responder a alguém que na verdade já está
salvo. Como reforço, use a variável `NEVER_AUTO_REPLY_NUMBERS` no `.env`
pra listar manualmente números que nunca devem receber resposta automática
(família, amigos, clientes que você já atende pessoalmente etc.), garantindo
que esses nunca sejam respondidos mesmo que a sincronização demore.

⚠️ **Sobre a Groq (IA):** é gratuita de verdade, sem cartão de crédito e sem
custo mensal, mas tem um limite diário de requisições/tokens (varia por
modelo, geralmente bem generoso para uso de uma empresa pequena). Se algum
dia estourar o limite, o bot mostra o erro no lugar de responder; nesse caso
é só trocar `GROQ_MODEL` no `.env` por outro modelo disponível, ou esperar o
limite resetar (24h). Crie sua chave grátis em
[console.groq.com/keys](https://console.groq.com/keys) (sem cartão).

⚠️ **Sobre o WhatsApp:** isso usa a biblioteca
[Baileys](https://github.com/WhiskeySockets/Baileys), uma implementação
não-oficial do protocolo do WhatsApp Web (não é a API oficial da Meta).
Funciona bem para uso pessoal/moderado, mas o WhatsApp pode banir números que
enviam volume alto de mensagens automatizadas. Use com moderação e por sua
conta e risco.

## 1. Testar localmente

```bash
npm install
cp .env.example .env
# edite o .env e coloque sua GROQ_API_KEY (gratuita, pegue em console.groq.com/keys)
npm start
```

Um QR code vai aparecer no terminal. No celular: **WhatsApp → Configurações →
Aparelhos conectados → Conectar um aparelho** e escaneie.

Se preferir escanear pelo navegador (mais fácil em alguns terminais), acesse
`http://localhost:3000/qr` enquanto o servidor estiver rodando.

Depois de conectado, mande uma mensagem de um número que NÃO está salvo na
sua agenda — o agente deve responder sozinho. Um número que já está salvo
não recebe resposta automática. E, assim que a pessoa demonstrar interesse
de verdade (ou pedir pra falar com alguém), o bot responde uma última vez,
fica quieto pra esse número dali em diante, e te avisa.

## 2. Subir para o GitHub

```bash
cd whatsapp-ai-bot
git init
git add .
git commit -m "primeiro commit"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/SEU-REPO.git
git push -u origin main
```

O `.gitignore` já exclui `node_modules`, `.env`, `auth/` e `data/` — nunca
suba sua sessão do WhatsApp nem sua chave da Groq pro GitHub.

## 3. Deploy no Render

1. No painel do Render: **New → Web Service** → conecte o repositório do GitHub.
2. Configurações:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
3. Em **Environment**, adicione as variáveis do `.env.example` (pelo menos
   `GROQ_API_KEY`). Ajuste `AUTH_DIR` e `DATA_DIR` para dentro do disco
   persistente (próximo passo).
4. **Adicione um Persistent Disk** (aba *Disks*, disponível em planos pagos):
   monte em, por exemplo, `/var/data`, e configure `AUTH_DIR=/var/data/auth`
   e `DATA_DIR=/var/data/data`.
   - **Sem isso**, a cada novo deploy o Render apaga o filesystem e você
     precisa escanear o QR code de novo, e a lista de "contatos já
     conhecidos" também se perde.
5. Depois do primeiro deploy, acesse `https://SEU-APP.onrender.com/qr` pra
   escanear o QR code (não dá pra ver o terminal do Render facilmente).

## Personalizando o comportamento

- **Texto/tom do agente:** edite `SYSTEM_PROMPT` no `.env` (ou direto em
  `lib/ai.js`).
- **Responder também contatos salvos:** em `index.js`, remova a linha
  `if (savedContactJids.has(jid)) return;` dentro de `handleMessage`.
- **Responder em grupos:** defina `RESPOND_TO_GROUPS=true` no `.env`.
- **Ligar sua base de dados / sistema:** dentro de `handleMessage`, antes de
  chamar `askAI`, você pode buscar dados do seu sistema (CRM, agenda, etc.)
  e incluir no `SYSTEM_PROMPT` ou como contexto extra na mensagem.

## Estrutura

```
index.js          # conexão com o WhatsApp (Baileys) + roteamento de mensagens
lib/ai.js          # chamada à API gratuita da Groq (Llama 3.3)
lib/contacts.js     # controla quem já é "contato conhecido" + histórico curto
```
