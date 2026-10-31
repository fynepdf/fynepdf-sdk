"""Runs the SDK against a real FynePDF API (FYNEPDF_API_KEY with credits, FYNEPDF_TEST_KEY, FYNEPDF_BASE_URL).

python tests/smoke.py /path/to/sample.pdf
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from fynepdf import FynePDF, FynePDFError  # noqa: E402

sample = sys.argv[1]
fyne = FynePDF()
test_fyne = FynePDF(api_key=os.environ["FYNEPDF_TEST_KEY"])
work = Path(tempfile.mkdtemp(prefix="fynepdf-smoke-"))
failed = 0


def check(name, ok, detail=""):
    global failed
    failed += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({str(detail)[:150]})" if detail else ""))


me = fyne.account.me()
check("account.me", me["mode"] == "live", me["prefix"])
file = fyne.files.upload(sample)
check("files.upload (in the request body)", file["id"].startswith("file_") and file["kind"] == "pdf", file["filename"])

job = fyne.pdf.compress(file_id=file["id"], level="high")
step = job["receipt"]["steps"][0]
check("pdf.compress: a finished job with a receipt", job["status"] == "succeeded", f"{step['bytes_before']} -> {step['bytes_after']}")
saved = fyne.files.download_to(job["outputs"][0], work / "compressed.pdf")
check("files.download_to: the result is a PDF", saved.read_bytes()[:4] == b"%PDF")
check("files.download by id", fyne.files.download(job["outputs"][0]["id"])[:4] == b"%PDF")

steps = [{"action": "compress", "params": {"level": "medium"}}, {"action": "page_numbers", "params": {"position": "bottom-right"}}]
quote = fyne.jobs.quote(inputs=[file["id"]], steps=steps)
finished = fyne.jobs.wait(fyne.jobs.create(inputs=[file["id"]], steps=steps))
check("jobs.quote, create, wait: two steps", finished["status"] == "succeeded" and len(finished["receipt"]["steps"]) == 2, f"quoted {quote['credits']}")

invoice = fyne.pdf.create_pdf(
    template="invoice",
    data={"invoice_number": "INV-PY-1", "currency": "EUR", "line_items": [{"description": "Design", "quantity": 2, "unit_price": 450}], "tax_rate": 20},
)
total = invoice["receipt"]["steps"][0].get("details", {}).get("total")
check("pdf.create_pdf: an invoice from data, added up", total == "€1,080.00", total)

big = work / "big.pdf"
big.write_bytes(b"%PDF-1.4\n" + b"0" * 26_000_000)
uploaded = fyne.files.upload(big)
check("files.upload over 25 MB (upload URL)", uploaded["status"] == "ready", uploaded["bytes"])
fyne.files.delete(uploaded["id"])

test_file = test_fyne.files.upload(sample)
answer = test_fyne.ai.ask(file_id=test_file["id"], question="What is this about?")
check("ai.ask on a test key: a sample answer", answer["object"] == "answer", answer["answer"][:60])

try:
    fyne.jobs.get("job_does_not_exist")
    check("errors: FynePDFError", False)
except FynePDFError as error:
    check("errors: FynePDFError with code and request id", error.code == "not_found" and bool(error.request_id), error.request_id)

print(f"\n{failed} FAILED" if failed else "\nall passed")
sys.exit(1 if failed else 0)
