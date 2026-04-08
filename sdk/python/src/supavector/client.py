from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any, Dict, Optional
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request


class SupaVectorError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        payload: Any = None,
        response_body: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload
        self.response_body = response_body


def _normalize_base_url(value: Optional[str]) -> str:
    base_url = (value or "http://localhost:3000").rstrip("/")
    return base_url or "http://localhost:3000"


def _stringify_query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class SupaVectorClient:
    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        api_key: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        anthropic_api_key: Optional[str] = None,
        tenant_id: Optional[str] = None,
        collection: Optional[str] = None,
        principal_id: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = _normalize_base_url(base_url)
        self.token = token or None
        self.api_key = api_key or None
        self.openai_api_key = openai_api_key or None
        self.gemini_api_key = gemini_api_key or None
        self.anthropic_api_key = anthropic_api_key or None
        self.tenant_id = tenant_id or None
        self.collection = collection or None
        self.principal_id = principal_id or None
        self.timeout = float(timeout)

    @classmethod
    def from_env(cls, **overrides: Any) -> "SupaVectorClient":
        options = {
            "base_url": os.getenv("SUPAVECTOR_BASE_URL") or os.getenv("SUPAVECTOR_URL") or "http://localhost:3000",
            "api_key": os.getenv("SUPAVECTOR_API_KEY"),
            "openai_api_key": os.getenv("OPENAI_API_KEY"),
            "gemini_api_key": os.getenv("GEMINI_API_KEY") or os.getenv("GEMINI_API"),
            "anthropic_api_key": os.getenv("ANTHROPIC_API_KEY"),
            "collection": os.getenv("SUPAVECTOR_COLLECTION"),
            "tenant_id": os.getenv("SUPAVECTOR_TENANT_ID"),
            "principal_id": os.getenv("SUPAVECTOR_PRINCIPAL_ID"),
        }
        options.update(overrides)
        return cls(**options)

    def set_token(self, token: Optional[str]) -> None:
        self.token = token or None

    def set_api_key(self, api_key: Optional[str]) -> None:
        self.api_key = api_key or None

    def set_openai_api_key(self, openai_api_key: Optional[str]) -> None:
        self.openai_api_key = openai_api_key or None

    def set_gemini_api_key(self, gemini_api_key: Optional[str]) -> None:
        self.gemini_api_key = gemini_api_key or None

    def set_anthropic_api_key(self, anthropic_api_key: Optional[str]) -> None:
        self.anthropic_api_key = anthropic_api_key or None

    def set_provider_api_key(self, provider: Optional[str], value: Optional[str]) -> None:
        clean_provider = str(provider or "").strip().lower()
        if clean_provider == "gemini":
            self.gemini_api_key = value or None
            return
        if clean_provider == "anthropic":
            self.anthropic_api_key = value or None
            return
        self.openai_api_key = value or None

    def set_tenant(self, tenant_id: Optional[str]) -> None:
        self.tenant_id = tenant_id or None

    def set_collection(self, collection: Optional[str]) -> None:
        self.collection = collection or None

    def set_principal(self, principal_id: Optional[str]) -> None:
        self.principal_id = principal_id or None

    def build_query(self, params: Optional[Mapping[str, Any]] = None) -> str:
        query: Dict[str, Any] = dict(params or {})
        if self.tenant_id and query.get("tenantId") is None:
            query["tenantId"] = self.tenant_id
        if self.collection and query.get("collection") is None:
            query["collection"] = self.collection
        encoded: Dict[str, str] = {}
        for key, value in query.items():
            if value is None or value == "":
                continue
            if isinstance(value, (list, tuple)):
                encoded[key] = ",".join(_stringify_query_value(item) for item in value)
            else:
                encoded[key] = _stringify_query_value(value)
        if not encoded:
            return ""
        return f"?{urllib_parse.urlencode(encoded)}"

    def build_body(self, body: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = dict(body or {})
        if self.tenant_id and payload.get("tenantId") is None:
            payload["tenantId"] = self.tenant_id
        if self.collection and payload.get("collection") is None:
            payload["collection"] = self.collection
        if self.principal_id and payload.get("principalId") is None:
            payload["principalId"] = self.principal_id
        return payload

    def _build_headers(
        self,
        *,
        auth: bool = True,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if auth:
            if self.api_key:
                headers["X-API-Key"] = self.api_key
            elif self.token:
                headers["Authorization"] = f"Bearer {self.token}"
        if self.openai_api_key:
            headers["X-OpenAI-API-Key"] = self.openai_api_key
        if self.gemini_api_key:
            headers["X-Gemini-API-Key"] = self.gemini_api_key
        if self.anthropic_api_key:
            headers["X-Anthropic-API-Key"] = self.anthropic_api_key
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _decode_json(self, payload: bytes) -> Any:
        text = payload.decode("utf-8") if payload else ""
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise SupaVectorError(
                "Response was not valid JSON",
                response_body=text,
            ) from exc

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        auth: bool = True,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        query_string = self.build_query(query) if query is not None else ""
        url = f"{self.base_url}{path}{query_string}"
        body_bytes = None
        if body is not None:
            body_bytes = json.dumps(self.build_body(body)).encode("utf-8")
        req = urllib_request.Request(
            url,
            data=body_bytes,
            method=method.upper(),
            headers=self._build_headers(auth=auth, idempotency_key=idempotency_key),
        )
        try:
            with urllib_request.urlopen(req, timeout=self.timeout) as res:
                return self._decode_json(res.read())
        except urllib_error.HTTPError as exc:
            raw = exc.read()
            text = raw.decode("utf-8") if raw else ""
            payload = None
            if text:
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    payload = None
            message = (
                (payload or {}).get("error", {}).get("message")
                if isinstance((payload or {}).get("error"), Mapping)
                else (payload or {}).get("error")
            ) or exc.reason
            raise SupaVectorError(
                str(message),
                status=exc.code,
                payload=payload,
                response_body=text or None,
            ) from None
        except urllib_error.URLError as exc:
            raise SupaVectorError(f"Request failed: {exc.reason}") from None

    def health(self) -> Any:
        return self.request("/v1/health", auth=False)

    def login(self, username: str, password: str) -> Any:
        payload = self.request(
            "/v1/login",
            method="POST",
            auth=False,
            body={"username": username, "password": password},
        )
        if isinstance(payload, Mapping):
            data = payload.get("data") or {}
            token = data.get("token")
            if token:
                self.token = str(token)
            tenant = (data.get("user") or {}).get("tenant")
            if tenant:
                self.tenant_id = str(tenant)
        return payload

    def stats(self) -> Any:
        return self.request("/v1/stats")

    def get_models(self) -> Any:
        return self.request("/v1/models", auth=False)

    def models(self) -> Any:
        return self.get_models()

    def list_docs(self, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/docs", query=params)

    def list_collections(self, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/collections", query=params)

    def index_text(self, doc_id: str, text: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        payload = dict(params or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/docs",
            method="POST",
            body={"docId": doc_id, "text": text, **payload},
            idempotency_key=idempotency_key,
        )

    def index_url(self, doc_id: str, url: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        payload = dict(params or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/docs/url",
            method="POST",
            body={"docId": doc_id, "url": url, **payload},
            idempotency_key=idempotency_key,
        )

    def delete_doc(self, doc_id: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        safe_doc_id = urllib_parse.quote(str(doc_id), safe="")
        return self.request(f"/v1/docs/{safe_doc_id}", method="DELETE", query=params)

    def delete_collection(self, collection: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        safe_collection = urllib_parse.quote(str(collection), safe="")
        return self.request(f"/v1/collections/{safe_collection}", method="DELETE", query=params)

    def search(self, query: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        next_query = {"q": query, **dict(params or {})}
        return self.request("/v1/search", query=next_query)

    def ask(self, question: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/ask", method="POST", body={"question": question, **dict(params or {})})

    def code(self, question: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/code", method="POST", body={"question": question, **dict(params or {})})

    def boolean_ask(self, question: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/boolean_ask", method="POST", body={"question": question, **dict(params or {})})

    def memory_write(self, data: Optional[Mapping[str, Any]]) -> Any:
        payload = dict(data or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/memory/write",
            method="POST",
            body=payload,
            idempotency_key=idempotency_key,
        )

    def memory_recall(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/memory/recall", method="POST", body=dict(data or {}))

    def memory_reflect(self, data: Optional[Mapping[str, Any]]) -> Any:
        payload = dict(data or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/memory/reflect",
            method="POST",
            body=payload,
            idempotency_key=idempotency_key,
        )

    def memory_cleanup(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/memory/cleanup", method="POST", body=dict(data or {}))

    def memory_compact(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/memory/compact", method="POST", body=dict(data or {}))

    def feedback(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/feedback", method="POST", body=dict(data or {}))

    def get_tenant_settings(self) -> Any:
        return self.request("/v1/admin/tenant")

    def update_tenant_settings(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/admin/tenant", method="PATCH", body=dict(data or {}))

    def get_job(self, job_id: str) -> Any:
        safe_job_id = urllib_parse.quote(str(job_id), safe="")
        return self.request(f"/v1/jobs/{safe_job_id}")


Client = SupaVectorClient
