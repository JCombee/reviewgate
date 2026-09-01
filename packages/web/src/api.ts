import type { FileDetail, ReviewSummary } from "@reviewgate/core/api";

/**
 * De review-id en het token staan in de URL waarmee de hook de browser opent
 * (`/r/<id>?token=…`). Beide gaan bij elke request mee; zonder token geeft de
 * server 403 (§3).
 */
export interface Ctx {
  id: string;
  token: string;
}

export function readContext(): Ctx | null {
  const m = /^\/r\/([^/]+)\/?$/.exec(window.location.pathname);
  const token = new URLSearchParams(window.location.search).get("token");
  if (!m?.[1] || !token) return null;
  return { id: m[1], token };
}

async function get<T>(ctx: Ctx, path: string): Promise<T> {
  const res = await fetch(`/api/review/${ctx.id}${path}`, {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const fetchSummary = (ctx: Ctx): Promise<ReviewSummary> => get(ctx, "");

export const fetchFile = (ctx: Ctx, index: number): Promise<FileDetail> =>
  get(ctx, `/files/${index}`);
