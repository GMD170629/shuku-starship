from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request as UrlRequest
from urllib.request import urlopen


USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36"
SEED_BASE_URLS = ("https://z-lib.fo", "https://z-library.sk", "https://1lib.sk")


@dataclass(frozen=True)
class ZlibrarySession:
    base_url: str
    user_id: str
    user_key: str

    @property
    def cookie(self) -> str:
        return f"remix_userid={self.user_id}; remix_userkey={self.user_key}"


class ZlibraryEapiError(ValueError):
    pass


class ZlibraryEapiTransientError(ZlibraryEapiError):
    pass


class ZlibraryEapiAuthError(ZlibraryEapiError):
    pass


def normalize_base_url(value: str | None) -> str | None:
    if not value:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    if not candidate.startswith(("http://", "https://")):
        candidate = f"https://{candidate}"
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ZlibraryEapiError("Z-Library baseUrl 必须是有效的 http/https URL。")
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def candidate_base_urls(config_base_url: str | None) -> list[str]:
    configured = normalize_base_url(config_base_url)
    if configured:
        return [configured]
    return list(SEED_BASE_URLS)


def browser_check_reason(body: str, content_type: str | None = None) -> str | None:
    lower = body.lower()
    if "checking your browser" in lower or "wait a moment, checking your browser" in lower:
        return "Z-Library 返回了浏览器校验页。"
    if "enable javascript" in lower and "browser" in lower:
        return "Z-Library 返回了需要浏览器 JavaScript 的页面。"
    if (content_type or "").lower().startswith("text/html") and "<html" in lower:
        return "Z-Library eapi 返回了 HTML 页面。"
    return None


def _api_error_message(payload: Any, fallback: str) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()
        if isinstance(error, str) and error.strip():
            return error.strip()
        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    return fallback


class ZlibraryEapiClient:
    def __init__(self, base_url: str) -> None:
        normalized = normalize_base_url(base_url)
        if not normalized:
            raise ZlibraryEapiError("Z-Library baseUrl 不能为空。")
        self.base_url = normalized

    def url(self, path: str) -> str:
        return urljoin(f"{self.base_url}/", path.lstrip("/"))

    def request_json(self, path: str, *, data: dict[str, Any] | None = None, session: ZlibrarySession | None = None, timeout: int = 20) -> dict[str, Any]:
        body = None
        method = "GET"
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "User-Agent": USER_AGENT,
        }
        if data is not None:
            body = urlencode({key: str(value) for key, value in data.items()}).encode("utf-8")
            method = "POST"
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
            headers["X-Requested-With"] = "XMLHttpRequest"
        if session is not None:
            headers["Cookie"] = session.cookie
        request = UrlRequest(self.url(path), data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8", "replace")
                content_type = response.headers.get("content-type")
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            content_type = exc.headers.get("content-type")
            payload = self._decode_payload(raw, content_type)
            message = _api_error_message(payload, f"HTTP {exc.code}")
            if "please login" in message.lower():
                raise ZlibraryEapiAuthError("Z-Library 登录已失效，请重新登录后再试。") from exc
            if "incorrect email or password" in message.lower():
                raise ZlibraryEapiAuthError("Z-Library 登录失败：邮箱或密码不正确。") from exc
            raise ZlibraryEapiError(f"Z-Library eapi 请求失败：{message}") from exc
        except URLError as exc:
            raise ZlibraryEapiTransientError(f"Z-Library eapi 网络请求失败：{exc.reason}") from exc
        return self._decode_payload(raw, content_type)

    def _decode_payload(self, raw: str, content_type: str | None) -> dict[str, Any]:
        if reason := browser_check_reason(raw, content_type):
            raise ZlibraryEapiTransientError(reason)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ZlibraryEapiError(f"Z-Library eapi 返回了无效 JSON：{exc}") from exc
        if not isinstance(payload, dict):
            raise ZlibraryEapiError("Z-Library eapi 返回结构异常。")
        return payload

    def login(self, email: str, password: str) -> ZlibrarySession:
        payload = self.request_json("/eapi/user/login", data={"email": email, "password": password}, timeout=20)
        if payload.get("success") != 1:
            message = _api_error_message(payload, "登录失败")
            if "incorrect email or password" in message.lower():
                raise ZlibraryEapiAuthError("Z-Library 登录失败：邮箱或密码不正确。")
            raise ZlibraryEapiAuthError(f"Z-Library 登录失败：{message}")
        user = payload.get("user") or payload.get("response")
        if not isinstance(user, dict):
            raise ZlibraryEapiAuthError("Z-Library 登录失败：响应中缺少会话信息。")
        user_id = str(user.get("id") or user.get("user_id") or "").strip()
        user_key = str(user.get("remix_userkey") or user.get("user_key") or "").strip()
        if not user_id or not user_key:
            raise ZlibraryEapiAuthError("Z-Library 登录失败：响应中缺少 remix_userid/remix_userkey。")
        return ZlibrarySession(base_url=self.base_url, user_id=user_id, user_key=user_key)

    def search(self, session: ZlibrarySession, keyword: str, *, languages: list[str], extensions: list[str], exact: bool, page: int, limit: int) -> dict[str, Any]:
        data: dict[str, Any] = {
            "message": keyword,
            "page": max(1, page),
            "limit": max(1, limit),
        }
        if exact:
            data["exact"] = 1
        for index, language in enumerate(languages):
            data[f"languages[{index}]"] = language
        for index, extension in enumerate(extensions):
            data[f"extensions[{index}]"] = extension
        payload = self.request_json("/eapi/book/search", data=data, session=session, timeout=30)
        if payload.get("success") != 1:
            raise ZlibraryEapiError(f"Z-Library 搜索失败：{_api_error_message(payload, '搜索失败')}")
        return payload

    def get_book_details(self, session: ZlibrarySession, book_id: str, book_hash: str) -> dict[str, Any]:
        payload = self.request_json(f"/eapi/book/{book_id}/{book_hash}", session=session, timeout=20)
        if payload.get("success") != 1 or not isinstance(payload.get("book"), dict):
            raise ZlibraryEapiError(f"Z-Library 书籍详情读取失败：{_api_error_message(payload, '详情缺失')}")
        return payload["book"]

    def get_download_link(self, session: ZlibrarySession, book_id: str, book_hash: str) -> dict[str, Any]:
        payload = self.request_json(f"/eapi/book/{book_id}/{book_hash}/file", session=session, timeout=20)
        if payload.get("success") != 1:
            raise ZlibraryEapiError(f"Z-Library 下载链接获取失败：{_api_error_message(payload, '下载链接缺失')}")
        file_data = payload.get("file")
        if not isinstance(file_data, dict) or not isinstance(file_data.get("downloadLink"), str) or not file_data["downloadLink"].strip():
            raise ZlibraryEapiError("Z-Library 下载链接获取失败：响应中缺少 downloadLink。")
        return file_data


def login_with_config(config: dict[str, Any]) -> tuple[ZlibraryEapiClient, ZlibrarySession]:
    email = str(config.get("email") or "").strip()
    password = str(config.get("password") or "").strip()
    if not email or not password:
        raise ZlibraryEapiAuthError("请在 Z-Library 源中配置 singlelogin 邮箱和密码。")
    last_error: Exception | None = None
    for base_url in candidate_base_urls(str(config.get("baseUrl") or "").strip() or None):
        client = ZlibraryEapiClient(base_url)
        try:
            return client, client.login(email, password)
        except ZlibraryEapiAuthError:
            raise
        except ZlibraryEapiTransientError as exc:
            last_error = exc
            continue
        except ZlibraryEapiError as exc:
            last_error = exc
            continue
    message = str(last_error) if last_error else "没有可用的 Z-Library eapi 域名。"
    raise ZlibraryEapiError(f"Z-Library eapi 不可用：{message}")

