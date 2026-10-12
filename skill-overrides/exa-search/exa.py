#!/usr/bin/env python3
"""Exa 官方 REST API wrapper（供 pi skill 调用）。

直接 POST 固定端点 https://api.exa.ai/search 与 /contents，API key 只通过
x-api-key 请求头传输，绝不放入 URL、日志或错误信息。错误输出仅包含安全
类别、HTTP 状态码与受控格式的 request id。
"""

import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from types import MappingProxyType
from typing import Any, Optional

API_BASE_URL = "https://api.exa.ai"  # 固定 host，不接受任何输入改写
SEARCH_PATH = "/search"
CONTENTS_PATH = "/contents"
_ALLOWED_PATHS = (SEARCH_PATH, CONTENTS_PATH)
MAX_RESPONSE_BYTES = 1 << 20
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_PROXY_HOST = "127.0.0.1"
DEFAULT_PROXY_PORT = 7897
DEFAULT_NUM_RESULTS = 10
DEFAULT_MAX_CHARACTERS = 3000
# 模块级公共请求头不含认证信息；x-api-key 在每次请求时单独附加。
HEADERS = MappingProxyType({
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "exa-pi-skill/2.0",
})
LOCAL_DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

# 可安全回显的 request id 响应头候选名，以及受限字符集白名单。
_REQUEST_ID_HEADERS = ("x-exa-request-id", "x-request-id")
_REQUEST_ID_PATTERN = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def _local_dotenv_api_key() -> str:
    """运行时从 skill 目录内 gitignored 的 .env 读取 key；仅内部使用，不打印。"""
    try:
        with open(LOCAL_DOTENV_PATH, encoding="utf-8") as dotenv:
            for line in dotenv:
                entry = line.strip()
                if not entry or entry.startswith("#"):
                    continue
                match = re.match(r"(?:export\s+)?EXA_API_KEY\s*=\s*(.*)$", entry)
                if not match:
                    if re.match(r"(?:export\s+)?EXA_API_KEY\b", entry):
                        raise RuntimeError("Invalid EXA_API_KEY entry in local .env")
                    continue
                value = match.group(1).strip()
                if not value:
                    return ""
                if value[0] in ("'", '"'):
                    quote = value[0]
                    if len(value) < 2 or value[-1] != quote or value[1:-1].find(quote) >= 0:
                        raise RuntimeError("Invalid EXA_API_KEY entry in local .env")
                    value = value[1:-1]
                return value.strip()
    except FileNotFoundError:
        return ""
    except OSError:
        raise RuntimeError("Unable to read local .env") from None
    return ""


def _required_api_key() -> str:
    """取回本次请求使用的 key：进程环境优先，其次本地 .env；缺失或非法即失败。"""
    api_key = os.environ.get("EXA_API_KEY", "").strip()
    if not api_key:
        api_key = _local_dotenv_api_key()
    if not api_key:
        raise RuntimeError(
            "EXA_API_KEY is required; set it in the environment or local .env before using exa-search"
        )
    if len(api_key) > 256 or any(ord(char) < 32 or ord(char) == 127 for char in api_key):
        # 拒绝控制字符，防止借 key 头注入额外请求头。
        raise RuntimeError(
            "EXA_API_KEY must be at most 256 characters and contain no control characters"
        )
    return api_key


def _proxy_dict(proxy_port: Optional[int]) -> dict:
    """仅作用于 Exa 请求的代理映射；在任何网络活动前完成校验。"""
    if proxy_port is None:
        port = DEFAULT_PROXY_PORT
    elif isinstance(proxy_port, int) and not isinstance(proxy_port, bool) and 1 <= proxy_port <= 65535:
        port = proxy_port
    else:
        raise RuntimeError("Exa proxy port must be an integer in [1, 65535]")
    proxy_url = f"http://{DEFAULT_PROXY_HOST}:{port}"
    return {"http": proxy_url, "https": proxy_url}


def _env_proxy_port() -> Optional[int]:
    """EXA_PROXY_PORT 单次调用覆盖（仅接受十进制端口 1–65535）。"""
    raw = os.environ.get("EXA_PROXY_PORT")
    if raw is None:
        return None
    if isinstance(raw, str) and re.fullmatch(r"[0-9]+", raw) and 1 <= int(raw, 10) <= 65535:
        return int(raw, 10)
    raise RuntimeError("EXA_PROXY_PORT must be a decimal port in [1, 65535]")


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """阻断跨域（host/scheme/port 任一不同）重定向，避免认证头被带往其他主机。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        source = urllib.parse.urlsplit(req.full_url)
        if (target.scheme, target.hostname, target.port) != (
            source.scheme,
            source.hostname,
            source.port,
        ):
            # 不回显目标 URL，防止把不受控的重定向地址写入错误输出。
            raise RuntimeError("Exa request redirect to a different host is blocked")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(req: urllib.request.Request, timeout: float, proxy_dict: dict):
    """经每次调用独立构建的 opener 发送请求；代理作用域仅限 Exa 自身。"""
    opener = urllib.request.build_opener(
        _SameOriginRedirectHandler(),
        urllib.request.ProxyHandler(proxy_dict),
    )
    return opener.open(req, timeout=timeout)


def _validate_positive_int(value: Any, name: str, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RuntimeError(f"{name} must be an integer >= {minimum}")
    return value


def _validate_str_list(value: Any, name: str) -> list:
    if not isinstance(value, (list, tuple)):
        raise RuntimeError(f"{name} must be a list of strings")
    items = list(value)
    if not items:
        raise RuntimeError(f"{name} must contain at least one entry")
    for item in items:
        if not isinstance(item, str) or not item.strip():
            raise RuntimeError(f"{name} entries must be non-empty strings")
    return items


def _serialize_payload(payload: dict) -> bytes:
    if not isinstance(payload, dict):
        raise RuntimeError("Exa request payload must be a JSON object")
    try:
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError):
        raise RuntimeError("Exa request payload is not JSON serializable") from None


def _http_error_category(code: int) -> str:
    """把 HTTP 状态码映射为可安全输出的脱敏类别。"""
    if code in (401, 403):
        return "authentication_error"
    if code == 402:
        return "payment_required"
    if code == 429:
        return "rate_limited"
    if 300 <= code < 400:
        return "redirect_error"
    if 400 <= code < 500:
        return "client_error"
    if code >= 500:
        return "server_error"
    return "http_error"


def _safe_request_id(headers: Any) -> str:
    """仅当 request id 匹配受限字符集时返回（保证可安全回显），否则返回空串。"""
    try:
        items = list(headers.items())
    except Exception:
        return ""
    wanted = {name.lower() for name in _REQUEST_ID_HEADERS}
    for key, value in items:
        if isinstance(key, str) and key.lower() in wanted and isinstance(value, str):
            candidate = value.strip()
            if _REQUEST_ID_PATTERN.match(candidate):
                return candidate
    return ""


def rest_post(path: str, payload: dict, proxy_port: Optional[int] = None) -> dict:
    """POST 固定 host 的 Exa REST 端点，把服务端结构化 JSON dict 原样返回。"""
    if path not in _ALLOWED_PATHS:
        raise RuntimeError("Unsupported Exa endpoint path")
    proxy_dict = _proxy_dict(proxy_port)  # 非法端口在任何请求前失败
    api_key = _required_api_key()
    body = _serialize_payload(payload)
    headers = dict(HEADERS)
    headers["x-api-key"] = api_key  # key 只经此请求头传输
    req = urllib.request.Request(
        API_BASE_URL + path, data=body, headers=headers, method="POST"
    )

    try:
        with _open(req, timeout=DEFAULT_TIMEOUT_SECONDS, proxy_dict=proxy_dict) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        request_id = _safe_request_id(exc.headers)
        suffix = f" (request_id={request_id})" if request_id else ""
        raise RuntimeError(
            f"Exa request failed: HTTP {exc.code} {_http_error_category(exc.code)}{suffix}"
        ) from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise RuntimeError("Exa request timed out") from None
        # 不回显 reason：其中可能包含目标 URL、userinfo 或其他敏感内容。
        raise RuntimeError(
            "Exa request failed before receiving a response (network error)"
        ) from None
    except (TimeoutError, socket.timeout):
        raise RuntimeError("Exa request timed out") from None
    except RuntimeError:
        raise  # 保留本模块已脱敏的错误（如跨域重定向阻断）。
    except Exception as exc:
        # 只输出异常类型名，不回显异常文本，避免泄露响应或环境内容。
        raise RuntimeError(f"Exa request failed: {type(exc).__name__}") from None

    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError(f"Exa response exceeds {MAX_RESPONSE_BYTES} bytes limit")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise RuntimeError("Exa response is not valid UTF-8") from None
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        # 非法 JSON（含被误投递的事件流格式错误体）一律按脱敏类别处理，不回显内容。
        raise RuntimeError("Exa response is not valid JSON") from None
    if not isinstance(parsed, dict):
        raise RuntimeError("Exa response JSON is not an object")
    return parsed


def search(
    query: str, num_results: int = DEFAULT_NUM_RESULTS, proxy_port: Optional[int] = None
) -> dict:
    """网页搜索；query 原样透传（保留调用方自带的 category:people/company 前缀语义）。"""
    if not isinstance(query, str) or not query.strip():
        raise RuntimeError("query must be a non-empty string")
    _validate_positive_int(num_results, "num_results", minimum=1)
    payload = {
        "query": query,
        "numResults": num_results,
        "type": "auto",
        "contents": {"highlights": True},
    }
    return rest_post(SEARCH_PATH, payload, proxy_port=proxy_port)


def fetch(
    urls: Optional[list] = None,
    ids: Optional[list] = None,
    max_characters: int = DEFAULT_MAX_CHARACTERS,
    proxy_port: Optional[int] = None,
) -> dict:
    """抓取正文；max_characters 为每个 URL 正文的字符上限（截断语义，非完整性保证）。

    urls 与 ids 二选一；逐 URL 的成败状态由服务端返回的 statuses 字段保留。
    """
    _validate_positive_int(max_characters, "max_characters", minimum=1)
    if urls is not None and ids is not None:
        raise RuntimeError("provide either urls or ids, not both")
    if urls is not None:
        entries = _validate_str_list(urls, "urls")
        key = "urls"
    elif ids is not None:
        entries = _validate_str_list(ids, "ids")
        key = "ids"
    else:
        raise RuntimeError("either urls or ids is required")
    payload = {key: entries, "text": {"maxCharacters": max_characters}}
    return rest_post(CONTENTS_PATH, payload, proxy_port=proxy_port)


_USAGE = (
    "Usage: exa.py search <query> [num_results]\n"
    "       exa.py fetch <url1> [url2 ...]"
)


def main() -> None:
    if len(sys.argv) < 2:
        print(_USAGE, file=sys.stderr)
        sys.exit(1)

    try:
        proxy_port = _env_proxy_port()  # 非法值在任何请求前失败
    except RuntimeError as exc:
        print(f"exa error: {exc}", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    try:
        if cmd == "search":
            if len(sys.argv) < 3:
                print("Usage: exa.py search <query> [num_results]", file=sys.stderr)
                sys.exit(1)
            query = sys.argv[2]
            num_results = DEFAULT_NUM_RESULTS
            if len(sys.argv) > 3:
                try:
                    num_results = int(sys.argv[3], 10)
                except ValueError:
                    raise RuntimeError("num_results must be an integer") from None
            result = search(query, num_results, proxy_port=proxy_port)
        elif cmd == "fetch":
            if len(sys.argv) < 3:
                print("Usage: exa.py fetch <url1> [url2 ...]", file=sys.stderr)
                sys.exit(1)
            result = fetch(urls=list(sys.argv[2:]), proxy_port=proxy_port)
        else:
            print(f"Unknown command: {cmd}", file=sys.stderr)
            sys.exit(1)
    except RuntimeError as exc:
        # 错误只含安全类别/HTTP 状态/受控 request id，不含凭据或响应内容。
        print(f"exa error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
