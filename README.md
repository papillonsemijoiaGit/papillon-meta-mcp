# Papillon · Meta (conector MCP)

Servidor MCP hospedado na Cloudflare que conecta o Claude ao Instagram e à Página do Facebook da Papillon.
Endereço: `https://papillon-meta.papillonsemijoia.workers.dev/mcp`

## O que o Claude consegue fazer

| Área | Ferramentas |
| --- | --- |
| Contas | `meta_contas` (Página e Instagram, seguidores, bio) |
| Posts e métricas | `meta_posts`, `meta_metricas` |
| Mídia | `meta_link_upload` (link de envio de foto ou vídeo, até 100 MB) |
| Publicar e agendar | `meta_publicar` (post, carrossel, Reels, Story; Instagram, Facebook ou os dois), `meta_agendados`, `meta_cancelar_agendado` |
| Comentários | `meta_comentarios`, `meta_responder_comentario`, `meta_ocultar_comentario` |
| Qualquer outra API | `meta_consultar` (leitura), `meta_executar` (escrita) |

Toda ferramenta que publica ou altera algo funciona em duas etapas: a primeira devolve só uma prévia; nada é feito até o Marcelo aprovar e o Claude repetir a chamada com o `confirmacao_id`.

### Agendamento

- **Facebook:** agendamento nativo da Meta, de 10 minutos a 30 dias à frente.
- **Instagram:** a API não tem agendamento. O post aprovado fica na fila deste Worker (KV `META_KV`) e um cron a cada 5 minutos publica o que venceu. Esses posts não aparecem no Planejador do Meta Business Suite; use `meta_agendados`.

### Mídia

A Meta baixa cada arquivo de um link público na hora de publicar. Imagens já na internet (site, Mercado Livre) podem ser usadas direto. Arquivos novos sobem com `meta_link_upload` para o bucket R2 `papillon-meta-media` e ficam em `/media/<id>/<nome>`. O Instagram só aceita fotos em JPEG.

## Como funciona o login

1. O Claude se conecta a `/mcp` e é mandado para `/authorize`, que pede permissão.
2. Ao permitir, o administrador entra no Facebook (login do Facebook para empresas, Graph API v25.0) e volta em `/meta/callback`.
3. O Worker troca o código por um token de longa duração e guarda o token da Página, que não expira. A Página precisa ter o Instagram profissional vinculado.
4. A primeira Página que conectar fica gravada como dona; nenhuma outra é aceita depois.

## Publicar (Cloudflare Workers Builds)

1. Cloudflare › R2: ative o R2 (até 10 GB é grátis). O bucket `papillon-meta-media` é criado no primeiro deploy; se o deploy reclamar do bucket, crie-o em R2 › Create bucket com esse nome.
2. Workers & Pages › Create › Import a repository › este repositório. Nome do Worker `papillon-meta`, build command vazio, deploy command `npx wrangler deploy`.
3. No Worker, Settings › Variables and Secrets, adicione como **Secret**: `META_APP_ID` e `META_APP_SECRET` (Configurações do app › Básico, no app da Meta). `META_WEBHOOK_TOKEN` fica para a segunda etapa.
4. Cada push na branch principal publica de novo. Os dois KV (`papillon-meta-oauth-kv` e `papillon-meta-meta-kv`) já existem e estão fixados pelo id no `wrangler.jsonc`, junto com o cron.

No app da Meta (modo de desenvolvimento):
- Casos de uso: "Gerenciar tudo na sua Página" e "Gerenciar mensagens e conteúdo no Instagram" (configuração da API com login do Facebook).
- URI de redirecionamento do OAuth: `https://papillon-meta.papillonsemijoia.workers.dev/meta/callback`

## Conectar no Claude

Configurações › Conectores › Adicionar conector personalizado › URL `https://papillon-meta.papillonsemijoia.workers.dev/mcp`. No login do Facebook, marque só a Página e o Instagram da Papillon.

## Desenvolvimento

```sh
npm install
npm run check   # typecheck + bundle de teste
```

Para rodar local, crie `.dev.vars` com `META_APP_ID` e `META_APP_SECRET` e use `npm run dev`. A descoberta OAuth só responde no endereço configurado em `BASE_URL` (`src/env.ts`).
