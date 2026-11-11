"""Exa REST wrapper 的离线单元测试：认证、key 校验、CLI 行为与代理路由。

全部测试使用隔离的临时 .env fixture、注入的 mock transport 或被阻断的
socket transport，绝不访问真实网络，也绝不读取 skill 目录内的真实 .env。
请求形状与传输层契约的专项覆盖见 test_rest.py。
"""

import importlib.util
import io
import os
import socket
import sys
import tempfile
import unittest
import urllib.request
from contextlib import contextmanager
from typing import Optional
from unittest.mock import patch


def _load_exa():
    """隔离加载 exa.py：LOCAL_DOTENV_PATH 指向不存在的临时路径，永不触碰真实 .env。"""
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
    """固定环境代理变量，避免 macOS 系统代理探测造成偶发失败。

    不匹配的 no_proxy 让 proxy_bypass 走确定性的环境路径。
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
    """记录出站连接目标 (host, port)，不允许任何真实网络 I/O。"""
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
    """key 的加载来源、优先级与合法性校验；全部使用临时 fixture。"""

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

    def test_missing_key_fails_before_any_request(self):
        mod = _load_exa()
        with _api_key(None), patch.object(mod, "_open") as proxied_open:
            with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                mod.search("missing-key-query")
        proxied_open.assert_not_called()

    def test_whitespace_api_key_fails_before_network_request(self):
        mod = _load_exa()
        with _api_key("   \t"), patch.object(mod, "_open") as proxied_open:
            with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                mod.search("whitespace-key-query")
        proxied_open.assert_not_called()

    def test_invalid_api_key_content_fails_before_network_request(self):
        """控制字符/超长 key 会被拒绝（同时防御借认证头注入额外请求头）。"""
        mod = _load_exa()
        for key in ("valid-prefix\nembedded", "valid-prefix\x1fembedded", "x" * 257):
            with self.subTest(key_length=len(key)), _api_key(key), patch.object(
                mod, "_open"
            ) as proxied_open:
                with self.assertRaisesRegex(RuntimeError, "EXA_API_KEY"):
                    mod.search("invalid-key-query")
            proxied_open.assert_not_called()


class ExaHeaderPolicyTests(unittest.TestCase):
    """公共请求头策略：不含认证信息、不可变、User-Agent 非默认 Python 值。"""

    def test_module_headers_carry_no_credentials(self):
        mod = _load_exa()
        lowered = {key.lower() for key in mod.HEADERS}
        self.assertNotIn("x-api-key", lowered)
        self.assertNotIn("authorization", lowered)

    def test_headers_include_non_python_user_agent_and_are_immutable(self):
        mod = _load_exa()
        user_agent = mod.HEADERS.get("User-Agent", "")
        self.assertTrue(user_agent)
        self.assertNotIn("Python", user_agent)
        with self.assertRaises(TypeError):
            mod.HEADERS["Authorization"] = "forbidden"


class ExaCliTests(unittest.TestCase):
    """CLI 入口：参数解析、错误退出码与 EXA_PROXY_PORT 覆盖。"""

    def test_cli_search_routes_through_exa_proxy_port_env(self):
        mod = _load_exa()
        stderr = io.StringIO()
        with _api_key("cli-override-test-key"), _proxy_env(), patch.dict(
            os.environ, {"EXA_PROXY_PORT": "7898"}
        ), patch.object(
            sys, "argv", ["exa.py", "search", "cli-override-query"]
        ), patch.object(
            sys, "stderr", stderr
        ), _blocked_transport() as targets:
            with self.assertRaises(SystemExit):
                mod.main()
        self.assertEqual(targets, [("127.0.0.1", 7898)])
        self.assertIn("network error", stderr.getvalue())

    def test_cli_rejects_invalid_exa_proxy_port_before_any_request(self):
        mod = _load_exa()
        invalid = ("0", "-1", "abc", "70000", "65536", "1.5", "", " 7897", "+7897", "0x1f90")
        for raw in invalid:
            with self.subTest(raw=raw):
                stderr = io.StringIO()
                with _api_key("cli-invalid-port-key"), _proxy_env(), patch.dict(
                    os.environ, {"EXA_PROXY_PORT": raw}
                ), patch.object(
                    sys, "argv", ["exa.py", "search", "invalid-port-query"]
                ), patch.object(
                    sys, "stderr", stderr
                ), _blocked_transport() as targets:
                    with self.assertRaises(SystemExit):
                        mod.main()
                self.assertIn("EXA_PROXY_PORT", stderr.getvalue())
                self.assertEqual(targets, [])

    def test_cli_search_rejects_non_integer_num_results(self):
        mod = _load_exa()
        stderr = io.StringIO()
        with _api_key("cli-num-results-key"), _proxy_env(), patch.object(
            sys, "argv", ["exa.py", "search", "bad-num-query", "not-a-number"]
        ), patch.object(sys, "stderr", stderr), patch.object(mod, "_open") as proxied_open:
            with self.assertRaises(SystemExit):
                mod.main()
        self.assertIn("num_results must be an integer", stderr.getvalue())
        proxied_open.assert_not_called()

    def test_cli_unknown_command_and_missing_args_exit_with_usage(self):
        mod = _load_exa()
        for argv, expected in (
            (["exa.py"], "Usage"),
            (["exa.py", "nope"], "Unknown command"),
            (["exa.py", "search"], "Usage"),
            (["exa.py", "fetch"], "Usage"),
        ):
            with self.subTest(argv=argv):
                stderr = io.StringIO()
                with _api_key("cli-usage-key"), _proxy_env(), patch.object(
                    sys, "argv", argv
                ), patch.object(sys, "stderr", stderr), patch.object(
                    mod, "_open"
                ) as proxied_open:
                    with self.assertRaises(SystemExit):
                        mod.main()
                self.assertIn(expected, stderr.getvalue())
                proxied_open.assert_not_called()


class ExaProxyTests(unittest.TestCase):
    """Exa 请求必须经由仅作用于自身的本机代理，且不污染全局 urllib 状态。"""

    def test_default_search_connects_to_local_proxy_7897(self):
        mod = _load_exa()
        with _api_key("proxy-routing-test-key"), _proxy_env(), _blocked_transport() as targets:
            with self.assertRaisesRegex(RuntimeError, "network error"):
                mod.search("proxy-default-query")
        self.assertEqual(targets, [("127.0.0.1", 7897)])

    def test_ambient_proxy_env_cannot_redirect_exa_requests(self):
        """环境变量代理是全局的、隐式的；Exa 请求必须改走自己的固定代理。"""
        mod = _load_exa()
        decoy = "http://10.255.255.10:3128"
        with _api_key("ambient-decoy-test-key"), _proxy_env(
            https_proxy=decoy
        ), _blocked_transport() as targets:
            with self.assertRaisesRegex(RuntimeError, "network error"):
                mod.search("ambient-decoy-query")
        self.assertEqual(targets, [("127.0.0.1", 7897)])

    def test_proxy_port_param_overrides_proxy_target(self):
        mod = _load_exa()
        cases = (
            (mod.search, ("proxy-passthrough-query", 5), 7898),
            (mod.fetch, (["https://passthrough.example/doc"],), 7900),
        )
        for func, args, port in cases:
            with self.subTest(func=func.__name__):
                with _api_key("passthrough-test-key"), _proxy_env(), _blocked_transport() as targets:
                    with self.assertRaisesRegex(RuntimeError, "network error"):
                        func(*args, proxy_port=port)
                self.assertEqual(targets, [("127.0.0.1", port)])

    def test_invalid_proxy_port_param_fails_before_any_request(self):
        mod = _load_exa()
        invalid = (0, -1, 70000, 65536, "7898", 1.5, True)
        for port in invalid:
            with self.subTest(port=port):
                with _api_key("param-invalid-port-key"), _proxy_env(), patch.object(
                    mod, "_open"
                ) as proxied_open:
                    with self.assertRaisesRegex(RuntimeError, "port"):
                        mod.search("invalid-port-query", proxy_port=port)
                proxied_open.assert_not_called()

    def test_global_default_opener_still_follows_ambient_env(self):
        """Exa 调用之后，普通 urlopen 仍必须遵循环境代理（作用域未泄漏）。"""
        mod = _load_exa()
        decoy = "http://10.255.255.10:3128"
        with _api_key("global-opener-test-key"), _proxy_env(
            https_proxy=decoy
        ), _blocked_transport() as targets:
            with self.assertRaisesRegex(RuntimeError, "network error"):
                mod.search("scope-leak-probe-query")
            probe = urllib.request.Request("https://global-probe.example/check")
            with self.assertRaises(OSError):
                urllib.request.urlopen(probe, timeout=5)
        self.assertEqual(targets, [("127.0.0.1", 7897), ("10.255.255.10", 3128)])


if __name__ == "__main__":
    unittest.main()
