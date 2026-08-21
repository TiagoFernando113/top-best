/* Bot de conexao permanente da alianca [TOP] Best.
 *
 * Diferente do "top-discord" (Supabase Edge Function, que so responde a
 * /comandos via HTTP), este processo fica conectado o tempo todo no gateway
 * do Discord porque precisa LER as mensagens do chat pra:
 *   1) traduzir automaticamente o que os jogadores escrevem em outro idioma
 *   2) reagir com o GIF de rosas quando alguem menciona a Lady ou a Maelle
 *
 * Roda em qualquer host que mantenha um processo Node vivo (Fly.io, Railway,
 * uma VPS, etc). Nao guarda nenhum segredo no codigo: tudo vem de variavel
 * de ambiente (ver .env.example).
 */

import { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

for (const [nome, valor] of Object.entries({ DISCORD_BOT_TOKEN: TOKEN, SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY })) {
  if (!valor) {
    console.error(`Faltou a variavel de ambiente ${nome}. Confira o .env / os secrets do host.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

/* ---------------- Supabase (mesmo padrao do top-discord) ---------------- */

async function sb(caminho) {
  const r = await fetch(`${SB_URL}/rest/v1/${caminho}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return await r.json();
}

async function sbPost(caminho, corpo) {
  const r = await fetch(`${SB_URL}/rest/v1/${caminho}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation",
    },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return await r.json();
}

const cacheAlianca = new Map(); // guildId -> { v, t }
async function aliancaDoGuild(guildId) {
  const achado = cacheAlianca.get(guildId);
  if (achado && Date.now() - achado.t < 5 * 60 * 1000) return achado.v;
  let v = null;
  try {
    const r = await sb(`alianca_discord?guild_id=eq.${encodeURIComponent(guildId)}&select=alianca_id`);
    v = r?.[0]?.alianca_id ?? null;
  } catch { /* tenta de novo na proxima mensagem */ }
  cacheAlianca.set(guildId, { v, t: Date.now() });
  return v;
}

let cacheGifRosas = { v: null, t: 0 };
async function gifRosas() {
  if (cacheGifRosas.v && Date.now() - cacheGifRosas.t < 10 * 60 * 1000) return cacheGifRosas.v;
  let v = null;
  try {
    const r = await sb(`discord_gifs?uso=eq.rosas&ativo=eq.true&select=url&limit=1`);
    v = r?.[0]?.url ?? null;
  } catch { /* sem gif por enquanto, sem problema */ }
  cacheGifRosas = { v, t: Date.now() };
  return v;
}

async function gifBoasVindas() {
  try {
    const r = await sb(`discord_gifs?uso=eq.boas_vindas&ativo=eq.true&select=url`);
    const opcoes = (r || []).map((x) => x.url).filter(Boolean);
    return opcoes.length ? opcoes[Math.floor(Math.random() * opcoes.length)] : null;
  } catch {
    return null;
  }
}

async function tagDaAlianca(aliancaId) {
  try {
    const r = await sb(`alianca_discord?alianca_id=eq.${aliancaId}&select=aliancas(tag,nome)`);
    const a = r?.[0]?.aliancas;
    return a ? `${a.tag ?? ""} ${a.nome ?? ""}`.trim() : "aliança";
  } catch {
    return "aliança";
  }
}

/* ---------------- seletor de idioma nas boas-vindas ---------------- */

/* Mesma lista (e mesmos codigos) do /meuidioma no bot de comandos -- clicar
   aqui ou digitar o comando salvam na mesma tabela. */
const LINGUAS_MENU = [
  ["pt", "Português", "🇧🇷"], ["en", "Inglês", "🇬🇧"], ["es", "Espanhol", "🇪🇸"], ["ko", "Coreano", "🇰🇷"],
  ["ja", "Japonês", "🇯🇵"], ["zh-CN", "Chinês", "🇨🇳"], ["de", "Alemão", "🇩🇪"], ["fr", "Francês", "🇫🇷"],
  ["it", "Italiano", "🇮🇹"], ["ru", "Russo", "🇷🇺"], ["ar", "Árabe", "🇸🇦"], ["tr", "Turco", "🇹🇷"],
  ["id", "Indonésio", "🇮🇩"], ["th", "Tailandês", "🇹🇭"], ["vi", "Vietnamita", "🇻🇳"], ["pl", "Polonês", "🇵🇱"],
  ["nl", "Holandês", "🇳🇱"], ["tl", "Filipino", "🇵🇭"], ["hi", "Hindi", "🇮🇳"], ["uk", "Ucraniano", "🇺🇦"],
];

function menuIdioma() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("escolher-idioma")
    .setPlaceholder("Selecione seu idioma / Select your language")
    .addOptions(LINGUAS_MENU.map(([value, label, emoji]) => ({ label, value, emoji })));
  return [new ActionRowBuilder().addComponents(select)];
}

function idDoWebhook(url) {
  const m = String(url || "").match(/\/webhooks\/(\d+)\//);
  return m ? m[1] : null;
}

const cacheWebhooks = new Map(); // aliancaId -> { v: {webhook, webhook_boas_vindas}, t }
async function webhookEhBoasVindas(aliancaId, webhookId) {
  let achado = cacheWebhooks.get(aliancaId);
  if (!achado || Date.now() - achado.t > 5 * 60 * 1000) {
    let cfg = {};
    try {
      const r = await sb(`alianca_discord?alianca_id=eq.${aliancaId}&select=webhook,webhook_boas_vindas`);
      cfg = r?.[0] || {};
    } catch { /* tenta de novo na proxima */ }
    achado = { v: cfg, t: Date.now() };
    cacheWebhooks.set(aliancaId, achado);
  }
  const alvo = idDoWebhook(achado.v.webhook_boas_vindas) || idDoWebhook(achado.v.webhook);
  return !!alvo && alvo === String(webhookId);
}

/* O aviso de boas-vindas sai por um webhook (nao pelo bot), entao a gente
   detecta esse post e responde por baixo com o seletor -- assim quem acabou
   de entrar ja recebe o convite pra escolher o idioma na hora. */
async function talvezMandarSeletorIdioma(msg) {
  try {
    const aliancaId = await aliancaDoGuild(msg.guild.id);
    if (!aliancaId) return;
    if (!(await webhookEhBoasVindas(aliancaId, msg.webhookId))) return;
    await msg.reply({
      content: "🌐 Select your language / Escolha seu idioma:",
      components: menuIdioma(),
      allowedMentions: { repliedUser: false },
    });
  } catch (e) {
    console.error("erro ao mandar seletor de idioma:", e?.message || e);
  }
}

/* Descobre o canal de boas-vindas a partir do webhook salvo -- so a URL fica
   guardada, entao pergunta pro proprio Discord qual canal ela aponta. */
const cacheCanalBv = new Map(); // aliancaId -> { v: channelId|null, t }
async function canalBoasVindas(aliancaId) {
  const achado = cacheCanalBv.get(aliancaId);
  if (achado && Date.now() - achado.t < 30 * 60 * 1000) return achado.v;
  let v = null;
  try {
    const cfg = await sb(`alianca_discord?alianca_id=eq.${aliancaId}&select=webhook,webhook_boas_vindas`);
    const url = cfg?.[0]?.webhook_boas_vindas || cfg?.[0]?.webhook;
    if (url) {
      const r = await fetch(url);
      if (r.ok) v = (await r.json())?.channel_id ?? null;
    }
  } catch { /* tenta de novo na proxima */ }
  cacheCanalBv.set(aliancaId, { v, t: Date.now() });
  return v;
}

/* Quem entra direto pelo Discord (sem passar pelo cadastro do portal) nao
   dispara o gatilho do banco -- esse listener cobre esse caso, mandando o
   mesmo aviso com GIF + seletor de idioma direto pelo bot. */
client.on("guildMemberAdd", async (member) => {
  try {
    /* Cada desistencia daqui pra baixo fala por que. Antes tudo era silencioso
       (`.catch(() => {})`), e quando as boas-vindas pararam nao havia uma linha
       de log dizendo se foi o canal, a permissao ou o vinculo -- so o canal
       vazio. Quem entra no Discord entra uma vez: nao da pra reproduzir depois. */
    const quem = member.displayName || member.user.username;

    const aliancaId = await aliancaDoGuild(member.guild.id);
    if (!aliancaId) {
      return console.error(`boas-vindas ${quem}: servidor ${member.guild.id} nao esta ligado a nenhuma alianca`);
    }
    const canalId = await canalBoasVindas(aliancaId);
    if (!canalId) {
      return console.error(`boas-vindas ${quem}: nao achei o canal (webhook de boas-vindas caiu ou nao esta configurado)`);
    }
    const canal = await member.guild.channels.fetch(canalId).catch((e) => {
      console.error(`boas-vindas ${quem}: nao consegui abrir o canal ${canalId}:`, e?.message || e);
      return null;
    });
    if (!canal) return;
    if (!canal.isTextBased?.()) {
      return console.error(`boas-vindas ${quem}: o canal ${canalId} nao aceita mensagem`);
    }

    const [gif, tag] = await Promise.all([gifBoasVindas(), tagDaAlianca(aliancaId)]);
    await canal.send({
      embeds: [{
        title: `🎉 Boas-vindas, ${quem}!`,
        description: `Entrou na **${tag}**. Bem-vindo(a) ao time!`,
        color: 6208835,
        ...(gif ? { image: { url: gif } } : {}),
        footer: { text: "🌐 Escolha seu idioma abaixo / Pick your language below" },
      }],
      components: menuIdioma(),
    }).then(
      () => console.log(`boas-vindas: ${quem} recebido em #${canal.name}`),
      (e) => console.error(`boas-vindas ${quem}: o Discord recusou o envio em #${canal.name} (falta permissao no canal?):`, e?.message || e),
    );
  } catch (e) {
    console.error("erro ao dar boas-vindas:", e?.message || e);
  }
});

/* ---------------- traducao (mesmo endpoint publico que o site ja usa) ---------------- */

const IDIOMA = {
  pt: { nome: "Português", bandeira: "🇧🇷" }, en: { nome: "Inglês", bandeira: "🇬🇧" },
  es: { nome: "Espanhol", bandeira: "🇪🇸" }, ko: { nome: "Coreano", bandeira: "🇰🇷" },
  ja: { nome: "Japonês", bandeira: "🇯🇵" }, zh: { nome: "Chinês", bandeira: "🇨🇳" },
  "zh-cn": { nome: "Chinês", bandeira: "🇨🇳" }, "zh-CN": { nome: "Chinês", bandeira: "🇨🇳" },
  "zh-tw": { nome: "Chinês", bandeira: "🇨🇳" }, de: { nome: "Alemão", bandeira: "🇩🇪" },
  fr: { nome: "Francês", bandeira: "🇫🇷" }, it: { nome: "Italiano", bandeira: "🇮🇹" },
  ru: { nome: "Russo", bandeira: "🇷🇺" }, ar: { nome: "Árabe", bandeira: "🇸🇦" },
  tr: { nome: "Turco", bandeira: "🇹🇷" }, id: { nome: "Indonésio", bandeira: "🇮🇩" },
  th: { nome: "Tailandês", bandeira: "🇹🇭" }, vi: { nome: "Vietnamita", bandeira: "🇻🇳" },
  pl: { nome: "Polonês", bandeira: "🇵🇱" }, nl: { nome: "Holandês", bandeira: "🇳🇱" },
  tl: { nome: "Filipino", bandeira: "🇵🇭" }, hi: { nome: "Hindi", bandeira: "🇮🇳" },
  uk: { nome: "Ucraniano", bandeira: "🇺🇦" },
};

/* Idiomas pra sempre cobrir, mesmo sem ninguem ter configurado /meuidioma ainda. */
const IDIOMAS_BASE = ["pt", "en"];
const MAX_IDIOMAS_EXTRA = 6; // trava de seguranca: no maximo 8 traducoes por mensagem (2 base + 6 extras)

/* A lista de idiomas "ativos" cresce sozinha conforme os jogadores configuram
   /meuidioma no bot de comandos -- ninguem precisa avisar quais idiomas a
   alianca fala, o bot descobre pelo uso real. */
let cacheIdiomas = { v: IDIOMAS_BASE, t: 0 };
async function idiomasAtivos() {
  if (Date.now() - cacheIdiomas.t < 60 * 1000) return cacheIdiomas.v;
  let extras = [];
  try {
    const r = await sb(`discord_idioma_jogador?select=idioma&order=atualizado_em.desc&limit=200`);
    const vistos = new Set();
    for (const row of r || []) {
      const cod = row.idioma;
      if (!cod || IDIOMAS_BASE.includes(cod) || vistos.has(cod)) continue;
      vistos.add(cod);
      extras.push(cod);
      if (extras.length >= MAX_IDIOMAS_EXTRA) break;
    }
  } catch { /* mantem o cache anterior/base */ }
  const v = [...IDIOMAS_BASE, ...extras];
  cacheIdiomas = { v, t: Date.now() };
  return v;
}

let falhasSeguidas = 0;
let tradutorFora = 0; // timestamp ate quando o tradutor fica desligado

async function traduzir(texto, alvo) {
  if (Date.now() < tradutorFora) return null;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${alvo}&dt=t&q=${encodeURIComponent(texto)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const idioma = j?.[2] || "";
    const traduzido = (j?.[0] || []).map((p) => p?.[0] || "").join("");
    falhasSeguidas = 0;
    return { idioma, traduzido };
  } catch {
    falhasSeguidas++;
    if (falhasSeguidas >= 8) {
      tradutorFora = Date.now() + 10 * 60 * 1000; // desliga 10min e tenta de novo depois
      falhasSeguidas = 0;
    }
    return null;
  }
}

/* Evita gasto/ruido com mensagens que nao valem a pena traduzir: comandos,
   so link, so emoji/numeros, ou muito curtas pra dar pro detector de idioma
   confiar no resultado.

   O teto e' parametro porque depende do destino: traducao que vai pro canal
   para em 800 (acima disso vira parede de texto), mas a que fica atras do
   seletor nao ocupa tela nenhuma, entao pode ir bem mais longe. */
function vantajosoTraduzir(texto, teto = 800) {
  if (texto.length < 2 || texto.length > teto) return false;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(texto)) return false;
  if (/^https?:\/\/\S+$/i.test(texto)) return false;
  if (/^[\d\s.,:!?-]+$/.test(texto)) return false;
  if (/^[/!.][a-z]/i.test(texto)) return false; // parece comando
  return true;
}

/* ---------------- traducao sob demanda, pra texto grande ----------------

   Recado curto sai traduzido no canal mesmo, em todos os idiomas da alianca:
   sao duas ou tres linhas e resolve sem ninguem clicar em nada. Texto grande
   e' o oposto -- em oito idiomas vira uma redacao que empurra a conversa pra
   cima. Nesse caso o bot nao traduz pra ninguem: pendura o seletor, e quem
   quiser abre no proprio idioma numa resposta efemera que so ele enxerga.

   Quem atende o clique e' o top-discord (Supabase), no ramo "traduzir-msg:".
   O texto vai pro banco porque o custom_id do Discord so cabe 100 caracteres,
   e um aviso de evento passa disso facil. */

const TEXTO_GRANDE = 300;   // daqui pra cima a traducao publica ocuparia mais tela que o original
const TEXTO_MAXIMO = 3500;  // teto do que cabe guardar e traduzir sob demanda

async function guardarPraTraduzir(texto) {
  const r = await sbPost("discord_msg_traducao", { texto: texto.slice(0, 4000) });
  return r?.[0]?.id ?? null;
}

/* Mesma lista do menuIdioma, com outro custom_id: aqui a escolha nao salva o
   idioma da pessoa por si so -- ela pede a traducao desta mensagem. (O
   top-discord aproveita e salva junto, entao clicar aqui tambem ensina ao bot
   mais um idioma da alianca.) */
function menuTraduzir(id) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`traduzir-msg:${id}`)
    .setPlaceholder("🌐 Ler no seu idioma / Read in your language")
    .addOptions(LINGUAS_MENU.map(([value, label, emoji]) => ({ label, value, emoji })));
  return [new ActionRowBuilder().addComponents(select)];
}

/* ---------------- limite simples por pessoa, pra ninguem floodar o tradutor ---------------- */

const janelaPorAutor = new Map(); // authorId -> [timestamps]
function podeTraduzirAgora(authorId) {
  const agora = Date.now();
  const lista = (janelaPorAutor.get(authorId) || []).filter((t) => agora - t < 60_000);
  if (lista.length >= 6) { janelaPorAutor.set(authorId, lista); return false; }
  lista.push(agora);
  janelaPorAutor.set(authorId, lista);
  return true;
}

/* ---------------- mencao a Lady / Maelle ---------------- */

function normalizar(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function mencionaLadyOuMaelle(texto) {
  return /\b(lady|maelle)\b/.test(normalizar(texto));
}

/* ---------------- evento principal ---------------- */

/* Traduz pra todo idioma que a alianca realmente usa, numa unica resposta
   (uma mensagem por idioma viraria spam). A lista de idiomas vem de
   idiomasAtivos() -- cresce sozinha conforme o uso de /meuidioma. Serve tanto
   pra mensagem de jogador quanto pra aviso automatico (evento, dica do dia).

   Acima de TEXTO_GRANDE a resposta troca de forma: em vez das traducoes, sai
   so o seletor. */
async function traduzirEResponder(msg, texto) {
  if (texto.length >= TEXTO_GRANDE) {
    if (!vantajosoTraduzir(texto, TEXTO_MAXIMO)) return;
    const id = await guardarPraTraduzir(texto).catch(() => null);
    if (id) {
      await msg.reply({
        content: "-# 🌐 Texto longo — escolha seu idioma / long text, pick your language",
        components: menuTraduzir(id),
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      return;
    }
    /* Banco fora do ar: melhor cair na resposta longa de sempre do que deixar
       quem nao le portugues sem entender nada. */
  }

  if (!vantajosoTraduzir(texto)) return;
  const alvos = await idiomasAtivos();
  const [primeiroAlvo, ...restoAlvos] = alvos;
  const primeira = await traduzir(texto, primeiroAlvo);
  if (!primeira || !primeira.idioma) return;

  const origem = primeira.idioma;
  const resultados = [];
  if (origem !== primeiroAlvo && primeira.traduzido) resultados.push([primeiroAlvo, primeira.traduzido]);

  const restantes = restoAlvos.filter((a) => a !== origem);
  const traduzidos = await Promise.all(restantes.map((a) => traduzir(texto, a)));
  traduzidos.forEach((r, idx) => { if (r?.traduzido) resultados.push([restantes[idx], r.traduzido]); });

  const linhas = resultados
    .filter(([, txt]) => txt.trim().toLowerCase() !== texto.toLowerCase())
    .map(([cod, txt]) => `${IDIOMA[cod]?.bandeira ?? "🌐"} **${IDIOMA[cod]?.nome ?? cod}:** ${txt}`);

  if (linhas.length) {
    await msg.reply({
      embeds: [{ color: 0x5865f2, description: linhas.join("\n").slice(0, 4000) }],
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
  }
}

client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;

    if (msg.webhookId) {
      const aliancaId = await aliancaDoGuild(msg.guild.id);
      if (!aliancaId) return;

      if (await webhookEhBoasVindas(aliancaId, msg.webhookId)) {
        await talvezMandarSeletorIdioma(msg);
        return; // e' so o convite pra escolher idioma, sem texto pra traduzir
      }

      /* Avisos automaticos (evento, dica do dia, arena) vem como embed -- o
         texto que importa esta la, nao em msg.content (que as vezes so tem
         "@everyone"). */
      const emb = msg.embeds?.[0];
      const texto = String(emb ? [emb.title, emb.description].filter(Boolean).join("\n") : (msg.content || "")).trim();
      if (podeTraduzirAgora(msg.webhookId)) await traduzirEResponder(msg, texto);
      return;
    }
    if (msg.author.bot) return;

    const texto = String(msg.content || "").trim();
    if (!texto) return;

    const aliancaId = await aliancaDoGuild(msg.guild.id);
    if (!aliancaId) return; // servidor ainda nao ligado ao portal (/configurar servidor)

    if (mencionaLadyOuMaelle(texto)) {
      const url = await gifRosas();
      if (url) msg.reply({ files: [url], allowedMentions: { repliedUser: false } }).catch(() => {});
    }

    if (podeTraduzirAgora(msg.author.id)) await traduzirEResponder(msg, texto);
  } catch (e) {
    console.error("erro ao processar mensagem:", e?.message || e);
  }
});

client.once("clientReady", () => {
  console.log(`Conectado como ${client.user.tag}, em ${client.guilds.cache.size} servidor(es).`);
});

client.on("error", (e) => console.error("erro do client:", e?.message || e));
process.on("unhandledRejection", (e) => console.error("rejeicao nao tratada:", e));

client.login(TOKEN);
