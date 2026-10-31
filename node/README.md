# fynepdf

The [FynePDF API](https://fynepdf.com/developers/docs) for Node.js: compress, convert, OCR, redact, merge, split and generate PDFs, and read them with AI. Typed from the API's own spec, no dependencies.

```bash
npm install fynepdf
```

```js
import FynePDF from "fynepdf";

const fyne = new FynePDF(); // reads FYNEPDF_API_KEY

const file = await fyne.files.upload("./report.pdf");
const job = await fyne.pdf.compress({ file_id: file.id, target_size_bytes: 5_000_000 });

console.log(job.receipt.steps[0]); // what it did and cost
await fyne.files.downloadTo(job.outputs[0], "./report-small.pdf");
```

Get a key at [fynepdf.com/developers](https://fynepdf.com/developers/dashboard). Test keys are free (results are watermarked); live keys get 250 free credits a month.

## Every action, one call

All 34 actions are methods on `fyne.pdf`, with their parameters typed:

```js
await fyne.pdf.merge({ file_ids: [a.id, b.id] });
await fyne.pdf.ocr({ file_id: scan.id });
await fyne.pdf.pdfToExcel({ file_id: statement.id, mode: "statement" });
await fyne.pdf.redact({ file_id: contract.id, text: ["Jane Doe", "555-0142"] });
await fyne.pdf.htmlToPdf({ url: "https://example.com" });
await fyne.pdf.createPdf({
  template: "invoice",
  data: { invoice_number: "INV-104", currency: "USD", line_items: [{ description: "Consulting", quantity: 3, unit_price: 120 }], tax_rate: 10 },
});
```

Each waits up to 30 seconds for the result. Pass `wait: 0` to get the job at once, then `fyne.jobs.wait(job)`, or give a `webhook_url`.

## Chains of steps

```js
const steps = [
  { action: "merge" },
  { action: "compress", params: { target_size_bytes: 5_000_000 } },
  { action: "page_numbers", params: { position: "bottom-right" } },
];
const quote = await fyne.jobs.quote({ inputs: [a.id, b.id], steps }); // the price, nothing run
const job = await fyne.jobs.wait(await fyne.jobs.create({ inputs: [a.id, b.id], steps }));
```

## Files

- `files.upload(pathOrBytesOrBlob, { filename })`: in the request body up to 25 MB, through an upload URL above that.
- `files.fromUrl(url)`: the API fetches a public link.
- `files.download(fileOrId)` returns an `ArrayBuffer`; `files.downloadTo(fileOrId, path)` writes it. Your key is never sent to storage.

## AI

```js
const { answer, citations } = await fyne.ai.ask({ file_id: file.id, question: "What's the notice period?" });
const { data, checks } = await fyne.ai.extract({ file_id: invoice.id, type: "invoice" });
```

## Errors and retries

Errors are `FynePDFError` with `status`, a `code` to branch on (`insufficient_credits`, `validation_failed`, `rate_limited`…), `detail` and `requestId`. Rate limits, timeouts and server errors are retried (twice by default, honouring `Retry-After`), and every POST carries an `Idempotency-Key`, so a retry never runs or charges twice.

## Webhooks

```js
import { verifyWebhook } from "fynepdf";

const event = await verifyWebhook(rawBody, request.headers, process.env.FYNEPDF_WEBHOOK_SECRET);
if (event.type === "job.succeeded") console.log(event.data.outputs[0].download_url);
```

## From an assistant instead

FynePDF is also an MCP server for Claude, ChatGPT, Cursor and others: [fynepdf.com/developers/mcp](https://fynepdf.com/developers/mcp).

## License

MIT
