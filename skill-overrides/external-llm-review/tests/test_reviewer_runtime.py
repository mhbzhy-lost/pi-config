import asyncio
import contextlib
import io
import sys
import unittest
from argparse import Namespace
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import yaml  # noqa: F401
except ModuleNotFoundError:
    sys.modules["yaml"] = MagicMock()

try:
    import dotenv  # noqa: F401
except ModuleNotFoundError:
    dotenv = MagicMock()
    dotenv.load_dotenv = MagicMock()
    sys.modules["dotenv"] = dotenv

try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    httpx = MagicMock()
    sys.modules["httpx"] = httpx

import reviewer


class DescribeApiExceptionRuntimeTest(unittest.TestCase):
    def test_rejects_injected_or_overlong_exception_type_names(self):
        unsafe_type_names = (
            "ProviderError\nSENSITIVE_TYPE_MARKER",
            "A" * 65,
            "Provider-Error",
        )

        for type_name in unsafe_type_names:
            with self.subTest(type_name=type_name):
                exc_type = type(type_name, (Exception,), {})
                detail = reviewer.describe_api_exception(exc_type("sensitive message"))

                self.assertEqual(detail, "UnknownError")
                self.assertNotIn("SENSITIVE_TYPE_MARKER", detail)
                self.assertNotIn(type_name, detail)


class RunReviewTimeoutRuntimeTest(unittest.TestCase):
    def _args(self, api_timeout_seconds: int) -> Namespace:
        return Namespace(
            base_sha="base",
            head_sha="head",
            provider="idealab-openai",
            worktree="/mock-worktree",
            spec=None,
            max_diff=80000,
            review_depth="standard",
            review_round=1,
            max_issues=25,
            max_output_tokens=100,
            api_timeout_seconds=api_timeout_seconds,
        )

    def _run_with_timeout(self, api_timeout_seconds: int):
        provider = MagicMock(model="mock-model", base_url="https://provider.test")
        provider.send_chat = AsyncMock(return_value="review output")
        client = MagicMock()
        timeout_values = []

        @asynccontextmanager
        async def timeout_context(value):
            timeout_values.append(value)
            yield

        client_context = MagicMock()
        client_context.__aenter__ = AsyncMock(return_value=client)
        client_context.__aexit__ = AsyncMock(return_value=None)

        with patch.object(reviewer, "get_provider", return_value=provider), \
             patch.object(reviewer.subprocess, "check_output", return_value="diff"), \
             patch.object(reviewer.asyncio, "timeout", side_effect=timeout_context), \
             patch.object(reviewer.httpx, "AsyncClient", return_value=client_context) as async_client:
            exit_code = asyncio.run(
                reviewer.run_review(
                    args=self._args(api_timeout_seconds),
                    skill_dir=Path(__file__).resolve().parents[1],
                )
            )

        return exit_code, provider, async_client, timeout_values

    def test_non_positive_timeout_uses_request_default_without_hard_timeout(self):
        for api_timeout_seconds in (0, -5):
            with self.subTest(api_timeout_seconds=api_timeout_seconds):
                exit_code, provider, async_client, timeout_values = self._run_with_timeout(
                    api_timeout_seconds
                )

                self.assertEqual(exit_code, 0)
                self.assertEqual(timeout_values, [None])
                async_client.assert_called_once_with(
                    timeout=reviewer.DEFAULT_REQUEST_TIMEOUT_SECONDS
                )
                self.assertEqual(
                    provider.send_chat.await_args.args[2]["timeout"],
                    reviewer.DEFAULT_REQUEST_TIMEOUT_SECONDS,
                )

    def test_positive_timeout_preserves_hard_and_request_timeout(self):
        exit_code, provider, async_client, timeout_values = self._run_with_timeout(42)

        self.assertEqual(exit_code, 0)
        self.assertEqual(timeout_values, [42])
        async_client.assert_called_once_with(timeout=42)
        self.assertEqual(provider.send_chat.await_args.args[2]["timeout"], 42)


class RunReviewStderrRedactionRuntimeTest(unittest.TestCase):
    def _args(self, **overrides) -> Namespace:
        values = {
            "base_sha": "base",
            "head_sha": "head",
            "provider": "idealab-openai",
            "worktree": "/mock-worktree",
            "spec": None,
            "max_diff": 80000,
            "review_depth": "standard",
            "review_round": 1,
            "max_issues": 25,
            "max_output_tokens": 100,
            "api_timeout_seconds": 42,
        }
        values.update(overrides)
        return Namespace(**values)

    def _run(self, args, **patches):
        stderr = io.StringIO()
        check_output = patches.pop("check_output", None)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict("os.environ", {}, clear=True))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            if patches:
                stack.enter_context(patch.multiple(reviewer, **patches))
            if check_output is not None:
                stack.enter_context(
                    patch.object(reviewer.subprocess, "check_output", check_output)
                )
            exit_code = asyncio.run(
                reviewer.run_review(
                    args=args,
                    skill_dir=Path(__file__).resolve().parents[1],
                )
            )
        return exit_code, stderr.getvalue()

    def test_legacy_api_format_does_not_echo_value(self):
        marker = "SENSITIVE_LEGACY_FORMAT_MARKER"
        stderr = io.StringIO()
        with patch.dict(
            "os.environ", {"EXTERNAL_LLM_API_FORMAT": marker}, clear=True
        ), contextlib.redirect_stderr(stderr):
            exit_code = asyncio.run(
                reviewer.run_review(
                    args=self._args(),
                    skill_dir=Path(__file__).resolve().parents[1],
                )
            )

        self.assertEqual(exit_code, 1)
        self.assertNotIn(marker, stderr.getvalue())

    def test_invalid_provider_and_review_depth_do_not_echo_values(self):
        for field, marker in (
            ("provider", "SENSITIVE_PROVIDER_MARKER"),
            ("review_depth", "SENSITIVE_DEPTH_MARKER"),
        ):
            with self.subTest(field=field):
                exit_code, stderr = self._run(
                    self._args(**{field: marker}),
                    get_provider=MagicMock(),
                )

                self.assertEqual(exit_code, 1)
                self.assertNotIn(marker, stderr)

    def test_provider_configuration_failure_emits_only_safe_exception_type(self):
        marker = "SENSITIVE_PROVIDER_EXCEPTION_MARKER"
        exc_type = type("Unsafe\nProviderError", (RuntimeError,), {})
        exit_code, stderr = self._run(
            self._args(),
            get_provider=MagicMock(side_effect=exc_type(marker)),
        )

        self.assertEqual(exit_code, 1)
        self.assertIn("UnknownError", stderr)
        self.assertNotIn(marker, stderr)
        self.assertNotIn("Unsafe", stderr)

    def test_git_diff_failure_does_not_echo_command_or_output(self):
        marker = "SENSITIVE_GIT_OUTPUT_MARKER"
        command_marker = "SENSITIVE_GIT_COMMAND_MARKER"
        error = __import__("subprocess").CalledProcessError(
            1, ["git", command_marker], output=marker, stderr=marker
        )
        exit_code, stderr = self._run(
            self._args(),
            get_provider=MagicMock(return_value=MagicMock()),
            check_output=MagicMock(side_effect=error),
        )

        self.assertEqual(exit_code, 2)
        self.assertIn("CalledProcessError", stderr)
        self.assertNotIn(marker, stderr)
        self.assertNotIn(command_marker, stderr)

    def test_spec_read_failure_does_not_echo_path_or_exception_text(self):
        path_marker = "/SENSITIVE_SPEC_PATH_MARKER"
        error_marker = "SENSITIVE_SPEC_ERROR_MARKER"
        provider = MagicMock(model="mock-model", base_url="https://provider.test")
        provider.send_chat = AsyncMock(return_value="review output")
        exit_code, stderr = self._run(
            self._args(spec=path_marker),
            get_provider=MagicMock(return_value=provider),
            check_output=MagicMock(return_value="diff"),
            read_text_block=MagicMock(side_effect=OSError(error_marker)),
        )

        self.assertEqual(exit_code, 0)
        self.assertIn("OSError", stderr)
        self.assertNotIn(path_marker, stderr)
        self.assertNotIn(error_marker, stderr)


if __name__ == "__main__":
    unittest.main()
