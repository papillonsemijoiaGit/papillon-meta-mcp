import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { prepare, take } from "./confirm";
import { BASE_URL, type Env } from "./env";
import { Graph } from "./graph";
import {
  advance,
  getJob,
  listJobs,
  publishFacebook,
  saveJob,
  validate,
  type JobInstagram,
  type Publicacao,
} from "./publish";

const INSTRUCOES = `Conector do Instagram e da Página do Facebook da Papillon Semijoias (Meta).
Toda ferramenta que publica ou altera algo funciona em duas etapas: a primeira chamada só devolve uma prévia e um confirmacao_id; mostre a prévia ao Marcelo e só repita a chamada com confirmacao_id depois que ele aprovar explicitamente aquele item. Nunca confirme por conta própria.
O Instagram não tem agendamento nativo na API: posts agendados para o Instagram ficam na fila deste conector (meta_agendados) e são publicados por ele, conferindo a cada 5 minutos; não aparecem no Planejador do Meta Business Suite. Os do Facebook são agendados na própria Meta.
Mídias precisam estar em link público: use URLs de imagens já publicadas (site, Mercado Livre) ou envie o arquivo com meta_link_upload. Imagens para o Instagram precisam ser JPEG.
Anúncios pagos ficam no conector oficial Meta Ads, não aqui.`;

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function tool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  description: string,
  schema: S,
  readOnly: boolean,
  run: (args: z.infer<S>) => Promise<unknown>,
) {
  // Generic wrapper: the SDK's overloads can't infer through a generic schema.
  (server.registerTool as Function).call(
    server,
    name,
    { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: false } },
    async (args: z.infer<S>) => {
      try {
        return text(await run(args));
      } catch (e) {
        return { ...text({ erro: e instanceof Error ? e.message : String(e) }), isError: true };
      }
    },
  );
}

const confirmacao = z.string().optional().describe("Só na segunda chamada: o confirmacao_id da prévia aprovada pelo Marcelo.");
const rede = z.enum(["instagram", "facebook"]);
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const IG_CONTA = ["reach", "views", "accounts_engaged", "total_interactions", "profile_links_taps"];
const IG_POST = ["reach", "views", "saved", "shares", "likes", "comments", "total_interactions"];
const FB_CONTA = ["page_media_view", "page_post_engagements", "page_follows"];
const FB_POST = ["post_media_view", "post_clicks", "post_reactions_by_type_total"];

export function buildServer(env: Env) {
  const server = new McpServer({ name: "papillon-meta", version: "1.0.0" }, { instructions: INSTRUCOES });
  const g = new Graph(env);

  // ---------- Contas ----------

  tool(server, "meta_contas",
    "Página do Facebook e Instagram conectados: nome, seguidores, número de posts, bio e site.",
    z.object({}), true,
    async () => {
      const c = await g.conta();
      const [page, ig] = await Promise.all([
        g.call(`/${c.page_id}`, { query: { fields: "name,link,followers_count,fan_count,category,website" } }),
        g.call(`/${c.ig_id}`, { query: { fields: "username,name,followers_count,follows_count,media_count,biography,website" } }),
      ]);
      return { facebook: page, instagram: ig, conectado_em: c.conectado_em };
    });

  // ---------- Posts e métricas ----------

  tool(server, "meta_posts",
    "Posts publicados, do mais novo para o mais antigo, com legenda, tipo, link e curtidas/comentários. Para posts agendados use meta_agendados.",
    z.object({ rede, limite: z.number().int().min(1).max(50).default(20), after: z.string().optional().describe("Cursor da próxima página.") }), true,
    async ({ rede, limite, after }) => {
      const c = await g.conta();
      if (rede === "instagram") {
        return g.call(`/${c.ig_id}/media`, {
          query: { fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url", limit: limite, after },
        });
      }
      return g.call(`/${c.page_id}/posts`, {
        query: { fields: "id,message,created_time,permalink_url,status_type,attachments{media_type,url}", limit: limite, after },
      });
    });

  tool(server, "meta_metricas",
    `Métricas da conta (por período) ou de um post. Padrões: Instagram conta ${IG_CONTA.join(", ")}; Instagram post ${IG_POST.join(", ")}; Facebook Página ${FB_CONTA.join(", ")}; Facebook post ${FB_POST.join(", ")}. A Meta renomeia métricas com frequência: se recusar alguma, passe a lista em metricas.`,
    z.object({
      rede,
      post_id: z.string().optional().describe("Sem post_id: métricas da conta no período."),
      dias: z.number().int().min(1).max(30).default(28).describe("Período até hoje, para métricas da conta."),
      metricas: z.array(z.string()).optional(),
    }), true,
    async ({ rede, post_id, dias, metricas }) => {
      const c = await g.conta();
      if (post_id) {
        const metric = (metricas ?? (rede === "instagram" ? IG_POST : FB_POST)).join(",");
        return g.call(`/${post_id}/insights`, { query: { metric } });
      }
      const since = unix(new Date(Date.now() - dias * 86_400_000));
      const until = unix(new Date());
      if (rede === "instagram") {
        return g.call(`/${c.ig_id}/insights`, {
          query: { metric: (metricas ?? IG_CONTA).join(","), period: "day", metric_type: "total_value", since, until },
        });
      }
      return g.call(`/${c.page_id}/insights`, { query: { metric: (metricas ?? FB_CONTA).join(","), period: "day", since, until } });
    });

  // ---------- Mídia ----------

  tool(server, "meta_link_upload",
    "Gera um link de envio (válido por 1 hora, uso único) para subir uma foto ou vídeo que ainda não está na internet. Envie o arquivo com HTTP PUT (ex.: curl -T arquivo.jpg -H 'content-type: image/jpeg' <upload_url>) e use media_url em meta_publicar. Até 100 MB. Fotos para o Instagram precisam ser JPEG.",
    z.object({
      nome_arquivo: z.string().regex(/^[\w.-]+$/).describe("Ex.: brinco-gota.jpg"),
      content_type: z.enum(["image/jpeg", "image/png", "video/mp4", "video/quicktime"]),
    }), false,
    async ({ nome_arquivo, content_type }) => {
      const key = `${crypto.randomUUID()}/${nome_arquivo}`;
      const token = crypto.randomUUID();
      await env.META_KV.put(`upload:${token}`, JSON.stringify({ key, content_type }), { expirationTtl: 3600 });
      return {
        upload_url: `${BASE_URL}/upload/${token}`,
        media_url: `${BASE_URL}/media/${key}`,
        exemplo: `curl -sS -T ${nome_arquivo} -H 'content-type: ${content_type}' ${BASE_URL}/upload/${token}`,
      };
    });

  // ---------- Publicar e agendar ----------

  tool(server, "meta_publicar",
    "Publica ou agenda foto, carrossel (2 a 10), Reels ou Story no Instagram, no Facebook ou nos dois. Sem horario publica na confirmação. Facebook: agendamento nativo de 10 minutos a 30 dias. Instagram: entra na fila do conector e sai no horário (conferência a cada 5 minutos). Primeira chamada valida as mídias e devolve a prévia; a segunda, só com confirmacao_id, publica ou agenda.",
    z.object({
      formato: z.enum(["post", "carrossel", "reels", "story"]).optional(),
      midias: z.array(z.object({ url: z.string().url(), tipo: z.enum(["imagem", "video"]) })).min(1).max(10).optional(),
      legenda: z.string().max(2200).optional().describe("Até 2.200 caracteres e 30 hashtags no Instagram."),
      redes: z.array(rede).min(1).optional(),
      horario: z.string().optional().describe("ISO 8601 com fuso, ex.: 2026-10-05T19:00:00-03:00 (Brasília). Omita para publicar agora."),
      alt_text: z.string().max(1000).optional().describe("Texto alternativo da foto (só post simples no Instagram)."),
      confirmacao_id: confirmacao,
    }), false,
    async ({ confirmacao_id, ...input }) => {
      if (confirmacao_id) {
        const { acao } = await take<{ pub: Publicacao; quando: number }>(env, "meta_publicar", confirmacao_id);
        const { pub, quando } = acao;
        const resultados: unknown[] = [];
        if (pub.redes.includes("facebook")) {
          try {
            resultados.push(await publishFacebook(g, pub, quando));
          } catch (e) {
            resultados.push({ rede: "facebook", erro: e instanceof Error ? e.message : String(e) });
          }
        }
        if (pub.redes.includes("instagram")) {
          let job: JobInstagram = { id: crypto.randomUUID(), pub, quando, estado: "agendado", criado_em: new Date().toISOString() };
          if (quando <= Date.now() + 60_000) job = await advance(g, job, true, 45 - g.calls);
          await saveJob(env, job);
          resultados.push({
            rede: "instagram",
            fila_id: job.id,
            estado: job.estado,
            ...(job.estado === "agendado" ? { publica_em: new Date(quando).toISOString() } : {}),
            ...(job.estado === "processando" ? { aviso: "A Meta ainda está processando o vídeo; o conector publica sozinho em até 5 minutos." } : {}),
            ...(job.resultado ? { publicado: job.resultado } : {}),
            ...(job.erro ? { erro: job.erro } : {}),
          });
        }
        return { status: "CONCLUIDO", resultados };
      }

      const { formato, midias, redes } = input;
      if (!formato || !midias || !redes) throw new Error("Informe formato, midias e redes para gerar a prévia.");
      const pub: Publicacao = { formato, midias, redes, legenda: input.legenda, horario: input.horario, alt_text: input.alt_text };
      const { quando, avisos } = await validate(env, BASE_URL, pub);
      const quandoTexto = input.horario
        ? new Date(quando).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
        : "agora, na confirmação";
      return prepare(env, "meta_publicar", `${formato} em ${redes.join(" e ")}, ${quandoTexto}`, { pub, quando }, {
        formato, redes, quando: quandoTexto, legenda: pub.legenda, midias, alt_text: pub.alt_text, avisos,
      });
    });

  tool(server, "meta_agendados",
    "Posts agendados e histórico recente: a fila do Instagram deste conector (agendados, processando, publicados e erros dos últimos 14 dias) e os posts agendados na Página do Facebook.",
    z.object({}), true,
    async () => {
      const c = await g.conta();
      const [fila, fb] = await Promise.all([
        listJobs(env),
        g.call(`/${c.page_id}/scheduled_posts`, { query: { fields: "id,message,scheduled_publish_time,created_time" } }),
      ]);
      return {
        instagram: fila.map((j) => ({
          fila_id: j.id,
          estado: j.estado,
          publica_em: new Date(j.quando).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
          formato: j.pub.formato,
          legenda: j.pub.legenda,
          midias: j.pub.midias,
          ...(j.resultado ? { publicado: j.resultado } : {}),
          ...(j.erro ? { erro: j.erro } : {}),
        })),
        facebook: fb.data,
      };
    });

  tool(server, "meta_cancelar_agendado",
    "Cancela um post agendado: no Instagram pelo fila_id (só se ainda não saiu); no Facebook pelo id do post agendado. Para mudar o horário, cancele e agende de novo. Primeira chamada devolve a prévia; a segunda, só com confirmacao_id, cancela.",
    z.object({ rede: rede.optional(), id: z.string().optional(), confirmacao_id: confirmacao }), false,
    async ({ rede, id, confirmacao_id }) => {
      if (confirmacao_id) {
        const { acao } = await take<{ rede: "instagram" | "facebook"; id: string }>(env, "meta_cancelar_agendado", confirmacao_id);
        if (acao.rede === "facebook") return { status: "CANCELADO", resultado: await g.call(`/${acao.id}`, { method: "DELETE" }) };
        const job = await getJob(env, acao.id);
        if (!job || job.estado !== "agendado") throw new Error(`Não dá mais para cancelar: estado ${job?.estado ?? "inexistente"}.`);
        job.estado = "cancelado";
        await saveJob(env, job);
        return { status: "CANCELADO", fila_id: job.id };
      }
      if (!rede || !id) throw new Error("Informe rede e id para gerar a prévia.");
      if (rede === "instagram") {
        const job = await getJob(env, id);
        if (!job || job.estado !== "agendado") throw new Error(`Post da fila não encontrado ou não está agendado (estado ${job?.estado ?? "inexistente"}).`);
        return prepare(env, "meta_cancelar_agendado", `Cancelar o ${job.pub.formato} do Instagram agendado`, { rede, id }, {
          publica_em: new Date(job.quando).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }), legenda: job.pub.legenda,
        });
      }
      const post = await g.call(`/${id}`, { query: { fields: "id,message,scheduled_publish_time,is_published" } });
      if (post.is_published) throw new Error("Este post do Facebook já foi publicado.");
      return prepare(env, "meta_cancelar_agendado", "Cancelar o post agendado na Página do Facebook", { rede, id }, post);
    });

  // ---------- Comentários ----------

  tool(server, "meta_comentarios",
    "Comentários de um post, ou dos últimos posts quando post_id é omitido, com respostas já dadas e se estão ocultos.",
    z.object({ rede, post_id: z.string().optional(), ultimos_posts: z.number().int().min(1).max(10).default(5) }), true,
    async ({ rede, post_id, ultimos_posts }) => {
      const c = await g.conta();
      const fields = rede === "instagram"
        ? "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}"
        : "id,message,from,created_time,is_hidden,comment_count,comments{id,message,from,created_time}";
      const ids: { id: string; legenda?: string; link?: string }[] = post_id
        ? [{ id: post_id }]
        : rede === "instagram"
          ? (await g.call(`/${c.ig_id}/media`, { query: { fields: "id,caption,permalink", limit: ultimos_posts } })).data.map((p: any) => ({ id: p.id, legenda: p.caption, link: p.permalink }))
          : (await g.call(`/${c.page_id}/posts`, { query: { fields: "id,message,permalink_url", limit: ultimos_posts } })).data.map((p: any) => ({ id: p.id, legenda: p.message, link: p.permalink_url }));
      return Promise.all(ids.map(async (p) => ({ ...p, comentarios: (await g.call(`/${p.id}/comments`, { query: { fields, limit: 50 } })).data })));
    });

  tool(server, "meta_responder_comentario",
    "Responde um comentário no Instagram ou no Facebook. Primeira chamada com comment_id e texto devolve a prévia com o comentário original; a segunda, só com confirmacao_id, publica a resposta.",
    z.object({ rede: rede.optional(), comment_id: z.string().optional(), texto: z.string().max(2200).optional(), confirmacao_id: confirmacao }), false,
    async ({ rede, comment_id, texto, confirmacao_id }) => {
      if (confirmacao_id) {
        const { acao } = await take<{ rede: string; comment_id: string; texto: string }>(env, "meta_responder_comentario", confirmacao_id);
        const path = acao.rede === "instagram" ? `/${acao.comment_id}/replies` : `/${acao.comment_id}/comments`;
        return { status: "PUBLICADO", resultado: await g.call(path, { body: { message: acao.texto } }) };
      }
      if (!rede || !comment_id || !texto) throw new Error("Informe rede, comment_id e texto para gerar a prévia.");
      const original = await g.call(`/${comment_id}`, { query: { fields: rede === "instagram" ? "text,username,timestamp" : "message,from,created_time" } });
      return prepare(env, "meta_responder_comentario", `Responder comentário no ${rede}`, { rede, comment_id, texto }, { comentario: original, resposta: texto });
    });

  tool(server, "meta_ocultar_comentario",
    "Oculta (ou volta a mostrar) um comentário no Instagram ou no Facebook, por exemplo spam ou ofensa. Primeira chamada devolve a prévia; a segunda, só com confirmacao_id, aplica.",
    z.object({ rede: rede.optional(), comment_id: z.string().optional(), ocultar: z.boolean().default(true), confirmacao_id: confirmacao }), false,
    async ({ rede, comment_id, ocultar, confirmacao_id }) => {
      if (confirmacao_id) {
        const { acao } = await take<{ rede: string; comment_id: string; ocultar: boolean }>(env, "meta_ocultar_comentario", confirmacao_id);
        const body = acao.rede === "instagram" ? { hide: acao.ocultar } : { is_hidden: acao.ocultar };
        return { status: "APLICADO", resultado: await g.call(`/${acao.comment_id}`, { body }) };
      }
      if (!rede || !comment_id) throw new Error("Informe rede e comment_id para gerar a prévia.");
      const original = await g.call(`/${comment_id}`, { query: { fields: rede === "instagram" ? "text,username" : "message,from" } });
      return prepare(env, "meta_ocultar_comentario", `${ocultar ? "Ocultar" : "Mostrar de novo"} comentário no ${rede}`, { rede, comment_id, ocultar }, original);
    });

  // ---------- Acesso genérico ----------

  tool(server, "meta_consultar",
    "GET em qualquer recurso da Graph API (https://graph.facebook.com/v25.0) com o acesso da Página, para o que as outras ferramentas não cobrem: hashtags (ig_hashtag_search), menções, dados públicos de concorrentes (business_discovery), conversas do Direct e do Messenger etc.",
    z.object({
      caminho: z.string().describe("Ex.: /{ig_id}?fields=business_discovery.username(concorrente){followers_count,media_count}"),
      parametros: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }), true,
    async ({ caminho, parametros }) => {
      const c = await g.conta();
      return g.call(caminho.replaceAll("{ig_id}", c.ig_id).replaceAll("{page_id}", c.page_id), { query: parametros });
    });

  tool(server, "meta_executar",
    "POST ou DELETE em qualquer recurso da Graph API, para ações que as outras ferramentas não cobrem. Sempre com prévia: a primeira chamada só descreve; a segunda, só com confirmacao_id, executa.",
    z.object({
      metodo: z.enum(["POST", "DELETE"]).optional(),
      caminho: z.string().optional(),
      corpo: z.record(z.string(), z.any()).optional(),
      resumo: z.string().optional().describe("Em uma frase, o que esta ação faz, para o Marcelo aprovar."),
      confirmacao_id: confirmacao,
    }), false,
    async ({ metodo, caminho, corpo, resumo, confirmacao_id }) => {
      if (confirmacao_id) {
        const { acao } = await take<{ metodo: "POST" | "DELETE"; caminho: string; corpo?: Record<string, unknown> }>(env, "meta_executar", confirmacao_id);
        return { status: "EXECUTADO", resultado: await g.call(acao.caminho, { method: acao.metodo, body: acao.corpo }) };
      }
      if (!metodo || !caminho || !resumo) throw new Error("Informe metodo, caminho e resumo para gerar a prévia.");
      const c = await g.conta();
      const path = caminho.replaceAll("{ig_id}", c.ig_id).replaceAll("{page_id}", c.page_id);
      return prepare(env, "meta_executar", resumo, { metodo, caminho: path, corpo }, { metodo, caminho: path, corpo });
    });

  return server;
}
