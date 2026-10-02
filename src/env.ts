import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  META_KV: KVNamespace;
  MEDIA: R2Bucket;
  OAUTH_PROVIDER: OAuthHelpers;
  META_APP_ID: string;
  META_APP_SECRET: string;
}

// What completeAuthorization() stores for each Claude grant.
export interface Props extends Record<string, unknown> {
  pageId: string;
}

// Must match the workers.dev address the Worker is deployed to.
export const BASE_URL = "https://papillon-meta.papillonsemijoia.workers.dev";
