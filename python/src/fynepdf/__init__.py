"""The FynePDF API for Python: compress, convert, OCR, redact, merge, split and generate PDFs, and read them with AI."""

from ._client import FynePDF, FynePDFError, __version__
from ._generated import File, Job, Problem, Quote, ReceiptLine
from ._webhooks import WebhookVerificationError, verify_webhook

__all__ = [
    "FynePDF",
    "FynePDFError",
    "File",
    "Job",
    "Problem",
    "Quote",
    "ReceiptLine",
    "WebhookVerificationError",
    "verify_webhook",
    "__version__",
]
