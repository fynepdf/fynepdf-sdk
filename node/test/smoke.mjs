// Runs the built SDK against a real FynePDF API: upload, compress, download, a
// chained job with a quote, a generated invoice, a large upload through an upload
// URL, an AI call, and an error. Needs FYNEPDF_API_KEY (a live key with credits),
// FYNEPDF_TEST_KEY (AI on a test key answers with samples) and FYNEPDF_BASE_URL.
//   npm run build && node test/smoke.mjs /path/to/sample.pdf
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FynePDF, FynePDFError } from "../dist/index.js";

const samplePath = process.argv[2];
if (!samplePath) throw new Error("Usage: node test/smoke.mjs <sample.pdf>");
const fyne = new FynePDF({ baseUrl: process.env.FYNEPDF_BASE_URL });
const testFyne = new FynePDF({ apiKey: process.env.FYNEPDF_TEST_KEY, baseUrl: process.env.FYNEPDF_BASE_URL });
const dir = mkdtempSync(join(tmpdir(), "fynepdf-smoke-"));
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 160)})` : ""}`);
};

const me = await fyne.account.me();
check("account.me: the key and its limits", me.mode === "live" && me.limits.requests_per_minute > 0, `${me.prefix} ${me.limits.requests_per_minute}/min`);
const balance = await fyne.account.balance();
check("account.balance", balance.total > 0, `${balance.total} credits`);

const file = await fyne.files.upload(samplePath);
check("files.upload (in the request body)", file.id.startsWith("file_") && file.kind === "pdf", `${file.filename} ${file.pages} pages`);

const compressed = await fyne.pdf.compress({ file_id: file.id, level: "high" });
const out = compressed.outputs[0];
check("pdf.compress: a finished job with a receipt", compressed.status === "succeeded" && compressed.receipt.steps[0].action === "compress", `${compressed.receipt.steps[0].bytes_before} -> ${compressed.receipt.steps[0].bytes_after}`);
const saved = await fyne.files.downloadTo(out, join(dir, "compressed.pdf"));
check("files.downloadTo: the result is a PDF", readFileSync(saved).subarray(0, 4).toString() === "%PDF");
const byId = Buffer.from(await fyne.files.download(out.id));
check("files.download by id (through the API's redirect)", byId.subarray(0, 4).toString() === "%PDF" && byId.length === out.bytes);

const steps = [
  { action: "compress", params: { level: "medium" } },
  { action: "page_numbers", params: { position: "bottom-right" } },
];
const quote = await fyne.jobs.quote({ inputs: [file.id], steps });
const chained = await fyne.jobs.create({ inputs: [file.id], steps });
const finished = await fyne.jobs.wait(chained);
check("jobs.quote, jobs.create, jobs.wait: a two-step job", quote.credits > 0 && finished.status === "succeeded" && finished.receipt.steps.length === 2, `quoted ${quote.credits}, spent ${finished.receipt.credits}`);

const invoice = await fyne.pdf.createPdf({
  template: "invoice",
  style: "classic",
  data: { invoice_number: "INV-SDK-1", currency: "USD", line_items: [{ description: "Consulting", quantity: 3, unit_price: 120 }], tax_rate: 10 },
});
const total = invoice.receipt.steps[0].details?.total;
check("pdf.createPdf: an invoice from data, added up", invoice.status === "succeeded" && total === "$396.00", total);

// Larger than the request-body limit: through an upload URL, straight to storage.
const big = new Uint8Array(26_000_000);
big.set(new TextEncoder().encode("%PDF-1.4\n"));
writeFileSync(join(dir, "big.pdf"), big);
const uploaded = await fyne.files.upload(join(dir, "big.pdf"));
check("files.upload over 25 MB (upload URL)", uploaded.status === "ready" && uploaded.bytes === big.length, `${uploaded.status} ${uploaded.bytes}`);
await fyne.files.delete(uploaded.id);

const testFile = await testFyne.files.upload(samplePath);
const answer = await testFyne.ai.ask({ file_id: testFile.id, question: "What is this document about?" });
check("ai.ask on a test key: a sample answer, free", answer.object === "answer" && typeof answer.answer === "string", answer.answer);

try {
  await fyne.jobs.get("job_does_not_exist");
  check("errors: a FynePDFError", false);
} catch (error) {
  check("errors: a FynePDFError with code and request id", error instanceof FynePDFError && error.code === "not_found" && Boolean(error.requestId), `${error.code} ${error.requestId}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
