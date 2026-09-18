"""Tests for authenticated Exa MCP requests."""

import importlib.util
import io
import os
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Optional
from unittest.mock import MagicMock, call, patch


def _load_exa():
    spec = importlib.util.spec_from_file_location(
        "exa", os.path.join(os.path.dirname(__file__), "exa.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    descriptor, isolated_dotenv = tempfile.mkstemp()
    os.close(descriptor)
    os.unlink(isolated_dotenv)
    mod.LOCAL_DOTENV_PATH = isolated_dotenv
    return mod


@contextmanager
def _api_key(value: Optional[str]):
    with patch.dict(os.environ, {}, clear=False):
        if value is None:
            os.environ.pop("EXA_API_KEY", None)
        else:
            os.environ["EXA_API_KEY"] = value
        yield


_PROXY_ENV_KEYS = (
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "ftp_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "FTP_PROXY",
    "no_proxy",
    "NO_PROXY",
    "EXA_PROXY_PORT",
)


@contextmanager
def _proxy_env(https_proxy: Optional[str] = None):
    """Pin ambient proxy env so macOS system-proxy fallback cannot flake tests.

    A non-matching no_proxy keeps ``proxy_bypass`` on the deterministic
    environment path instead of reading macOS system proxy settings.
    """
    with patch.dict(os.environ, {}, clear=False):
        for key in _PROXY_ENV_KEYS:
            os.environ.pop(key, None)
        if https_proxy is not None:
            os.environ["https_proxy"] = https_proxy
        os.environ["no_proxy"] = "bypass-control.invalid"
        yield


@contextmanager
def _blocked_transport():
    """Record outbound connect targets as (host, port); allow no real network I/O."""
    targets = []

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (str(host), int(port)))]

    def fake_connect(self, address):
        targets.append((address[0], address[1]))
        raise OSError("blocked by test harness")

    with patch.object(socket, "getaddrinfo", fake_getaddrinfo), patch.object(
        socket.socket, "connect", fake_connect
    ):
        yield targets


class ExaAuthenticationTests(unittest.TestCase):
    def test_dotenv_key_is_used_when_process_env_is_missing(self):
        mod = _load_exa()
        with tempfile.TemporaryDirectory() as directory:
            dotenv = os.path.join(directory, ".env")
            with open(dotenv, "w", encoding="utf-8") as stream:
                stream.write("# local only\nexport EXA_API_KEY=dotenv-test-key\n")
            with _api_key(None), patch.object(mod, "LOCAL_DOTENV_PATH", dotenv):
                self.assertEqual(mod._required_api_key(), "dotenv-test-key")
                self.assertNotIn("EXA_API_KEY", os.environ)

    def test_dotenv_supports_single_and_double_quotes(self):
        mod = _load_exa()
        fixtures = (
            ('EXA_API_KEY="double-test-key"', "double-test-key"),
            ("export EXA_API_KEY='single-test-key'", "single-test-key"),
        )
        for line, expected in fixtures:
            with self.subTest(line=line), tempfile.TemporaryDirectory() as directory:
                dotenv = os.path.join(directory, ".env")
                with open(dotenv, "w", encoding="utf-8") as stream:
                    stream.write(line + "\n")
                with _api_key(None), patch.object(mod, "LOCAL_DOTENV_PATH", dotenv):
                    self.assertEqual(mod._required_api_key(), expected)

    def test_process_env_overrides_dotenv(self):
        mod = _load_exa()
        with tempfile.TemporaryDirectory() as directory:
            dotenv = os.path.join(directory, ".env")
            with open(dotenv, "w", encoding="utf-8") as stream:
                stream.write('EXA_API_KEY="dotenv-test-key"\n')
            with _api_key("process-test-key"), patch.object(mod, "LOCAL_DOTENV_PATH", dotenv):
                self.assertEqual(mod._required_api_key(), "process-test-key")

    def test_empty_process_env_and_dotenv_keep_existing_error(self):
        mod = _load_exa()
        with tempfile.TemporaryDirectory() as directory:
            dotenv = os.path.join(directory, ".env")
            with open(dotenv, "w", encoding="utf-8") as stream:
                stream.write("EXA_API_KEY=   \n")
            with _api_key("   "), patch.object(mod, "LOCAL_DOTENV_PATH", dotenv):
                with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                    mod._required_api_key()

    def test_malformed_dotenv_target_is_rejected_without_leaking_value(self):
        mod = _load_exa()
        secret = "malformed-test-secret"
        with tempfile.TemporaryDirectory() as directory:
            dotenv = os.path.join(directory, ".env")
            with open(dotenv, "w", encoding="utf-8") as stream:
                stream.write(f"EXA_API_KEY=\"{secret}\nOTHER={secret}\n")
            with _api_key(None), patch.object(mod, "LOCAL_DOTENV_PATH", dotenv):
                with self.assertRaises(RuntimeError) as raised:
                    mod._required_api_key()
        self.assertIn("EXA_API_KEY", str(raised.exception))
        self.assertNotIn(secret, str(raised.exception))

    def test_dotenv_ignores_comments_and_unrelated_lines(self):
        mod = _load_exa()
        with tempfile.TemporaryDirectory() as directory:
            dotenv = os.path.join(directory, ".env")
            with open(dotenv, "w", encoding="utf-8") as stream:
                stream.write("# EXA_API_KEY=wrong-test-key\nUNRELATED=value\n")
            with _api_key(None), patch.object(mod, "LOCAL_DOTENV_PATH", dotenv):
                with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                    mod._required_api_key()

    def test_missing_api_key_ignores_dotenv_next_to_script(self):
        """Normal tests use their isolated dotenv path, never a script sibling."""
        mod = _load_exa()
        script_dotenv = os.path.join(os.path.dirname(mod.__file__), ".env")
        created_fixture = not os.path.exists(script_dotenv)
        if created_fixture:
            with open(script_dotenv, "w", encoding="utf-8") as stream:
                stream.write("EXA_API_KEY=script-sibling-test-key\n")
        try:
            with _api_key(None), patch.object(mod, "_open") as proxied_open:
                with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                    mod.mcp_call("tools/list", {})
            proxied_open.assert_not_called()
        finally:
            if created_fixture:
                os.unlink(script_dotenv)

    def test_whitespace_api_key_fails_before_network_request(self):
        mod = _load_exa()

        with _api_key("   \t"), patch.object(mod, "_open") as proxied_open:
            with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                mod.mcp_call("tools/list", {})
        proxied_open.assert_not_called()

    def test_invalid_api_key_content_fails_before_network_request(self):
        mod = _load_exa()

        for key in ("valid-prefix\nembedded", "valid-prefix\x1fembedded", "x" * 257):
            with self.subTest(key_length=len(key)), _api_key(key), patch.object(
                mod, "_open"
            ) as proxied_open:
                with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                    mod.mcp_call("tools/list", {})
                proxied_open.assert_not_called()

    def test_api_key_is_read_when_request_is_created(self):
        mod = _load_exa()

        with _api_key("test-key-123"):
            self.assertTrue(
                mod._mcp_url(mod._required_api_key()).endswith(
                    "?exaApiKey=test-key-123"
                )
            )
        with _api_key("rotated-key-456"):
            self.assertTrue(
                mod._mcp_url(mod._required_api_key()).endswith(
                    "?exaApiKey=rotated-key-456"
                )
            )

    def test_api_key_special_characters_are_url_encoded(self):
        mod = _load_exa()

        with _api_key("key+with&special=chars"):
            url = mod._mcp_url(mod._required_api_key())

        self.assertTrue(url.endswith("?exaApiKey=key%2Bwith%26special%3Dchars"), url)

    def test_short_key_does_not_destroy_diagnostic_text(self):
        mod = _load_exa()

        self.assertEqual(mod._safe_diagnostic("server error", "e"), "server error")

    def test_unrepresentable_diagnostic_uses_safe_fallback(self):
        mod = _load_exa()

        class BrokenDiagnostic:
            def __str__(self):
                raise ValueError("cannot stringify")

        self.assertEqual(
            mod._safe_diagnostic(BrokenDiagnostic(), "sensitive-test-key"),
            "<unrepresentable diagnostic>",
        )

    def test_truncation_does_not_split_redaction_marker(self):
        mod = _load_exa()
        key = "sensitive-test-key"
        diagnostic = ("x" * 493) + key + " suffix"

        result = mod._safe_diagnostic(diagnostic, key)

        self.assertLessEqual(len(result), 500)
        self.assertTrue(result.endswith("..."))
        partial_markers = tuple(
            "<redacted>"[:length] for length in range(2, len("<redacted>"))
        )
        self.assertFalse(result[:-3].endswith(partial_markers))

    def test_truncation_preserves_unrelated_trailing_angle_bracket(self):
        mod = _load_exa()

        result = mod._safe_diagnostic(("x" * 496) + "<more", "test-key")

        self.assertTrue(result.endswith("<..."))

    def test_http_error_does_not_expose_api_key(self):
        mod = _load_exa()
        key = "sensitive-test-key"
        upstream = urllib.error.HTTPError(
            f"https://mcp.exa.ai/mcp?exaApiKey={key}",
            403,
            "Forbidden",
            {},
            io.BytesIO(f"quota exhausted; echoed key={key}".encode()),
        )

        with _api_key(key), patch.object(
            mod, "_open", side_effect=upstream
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/list", {})

        self.assertNotIn(key, str(raised.exception))
        self.assertIn("HTTP 403", str(raised.exception))
        self.assertIn("quota exhausted", str(raised.exception))

    def test_http_error_body_uses_independent_socket_timeout(self):
        mod = _load_exa()
        key = "sensitive-test-key"

        class SocketBackedBody:
            def __init__(self):
                self.socket = MagicMock()
                self.socket.gettimeout.return_value = None
                self.fp = SimpleNamespace(raw=SimpleNamespace(_sock=self.socket))

            def close(self):
                pass

            def read(self, _size):
                return b"quota exhausted"

        body = SocketBackedBody()
        upstream = urllib.error.HTTPError(
            "https://mcp.exa.ai/mcp", 403, "Forbidden", {}, body
        )

        with _api_key(key), patch.object(
            mod, "_open", side_effect=upstream
        ):
            with self.assertRaisesRegex(RuntimeError, "quota exhausted"):
                mod.mcp_call("tools/list", {})

        self.assertEqual(body.socket.settimeout.call_args_list, [call(5), call(None)])

    def test_http_error_without_bounded_stream_skips_body_read(self):
        mod = _load_exa()
        key = "sensitive-test-key"

        class UnboundedBody:
            def __init__(self):
                self.read_called = False

            def close(self):
                pass

            def read(self, _size):
                self.read_called = True
                raise AssertionError("unbounded body must not be read")

        body = UnboundedBody()
        upstream = urllib.error.HTTPError(
            "https://mcp.exa.ai/mcp", 403, "Forbidden", {}, body
        )

        with _api_key(key), patch.object(
            mod, "_open", side_effect=upstream
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 403") as raised:
                mod.mcp_call("tools/list", {})

        self.assertNotIn("unbounded body", str(raised.exception))
        self.assertFalse(body.read_called)

    def test_encoded_api_key_is_redacted_from_http_body(self):
        mod = _load_exa()
        key = "key+with&special=chars"
        encoded_key = "key%2Bwith%26special%3Dchars"
        upstream = urllib.error.HTTPError(
            "https://mcp.exa.ai/mcp",
            403,
            "Forbidden",
            {},
            io.BytesIO(f"echoed={encoded_key}".encode()),
        )

        with _api_key(key), patch.object(
            mod, "_open", side_effect=upstream
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/list", {})

        self.assertNotIn(key, str(raised.exception))
        self.assertNotIn(encoded_key, str(raised.exception))
        self.assertIn("<redacted>", str(raised.exception))

    def test_key_rotation_during_request_cannot_bypass_redaction(self):
        mod = _load_exa()
        original_key = "original-sensitive-key"

        def rotate_then_fail(_request, timeout, proxy_dict):
            os.environ["EXA_API_KEY"] = "rotated-sensitive-key"
            raise urllib.error.HTTPError(
                "https://mcp.exa.ai/mcp",
                403,
                "Forbidden",
                {},
                io.BytesIO(f"echoed={original_key}".encode()),
            )

        with _api_key(original_key), patch.object(
            mod, "_open", side_effect=rotate_then_fail
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/list", {})

        self.assertNotIn(original_key, str(raised.exception))
        self.assertIn("<redacted>", str(raised.exception))

    def test_url_error_keeps_safe_reason_without_api_key(self):
        mod = _load_exa()
        key = "sensitive-test-key"
        upstream = urllib.error.URLError(
            f"timed out contacting https://mcp.exa.ai/mcp?exaApiKey={key}"
        )

        with _api_key(key), patch.object(
            mod, "_open", side_effect=upstream
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/list", {})

        self.assertIn("timed out", str(raised.exception))
        self.assertNotIn(key, str(raised.exception))

    def test_request_construction_error_is_redacted(self):
        mod = _load_exa()
        key = "sensitive-test-key"

        with _api_key(key), patch.object(
            mod.urllib.request,
            "Request",
            side_effect=ValueError(f"invalid URL containing {key}"),
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/list", {})

        self.assertNotIn(key, str(raised.exception))
        self.assertIn("invalid URL", str(raised.exception))

    def test_non_serializable_params_are_wrapped_without_api_key(self):
        mod = _load_exa()
        key = "sensitive-test-key"

        with _api_key(key):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/call", {"invalid": object()})

        self.assertIn("request/response handling failed", str(raised.exception))
        self.assertNotIn(key, str(raised.exception))

    def test_non_utf8_response_uses_replacement_diagnostic(self):
        mod = _load_exa()
        response = MagicMock()
        response.read.return_value = b"\xff\xfeinvalid"
        response.__enter__.return_value = response

        with _api_key("test-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaisesRegex(RuntimeError, "Unexpected response"):
                mod.mcp_call("tools/list", {})

    def test_response_read_timeout_keeps_diagnostic(self):
        mod = _load_exa()
        response = MagicMock()
        response.read.side_effect = TimeoutError("read timed out")
        response.__enter__.return_value = response

        with _api_key("test-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaisesRegex(RuntimeError, "read timed out"):
                mod.mcp_call("tools/list", {})

    def test_oversized_success_response_is_rejected(self):
        mod = _load_exa()
        response = MagicMock()
        response.read.return_value = b"x" * (mod.MAX_RESPONSE_BYTES + 1)
        response.__enter__.return_value = response

        with _api_key("test-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaisesRegex(RuntimeError, "response exceeds"):
                mod.mcp_call("tools/list", {})

        response.read.assert_called_once_with(mod.MAX_RESPONSE_BYTES + 1)

    def test_valid_sse_response_returns_json_rpc_payload(self):
        mod = _load_exa()
        response = MagicMock()
        response.read.return_value = (
            'event: message\ndata: {"jsonrpc":"2.0","result":{"items":[1]}}\n'
        ).encode()
        response.__enter__.return_value = response

        with _api_key("test-key"), patch.object(
            mod, "_open", return_value=response
        ):
            result = mod.mcp_call("tools/list", {})

        self.assertEqual(result, {"jsonrpc": "2.0", "result": {"items": [1]}})

    def test_malformed_sse_json_is_redacted(self):
        mod = _load_exa()
        key = "key+with&special=chars"
        encoded_key = "key%2Bwith%26special%3Dchars"
        response = MagicMock()
        response.read.return_value = f"data: not-json-{encoded_key}".encode()
        response.__enter__.return_value = response

        with _api_key(key), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/list", {})

        self.assertIn("invalid JSON", str(raised.exception))
        self.assertNotIn(key, str(raised.exception))
        self.assertNotIn(encoded_key, str(raised.exception))

    def test_unexpected_response_is_truncated(self):
        mod = _load_exa()
        response = MagicMock()
        response.read.return_value = ("x" * 2000).encode()
        response.__enter__.return_value = response

        with _api_key("test-key"), patch.object(
            mod, "_open", return_value=response
        ):
            with self.assertRaises(RuntimeError) as raised:
                mod.mcp_call("tools/list", {})

        self.assertLessEqual(
            len(str(raised.exception)), 500 + len("Unexpected response: ")
        )

    def test_headers_include_user_agent(self):
        """HEADERS must include a non-Python User-Agent to avoid 403 from Exa CDN."""
        mod = _load_exa()
        ua = mod.HEADERS.get("User-Agent", "")
        self.assertTrue(ua)
        self.assertNotIn("Python", ua)
        with self.assertRaises(TypeError):
            mod.HEADERS["Authorization"] = "forbidden"


class ExaProxyTests(unittest.TestCase):
    """Exa 请求必须经由仅作用于自身的本机代理，且不污染全局 urllib 状态。"""

    def test_default_mcp_call_connects_to_local_proxy_7897(self):
        mod = _load_exa()
        with _api_key("proxy-routing-test-key"), _proxy_env(), _blocked_transport() as targets:
            with self.assertRaisesRegex(RuntimeError, "blocked by test harness"):
                mod.mcp_call("tools/list", {})
        self.assertEqual(targets, [("127.0.0.1", 7897)])

    def test_ambient_proxy_env_cannot_redirect_exa_requests(self):
        """环境变量代理是全局的、隐式的；Exa 请求必须改走自己的固定代理。"""
        mod = _load_exa()
        decoy = "http://10.255.255.10:3128"
        with _api_key("ambient-decoy-test-key"), _proxy_env(
            https_proxy=decoy
        ), _blocked_transport() as targets:
            with self.assertRaisesRegex(RuntimeError, "blocked by test harness"):
                mod.mcp_call("tools/list", {})
        self.assertEqual(targets, [("127.0.0.1", 7897)])

    def test_mcp_call_proxy_port_overrides_proxy_target(self):
        mod = _load_exa()
        for port in (1, 7898, 65535):
            with self.subTest(port=port):
                with _api_key("port-override-test-key"), _proxy_env(), _blocked_transport() as targets:
                    with self.assertRaisesRegex(RuntimeError, "blocked by test harness"):
                        mod.mcp_call("tools/list", {}, proxy_port=port)
                self.assertEqual(targets, [("127.0.0.1", port)])

    def test_search_and_fetch_forward_proxy_port(self):
        mod = _load_exa()
        cases = (
            (mod.search, ("proxy-passthrough-query", 5), 7898),
            (mod.fetch, (["https://passthrough.example/doc"],), 7900),
        )
        for func, args, port in cases:
            with self.subTest(func=func.__name__):
                with _api_key("passthrough-test-key"), _proxy_env(), _blocked_transport() as targets:
                    with self.assertRaisesRegex(RuntimeError, "blocked by test harness"):
                        func(*args, proxy_port=port)
                self.assertEqual(targets, [("127.0.0.1", port)])

    def test_cli_exa_proxy_port_env_overrides_default(self):
        mod = _load_exa()
        with _api_key("cli-override-test-key"), _proxy_env(), patch.dict(
            os.environ, {"EXA_PROXY_PORT": "7898"}
        ), patch.object(sys, "argv", ["exa.py", "search", "cli-override-query"]), _blocked_transport() as targets:
            with self.assertRaisesRegex(RuntimeError, "blocked by test harness"):
                mod.main()
        self.assertEqual(targets, [("127.0.0.1", 7898)])

    def test_cli_rejects_invalid_exa_proxy_port_before_any_request(self):
        mod = _load_exa()
        invalid = ("0", "-1", "abc", "70000", "65536", "1.5", "", " 7897", "+7897", "0x1f90")
        for raw in invalid:
            with self.subTest(raw=raw):
                with _api_key("cli-invalid-port-key"), _proxy_env(), patch.dict(
                    os.environ, {"EXA_PROXY_PORT": raw}
                ), patch.object(
                    sys, "argv", ["exa.py", "search", "invalid-port-query"]
                ), _blocked_transport() as targets:
                    with self.assertRaisesRegex(RuntimeError, "EXA_PROXY_PORT"):
                        mod.main()
                self.assertEqual(targets, [])

    def test_mcp_call_rejects_invalid_proxy_port_before_any_request(self):
        mod = _load_exa()
        invalid = (0, -1, 70000, 65536, "7898", 1.5, True)
        for port in invalid:
            with self.subTest(port=port):
                with _api_key("param-invalid-port-key"), _proxy_env(), _blocked_transport() as targets:
                    with self.assertRaisesRegex(RuntimeError, "port"):
                        mod.mcp_call("tools/list", {}, proxy_port=port)
                self.assertEqual(targets, [])

    def test_global_default_opener_still_follows_ambient_env(self):
        """Exa 调用之后，普通 urlopen 仍必须遵循环境代理（作用域未泄漏）。"""
        mod = _load_exa()
        decoy = "http://10.255.255.10:3128"
        with _api_key("global-opener-test-key"), _proxy_env(
            https_proxy=decoy
        ), _blocked_transport() as targets:
            with self.assertRaisesRegex(RuntimeError, "blocked by test harness"):
                mod.mcp_call("tools/list", {})
            probe = urllib.request.Request("https://global-probe.example/check")
            with self.assertRaises(OSError):
                urllib.request.urlopen(probe, timeout=5)
        self.assertEqual(targets, [("127.0.0.1", 7897), ("10.255.255.10", 3128)])


if __name__ == "__main__":
    unittest.main()
