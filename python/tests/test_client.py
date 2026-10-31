import base64
import hashlib
import hmac
import json
import os
import sys
import time
import unittest
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from fynepdf import FynePDF, FynePDFError, WebhookVerificationError, verify_webhook  # noqa: E402


def client(handler, **options):
    return FynePDF(
        api_key="fyne_test_abc",
        base_url="http://api.test/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        **options,
    )


class ClientTest(unittest.TestCase):
    def test_action_posts_params_and_retry_keeps_idempotency_key(self):
        calls = []

        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(503, json={"code": "busy", "detail": "Busy"}, headers={"retry-after": "0"})
            return httpx.Response(200, json={"object": "job", "id": "job_1", "status": "succeeded"})

        job = client(handler).pdf.compress(file_id="file_1", target_size_bytes=5_000_000)
        self.assertEqual(job["id"], "job_1")
        self.assertEqual(len(calls), 2)
        self.assertEqual(str(calls[0].url), "http://api.test/v1/pdf/compress")
        self.assertEqual(calls[0].headers["authorization"], "Bearer fyne_test_abc")
        # Arguments left at None aren't sent.
        self.assertEqual(json.loads(calls[0].content), {"file_id": "file_1", "target_size_bytes": 5_000_000})
        self.assertEqual(calls[0].headers["idempotency-key"], calls[1].headers["idempotency-key"])

    def test_api_error_becomes_fynepdf_error(self):
        def handler(request):
            return httpx.Response(
                402, json={"code": "insufficient_credits", "detail": "Step 1 needs 3 credits.", "request_id": "req_9"}
            )

        with self.assertRaises(FynePDFError) as caught:
            client(handler).jobs.create(inputs=["file_1"], steps=[{"action": "ocr"}])
        error = caught.exception
        self.assertEqual((error.status, error.code, error.request_id), (402, "insufficient_credits", "req_9"))
        self.assertEqual(str(error), "Step 1 needs 3 credits.")

    def test_client_errors_are_not_retried(self):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(404, json={"code": "not_found", "detail": "No job job_x."})

        with self.assertRaises(FynePDFError):
            client(handler).jobs.get("job_x")
        self.assertEqual(len(calls), 1)
        self.assertNotIn("idempotency-key", calls[0].headers)

    def test_small_upload_in_body_large_through_upload_url(self):
        calls = []

        def handler(request):
            calls.append(request)
            if request.url.host == "storage.test":
                return httpx.Response(200)
            if request.method == "GET":
                return httpx.Response(200, json={"id": "file_l", "status": "ready"})
            if request.headers["content-type"].startswith("multipart/form-data"):
                return httpx.Response(201, json={"id": "file_s", "status": "ready"})
            return httpx.Response(
                201, json={"id": "file_l", "upload_url": "http://storage.test/put", "content_type": "application/pdf"}
            )

        fyne = client(handler)
        self.assertEqual(fyne.files.upload(b"%PDF-1.4", filename="a.pdf")["id"], "file_s")
        self.assertIn(b'filename="a.pdf"', calls[0].content)
        self.assertEqual(fyne.files.upload(b"0" * 26_000_000, filename="big.pdf")["status"], "ready")
        put = next(c for c in calls if c.url.host == "storage.test")
        self.assertEqual(put.method, "PUT")
        self.assertNotIn("authorization", put.headers)

    def test_download_follows_redirect_without_the_key(self):
        calls = []

        def handler(request):
            calls.append(request)
            if request.url.path.endswith("/content"):
                return httpx.Response(302, headers={"location": "http://storage.test/f?sig=1"})
            return httpx.Response(200, content=b"%PDF")

        self.assertEqual(client(handler).files.download("file_1"), b"%PDF")
        self.assertNotIn("authorization", calls[1].headers)

    def test_wait_polls_and_raises_on_failure(self):
        answers = [{"id": "job_1", "status": "running"}, {"id": "job_1", "status": "succeeded"}]
        fyne = client(lambda request: httpx.Response(200, json=answers.pop(0)))
        self.assertEqual(fyne.jobs.wait("job_1")["status"], "succeeded")
        failed = client(
            lambda request: httpx.Response(
                200, json={"id": "job_2", "status": "failed", "error": {"code": "step_failed", "message": "none found"}}
            )
        )
        with self.assertRaises(FynePDFError) as caught:
            failed.jobs.wait("job_2")
        self.assertEqual(caught.exception.code, "step_failed")

    def test_actions_list(self):
        fyne = client(lambda request: httpx.Response(200, json={"object": "list", "data": [{"name": "compress"}]}))
        self.assertEqual(fyne.actions.list(), [{"name": "compress"}])

    def test_no_key_says_where_to_get_one(self):
        saved = os.environ.pop("FYNEPDF_API_KEY", None)
        try:
            with self.assertRaisesRegex(ValueError, "FYNEPDF_API_KEY"):
                FynePDF()
        finally:
            if saved is not None:
                os.environ["FYNEPDF_API_KEY"] = saved


def signed(secret_bytes, body, msg_id="msg_1", at=None):
    at = int(time.time()) if at is None else at
    signature = base64.b64encode(
        hmac.new(secret_bytes, f"{msg_id}.{at}.{body}".encode(), hashlib.sha256).digest()
    ).decode()
    return {"webhook-id": msg_id, "webhook-timestamp": str(at), "webhook-signature": f"v1,{signature}"}


class WebhookTest(unittest.TestCase):
    def test_verify(self):
        secret_bytes = os.urandom(24)
        secret = "whsec_" + base64.b64encode(secret_bytes).decode()
        body = json.dumps({"type": "job.succeeded", "data": {"id": "job_1"}})
        self.assertEqual(verify_webhook(body, signed(secret_bytes, body), secret)["data"]["id"], "job_1")
        self.assertEqual(verify_webhook(body.encode(), {k.upper(): v for k, v in signed(secret_bytes, body).items()}, secret)["type"], "job.succeeded")
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(body.replace("job_1", "job_2"), signed(secret_bytes, body), secret)
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(body, signed(os.urandom(24), body), secret)
        with self.assertRaisesRegex(WebhookVerificationError, "too old"):
            verify_webhook(body, signed(secret_bytes, body, at=int(time.time()) - 3600), secret)


if __name__ == "__main__":
    unittest.main()
