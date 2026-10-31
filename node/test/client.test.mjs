import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";

import { FynePDF, FynePDFError, verifyWebhook, WebhookVerificationError } from "../dist/index.js";

/** A stand-in fetch that answers from a list and remembers every call. */
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body, headers = {} } = next;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { fetch, calls };
}

const client = (fetch, options = {}) =>
  new FynePDF({ apiKey: "fyne_test_abc", baseUrl: "http://api.test/v1", fetch, ...options });

test("an action posts its params with the key, and a retry keeps its Idempotency-Key", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 503, body: { code: "busy", detail: "Temporarily busy" }, headers: { "retry-after": "0" } },
    { body: { object: "job", id: "job_1", status: "succeeded" } },
  ]);
  const job = await client(fetch).pdf.compress({ file_id: "file_1", target_size_bytes: 5_000_000 });
  assert.equal(job.id, "job_1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://api.test/v1/pdf/compress");
  assert.equal(calls[0].init.headers.Authorization, "Bearer fyne_test_abc");
  assert.deepEqual(JSON.parse(calls[0].init.body), { file_id: "file_1", target_size_bytes: 5_000_000 });
  assert.ok(calls[0].init.headers["Idempotency-Key"]);
  assert.equal(calls[0].init.headers["Idempotency-Key"], calls[1].init.headers["Idempotency-Key"]);
});

test("an API error becomes a FynePDFError with its code, detail and request id", async () => {
  const { fetch } = fakeFetch([
    {
      status: 402,
      body: { code: "insufficient_credits", detail: "Step 1 needs 3 credits.", request_id: "req_9", status: 402 },
    },
  ]);
  await assert.rejects(client(fetch).jobs.create({ inputs: ["file_1"], steps: [{ action: "ocr" }] }), (error) => {
    assert.ok(error instanceof FynePDFError);
    assert.equal(error.status, 402);
    assert.equal(error.code, "insufficient_credits");
    assert.equal(error.requestId, "req_9");
    assert.equal(error.message, "Step 1 needs 3 credits.");
    return true;
  });
});

test("client errors aren't retried; GETs carry no Idempotency-Key", async () => {
  const { fetch, calls } = fakeFetch([{ status: 404, body: { code: "not_found", detail: "No job job_x." } }]);
  await assert.rejects(client(fetch).jobs.get("job_x"), { code: "not_found" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["Idempotency-Key"], undefined);
});

test("a small file goes in the request body; a large one through an upload URL", async () => {
  const small = fakeFetch([{ status: 201, body: { id: "file_s", status: "ready" } }]);
  await client(small.fetch).files.upload(new Uint8Array(10), { filename: "a.pdf" });
  assert.ok(small.calls[0].init.body instanceof FormData);
  assert.equal(small.calls[0].init.body.get("file").type, "application/pdf");

  const large = fakeFetch([
    { status: 201, body: { id: "file_l", upload_url: "http://storage.test/put", content_type: "application/pdf" } },
    { status: 200 },
    { body: { id: "file_l", status: "ready" } },
  ]);
  const file = await client(large.fetch).files.upload(new Uint8Array(26_000_000), { filename: "big.pdf" });
  assert.equal(file.status, "ready");
  assert.deepEqual(JSON.parse(large.calls[0].init.body).size, 26_000_000);
  assert.equal(large.calls[1].url, "http://storage.test/put");
  assert.equal(large.calls[1].init.method, "PUT");
  assert.equal(large.calls[1].init.headers.Authorization, undefined);
});

test("downloads follow the API's redirect without sending the key to storage", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/content")) return new Response(null, { status: 302, headers: { location: "http://storage.test/f?sig=1" } });
    return new Response(new Uint8Array([37, 80, 68, 70]));
  };
  const bytes = await client(fetch).files.download("file_1");
  assert.equal(new TextDecoder().decode(bytes), "%PDF");
  assert.equal(calls[1].url, "http://storage.test/f?sig=1");
  assert.equal(calls[1].init.headers, undefined);
});

test("jobs.wait polls until the job ends, and throws with the job's error when it fails", async () => {
  const ok = fakeFetch([{ body: { id: "job_1", status: "running" } }, { body: { id: "job_1", status: "succeeded" } }]);
  assert.equal((await client(ok.fetch).jobs.wait("job_1")).status, "succeeded");
  assert.match(ok.calls[0].url, /\/jobs\/job_1\?wait=30$/);
  const failed = fakeFetch([
    { body: { id: "job_2", status: "failed", error: { code: "step_failed", message: "Step 1 (redact) failed: none of the text was found." } } },
  ]);
  await assert.rejects(client(failed.fetch).jobs.wait("job_2"), { code: "step_failed" });
});

test("no key: a clear message where to get one", () => {
  const saved = process.env.FYNEPDF_API_KEY;
  delete process.env.FYNEPDF_API_KEY;
  assert.throws(() => new FynePDF(), /FYNEPDF_API_KEY/);
  if (saved !== undefined) process.env.FYNEPDF_API_KEY = saved;
});

function signed(secretBytes, body, { id = "msg_1", at = Math.floor(Date.now() / 1000) } = {}) {
  const signature = createHmac("sha256", secretBytes).update(`${id}.${at}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${signature}` };
}

test("webhooks: a signed event verifies; a changed body, wrong secret or old timestamp doesn't", async () => {
  const secretBytes = randomBytes(24);
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const body = JSON.stringify({ type: "job.succeeded", timestamp: new Date().toISOString(), data: { id: "job_1" } });
  const event = await verifyWebhook(body, signed(secretBytes, body), secret);
  assert.equal(event.type, "job.succeeded");
  assert.equal(event.data.id, "job_1");
  // Fetch-style headers work too.
  assert.equal((await verifyWebhook(body, new Headers(signed(secretBytes, body)), secret)).data.id, "job_1");

  await assert.rejects(verifyWebhook(body.replace("job_1", "job_2"), signed(secretBytes, body), secret), WebhookVerificationError);
  await assert.rejects(verifyWebhook(body, signed(randomBytes(24), body), secret), WebhookVerificationError);
  const old = signed(secretBytes, body, { at: Math.floor(Date.now() / 1000) - 3600 });
  await assert.rejects(verifyWebhook(body, old, secret), /too old/);
});
