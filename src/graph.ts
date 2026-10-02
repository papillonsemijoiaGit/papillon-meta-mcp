import type { Env } from "./env";

export const GRAPH_VERSION = "v25.0";
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const FB_DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

export const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_read_user_content",
  "pages_messaging",
  "read_insights",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
  "instagram_manage_messages",
  "business_management",
];

const CONTA_KEY = "meta:conta";
export const OWNER_KEY = "meta:owner";

// A Page token obtained from a long-lived user token does not expire, so it is all we keep.
export interface Conta {
  page_id: string;
  page_name: string;
  page_token: string;
  ig_id: string;
  ig_username: string;
  conectado_em: string;
}

export class GraphError extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    super(`Meta respondeu ${status}: ${body?.error?.message ?? (typeof body === "string" ? body : JSON.stringify(body))}`);
  }
}

async function parse(res: Response) {
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new GraphError(res.status, body);
  return body;
}

const get = (path: string, query: Record<string, string>) => fetch(`${GRAPH}${path}?${new URLSearchParams(query)}`).then(parse);

// Code from the login dialog -> long-lived user token -> the Papillon Page and its Instagram account.
export async function connect(env: Env, code: string, redirectUri: string): Promise<Conta> {
  const app = { client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET };
  const short = await get("/oauth/access_token", { ...app, redirect_uri: redirectUri, code });
  const long = await get("/oauth/access_token", { ...app, grant_type: "fb_exchange_token", fb_exchange_token: short.access_token });
  const pages = await get("/me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username}",
    limit: "100",
    access_token: long.access_token,
  });
  const comInstagram = (pages.data as any[]).filter((p) => p.instagram_business_account);
  if (comInstagram.length !== 1) {
    throw new Error(
      comInstagram.length === 0
        ? "Nenhuma Página com Instagram profissional vinculado foi autorizada. Vincule o Instagram à Página no portfólio da Meta e conecte de novo marcando os dois."
        : `Mais de uma Página com Instagram foi autorizada (${comInstagram.map((p) => p.name).join(", ")}). Conecte de novo marcando só a Página da Papillon.`,
    );
  }
  const p = comInstagram[0];
  const conta: Conta = {
    page_id: p.id,
    page_name: p.name,
    page_token: p.access_token,
    ig_id: p.instagram_business_account.id,
    ig_username: p.instagram_business_account.username,
    conectado_em: new Date().toISOString(),
  };
  return conta;
}

export async function saveConta(env: Env, conta: Conta) {
  await env.META_KV.put(CONTA_KEY, JSON.stringify(conta));
}

async function hmacHex(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Params = Record<string, string | number | boolean | undefined>;

export interface GraphRequest {
  method?: "GET" | "POST" | "DELETE";
  query?: Params;
  // Sent form-encoded; objects and arrays are JSON-encoded, as the Graph API expects.
  body?: Record<string, unknown>;
}

export class Graph {
  private cached?: Conta;
  // Outbound requests made by this instance; the Cloudflare free plan allows 50 per invocation.
  calls = 0;
  constructor(private env: Env) {}

  async conta(): Promise<Conta> {
    this.cached ??= (await this.env.META_KV.get<Conta>(CONTA_KEY, "json")) ?? undefined;
    if (!this.cached) throw new Error("Meta ainda não autorizada. Conecte o conector no Claude para fazer o login.");
    return this.cached;
  }

  async call<T = any>(path: string, req: GraphRequest = {}): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `${GRAPH}${path.startsWith("/") ? "" : "/"}${path}`);
    if (url.hostname !== "graph.facebook.com") throw new Error("Só é permitido chamar graph.facebook.com");
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const { page_token } = await this.conta();
    url.searchParams.set("appsecret_proof", await hmacHex(this.env.META_APP_SECRET, page_token));

    let body: URLSearchParams | undefined;
    if (req.body) {
      body = new URLSearchParams();
      for (const [k, v] of Object.entries(req.body)) {
        if (v !== undefined) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    this.calls++;
    try {
      return await fetch(url, {
        method: req.method ?? (body ? "POST" : "GET"),
        headers: { authorization: `Bearer ${page_token}`, accept: "application/json" },
        body,
      }).then(parse);
    } catch (e) {
      if (e instanceof GraphError && e.body?.error?.code === 190) {
        throw new Error("A conexão com a Meta expirou ou foi revogada. Desconecte e conecte de novo o conector no Claude. " + e.message);
      }
      throw e;
    }
  }
}
