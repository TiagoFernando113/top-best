# Bot de conexão permanente ([TOP] Best)

Este bot fica ligado 24h no Discord pra fazer duas coisas que o bot de
`/comandos` (Supabase) não consegue, porque aquele só responde HTTP e nunca lê
o chat:

- traduz automaticamente mensagens de jogadores que não escreverem em português
- pendura o seletor 🌐 de tradução privada nos avisos de evento
- responde com o GIF de rosas quando alguém menciona "Lady" ou "Maelle"

## Tradução privada (o seletor 🌐)

A aliança tem gente lendo em português, inglês, árabe e japonês. Traduzir cada
aviso para todos os idiomas de uma vez deixaria o canal de eventos ilegível —
um aviso viraria oito versões empilhadas.

Então o bot **não traduz nada no canal**. Ele pendura um seletor 🌐 embaixo da
mensagem; quem escolhe um idioma recebe o texto traduzido numa resposta
**efêmera**, que só essa pessoa vê. O canal fica com uma linha a mais, não com
oito.

Quem atende o clique é o `top-discord` (Supabase Edge Function), no ramo
`traduzir-msg:` — este bot só guarda o texto original em `discord_msg_traducao`
e manda o id junto no seletor, porque o `custom_id` do Discord só cabe 100
caracteres e um aviso de evento passa disso fácil.

Para traduzir uma mensagem qualquer que não tenha seletor, cada pessoa também
pode usar **clique direito na mensagem → Apps → Translate**, que já responde no
idioma salvo em `/mylanguage`.

## 1. No Discord Developer Portal

1. **Resetar o token do bot** (o antigo foi exposto em uma conversa):
   `discord.com/developers/applications` → sua aplicação (CYRON) → **Bot** →
   **Reset Token** → copie o novo token e guarde só nos secrets do host (não
   cole aqui, nem no chat).
2. Na mesma página **Bot**, ligue o toggle **MESSAGE CONTENT INTENT**
   (em "Privileged Gateway Intents"). Sem isso o bot recebe as mensagens
   vazias e não consegue traduzir nada.

## 2. Variáveis de ambiente

Veja `.env.example`. Você precisa de 3 valores:

- `DISCORD_BOT_TOKEN` — o token novo do passo 1
- `SUPABASE_URL` — já preenchido no exemplo
- `SUPABASE_SERVICE_ROLE_KEY` — em supabase.com → seu projeto → Project
  Settings → API → `service_role` (secreta, nunca vai no código nem no
  front-end)

## 3. Deploy

Qualquer host que rode um processo Node continuamente funciona. Duas opções
simples com Dockerfile já pronto nesta pasta:

**Fly.io**
```
brew install flyctl   # ou veja fly.io/docs/flyctl/install
fly auth signup        # ou login, se já tiver conta
cd discord-bot-gateway
fly launch --no-deploy  # aceite gerar o fly.toml, escolha a região mais perto
fly secrets set DISCORD_BOT_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
fly deploy
```

**Railway**
- railway.app → New Project → Deploy from GitHub repo → selecione este repositório e a pasta `discord-bot-gateway`
- em Variables, adicione as 3 variáveis de ambiente acima
- Railway detecta o Dockerfile e sobe sozinho

Depois do primeiro deploy manual, dá pra automatizar (todo push atualiza o
bot sozinho) — é só avisar depois de escolher o host e eu configuro isso.
