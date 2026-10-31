/**
 * Checks a FynePDF webhook (Standard Webhooks: https://www.standardwebhooks.com)
 * and returns its event. Uses Web Crypto, so it runs on Node 18+, Bun, Deno and
 * edge runtimes.
 */
import type { Job } from "./generated.js";

export interface WebhookEvent {
  type: "job.succeeded" | "job.failed" | "job.canceled";
  timestamp: string;
  data: Job;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type Headers = Record<string, string | string[] | undefined> | { get(name: string): string | null };

function header(headers: Headers, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function")
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value[0] : value;
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** Compares in constant time, so the check doesn't leak how much of a signature matched. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param payload The raw request body, exactly as it arrived (not parsed and re-serialized).
 * @param headers The request's headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
 * @param secret Your signing secret, `whsec_…`, from the dashboard.
 * @param toleranceSeconds How old (or new) the timestamp may be; stops replays. Default 5 minutes.
 */
export async function verifyWebhook(
  payload: string,
  headers: Headers,
  secret: string,
  toleranceSeconds = 300,
): Promise<WebhookEvent> {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError("Missing webhook headers.");
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(Date.now() / 1000 - sent) > toleranceSeconds)
    throw new WebhookVerificationError("The webhook's timestamp is too old or too new.");

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    fromBase64(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = toBase64(
    await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`)),
  );
  const valid = signatures
    .split(" ")
    .some((part) => part.startsWith("v1,") && same(part.slice(3), expected));
  if (!valid) throw new WebhookVerificationError("The webhook's signature doesn't match.");
  return JSON.parse(payload) as WebhookEvent;
}
