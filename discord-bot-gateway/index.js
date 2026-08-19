/* Bot de conexao permanente da alianca [TOP] Best.
 *
 * Diferente do "top-discord" (Supabase Edge Function, que so responde a
 * /comandos via HTTP), este processo fica conectado o tempo todo no gateway
 * do Discord porque precisa LER as mensagens do chat pra:
 *   1) traduzir automaticamente o que os jogadores escrevem em outro idioma
 *   2) pendurar o seletor de traducao privada nos avisos de evento, que chegam
 *      por webhook e por isso nao conseguem trazer o seletor junto
 *   3) reagir com o GIF de rosas quando alguem menciona a Lady ou a Maelle
 *
 * Roda em qualquer host que mantenha um processo Node vivo (Fly.io, Railway,
 * uma VPS, etc). Nao guarda nenhum segredo no codigo: tudo vem de variavel
 * de ambiente (ver .env.example).
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";

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

/* ---------------- traducao (mesmo endpoint publico que o site ja usa) ---------------- */

const IDIOMA_NOME = {
  en: "inglês", es: "espanhol", ko: "coreano", ja: "japonês", zh: "chinês", "zh-cn": "chinês",
  "zh-tw": "chinês", de: "alemão", fr: "francês", it: "italiano", ru: "russo", ar: "árabe",
  tr: "turco", id: "indonésio", th: "tailandês", vi: "vietnamita", pl: "polonês", nl: "holandês",
  tl: "filipino", hi: "hindi",
};

let falhasSeguidas = 0;
let tradutorFora = 0; // timestamp ate quando o tradutor fica desligado

async function traduzir(texto) {
  if (Date.now() < tradutorFora) return null;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t&q=${encodeURIComponent(texto)}`;
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
   confiar no resultado. */
function vantajosoTraduzir(texto) {
  if (texto.length < 4 || texto.length > 800) return false;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(texto)) return false;
  if (/^https?:\/\/\S+$/i.test(texto)) return false;
  if (/^[\d\s.,:!?-]+$/.test(texto)) return false;
  if (/^[/!.][a-z]/i.test(texto)) return false; // parece comando
  return true;
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

/* ---------------- traducao privada, um idioma por pessoa ----------------

   Traduzir pra todo mundo de uma vez encheria o canal: a alianca ja tem gente
   em ingles, arabe e japones, e um aviso de evento sairia em oito versoes
   empilhadas. Entao o bot nao traduz pra ninguem no canal -- ele so pendura um
   seletor. Quem escolhe recebe o texto no proprio idioma numa resposta efemera,
   que so ele enxerga (quem atende o clique e o top-discord, no Supabase, no
   ramo "traduzir-msg:").

   O texto original vai pro banco porque o custom_id cabe 100 chars e uma
   mensagem de evento passa disso facil; no clique o top-discord busca o texto
   por esse id. */

async function guardarPraTraduzir(texto) {
  const r = await sbPost("discord_msg_traducao", { texto: texto.slice(0, 4000) });
  return r?.[0]?.id ?? null;
}

/* Os codigos tem que bater com o LINGUAS do top-discord, que recusa o que nao
   conhece. O rotulo vai no proprio idioma de proposito: quem nao le portugues
   precisa achar a propria linha na lista sem depender de traducao. */
const LINGUA_NATIVA = {
  pt: "🇧🇷 Português", en: "🇺🇸 English", es: "🇪🇸 Español", ko: "🇰🇷 한국어",
  ja: "🇯🇵 日本語", "zh-CN": "🇨🇳 中文", de: "🇩🇪 Deutsch", fr: "🇫🇷 Français",
  it: "🇮🇹 Italiano", ru: "🇷🇺 Русский", ar: "🇸🇦 العربية", tr: "🇹🇷 Türkçe",
  id: "🇮🇩 Bahasa Indonesia", th: "🇹🇭 ไทย", vi: "🇻🇳 Tiếng Việt", pl: "🇵🇱 Polski",
  nl: "🇳🇱 Nederlands", tl: "🇵🇭 Filipino", hi: "🇮🇳 हिन्दी", uk: "🇺🇦 Українська",
};

function seletorTraduzir(id) {
  return [{
    type: 1,
    components: [{
      type: 3, custom_id: `traduzir-msg:${id}`,
      placeholder: "🌐 Read in your language",
      options: Object.entries(LINGUA_NATIVA).map(([valor, rotulo]) => ({ label: rotulo, value: valor })),
    }],
  }];
}

/* Junta o que da pra ler de um aviso automatico (eles vem como embed via
   webhook, nao como texto solto). */
function textoDoAviso(msg) {
  const partes = [];
  for (const e of msg.embeds || []) {
    if (e.title) partes.push(e.title);
    if (e.description) partes.push(e.description);
    for (const f of e.fields || []) {
      if (f.name) partes.push(f.name);
      if (f.value) partes.push(f.value);
    }
  }
  if (!partes.length && msg.content) partes.push(msg.content);
  return partes.join("\n\n").trim();
}

/* ---------------- mencao a Lady / Maelle ---------------- */

function normalizar(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function mencionaLadyOuMaelle(texto) {
  return /\b(lady|maelle)\b/.test(normalizar(texto));
}

/* ---------------- evento principal ---------------- */

client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author.id === client.user?.id) return; // nunca reage ao proprio recado

    /* Os avisos de evento chegam por webhook, e webhook comum nao consegue
       mandar seletor junto -- por isso o bot precisa entrar depois e pendurar
       o dele por fora. Antes esta linha descartava webhook, e era justamente o
       canal de eventos que ficava sem tradutor. Bot comum continua de fora. */
    const deWebhook = Boolean(msg.webhookId);
    if (msg.author.bot && !deWebhook) return;

    const aliancaId = await aliancaDoGuild(msg.guild.id);
    if (!aliancaId) return; // servidor ainda nao ligado ao portal (/configurar servidor)

    if (deWebhook) {
      /* O card de boas-vindas ja sai do webhook com o proprio seletor de
         idioma; pendurar um segundo em cima dele so confundiria. */
      const aviso = msg.components?.length ? "" : textoDoAviso(msg);
      if (aviso.length >= 4) {
        const id = await guardarPraTraduzir(aviso).catch(() => null);
        if (id) {
          await msg.reply({
            content: "-# 🌐 Read this in your language",
            components: seletorTraduzir(id),
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
      }
      return; // aviso automatico nao leva GIF de rosas nem traducao publica
    }

    const texto = String(msg.content || "").trim();
    if (!texto) return;

    if (mencionaLadyOuMaelle(texto)) {
      const url = await gifRosas();
      if (url) msg.reply({ files: [url], allowedMentions: { repliedUser: false } }).catch(() => {});
    }

    if (vantajosoTraduzir(texto) && podeTraduzirAgora(msg.author.id)) {
      const r = await traduzir(texto);
      if (r && r.idioma && r.idioma !== "pt" && r.traduzido) {
        const igual = r.traduzido.trim().toLowerCase() === texto.toLowerCase();
        if (!igual) {
          const rotulo = IDIOMA_NOME[r.idioma] || r.idioma;
          /* A linha em portugues fica publica de proposito: e uma linha so, no
             idioma da casa, e resolve pra maioria sem ninguem clicar em nada.
             O seletor ao lado atende quem nao le portugues -- e ele traduz o
             ORIGINAL, nao esta traducao, pra nao virar telefone sem fio. */
          const id = await guardarPraTraduzir(texto).catch(() => null);
          await msg.reply({
            content: `🌐 *${rotulo} → pt:* ${r.traduzido}`.slice(0, 1900),
            ...(id ? { components: seletorTraduzir(id) } : {}),
            allowedMentions: { repliedUser: false },
          }).catch(() => {});
        }
      }
    }
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
