"""The FynePDF API client: FynePDF() with files, jobs, every PDF action, AI and account calls."""

from __future__ import annotations

import mimetypes
import os
import time
import uuid
from pathlib import Path
from typing import Any, BinaryIO, List, Mapping, Union

import httpx

from ._generated import File, Job, PdfActions, Quote

__version__ = "0.1.0"
DEFAULT_BASE_URL = "https://api.fynepdf.com/v1"
#: Larger files go through an upload URL instead of the request body.
MULTIPART_LIMIT = 25 * 1000 * 1000
RETRY_STATUSES = {408, 409, 429, 500, 502, 503, 504}

Uploadable = Union[str, os.PathLike, bytes, BinaryIO]


class FynePDFError(Exception):
    """An error the API answered with (RFC 9457 problem details), ready to branch on."""

    def __init__(self, status: int, problem: Mapping[str, Any] | None, fallback: str) -> None:
        problem = problem or {}
        self.status = status
        #: A stable code: insufficient_credits, validation_failed, rate_limited, ...
        self.code: str = problem.get("code") or (f"http_{status}" if status else "network_error")
        self.detail: str = problem.get("detail") or fallback
        self.request_id: str | None = problem.get("request_id")
        self.errors: list[dict[str, str]] | None = problem.get("errors")
        self.problem = dict(problem)
        super().__init__(self.detail)


def _clean(body: Mapping[str, Any]) -> dict[str, Any]:
    """Drops arguments left at None, so the API applies its own defaults."""
    return {key: value for key, value in body.items() if value is not None}


class _Files:
    def __init__(self, client: FynePDF) -> None:
        self._client = client

    def upload(self, file: Uploadable, *, filename: str | None = None, ttl_seconds: int | None = None) -> File:
        """Adds a file: a path, bytes or an open file. In the request body up to 25 MB, through an upload URL above."""
        if isinstance(file, (str, os.PathLike)):
            path = Path(file)
            data, filename = path.read_bytes(), filename or path.name
        elif isinstance(file, (bytes, bytearray)):
            data = bytes(file)
        else:
            data = file.read()
            filename = filename or Path(getattr(file, "name", "")).name or None
        if not filename:
            raise ValueError('Give the file a name: files.upload(data, filename="report.pdf").')
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if len(data) <= MULTIPART_LIMIT:
            return self._client._request(
                "POST",
                "/files",
                files={"file": (filename, data, content_type)},
                data=_clean({"ttl_seconds": ttl_seconds}),
            )
        # Large files go straight to storage: an upload URL, a PUT, then the file.
        created = self._client._post(
            "/files", {"filename": filename, "size": len(data), "content_type": content_type, "ttl_seconds": ttl_seconds}
        )
        put = self._client._http.put(
            created["upload_url"], content=data, headers={"Content-Type": created.get("content_type") or content_type}
        )
        if put.status_code >= 400:
            raise FynePDFError(put.status_code, None, f"The upload to storage failed ({put.status_code}).")
        return self.get(created["id"])

    def from_url(self, url: str, *, filename: str | None = None, ttl_seconds: int | None = None) -> File:
        """Adds a file the API fetches from a public link."""
        return self._client._post("/files", {"url": url, "filename": filename, "ttl_seconds": ttl_seconds})

    def get(self, file_id: str) -> File:
        return self._client._request("GET", f"/files/{file_id}")

    def list(self, *, limit: int | None = None) -> List[File]:
        return self._client._request("GET", "/files", params=_clean({"limit": limit}))["data"]

    def delete(self, file_id: str) -> None:
        self._client._request("DELETE", f"/files/{file_id}")

    def download(self, file: str | Mapping[str, Any]) -> bytes:
        """The file's bytes: from an id, or a file (a job output) with its download link. The key never goes to storage."""
        link = None if isinstance(file, str) else file.get("download_url")
        if not link:
            file_id = file if isinstance(file, str) else file["id"]
            response = self._client._http.get(
                f"{self._client.base_url}/files/{file_id}/content",
                headers={"Authorization": f"Bearer {self._client._api_key}"},
                follow_redirects=False,
            )
            if response.is_redirect:
                link = response.headers["location"]
            elif response.status_code < 300:
                return response.content
            else:
                raise FynePDFError(response.status_code, _problem(response), f"Download answered {response.status_code}")
        response = self._client._http.get(link)
        if response.status_code >= 400:
            raise FynePDFError(response.status_code, None, f"Download answered {response.status_code}")
        return response.content

    def download_to(self, file: str | Mapping[str, Any], path: str | os.PathLike) -> Path:
        target = Path(path)
        target.write_bytes(self.download(file))
        return target


class _Jobs:
    def __init__(self, client: FynePDF) -> None:
        self._client = client

    def create(
        self,
        *,
        steps: list[dict[str, Any]],
        inputs: list[str] | None = None,
        wait: int | None = None,
        webhook_url: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> Job:
        """Runs steps on files: [{"action": "compress", "params": {...}}, ...], each on the last one's result."""
        return self._client._post(
            "/jobs", {"inputs": inputs, "steps": steps, "wait": wait, "webhook_url": webhook_url, "metadata": metadata}
        )

    def quote(self, *, steps: list[dict[str, Any]], inputs: list[str] | None = None) -> Quote:
        """What a job would cost, without running it."""
        return self._client._post("/jobs/quote", {"inputs": inputs, "steps": steps})

    def get(self, job_id: str, *, wait: int | None = None) -> Job:
        return self._client._request("GET", f"/jobs/{job_id}", params=_clean({"wait": wait}))

    def list(self, *, limit: int | None = None) -> List[Job]:
        return self._client._request("GET", "/jobs", params=_clean({"limit": limit}))["data"]

    def cancel(self, job_id: str) -> Job:
        return self._client._request("POST", f"/jobs/{job_id}/cancel")

    def wait(self, job: str | Mapping[str, Any], *, timeout: float = 600) -> Job:
        """Polls until the job succeeds, fails or is canceled; raises FynePDFError if it doesn't succeed."""
        job_id = job if isinstance(job, str) else job["id"]
        deadline = time.monotonic() + timeout
        while True:
            # The API holds each poll up to 30 s, so this rarely loops more than a few times.
            current = self.get(job_id, wait=30)
            if current["status"] == "succeeded":
                return current
            if current["status"] in ("failed", "canceled"):
                error = current.get("error") or {}
                raise FynePDFError(
                    200,
                    {"code": error.get("code") or f"job_{current['status']}", "detail": error.get("message")},
                    f"The job {current['status']}.",
                )
            if time.monotonic() > deadline:
                raise TimeoutError(f"Job {job_id} is still {current['status']}; call jobs.wait again or use a webhook.")


class _Ai:
    def __init__(self, client: FynePDF) -> None:
        self._client = client

    def ask(self, *, file_id: str, question: str) -> dict[str, Any]:
        """Answers a question about the PDF, citing its pages."""
        return self._client._post("/ai/ask", {"file_id": file_id, "question": question})

    def summarize(self, *, file_id: str, length: str | None = None, focus: str | None = None) -> dict[str, Any]:
        return self._client._post("/ai/summarize", {"file_id": file_id, "length": length, "focus": focus})

    def extract(
        self,
        *,
        file_id: str,
        type: str,
        schema: dict[str, Any] | None = None,
        instructions: str | None = None,
    ) -> dict[str, Any]:
        """Extracts an invoice, a statement, tables, or your own JSON schema (type="schema")."""
        return self._client._post(
            "/ai/extract", {"file_id": file_id, "type": type, "schema": schema, "instructions": instructions}
        )

    def find_redactions(self, *, file_id: str, request: str) -> dict[str, Any]:
        """Finds what to redact from a description ("every name and phone number")."""
        return self._client._post("/ai/redact-find", {"file_id": file_id, "request": request})

    def edit(self, *, file_id: str, instruction: str, run: bool | None = None, wait: int | None = None) -> dict[str, Any]:
        """Plans (and with run=True runs) an edit described in words."""
        return self._client._post("/ai/edit", {"file_id": file_id, "instruction": instruction, "run": run, "wait": wait})


class _Account:
    def __init__(self, client: FynePDF) -> None:
        self._client = client

    def me(self) -> dict[str, Any]:
        return self._client._request("GET", "/me")

    def balance(self) -> dict[str, Any]:
        return self._client._request("GET", "/balance")


def _problem(response: httpx.Response) -> dict[str, Any] | None:
    try:
        body = response.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


class FynePDF:
    """The FynePDF API. The key comes from `api_key` or the FYNEPDF_API_KEY environment variable."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = 120.0,
        max_retries: int = 2,
        http_client: httpx.Client | None = None,
    ) -> None:
        api_key = api_key or os.environ.get("FYNEPDF_API_KEY")
        if not api_key:
            raise ValueError(
                "No FynePDF API key: pass api_key or set FYNEPDF_API_KEY. "
                "Make one at https://fynepdf.com/developers/dashboard."
            )
        self._api_key = api_key
        self.base_url = (base_url or os.environ.get("FYNEPDF_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.max_retries = max_retries
        self._http = http_client or httpx.Client(timeout=timeout)
        #: Files in and out.
        self.files = _Files(self)
        #: Jobs: one or more steps on your files.
        self.jobs = _Jobs(self)
        #: Every PDF action as one call.
        self.pdf = PdfActions(self)
        #: Reading PDFs with AI.
        self.ai = _Ai(self)
        #: The key you're calling with, and the credits left.
        self.account = _Account(self)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> FynePDF:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _post(self, path: str, body: Mapping[str, Any]) -> Any:
        return self._request("POST", path, json=_clean(body))

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        """One call. POSTs carry an Idempotency-Key, the same on every retry, so nothing runs or charges twice."""
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": f"fynepdf-python/{__version__}",
        }
        if method == "POST":
            headers["Idempotency-Key"] = str(uuid.uuid4())
        for attempt in range(self.max_retries + 1):
            try:
                response = self._http.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)
            except httpx.TransportError as error:
                if attempt < self.max_retries:
                    time.sleep(0.5 * 2**attempt)
                    continue
                raise FynePDFError(0, None, f"Couldn't reach the FynePDF API: {error}") from error
            if response.status_code < 300:
                return response.json() if response.content else None
            if response.status_code in RETRY_STATUSES and attempt < self.max_retries:
                after = response.headers.get("retry-after", "")
                time.sleep(min(float(after), 60) if after.replace(".", "", 1).isdigit() else 0.5 * 2**attempt)
                continue
            raise FynePDFError(response.status_code, _problem(response), f"{method} {path} answered {response.status_code}")
        raise AssertionError("unreachable")
