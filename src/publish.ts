import type { Env } from "./env";
import { Graph, type Params } from "./graph";

export type Rede = "instagram" | "facebook";
export type Formato = "post" | "carrossel" | "reels" | "story";

export interface Midia {
  url: string;
  tipo: "imagem" | "video";
}

export interface Publicacao {
  formato: Formato;
  midias: Midia[];
  legenda?: string;
  redes: Rede[];
  horario?: string; // ISO 8601 with offset; absent = now
  alt_text?: string;
}

// Instagram has no native scheduling: each Instagram post lives in KV until the cron publishes it.
export interface JobInstagram {
  id: string;
  pub: Publicacao;
  quando: number; // epoch ms
  estado: "agendado" | "processando" | "publicado" | "erro" | "cancelado";
  filhos?: string[]; // carousel item containers
  container?: string;
  resultado?: { id: string; permalink?: string };
  erro?: string;
  criado_em: string;
}

const FILA = "fila:";
const KEEP_DONE_SECONDS = 14 * 86_400;
const FB_MIN_MS = 10 * 60_000;
const FB_MAX_MS = 30 * 86_400_000;

// Checks a publication before the preview so the confirm call only fails on Meta's side.
export async function validate(env: Env, origin: string, pub: Publicacao): Promise<{ quando: number; avisos: string[] }> {
  const avisos: string[] = [];
  const n = pub.midias.length;
  const videos = pub.midias.filter((m) => m.tipo === "video").length;
  if (pub.formato === "post" && (n !== 1 || videos)) throw new Error("Post simples leva exatamente 1 imagem. Para vídeo use reels.");
  if (pub.formato === "carrossel" && (n < 2 || n > 10)) throw new Error("Carrossel leva de 2 a 10 mídias.");
  if (pub.formato === "reels" && (n !== 1 || !videos)) throw new Error("Reels leva exatamente 1 vídeo.");
  if (pub.formato === "story" && n !== 1) throw new Error("Story leva exatamente 1 mídia.");
  if (pub.redes.includes("facebook")) {
    if (pub.formato === "story") throw new Error("Stories no Facebook ainda não estão no conector (segunda etapa). Escolha só instagram.");
    if (pub.formato === "carrossel" && videos) throw new Error("No Facebook o post com várias mídias aceita só imagens.");
  }

  const quando = pub.horario ? Date.parse(pub.horario) : Date.now();
  if (Number.isNaN(quando)) throw new Error("horario inválido. Use ISO 8601 com fuso, ex.: 2026-10-05T19:00:00-03:00.");
  const ate = quando - Date.now();
  if (pub.horario && ate < 0) throw new Error("horario já passou. Omita o horario para publicar agora.");
  if (pub.redes.includes("facebook") && pub.horario) {
    if (ate > FB_MAX_MS) throw new Error("O Facebook só agenda até 30 dias à frente.");
    if (ate < FB_MIN_MS) avisos.push("Facebook: menos de 10 minutos à frente, então será publicado na hora da confirmação.");
  }

  // Meta downloads each file itself, so every URL must be public and the right type.
  await Promise.all(
    pub.midias.map(async (m) => {
      let tipo: string;
      if (m.url.startsWith(`${origin}/media/`)) {
        // A Worker cannot fetch its own workers.dev address, so files uploaded here are checked in R2.
        const obj = await env.MEDIA.head(m.url.slice(origin.length + "/media/".length));
        if (!obj) throw new Error(`O arquivo ${m.url} não existe mais no armazenamento. Envie de novo com meta_link_upload.`);
        tipo = obj.httpMetadata?.contentType ?? "";
      } else {
        const res = await fetch(m.url, { method: "HEAD" });
        if (!res.ok) throw new Error(`Não consegui acessar ${m.url} (HTTP ${res.status}). A mídia precisa estar num link público.`);
        tipo = res.headers.get("content-type") ?? "";
      }
      if (m.tipo === "imagem" && pub.redes.includes("instagram") && !/image\/jpe?g/.test(tipo)) {
        throw new Error(`${m.url} é ${tipo || "de tipo desconhecido"}; o Instagram só aceita imagens JPEG.`);
      }
      if (m.tipo === "video" && !tipo.startsWith("video/")) avisos.push(`${m.url} não informa tipo de vídeo (${tipo || "vazio"}); confira se é MP4 ou MOV.`);
    }),
  );
  return { quando, avisos };
}

// ---------- Facebook: native scheduling on the Page ----------

export async function publishFacebook(g: Graph, pub: Publicacao, quando: number) {
  const { page_id } = await g.conta();
  const agendar = quando - Date.now() >= FB_MIN_MS;
  const schedule: Params = agendar ? { published: false, scheduled_publish_time: Math.floor(quando / 1000) } : {};

  if (pub.formato === "reels") {
    const r = await g.call(`/${page_id}/videos`, { body: { file_url: pub.midias[0].url, description: pub.legenda, ...schedule } });
    return { rede: "facebook", id: r.id, agendado_para: agendar ? new Date(quando).toISOString() : undefined };
  }

  // Photos are uploaded unpublished, then attached to one feed post (scheduled posts need temporary photos).
  const fotos = [];
  for (const m of pub.midias) {
    const f = await g.call(`/${page_id}/photos`, { body: { url: m.url, published: false, ...(agendar ? { temporary: true } : {}) } });
    fotos.push({ media_fbid: f.id });
  }
  const r = await g.call(`/${page_id}/feed`, { body: { message: pub.legenda, attached_media: fotos, ...schedule } });
  return { rede: "facebook", id: r.id, agendado_para: agendar ? new Date(quando).toISOString() : undefined };
}

// ---------- Instagram: container -> processing -> publish ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createContainer(g: Graph, ig: string, pub: Publicacao, filhos?: string[]): Promise<string> {
  const m = pub.midias[0];
  const media = m.tipo === "video" ? { video_url: m.url } : { image_url: m.url };
  const body: Record<string, unknown> =
    pub.formato === "carrossel"
      ? { media_type: "CAROUSEL", children: filhos!.join(","), caption: pub.legenda }
      : pub.formato === "reels"
        ? { media_type: "REELS", ...media, caption: pub.legenda, share_to_feed: true }
        : pub.formato === "story"
          ? { media_type: "STORIES", ...media }
          : { ...media, caption: pub.legenda, alt_text: pub.alt_text };
  return (await g.call(`/${ig}/media`, { body })).id;
}

async function status(g: Graph, container: string): Promise<string> {
  return (await g.call(`/${container}`, { query: { fields: "status_code" } })).status_code;
}

// Moves a job as far as it can within the request budget. With esperar, waits for video processing.
export async function advance(g: Graph, job: JobInstagram, esperar: boolean, budget = 40): Promise<JobInstagram> {
  const { ig_id } = await g.conta();
  const start = g.calls;
  const left = () => budget - (g.calls - start);
  try {
    for (let round = 0; round < (esperar ? 12 : 1); round++) {
      if (job.pub.formato === "carrossel" && !job.filhos) {
        if (left() < job.pub.midias.length + 2) break;
        job.filhos = [];
        for (const m of job.pub.midias) {
          const media = m.tipo === "video" ? { media_type: "VIDEO", video_url: m.url } : { image_url: m.url };
          job.filhos.push((await g.call(`/${ig_id}/media`, { body: { is_carousel_item: true, ...media } })).id);
        }
      }
      if (job.filhos && !job.container) {
        if (left() < job.filhos.length + 1) break;
        const s = await Promise.all(job.filhos.map((f) => status(g, f)));
        if (s.some((x) => x === "ERROR" || x === "EXPIRED")) throw new Error(`Uma mídia do carrossel falhou no processamento da Meta (${s.join(", ")}).`);
        if (s.some((x) => x !== "FINISHED")) {
          job.estado = "processando";
          if (esperar) await sleep(5000);
          continue;
        }
      }
      if (!job.container) {
        if (left() < 1) break;
        job.container = await createContainer(g, ig_id, job.pub, job.filhos);
      }
      if (left() < 3) break;
      const s = await status(g, job.container);
      if (s === "FINISHED") {
        const pub = await g.call(`/${ig_id}/media_publish`, { body: { creation_id: job.container } });
        const info = await g.call(`/${pub.id}`, { query: { fields: "permalink" } }).catch(() => ({}));
        job.estado = "publicado";
        job.resultado = { id: pub.id, permalink: info.permalink };
        return job;
      }
      if (s === "ERROR" || s === "EXPIRED") throw new Error(`A Meta não conseguiu processar a mídia (status ${s}).`);
      job.estado = "processando";
      if (esperar) await sleep(5000);
    }
  } catch (e) {
    job.estado = "erro";
    job.erro = e instanceof Error ? e.message : String(e);
  }
  return job;
}

export async function saveJob(env: Env, job: JobInstagram) {
  const done = job.estado === "publicado" || job.estado === "erro" || job.estado === "cancelado";
  await env.META_KV.put(FILA + job.id, JSON.stringify(job), {
    metadata: { estado: job.estado, quando: job.quando },
    ...(done ? { expirationTtl: KEEP_DONE_SECONDS } : {}),
  });
}

export async function getJob(env: Env, id: string) {
  return env.META_KV.get<JobInstagram>(FILA + id, "json");
}

export async function listJobs(env: Env): Promise<JobInstagram[]> {
  const jobs: JobInstagram[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.META_KV.list({ prefix: FILA, cursor });
    for (const k of page.keys) {
      const j = await env.META_KV.get<JobInstagram>(k.name, "json");
      if (j) jobs.push(j);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return jobs.sort((a, b) => a.quando - b.quando);
}

// Cron: publish whatever is due. Key metadata carries state and time, so only due jobs are read.
export async function runQueue(env: Env) {
  const g = new Graph(env);
  let cursor: string | undefined;
  do {
    const page = await env.META_KV.list<{ estado: string; quando: number }>({ prefix: FILA, cursor });
    for (const k of page.keys) {
      const m = k.metadata;
      if (!m || (m.estado !== "agendado" && m.estado !== "processando") || m.quando > Date.now()) continue;
      if (g.calls > 35) return; // leave the rest for the next run
      const job = await env.META_KV.get<JobInstagram>(k.name, "json");
      if (job) await saveJob(env, await advance(g, job, false, 45 - g.calls));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
