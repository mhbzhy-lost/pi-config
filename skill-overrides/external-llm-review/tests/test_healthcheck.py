import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


HEALTHCHECK_PATH = Path(__file__).resolve().parents[1] / "_healthcheck.py"


class FakeHTTPStatusError(Exception):
    def __init__(self, message, *, response):
        super().__init__(message)
        self.response = response


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


def load_healthcheck():
    """Load the script without consulting its local environment file."""
    dotenv = types.ModuleType("dotenv")
    dotenv.load_dotenv = lambda *_args, **_kwargs: None
    config = types.ModuleType("_config")
    config.get_provider = lambda _name: None
    httpx = types.ModuleType("httpx")
    httpx.HTTPStatusError = FakeHTTPStatusError
    httpx.AsyncClient = object
    spec = importlib.util.spec_from_file_location("healthcheck_under_test", HEALTHCHECK_PATH)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"dotenv": dotenv, "_config": config, "httpx": httpx}):
        spec.loader.exec_module(module)
    return module


class FakeAsyncClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class HealthcheckRedactionTest(unittest.TestCase):
    def setUp(self):
        self.healthcheck = load_healthcheck()

    def run_check(self):
        return asyncio.run(self.healthcheck.check("test-provider"))

    def test_success_reports_reachability_without_model_content(self):
        sensitive_content = "SUCCESS_SECRET_MARKER"

        class Provider:
            async def send_chat(self, _client, _messages, _spec):
                return sensitive_content

        with patch.object(self.healthcheck, "get_provider", return_value=Provider()), patch.object(
            self.healthcheck.httpx, "AsyncClient", return_value=FakeAsyncClient()
        ):
            name, ok, detail = self.run_check()

        self.assertEqual((name, ok, detail), ("test-provider", True, "reachable"))
        self.assertNotIn(sensitive_content, detail)

    def test_http_error_keeps_only_safe_whitelisted_error_fields(self):
        response_marker = "HTTP_MESSAGE_SECRET_MARKER"
        unsafe_marker = "UNSAFE_FIELD_SECRET_MARKER"
        response = FakeResponse(
            429,
            {
                "error": {
                    "code": "rate_limit",
                    "type": "request_error",
                    "param": "model",
                    "message": response_marker,
                    "credential": unsafe_marker,
                    "unsafe": "contains spaces",
                }
            },
        )
        error = FakeHTTPStatusError("EXCEPTION_SECRET_MARKER", response=response)

        class Provider:
            async def send_chat(self, _client, _messages, _spec):
                raise error

        with patch.object(self.healthcheck, "get_provider", return_value=Provider()), patch.object(
            self.healthcheck.httpx, "AsyncClient", return_value=FakeAsyncClient()
        ):
            _name, ok, detail = self.run_check()

        self.assertFalse(ok)
        self.assertEqual(detail, "HTTP 429: code=rate_limit type=request_error param=model")
        for marker in (response_marker, unsafe_marker, "EXCEPTION_SECRET_MARKER", "contains spaces"):
            self.assertNotIn(marker, detail)

    def test_http_error_omits_unsafe_whitelisted_values(self):
        response = FakeResponse(
            400,
            {
                "error": {
                    "code": "contains spaces",
                    "type": "x" * 65,
                    "param": "model/name",
                    "message": "HTTP_MESSAGE_SECRET_MARKER",
                }
            },
        )
        error = FakeHTTPStatusError("EXCEPTION_SECRET_MARKER", response=response)

        class Provider:
            async def send_chat(self, _client, _messages, _spec):
                raise error

        with patch.object(self.healthcheck, "get_provider", return_value=Provider()), patch.object(
            self.healthcheck.httpx, "AsyncClient", return_value=FakeAsyncClient()
        ):
            _name, ok, detail = self.run_check()

        self.assertFalse(ok)
        self.assertEqual(detail, "HTTP 400")
        for marker in ("contains spaces", "model/name", "HTTP_MESSAGE_SECRET_MARKER"):
            self.assertNotIn(marker, detail)

    def test_config_error_reports_stage_and_type_without_exception_text(self):
        exception_marker = "CONFIG_SECRET_MARKER"

        with patch.object(
            self.healthcheck,
            "get_provider",
            side_effect=ValueError(exception_marker),
        ):
            _name, ok, detail = self.run_check()

        self.assertFalse(ok)
        self.assertEqual(detail, "config load failed: ValueError")
        self.assertNotIn(exception_marker, detail)

    def test_request_error_reports_stage_and_type_without_exception_text(self):
        exception_marker = "REQUEST_SECRET_MARKER"

        class Provider:
            async def send_chat(self, _client, _messages, _spec):
                raise RuntimeError(exception_marker)

        with patch.object(self.healthcheck, "get_provider", return_value=Provider()), patch.object(
            self.healthcheck.httpx, "AsyncClient", return_value=FakeAsyncClient()
        ):
            _name, ok, detail = self.run_check()

        self.assertFalse(ok)
        self.assertEqual(detail, "request failed: RuntimeError")
        self.assertNotIn(exception_marker, detail)


if __name__ == "__main__":
    unittest.main()
