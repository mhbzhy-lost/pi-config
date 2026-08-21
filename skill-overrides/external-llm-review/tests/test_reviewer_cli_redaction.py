import argparse
import asyncio
import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


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
    sys.modules["httpx"] = MagicMock()

import reviewer


class ArgumentParserRedactionTest(unittest.TestCase):
    def test_invalid_values_do_not_echo_user_controlled_input(self):
        cases = (
            ("--provider", "PROVIDER_MARKER", "PROVIDER_MARKER"),
            ("--review-depth", "DEPTH_MARKER", "DEPTH_MARKER"),
            ("--max-diff", "INTEGER_MARKER", "INTEGER_MARKER"),
        )

        for option, value, marker in cases:
            with self.subTest(option=option):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                    reviewer.build_arg_parser().parse_args(
                        ["base", "head", option, value]
                    )

                output = stderr.getvalue()
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(output, "ERROR: invalid command line arguments\n")
                self.assertNotIn(marker, output)
                self.assertNotIn("reviewer.py", output)
                self.assertNotIn(str(Path(__file__).resolve()), output)


class RunReviewProviderConfigurationRedactionTest(unittest.TestCase):
    def _args(self):
        return argparse.Namespace(
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
            api_timeout_seconds=42,
        )

    def test_get_provider_exceptions_are_redacted(self):
        marker = "PROVIDER_CONFIGURATION_SECRET_MARKER"
        custom_type = type("CustomProviderFailure", (Exception,), {})
        for exception in (KeyError(marker), custom_type(marker), RuntimeError(marker)):
            with self.subTest(exception_type=type(exception).__name__):
                stderr = io.StringIO()
                with patch.dict("os.environ", {}, clear=True), \
                     patch.object(reviewer, "get_provider", side_effect=exception), \
                     contextlib.redirect_stderr(stderr):
                    exit_code = asyncio.run(
                        reviewer.run_review(
                            args=self._args(),
                            skill_dir=Path(__file__).resolve().parents[1],
                        )
                    )

                output = stderr.getvalue()
                self.assertEqual(exit_code, 1)
                self.assertEqual(
                    output,
                    f"ERROR: provider configuration failed: {type(exception).__name__}\n",
                )
                self.assertNotIn(marker, output)
                self.assertNotIn("Traceback", output)


class MainExceptionRedactionTest(unittest.TestCase):
    def test_unexpected_exception_is_redacted(self):
        marker = "MAIN_EXCEPTION_SECRET_MARKER"
        stderr = io.StringIO()
        with patch.object(
            reviewer, "build_arg_parser", side_effect=RuntimeError(marker)
        ), contextlib.redirect_stderr(stderr):
            exit_code = asyncio.run(reviewer.main())

        output = stderr.getvalue()
        self.assertEqual(exit_code, 1)
        self.assertEqual(output, "ERROR: unexpected failure: RuntimeError\n")
        self.assertNotIn(marker, output)
        self.assertNotIn("Traceback", output)


if __name__ == "__main__":
    unittest.main()
