import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { BASE_URL, type Env, type Props } from "./env";
import { FB_DIALOG, OWNER_KEY, SCOPES, connect, saveConta } from "./graph";
import { runQueue } from "./publish";
import { buildServer } from "./tools";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;line-height:1.5;color:#222}
button{font-size:16px;padding:10px 18px;margin-right:8px;border-radius:8px;border:1px solid #888;cursor:pointer}
button[value=approve]{background:#0866ff;color:#fff;border-color:#0866ff}.warn{background:#fff3cd;padding:8px 12px;border-radius:6px}</style>
<h1>${escape(title)}</h1>${body}</html>`,
    { status, headers },
  );
}

function consentPage(d: ConsentDescription, handle: string) {
  const origin = d.clientDomain
    ? `Publicado por <strong>${escape(d.clientDomain)}</strong>.`
    : "Este aplicativo se registrou sozinho; o nome não é verificado.";
  return `<p>${origin} O acesso será enviado para <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">Isto envia o acesso para um aplicativo no seu computador. Continue só se você acabou de iniciar a conexão nele.</p>' : ""}
<p>Ao permitir, você vai entrar no Facebook e autorizar o acesso à Página e ao Instagram da Papillon. Toda publicação ou alteração pede sua confirmação antes de ser feita.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Permitir</button><button name="decision" value="deny">Negar</button></form>`;
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const oauth = env.OAUTH_PROVIDER;
    const callbackUrl = `${url.origin}/meta/callback`;

    try {
      // Claude asks to connect: show who is asking, then send the admin to the Facebook login.
      if (url.pathname === "/authorize" && req.method === "GET") {
        const request = await oauth.parseAuthRequest(req);
        const details = await oauth.describeConsent(request);
        const consent = await oauth.beginConsent(request);
        return page(`Permitir que ${details.clientName} acesse o Instagram e o Facebook da Papillon?`, consentPage(details, consent.handle), 200, consent.headers);
      }

      if (url.pathname === "/authorize" && req.method === "POST") {
        const form = await req.formData();
        const handle = String(form.get("handle"));
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(req, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(req, handle);
        const { state, headers } = await oauth.beginUpstream(approved.request, { data: {}, headers: approved.headers });
        const auth = new URL(FB_DIALOG);
        auth.search = new URLSearchParams({
          client_id: env.META_APP_ID,
          redirect_uri: callbackUrl,
          state,
          response_type: "code",
          scope: SCOPES.join(","),
        }).toString();
        headers.set("Location", auth.toString());
        return new Response(null, { status: 302, headers });
      }

      // Facebook sends the admin back here after the login.
      if (url.pathname === "/meta/callback") {
        const { request: original, headers } = await oauth.finishUpstream(req);
        const code = url.searchParams.get("code");
        if (url.searchParams.get("error") || !code) {
          headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
          return new Response(null, { status: 302, headers });
        }
        let conta;
        try {
          conta = await connect(env, code, callbackUrl);
        } catch (e) {
          return page("Não deu para conectar", `<p>${escape(e instanceof Error ? e.message : String(e))}</p>`, 400);
        }

        // The first Page to connect becomes the only one this server will ever serve.
        const owner = await env.META_KV.get(OWNER_KEY);
        if (owner && owner !== conta.page_id) {
          return page("Página não autorizada", "<p>Este servidor está vinculado a outra Página do Facebook.</p>", 403);
        }
        if (!owner) await env.META_KV.put(OWNER_KEY, conta.page_id);
        await saveConta(env, conta);

        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: conta.page_id,
          metadata: {},
          scope: original.scope,
          props: { pageId: conta.page_id } satisfies Props,
        });
        headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers });
      }

      // One-time upload links created by meta_link_upload.
      if (url.pathname.startsWith("/upload/") && req.method === "PUT") {
        const tokenKey = `upload:${url.pathname.slice("/upload/".length)}`;
        const upload = await env.META_KV.get<{ key: string; content_type: string }>(tokenKey, "json");
        if (!upload || !req.body) return new Response("Link de envio inválido ou expirado.", { status: 404 });
        await env.META_KV.delete(tokenKey);
        await env.MEDIA.put(upload.key, req.body, { httpMetadata: { contentType: upload.content_type } });
        return Response.json({ ok: true, media_url: `${url.origin}/media/${upload.key}` });
      }

      // Public media for Meta to download when publishing; keys are random UUIDs.
      if (url.pathname.startsWith("/media/") && (req.method === "GET" || req.method === "HEAD")) {
        const obj = await env.MEDIA.get(decodeURIComponent(url.pathname.slice("/media/".length)));
        if (!obj) return new Response("Not found", { status: 404 });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("etag", obj.httpEtag);
        return new Response(req.method === "HEAD" ? null : obj.body, { headers });
      }

      if (url.pathname === "/") {
        const owner = await env.META_KV.get(OWNER_KEY);
        return page("Papillon · Meta", `<p>Servidor no ar. ${owner ? "Página conectada." : "Nenhuma Página conectada ainda."}</p><p>URL do conector: <code>${escape(url.origin)}/mcp</code></p>`);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : "Não foi possível verificar este aplicativo.";
        return page("Não deu para continuar", `<p>${escape(message ?? "Pedido inválido.")}</p><p>Tente conectar de novo pelo Claude.</p>`, 400);
      }
      throw error;
    }
  },
};

const mcpHandler: ExportedHandler<Env> = {
  fetch(req, env, ctx) {
    return createMcpHandler(() => buildServer(env))(req, env, ctx);
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler as any,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
  resourceMetadata: {
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
    resource_name: "Papillon · Meta",
  },
});

export default {
  fetch: (req, env, ctx) => provider.fetch(req, env, ctx),
  // Every 5 minutes: publish the Instagram posts that are due.
  scheduled: (_event, env, ctx) => ctx.waitUntil(runQueue(env)),
} satisfies ExportedHandler<Env>;
