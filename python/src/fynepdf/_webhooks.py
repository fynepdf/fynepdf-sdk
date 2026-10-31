"""Checks a FynePDF webhook (Standard Webhooks: https://www.standardwebhooks.com) and returns its event."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Mapping


class WebhookVerificationError(Exception):
    """The webhook isn't from FynePDF, was changed, or is too old."""


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def verify_webhook(
    payload: bytes | str,
    headers: Mapping[str, str],
    secret: str,
    *,
    tolerance_seconds: int = 300,
) -> dict[str, Any]:
    """Returns the event ({"type": "job.succeeded", "data": job, ...}) if the signature is good.

    payload: the raw request body, exactly as it arrived (not parsed and re-serialized).
    headers: the request's headers (webhook-id, webhook-timestamp, webhook-signature).
    secret: your signing secret, whsec_..., from the dashboard.
    """
    body = payload.decode() if isinstance(payload, bytes) else payload
    msg_id = _header(headers, "webhook-id")
    timestamp = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if not msg_id or not timestamp or not signatures:
        raise WebhookVerificationError("Missing webhook headers.")
    try:
        sent = int(timestamp)
    except ValueError as error:
        raise WebhookVerificationError("The webhook's timestamp isn't a number.") from error
    if abs(time.time() - sent) > tolerance_seconds:
        raise WebhookVerificationError("The webhook's timestamp is too old or too new.")
    key = base64.b64decode(secret.removeprefix("whsec_"))
    expected = base64.b64encode(hmac.new(key, f"{msg_id}.{timestamp}.{body}".encode(), hashlib.sha256).digest()).decode()
    if not any(
        part.startswith("v1,") and hmac.compare_digest(part[3:], expected) for part in signatures.split(" ")
    ):
        raise WebhookVerificationError("The webhook's signature doesn't match.")
    return json.loads(body)
