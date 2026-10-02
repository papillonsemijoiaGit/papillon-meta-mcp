import type { Env } from "./env";

// Every write goes through two calls: the first stores the exact action and returns a preview with a
// confirmacao_id; only a second call to the same tool with that id carries it out.
const TTL_SECONDS = 600;

export async function prepare<A>(env: Env, ferramenta: string, resumo: string, acao: A, previa: unknown) {
  const id = crypto.randomUUID();
  await env.META_KV.put(`pending:${id}`, JSON.stringify({ ferramenta, resumo, acao }), { expirationTtl: TTL_SECONDS });
  return {
    status: "PREVIA_NAO_GRAVADA",
    resumo,
    previa,
    confirmacao_id: id,
    instrucao:
      "Nada foi publicado nem alterado ainda. Mostre esta prévia ao Marcelo e só chame esta mesma ferramenta de novo, passando apenas confirmacao_id, depois que ele aprovar explicitamente. Expira em 10 minutos.",
  };
}

export async function take<A>(env: Env, ferramenta: string, id: string): Promise<{ resumo: string; acao: A }> {
  const key = `pending:${id}`;
  const pending = await env.META_KV.get<{ ferramenta: string; resumo: string; acao: A }>(key, "json");
  if (!pending || pending.ferramenta !== ferramenta) throw new Error("confirmacao_id inválido ou expirado para esta ferramenta. Gere uma nova prévia.");
  await env.META_KV.delete(key);
  return pending;
}
