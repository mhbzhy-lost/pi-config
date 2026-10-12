"""Exa REST 传输层的离线契约测试。

覆盖：请求形状（method/path/body/header）、认证头位置（仅 x-api-key，不进
URL/body）、代理端口与超时、成功 JSON 原样透传、非法 JSON/事件流形态错误体、
读超时/连接超时、响应超限、401/402/429 等状态码类别、request id 安全回显、
跨域重定向阻断。全部通过注入 mock response 或被阻断的 socket transport
完成，不访问真实网络与真实凭据。
"""

import email.message
import io
import json
import sys
import unittest
import urllib.error
import urllib.request
from unittest.mock import MagicMock, patch

from test_exa import _api_key, _blocked_transport, _load_exa, _proxy_env


def _mock_response(body: bytes, status: int = 200) -> MagicMock:
    """可进入 with 语句的 mock response，read 返回给定字节。"""
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = body
    resp.__enter__.return_value = resp
    return resp


def _capturing_open(response=None):
    """替换 _open，捕获发出的 urllib Request 与调用参数；返回 (captured, mock)。"""
    captured = {}

    def fake_open(req, timeout, proxy_dict):
        captured["req"] = req
        captured["timeout"] = timeout
        captured["proxy_dict"] = proxy_dict
        if response is not None:
            return response
        return _mock_response(b"{}")

    return captured, MagicMock(side_effect=fake_open)


class ExaRequestShapeTests(unittest.TestCase):
    """官方 REST 端点、方法、请求体与请求头形状。"""

    def test_search_posts_to_fixed_official_endpoint(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        with _api_key("shape-test-key"), patch.object(mod, "_open", mock_open):
            mod.search("shape query", 5)

        req = captured["req"]
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.full_url, "https://api.exa.ai/search")
        self.assertNotIn("?", req.full_url)
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(
            body,
            {
                "query": "shape query",
                "numResults": 5,
                "type": "auto",
                "contents": {"highlights": True},
            },
        )

    def test_search_query_with_category_prefix_passes_through_verbatim(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        query = "category:people John Doe software engineer"
        with _api_key("category-prefix-key"), patch.object(mod, "_open", mock_open):
            mod.search(query)

        body = json.loads(captured["req"].data.decode("utf-8"))
        self.assertEqual(body["query"], query)

    def test_search_default_num_results_is_10(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        with _api_key("default-num-key"), patch.object(mod, "_open", mock_open):
            mod.search("default query")

        body = json.loads(captured["req"].data.decode("utf-8"))
        self.assertEqual(body["numResults"], 10)

    def test_api_key_only_via_x_api_key_header_not_url_or_body(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        key = "header-only-test-key"
        with _api_key(key), patch.object(mod, "_open", mock_open):
            mod.search("header-policy query", 3)

        req = captured["req"]
        # 只断言认证头存在且非空；不在任何输出中打印 key 值。
        self.assertTrue(
            any(name.lower() == "x-api-key" for name in req.headers),
            msg="x-api-key header must be present",
        )
        self.assertTrue(
            all(str(value) for name, value in req.headers.items() if name.lower() == "x-api-key"),
            msg="x-api-key header must be non-empty",
        )
        lowered = {name.lower() for name in req.headers}
        self.assertNotIn("authorization", lowered)
        self.assertNotIn("?", req.full_url)
        self.assertNotIn(key, req.full_url)
        self.assertNotIn(key, req.data.decode("utf-8"))

    def test_content_type_and_accept_are_json_only(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        with _api_key("accept-json-key"), patch.object(mod, "_open", mock_open):
            mod.search("accept query")

        req = captured["req"]
        self.assertEqual(req.headers.get("Content-type"), "application/json")
        self.assertEqual(req.headers.get("Accept"), "application/json")
        self.assertTrue(req.headers.get("User-agent"))
        self.assertNotIn("Python", req.headers.get("User-agent", ""))

    def test_fetch_posts_contents_with_urls_and_default_max_characters(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        with _api_key("fetch-shape-key"), patch.object(mod, "_open", mock_open):
            mod.fetch(["https://docs.example.com/a", "https://docs.example.com/b"])

        req = captured["req"]
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.full_url, "https://api.exa.ai/contents")
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["urls"], ["https://docs.example.com/a", "https://docs.example.com/b"])
        self.assertEqual(body["text"], {"maxCharacters": 3000})
        self.assertNotIn("ids", body)

    def test_fetch_supports_ids_and_custom_max_characters(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        with _api_key("fetch-ids-key"), patch.object(mod, "_open", mock_open):
            mod.fetch(ids=["doc-1", "doc-2"], max_characters=1500)

        body = json.loads(captured["req"].data.decode("utf-8"))
        self.assertEqual(body["ids"], ["doc-1", "doc-2"])
        self.assertEqual(body["text"], {"maxCharacters": 1500})
        self.assertNotIn("urls", body)

    def test_fetch_argument_validation_fails_before_request(self):
        mod = _load_exa()
        cases = (
            (("both",), {"urls": ["https://a.example"], "ids": ["d1"]}, "either urls or ids"),
            (("neither",), {}, "either urls or ids"),
            (("empty-urls",), {"urls": []}, "urls"),
            (("empty-ids",), {"ids": []}, "ids"),
            (("non-str-entry",), {"urls": ["ok", 123]}, "urls"),
            (("blank-entry",), {"urls": ["ok", "   "]}, "urls"),
            (("zero-max",), {"urls": ["https://a.example"], "max_characters": 0}, "max_characters"),
            (("bool-max",), {"urls": ["https://a.example"], "max_characters": True}, "max_characters"),
        )
        for name, kwargs, expected in cases:
            with self.subTest(case=name):
                with _api_key("validation-key"), patch.object(mod, "_open") as proxied_open:
                    with self.assertRaisesRegex(RuntimeError, expected):
                        mod.fetch(**kwargs)
                proxied_open.assert_not_called()

    def test_search_argument_validation_fails_before_request(self):
        mod = _load_exa()
        cases = (
            ("empty-query", ("",), {}),
            ("blank-query", ("   ",), {}),
            ("non-str-query", (123,), {}),
            ("zero-num", ("q",), {"num_results": 0}),
            ("negative-num", ("q",), {"num_results": -1}),
            ("bool-num", ("q",), {"num_results": True}),
            ("str-num", ("q",), {"num_results": "5"}),
            ("float-num", ("q",), {"num_results": 1.5}),
        )
        for name, args, kwargs in cases:
            with self.subTest(case=name):
                with _api_key("validation-key"), patch.object(mod, "_open") as proxied_open:
                    with self.assertRaises(RuntimeError):
                        mod.search(*args, **kwargs)
                proxied_open.assert_not_called()

    def test_rest_post_path_whitelist_blocks_host_rewrites(self):
        mod = _load_exa()
        cases = (
            "https://evil.example/search",
            "//evil.example/search",
            "/search/extra",
            "/v2/search",
        )
        for path in cases:
            with self.subTest(path=path):
                with _api_key("whitelist-key"), patch.object(mod, "_open") as proxied_open:
                    with self.assertRaisesRegex(RuntimeError, "Unsupported Exa endpoint"):
                        mod.rest_post(path, {})
                proxied_open.assert_not_called()

    def test_proxy_mapping_and_timeout_are_bounded(self):
        mod = _load_exa()
        captured, mock_open = _capturing_open()
        with _api_key("bounded-key"), _proxy_env(), patch.object(mod, "_open", mock_open):
            mod.search("bounded query")

        self.assertEqual(
            captured["proxy_dict"],
            {
                "http": "http://127.0.0.1:7897",
                "https": "http://127.0.0.1:7897",
            },
        )
        self.assertEqual(captured["timeout"], mod.DEFAULT_TIMEOUT_SECONDS)
        self.assertGreater(captured["timeout"], 0)
        self.assertLessEqual(captured["timeout"], 60)


class ExaResponseTests(unittest.TestCase):
    """成功透传与错误脱敏：非法 JSON、事件流形态错误体、超时、超限。"""

    def test_success_json_is_returned_structured_and_untouched(self):
        mod = _load_exa()
        payload = {
            "requestId": "req-1",
            "results": [
                {"title": "t", "url": "https://r.example/a", "highlights": ["h1"]}
            ],
            "statuses": [{"id": "https://r.example/a", "status": "success"}],
        }
        response = _mock_response(json.dumps(payload).encode("utf-8"))
        with _api_key("success-key"), patch.object(mod, "_open", return_value=response):
            result = mod.fetch(["https://r.example/a"])

        self.assertEqual(result, payload)
        self.assertIn("statuses", result)
        self.assertIn("results", result)

    def test_oversized_response_is_rejected(self):
        mod = _load_exa()
        response = MagicMock()
        response.read.return_value = b"x" * (mod.MAX_RESPONSE_BYTES + 1)
        response.__enter__.return_value = response
        with _api_key("oversize-key"), patch.object(mod, "_open", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "response exceeds"):
                mod.search("oversize query")
        response.read.assert_called_once_with(mod.MAX_RESPONSE_BYTES + 1)

    def test_invalid_json_body_is_sanitized(self):
        mod = _load_exa()
        response = _mock_response(b"<html>gateway exploded</html>")
        with _api_key("bad-json-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("bad-json query")
        self.assertIn("not valid JSON", str(raised.exception))
        self.assertNotIn("gateway exploded", str(raised.exception))

    def test_event_stream_shaped_error_body_is_not_parsed_or_echoed(self):
        """被误投递的事件流形态错误体必须按脱敏错误处理，不做任何流解析与回显。"""
        mod = _load_exa()
        body = b'event: error\ndata: {"error": "quota blown"}\n\n'
        response = _mock_response(body)
        with _api_key("stream-error-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("stream-error query")
        message = str(raised.exception)
        self.assertIn("not valid JSON", message)
        self.assertNotIn("quota blown", message)
        self.assertNotIn("event:", message)
        self.assertNotIn("data:", message)

    def test_non_object_json_is_rejected(self):
        mod = _load_exa()
        response = _mock_response(b'["not", "an", "object"]')
        with _api_key("non-object-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaisesRegex(RuntimeError, "not an object"):
                mod.search("non-object query")

    def test_non_utf8_response_is_rejected_without_echo(self):
        mod = _load_exa()
        response = _mock_response(b"\xff\xfe\xfd")
        with _api_key("non-utf8-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaisesRegex(RuntimeError, "not valid UTF-8"):
                mod.search("non-utf8 query")

    def test_read_timeout_maps_to_timeout_category(self):
        mod = _load_exa()
        response = MagicMock()
        response.read.side_effect = TimeoutError("read timed out")
        response.__enter__.return_value = response
        with _api_key("read-timeout-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                mod.search("read-timeout query")

    def test_connect_timeout_maps_to_timeout_category(self):
        mod = _load_exa()
        with _api_key("connect-timeout-key"), patch.object(
            mod, "_open", side_effect=urllib.error.URLError(TimeoutError("connect timed out"))
        ):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                mod.search("connect-timeout query")

    def test_generic_url_error_reason_is_never_echoed(self):
        mod = _load_exa()
        key = "urlopener-secret-key"
        reason = f"refused https://user:pass@internal.invalid/path {key}"
        with _api_key(key), patch.object(
            mod, "_open", side_effect=urllib.error.URLError(reason)
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("urlerror query")
        message = str(raised.exception)
        self.assertIn("network error", message)
        self.assertNotIn(key, message)
        self.assertNotIn("refused", message)
        self.assertNotIn("user:pass", message)

    def test_unexpected_exception_hides_message_and_shows_type_only(self):
        mod = _load_exa()
        key = "unexpected-secret-key"
        with _api_key(key), patch.object(
            mod, "_open", side_effect=ValueError(f"boom {key}")
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("unexpected query")
        message = str(raised.exception)
        self.assertIn("ValueError", message)
        self.assertNotIn("boom", message)
        self.assertNotIn(key, message)

    def test_unserializable_payload_fails_before_request(self):
        mod = _load_exa()
        with _api_key("serialization-key"), patch.object(mod, "_open") as proxied_open:
            with self.assertRaisesRegex(RuntimeError, "not JSON serializable"):
                mod.rest_post(mod.SEARCH_PATH, {"x": object()})
        proxied_open.assert_not_called()


class ExaHttpStatusTests(unittest.TestCase):
    """HTTP 状态码 → 脱敏类别；不回显响应体或 key；request id 受控回显。"""

    def test_status_codes_map_to_safe_categories(self):
        mod = _load_exa()
        key = "status-secret-key"
        cases = (
            (401, "authentication_error"),
            (402, "payment_required"),
            (403, "authentication_error"),
            (429, "rate_limited"),
            (400, "client_error"),
            (500, "server_error"),
        )
        for code, category in cases:
            with self.subTest(code=code):
                upstream = urllib.error.HTTPError(
                    "https://api.exa.ai/search",
                    code,
                    "upstream message",
                    {},
                    io.BytesIO(f"upstream body echoed {key}".encode()),
                )
                with _api_key(key), patch.object(mod, "_open", side_effect=upstream):
                    with self.assertRaises(RuntimeError) as raised:
                        mod.search("status query")
                message = str(raised.exception)
                self.assertIn(f"HTTP {code}", message)
                self.assertIn(category, message)
                self.assertNotIn(key, message)
                self.assertNotIn("upstream body", message)

    def test_safe_request_id_is_included(self):
        mod = _load_exa()
        upstream = urllib.error.HTTPError(
            "https://api.exa.ai/search",
            429,
            "Too Many Requests",
            {"x-exa-request-id": "req-123-abc"},
            io.BytesIO(b""),
        )
        with _api_key("request-id-key"), patch.object(mod, "_open", side_effect=upstream):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("request-id query")
        self.assertIn("request_id=req-123-abc", str(raised.exception))

    def test_unsafe_request_id_is_dropped(self):
        mod = _load_exa()
        upstream = urllib.error.HTTPError(
            "https://api.exa.ai/search",
            429,
            "Too Many Requests",
            {"x-request-id": "bad id\nwith spaces"},
            io.BytesIO(b""),
        )
        with _api_key("unsafe-id-key"), patch.object(mod, "_open", side_effect=upstream):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("unsafe-id query")
        self.assertNotIn("request_id", str(raised.exception))

    def test_request_id_header_match_is_case_insensitive(self):
        mod = _load_exa()
        headers = email.message.Message()
        headers["X-Exa-Request-Id"] = "CaseId-9"
        upstream = urllib.error.HTTPError(
            "https://api.exa.ai/search", 500, "Internal Error", headers, io.BytesIO(b"")
        )
        with _api_key("case-id-key"), patch.object(mod, "_open", side_effect=upstream):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("case-id query")
        self.assertIn("request_id=CaseId-9", str(raised.exception))

    def test_missing_request_id_is_omitted(self):
        mod = _load_exa()
        upstream = urllib.error.HTTPError(
            "https://api.exa.ai/search", 401, "Unauthorized", {}, io.BytesIO(b"")
        )
        with _api_key("no-id-key"), patch.object(mod, "_open", side_effect=upstream):
            with self.assertRaises(RuntimeError) as raised:
                mod.search("no-id query")
        self.assertNotIn("request_id", str(raised.exception))


class ExaRedirectTests(unittest.TestCase):
    """跨域重定向阻断；同源重定向保留认证头；opener 接线正确。"""

    def _post_request(self) -> urllib.request.Request:
        return urllib.request.Request(
            "https://api.exa.ai/search",
            data=b"{}",
            headers={"x-api-key": "redirect-test-key"},
            method="POST",
        )

    def test_cross_origin_redirect_is_blocked_without_url_echo(self):
        mod = _load_exa()
        handler = mod._SameOriginRedirectHandler()
        for target in ("https://evil.example/capture", "http://api.exa.ai/search"):
            with self.subTest(target=target):
                with self.assertRaises(RuntimeError) as raised:
                    handler.redirect_request(
                        self._post_request(),
                        io.BytesIO(b""),
                        302,
                        "Found",
                        {},
                        target,
                    )
                message = str(raised.exception)
                self.assertIn("different host", message)
                self.assertNotIn("evil.example", message)

    def test_same_origin_redirect_keeps_request_and_auth_header(self):
        mod = _load_exa()
        handler = mod._SameOriginRedirectHandler()
        newreq = handler.redirect_request(
            self._post_request(),
            io.BytesIO(b""),
            302,
            "Found",
            {},
            "https://api.exa.ai/search?page=2",
        )
        self.assertIsInstance(newreq, urllib.request.Request)
        self.assertTrue(
            any(name.lower() == "x-api-key" for name in newreq.headers),
            msg="same-origin redirect must keep the auth header",
        )

    def test_opener_wires_same_origin_redirect_handler(self):
        mod = _load_exa()
        real_build_opener = urllib.request.build_opener
        seen = []

        def spy(*handlers, **kwargs):
            seen.extend(handlers)
            return real_build_opener(*handlers, **kwargs)

        with _api_key("opener-wiring-key"), _proxy_env(), _blocked_transport():
            with patch.object(urllib.request, "build_opener", side_effect=spy):
                with self.assertRaisesRegex(RuntimeError, "network error"):
                    mod.search("opener-wiring query")

        wired = [h for h in seen if isinstance(h, mod._SameOriginRedirectHandler)]
        self.assertEqual(len(wired), 1)


class ExaCliOutputTests(unittest.TestCase):
    """CLI 成功路径：stdout 只含结构化结果 JSON，不包含 key 或请求头。"""

    def test_cli_search_prints_structured_result_without_leaking_key(self):
        mod = _load_exa()
        payload = {"requestId": "req-9", "results": [{"title": "ok"}]}
        response = _mock_response(json.dumps(payload).encode("utf-8"))
        stdout = io.StringIO()
        stderr = io.StringIO()
        with _api_key("cli-stdout-secret-key"), _proxy_env(), patch.object(
            mod, "_open", return_value=response
        ), patch.object(
            sys, "argv", ["exa.py", "search", "cli success query", "3"]
        ), patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
            mod.main()

        output = stdout.getvalue()
        self.assertEqual(json.loads(output), payload)
        self.assertNotIn("cli-stdout-secret-key", output)
        self.assertNotIn("x-api-key", output)
        self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
