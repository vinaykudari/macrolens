"""Stdlib scrypt PIN hashing, HMAC-SHA256 bearer/cookie tokens, and FastAPI auth dependencies."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import User

SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 64

_bearer_scheme = HTTPBearer(auto_error=False)


class TokenError(Exception):
    """Raised when a bearer or session token is invalid or expired."""


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def hash_pin(pin: str) -> str:
    """Hash a numeric PIN using Python stdlib hashlib.scrypt with a random salt."""
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        pin.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return (
        f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}$"
        f"{_b64url_encode(salt)}${_b64url_encode(digest)}"
    )


def verify_pin(pin: str, stored_hash: str) -> bool:
    """Verify a PIN against a stored scrypt hash in constant time."""
    try:
        scheme, n_str, r_str, p_str, salt_b64, digest_b64 = stored_hash.split("$")
        if scheme != "scrypt":
            return False
        n = int(n_str)
        r = int(r_str)
        p = int(p_str)
        salt = _b64url_decode(salt_b64)
        expected_digest = _b64url_decode(digest_b64)
        computed_digest = hashlib.scrypt(
            pin.encode("utf-8"),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=len(expected_digest),
        )
        return hmac.compare_digest(computed_digest, expected_digest)
    except (ValueError, TypeError):
        return False


def create_access_token(
    *,
    user_id: int,
    email: str,
    secret_key: str | None = None,
    expires_seconds: int | None = None,
) -> str:
    """Create a signed HMAC-SHA256 compact JWT-style access token."""
    resolved_secret = (secret_key if secret_key is not None else settings.SECRET_KEY).encode("utf-8")
    ttl = expires_seconds if expires_seconds is not None else settings.access_token_ttl_seconds
    now = int(time.time())

    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": str(user_id),
        "email": email,
        "iat": now,
        "exp": now + int(ttl),
        "jti": secrets.token_hex(8),
    }
    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = hmac.new(resolved_secret, signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{_b64url_encode(signature)}"


def decode_access_token(token: str, *, secret_key: str | None = None) -> dict[str, Any]:
    """Verify an HMAC-SHA256 token's signature and expiration and return its payload."""
    resolved_secret = (secret_key if secret_key is not None else settings.SECRET_KEY).encode("utf-8")
    parts = token.split(".")
    if len(parts) != 3:
        raise TokenError("Malformed token")

    header_b64, payload_b64, sig_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected_sig = hmac.new(resolved_secret, signing_input, hashlib.sha256).digest()

    try:
        actual_sig = _b64url_decode(sig_b64)
        header = json.loads(_b64url_decode(header_b64).decode("utf-8"))
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TokenError("Invalid token encoding") from exc

    if not isinstance(header, dict) or header.get("alg") != "HS256":
        raise TokenError("Unsupported token algorithm")
    if not hmac.compare_digest(actual_sig, expected_sig):
        raise TokenError("Invalid token signature")
    if not isinstance(payload, dict) or "sub" not in payload or "exp" not in payload:
        raise TokenError("Incomplete token claims")

    try:
        exp = int(payload["exp"])
        int(payload["sub"])
    except (ValueError, TypeError) as exc:
        raise TokenError("Invalid token claims") from exc

    if int(time.time()) >= exp:
        raise TokenError("Token has expired")

    return payload


def extract_token_from_request(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
) -> str | None:
    """Resolve auth token from Authorization Bearer header or persistent session cookie."""
    if credentials is not None and credentials.credentials:
        return credentials.credentials.strip()
    cookie_token = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if cookie_token:
        return cookie_token.strip()
    return None


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Authenticate current user via Authorization Bearer header or macro_session cookie."""
    token = extract_token_from_request(request, credentials)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication credentials were not provided",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except (TokenError, ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authenticated user no longer exists",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user
