# fynepdf

The [FynePDF API](https://fynepdf.com/developers/docs) for Python: compress, convert, OCR, redact, merge, split and generate PDFs, and read them with AI. Typed from the API's own spec.

```bash
pip install fynepdf
```

```python
from fynepdf import FynePDF

fyne = FynePDF()  # reads FYNEPDF_API_KEY

file = fyne.files.upload("report.pdf")
job = fyne.pdf.compress(file_id=file["id"], target_size_bytes=5_000_000)

print(job["receipt"]["steps"][0])  # what it did and cost
fyne.files.download_to(job["outputs"][0], "report-small.pdf")
```

Get a key at [fynepdf.com/developers](https://fynepdf.com/developers/dashboard). Test keys are free (results are watermarked); live keys get 250 free credits a month.

## Every action, one call

All 34 actions are methods on `fyne.pdf`, with their parameters as keyword arguments your editor completes:

```python
fyne.pdf.merge(file_ids=[a["id"], b["id"]])
fyne.pdf.ocr(file_id=scan["id"])
fyne.pdf.pdf_to_excel(file_id=statement["id"], mode="statement")
fyne.pdf.redact(file_id=contract["id"], text=["Jane Doe", "555-0142"])
fyne.pdf.html_to_pdf(url="https://example.com")
fyne.pdf.create_pdf(
    template="invoice",
    data={"invoice_number": "INV-104", "currency": "USD",
          "line_items": [{"description": "Consulting", "quantity": 3, "unit_price": 120}], "tax_rate": 10},
)
```

Each waits up to 30 seconds for the result. Pass `wait=0` to get the job at once, then `fyne.jobs.wait(job)`, or give a `webhook_url`.

## Chains of steps

```python
steps = [
    {"action": "merge"},
    {"action": "compress", "params": {"target_size_bytes": 5_000_000}},
    {"action": "page_numbers", "params": {"position": "bottom-right"}},
]
quote = fyne.jobs.quote(inputs=[a["id"], b["id"]], steps=steps)  # the price, nothing run
job = fyne.jobs.wait(fyne.jobs.create(inputs=[a["id"], b["id"]], steps=steps))
```

## Files

- `files.upload(path_or_bytes_or_file, filename=...)`: in the request body up to 25 MB, through an upload URL above that.
- `files.from_url(url)`: the API fetches a public link.
- `files.download(file_or_id)` returns bytes; `files.download_to(file_or_id, path)` writes them. Your key is never sent to storage.

## AI

```python
answer = fyne.ai.ask(file_id=file["id"], question="What's the notice period?")
invoice = fyne.ai.extract(file_id=file["id"], type="invoice")
```

## Errors and retries

Errors are `FynePDFError` with `status`, a `code` to branch on (`insufficient_credits`, `validation_failed`, `rate_limited`…), `detail` and `request_id`. Rate limits, timeouts and server errors are retried (twice by default, honouring `Retry-After`), and every POST carries an `Idempotency-Key`, so a retry never runs or charges twice.

## Webhooks

```python
from fynepdf import verify_webhook

event = verify_webhook(request.body, request.headers, os.environ["FYNEPDF_WEBHOOK_SECRET"])
if event["type"] == "job.succeeded":
    print(event["data"]["outputs"][0]["download_url"])
```

## From an assistant instead

FynePDF is also an MCP server for Claude, ChatGPT, Cursor and others: [fynepdf.com/developers/mcp](https://fynepdf.com/developers/mcp).

## License

MIT
