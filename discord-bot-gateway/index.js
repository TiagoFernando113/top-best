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
  /* O minimo subiu de 2 pra 12 porque agora TODA mensagem ganharia seletor,
     nao so as de outro idioma. "ok", "kkkk", "sim", "boa" nao precisam de
     tradutor -- e uma caixa embaixo de cada uma dessas encheria o canal de
     coisa inutil. Doze caracteres e mais ou menos onde comeca a frase. */
  if (texto.length < 12 || texto.length > teto) return false;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(texto)) return false;
  if (/^https?:\/\/\S+$/i.test(texto)) return false;
  if (/^[\d\s.,:!?-]+$/.test(texto)) return false;
  if (/^[/!.][a-z]/i.test(texto)) return false; // parece comando
  /* So risadas e interjeicoes: "kkkkkk", "hahaha", "rsrsrs", "hehe". */
  if (/^[kkhaeirs\s!?.]+$/i.test(texto)) return false;
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

const TEXTO_MAXIMO = 3500;  // teto do que cabe guardar e traduzir sob demanda


async function guardarPraTraduzir(texto, link) {
  const r = await sbPost("discord_msg_traducao", {
    texto: texto.slice(0, 4000),
    /* O link e o que permite a traducao oferecer o caminho de volta: a resposta
       efemera nasce no fim do canal, e sem ele quem toca num recado antigo tem
       que rolar de volta na mao. */
    link: link || null,
  });
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

/* Uma resposta, um seletor, e a traducao acontece no clique.

   Antes o bot traduzia pra todos os idiomas da alianca e despejava tudo no
   canal. Isso tinha tres defeitos que so apareceram no uso: quem escreveu a
   mensagem via a traducao do proprio texto (sujeira pura, ela ja sabe o que
   escreveu), cada pessoa lia uma linha e ignorava as outras quatro, e o bot
   gastava cinco chamadas de traducao por mensagem.

   Agora o bot so descobre em que idioma a mensagem esta -- uma chamada -- e
   guarda o texto. Quem quer ler toca no seletor e recebe so o seu idioma, numa
   resposta que so ele enxerga. Trocar de idioma depois reescreve aquela mesma
   resposta no lugar, sem empilhar (quem faz isso e o top-discord, no ramo
   "traduzir-msg:").

   Serve pra mensagem de jogador e pra aviso automatico igual. */
async function traduzirEResponder(msg, texto) {
  if (!vantajosoTraduzir(texto, TEXTO_MAXIMO)) return;

  /* O seletor vale pra qualquer idioma, inclusive portugues.

     A primeira versao pulava portugues, com medo de encher o canal de caixas.
     Errado: metade da alianca nao le portugues, e pular significava que os
     recados da casa eram justamente os que ninguem de fora conseguia ler --
     o contrario do que o tradutor existe pra fazer. Agora vale pros dois
     lados, e ninguem depende do idioma de quem escreveu.

     Sem deteccao de idioma aqui: nao ha mais nada pra decidir com ela, e a
     traducao acontece no clique. Zero chamada de traducao por mensagem. */
  const id = await guardarPraTraduzir(texto, msg.url).catch(() => null);
  if (!id) return;

  /* O seletor vai dentro de um topico preso na mensagem, nao solto no canal.

     Duas coisas melhoram de uma vez. No canal sobra so a linha fina do topico
     ("Ver topico"), bem menor que uma caixa de seletor embaixo de cada recado.
     E a resposta com a traducao, que e efemera, nasce no fim do lugar onde foi
     pedida -- dentro do topico isso e logo abaixo do seletor, porque o topico
     tem uma mensagem so. Some o "desce la embaixo": nao ha pra onde descer.

     Solto no canal a efemera ia parar no fim de tudo, e quem tocasse num
     recado antigo perdia o lugar na conversa.

     Uma hora de arquivamento: passado esse tempo o topico sai da lista de
     ativos sozinho, senao um chat movimentado viraria um cemiterio deles. */
  const topico = await msg.startThread({
    name: "🌐 Tradução",
    autoArchiveDuration: 60,
  }).catch((e) => {
    console.error(`traducao: nao consegui criar topico em #${msg.channel?.name}:`, e?.message || e);
    return null;
  });

  const corpo = {
    content: "🌐 Escolha seu idioma / Pick your language",
    components: menuTraduzir(id),
    allowedMentions: { parse: [] },
  };

  /* Sem topico (falta de permissao, canal que nao aceita), o seletor volta a
     sair solto no canal. Pior de posicao, mas melhor que ficar sem tradutor.
     Aqui o metodo muda junto: topico manda com send, mensagem com reply. */
  await (topico
    ? topico.send(corpo)
    : msg.reply({ ...corpo, allowedMentions: { parse: [], repliedUser: false } })
  ).catch((e) => console.error("traducao: nao consegui mandar o seletor:", e?.message || e));
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
