#!/usr/bin/env python3
"""DeepSeek 官方 Search / Fetch REST API wrapper（供 pi skill 调用）。

直接 POST 固定端点 https://api.deepseek.com/v1/tools/search 与 /v1/tools/fetch：

- 纯 JSON 请求/响应，非流式，不需要模型名，也不是聊天补全；
- API key 只通过 ``Authorization: Bearer`` 请求头传输，绝不进入 URL、日志或错误信息；
- 失败时 stderr 只输出安全类别、HTTP 状态码与受控格式的 request id，不回显服务端原文；
- 不静默重试，不回退到 Exa 或其他搜索供应商（重试策略由调用方按官方说明决定）。
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
from typing import Any

API_BASE_URL = "https://api.deepseek.com"  # 固定 host，不接受任何输入改写
SEARCH_PATH = "/v1/tools/search"
FETCH_PATH = "/v1/tools/fetch"
_ALLOWED_PATHS = (SEARCH_PATH, FETCH_PATH)
MAX_RESPONSE_BYTES = 1 << 20  # 1 MiB，超限直接失败，不伪装成完整内容
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_COUNT = 10
MIN_COUNT = 1
MAX_COUNT = 50
MAX_QUERY_CHARS = 128  # 官方约束：1–128 个 Unicode 字符
MAX_FETCH_URL_CHARS = 8192  # 官方约束：url 不超过 8192 字符
MAX_API_KEY_CHARS = 256
# 模块级公共请求头不含认证信息；Authorization 在每次请求时单独附加。
HEADERS = MappingProxyType({
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "deepseek-pi-skill/1.0",
})
# 脚本按自身所在目录定位 .env，与当前工作目录无关。
LOCAL_DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

# 可安全回显的 request id 响应头候选名，以及受限字符集白名单。
_REQUEST_ID_HEADERS = ("x-request-id", "x-ds-request-id", "x-deepseek-request-id")
_REQUEST_ID_PATTERN = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def _local_dotenv_api_key() -> str:
    """运行时从 skill 目录内 gitignored 的 .env 读取 key；仅内部使用，不打印。"""
    try:
        with open(LOCAL_DOTENV_PATH, encoding="utf-8") as dotenv:
            for line in dotenv:
                entry = line.strip()
                if not entry or entry.startswith("#"):
                    continue
                match = re.match(r"(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)$", entry)
                if not match:
                    if re.match(r"(?:export\s+)?DEEPSEEK_API_KEY\b", entry):
                        raise RuntimeError("Invalid DEEPSEEK_API_KEY entry in local .env")
                    continue
                value = match.group(1).strip()
                if not value:
                    return ""
                if value[0] in ("'", '"'):
                    quote = value[0]
                    if len(value) < 2 or value[-1] != quote or value[1:-1].find(quote) >= 0:
                        raise RuntimeError("Invalid DEEPSEEK_API_KEY entry in local .env")
                    value = value[1:-1]
                return value.strip()
    except FileNotFoundError:
        return ""
    except OSError:
        raise RuntimeError("Unable to read local .env") from None
    return ""


def _required_api_key() -> str:
    """取回本次请求使用的 key：进程环境优先，其次本地 .env；缺失或非法即失败。"""
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        api_key = _local_dotenv_api_key()
    if not api_key:
        raise RuntimeError(
            "DEEPSEEK_API_KEY is required; export it in the environment "
            "or put it in the .env file next to deepseek.py (see .env.example)"
        )
    if len(api_key) > MAX_API_KEY_CHARS or any(
        ord(char) < 32 or ord(char) == 127 for char in api_key
    ):
        # 拒绝控制字符，防止借 Authorization 头注入额外请求头。
        raise RuntimeError(
            "DEEPSEEK_API_KEY must be at most "
            f"{MAX_API_KEY_CHARS} characters and contain no control characters"
        )
    return api_key


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """阻断跨域（scheme/host/port 任一不同）与 https→http 重定向，避免认证头被带往其他主机。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        source = urllib.parse.urlsplit(req.full_url)
        if (target.scheme, target.hostname, target.port) != (
            source.scheme,
            source.hostname,
            source.port,
        ):
            # 不回显目标 URL，防止把不受控的重定向地址写入错误输出。
            raise RuntimeError("DeepSeek request redirect to a different origin is blocked")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(req: urllib.request.Request):
    """发送请求。

    只替换重定向策略；其余走 urllib 默认 handler，因此系统 ``HTTPS_PROXY`` /
    ``NO_PROXY`` 等环境代理按 urllib 默认行为生效，本脚本不提供额外代理参数。
    HTTPS 证书按系统默认校验。
    """
    opener = urllib.request.build_opener(_SameOriginRedirectHandler())
    return opener.open(req, timeout=DEFAULT_TIMEOUT_SECONDS)


def _validate_query(query: Any) -> str:
    """官方约束：1–128 个 Unicode 字符，不可全空白；内容原样透传以保留检索算子。"""
    if not isinstance(query, str):
        raise RuntimeError("query must be a string")
    if not query.strip():
        raise RuntimeError("query must not be empty or whitespace-only")
    if len(query) > MAX_QUERY_CHARS:
        raise RuntimeError(f"query must be at most {MAX_QUERY_CHARS} Unicode characters")
    return query


def _validate_count(count: Any) -> int:
    """官方约束：整数 1–50，默认 10。"""
    if isinstance(count, bool) or not isinstance(count, int):
        raise RuntimeError("count must be an integer")
    if not MIN_COUNT <= count <= MAX_COUNT:
        raise RuntimeError(f"count must be between {MIN_COUNT} and {MAX_COUNT}")
    return count


def _validate_fetch_url(url: Any) -> str:
    """官方约束：字符串、不超过 8192 字符、http/https、必须有 host、不得含 userinfo。"""
    if not isinstance(url, str):
        raise RuntimeError("url must be a string")
    candidate = url.strip()
    if not candidate:
        raise RuntimeError("url must not be empty")
    if len(candidate) > MAX_FETCH_URL_CHARS:
        raise RuntimeError(f"url must be at most {MAX_FETCH_URL_CHARS} characters")
    if any(char.isspace() for char in candidate) or any(
        ord(char) < 32 or ord(char) == 127 for char in candidate
    ):
        raise RuntimeError("url must not contain whitespace or control characters")
    try:
        parts = urllib.parse.urlsplit(candidate)
        hostname = parts.hostname
        username = parts.username
        password = parts.password
    except ValueError:
        raise RuntimeError("url is not a valid URL") from None
    if parts.scheme.lower() not in ("http", "https"):
        raise RuntimeError("url scheme must be http or https")
    if not hostname:
        raise RuntimeError("url must include a host")
    if username is not None or password is not None:
        raise RuntimeError("url must not contain userinfo")
    return candidate


def _serialize_payload(payload: dict) -> bytes:
    if not isinstance(payload, dict):
        raise RuntimeError("DeepSeek request payload must be a JSON object")
    try:
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError):
        raise RuntimeError("DeepSeek request payload is not JSON serializable") from None


def _http_error_category(code: int, kind: str) -> str:
    """把 HTTP 状态码映射为可安全输出的脱敏类别（按官方错误码表区分）。"""
    if code == 400:
        return "invalid_request"
    if code == 401:
        return "authentication_error"
    if code == 402:
        return "payment_required"
    if code == 403:
        return "fetch_blocked_by_policy" if kind == "fetch" else "access_forbidden"
    if code == 404:
        return "content_unavailable" if kind == "fetch" else "not_found"
    if code == 408:
        return "request_timeout"
    if code == 413:
        return "request_too_large"
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


def rest_post(path: str, payload: dict) -> dict:
    """POST 固定 host 的 DeepSeek REST 端点，把服务端结构化 JSON dict 原样返回。"""
    if path not in _ALLOWED_PATHS:
        raise RuntimeError("Unsupported DeepSeek endpoint path")
    kind = "fetch" if path == FETCH_PATH else "search"
    api_key = _required_api_key()
    body = _serialize_payload(payload)
    headers = dict(HEADERS)
    headers["Authorization"] = f"Bearer {api_key}"  # key 只经此请求头传输
    req = urllib.request.Request(
        API_BASE_URL + path, data=body, headers=headers, method="POST"
    )

    try:
        with _open(req) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        request_id = _safe_request_id(exc.headers)
        suffix = f" (request_id={request_id})" if request_id else ""
        raise RuntimeError(
            f"DeepSeek {kind} request failed: HTTP {exc.code} "
            f"{_http_error_category(exc.code, kind)}{suffix}"
        ) from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise RuntimeError("DeepSeek request timed out") from None
        # 不回显 reason：其中可能包含目标 URL、userinfo 或其他敏感内容。
        raise RuntimeError(
            "DeepSeek request failed before receiving a response (network error)"
        ) from None
    except (TimeoutError, socket.timeout):
        raise RuntimeError("DeepSeek request timed out") from None
    except RuntimeError:
        raise  # 保留本模块已脱敏的错误（如跨域重定向阻断）。
    except Exception as exc:
        # 只输出异常类型名，不回显异常文本，避免泄露响应或环境内容。
        raise RuntimeError(f"DeepSeek request failed: {type(exc).__name__}") from None

    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError(f"DeepSeek response exceeds {MAX_RESPONSE_BYTES} bytes limit")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise RuntimeError("DeepSeek response is not valid UTF-8") from None
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise RuntimeError("DeepSeek response is not valid JSON") from None
    if not isinstance(parsed, dict):
        raise RuntimeError("DeepSeek response JSON is not an object")
    return parsed


def search(query: str, count: int = DEFAULT_COUNT, need_content: bool = False) -> dict:
    """网页搜索：返回 ``{"results": [...]}`` 原始结构，不做摘要或改写。

    ``query`` 原样透传（保留 ``site:`` / ``lang:`` / ``after:`` 等官方算子）；
    ``count`` 映射请求体 ``count``（1–50，默认 10）；
    ``need_content`` 为真时才请求服务端填充 ``results[].content``（默认不取）。
    """
    query = _validate_query(query)
    count = _validate_count(count)
    if not isinstance(need_content, bool):
        raise RuntimeError("need_content must be a boolean")
    payload = {"query": query, "count": count}
    if need_content:
        payload["need_content"] = True
    return rest_post(SEARCH_PATH, payload)


def fetch(url: str) -> dict:
    """抓取单个网页：返回 ``{"title": ..., "content": <Markdown>}`` 原始结构。

    官方无批量抓取、无正文字符上限参数，也不提供分页。
    """
    return rest_post(FETCH_PATH, {"url": _validate_fetch_url(url)})


_USAGE = (
    "用法：\n"
    "  deepseek.py search [--need-content] [--] <query> [count]\n"
    "  deepseek.py fetch <url>\n"
    "\n"
    "  -- 是选项终止符：其后所有参数按位置参数原样传入，不再解析选项；\n"
    "     查询本身以 - 开头（如 -site:example.com）时放在 -- 之后。\n"
    "\n"
    "两个子命令都直接调用 DeepSeek 官方独立 REST API：\n"
    "  POST https://api.deepseek.com/v1/tools/search\n"
    "  POST https://api.deepseek.com/v1/tools/fetch\n"
    "成功时 stdout 输出服务端原始 JSON；失败时 stderr 输出安全错误类别并以非 0 退出。\n"
    "子命令帮助：deepseek.py search --help / deepseek.py fetch --help\n"
    "凭据：环境变量 DEEPSEEK_API_KEY，或本 skill 目录下 .env（见 .env.example）。\n"
)

_SEARCH_HELP = (
    "用法：deepseek.py search [--need-content] [--] <query> [count]\n"
    "\n"
    "参数：\n"
    "  query          检索语句，1–128 个 Unicode 字符，不可全空白；\n"
    "                 原样透传，支持 site: / -site: / \"精确短语\" / -term /\n"
    "                 lang: / after: / before: 等官方算子。\n"
    "  count          结果条数，整数 1–50，默认 10。\n"
    "  --need-content 让服务端同时填充 results[].content（默认不取，只在需要正文时加）；\n"
    "                 需放在 -- 之前。\n"
    "  --             选项终止符：其后所有参数只当位置参数（query、count）原样传入，\n"
    "                 连 --need-content 与 --help 也不再按选项解析；查询以 - 开头\n"
    "                 （如 -site:example.com）时必须在查询前加上 --。\n"
    "\n"
    "示例：\n"
    "  deepseek.py search 'DeepSeek 官方 Search API site:api-docs.deepseek.com' 5\n"
    "  deepseek.py search --need-content -- '-site:example.com DeepSeek' 5\n"
    "\n"
    "输出：服务端原始 JSON，形如 {\"results\": [{title, url, snippet, summary,\n"
    "content, site_name, site_icon, date, authority, rerank_score, ...}]}。\n"
    "引用使用 results[].url；summary/snippet 是服务端字段，脚本不做摘要改写。\n"
    "计费：按成功请求计（调研时官方文档为 $0.75 / 1000 次），count 不影响单价。\n"
)

_FETCH_HELP = (
    "用法：deepseek.py fetch <url>\n"
    "\n"
    "参数：\n"
    "  url            单个网页地址，不超过 8192 字符，仅 http/https、必须有 host、\n"
    "                 不得包含 userinfo（user:pass@host）。\n"
    "\n"
    "输出：服务端原始 JSON {\"title\": ..., \"content\": <Markdown 正文>}；\n"
    "title 不可得时为空串。官方没有批量抓取，也没有正文字符上限参数。\n"
    "计费：按成功请求计（调研时官方文档为 $0.75 / 1000 次）。\n"
)


def _parse_search_args(args: list) -> tuple:
    """解析 search 子命令参数；``--`` 之后全部按位置参数处理，不再识别选项。"""
    positional = []
    need_content = False
    options_ended = False
    for arg in args:
        if options_ended:
            # 终止符之后一律原样作为位置参数，保证 -site: / -term 等算子不被当成选项。
            positional.append(arg)
            continue
        if arg == "--":
            options_ended = True
            continue
        if arg in ("-h", "--help"):
            print(_SEARCH_HELP, end="")
            sys.exit(0)
        if arg == "--need-content":
            need_content = True
            continue
        if arg.startswith("-") and arg != "-":
            raise RuntimeError("unknown option; run: deepseek.py search --help")
        positional.append(arg)
    if not positional:
        print(_SEARCH_HELP, end="", file=sys.stderr)
        sys.exit(1)
    query = positional[0]
    if len(positional) > 2:
        raise RuntimeError("too many arguments; run: deepseek.py search --help")
    count = DEFAULT_COUNT
    if len(positional) == 2:
        try:
            count = int(positional[1], 10)
        except ValueError:
            raise RuntimeError("count must be an integer") from None
    return query, count, need_content


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(_USAGE, end="", file=sys.stderr)
        sys.exit(1)
    if args[0] in ("-h", "--help", "help"):
        print(_USAGE, end="")
        sys.exit(0)
    cmd = args[0]
    if cmd not in ("search", "fetch"):
        print(_USAGE, end="", file=sys.stderr)
        sys.exit(1)

    try:
        if cmd == "search":
            query, count, need_content = _parse_search_args(args[1:])
            result = search(query, count, need_content)
        else:
            rest = args[1:]
            if any(arg in ("-h", "--help") for arg in rest):
                print(_FETCH_HELP, end="")
                sys.exit(0)
            if len(rest) != 1:
                print(_FETCH_HELP, end="", file=sys.stderr)
                sys.exit(1)
            result = fetch(rest[0])
    except RuntimeError as exc:
        # 错误只含安全类别/HTTP 状态/受控 request id，不含凭据、query、URL 或响应内容。
        print(f"deepseek error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
