import asyncio
import sys
import types
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


try:
    import dotenv  # noqa: F401
except ImportError:
    dotenv = types.ModuleType("dotenv")
    dotenv.load_dotenv = lambda *_args, **_kwargs: None
    sys.modules["dotenv"] = dotenv

for optional_module in ("httpx", "yaml"):
    try:
        __import__(optional_module)
    except ImportError:
        sys.modules[optional_module] = types.ModuleType(optional_module)

import reviewer


class ReviewerStreamingWarningRedactionTest(unittest.TestCase):
    def test_malformed_chunk_warning_is_redacted_and_stream_continues(self):
        marker = "SENSITIVE_MALFORMED_CHUNK_MARKER"
        chunks = [
            marker,
            {"choices": [{"delta": {"content": "after"}, "finish_reason": "stop"}]},
        ]
        stderr = StringIO()

        with redirect_stderr(stderr):
            result = asyncio.run(reviewer.extract_openai_stream_content(chunks))

        self.assertEqual(result["content"], "after")
        self.assertEqual(
            stderr.getvalue(),
            "[external-llm-review] WARN: dropping malformed SSE chunk\n",
        )
        self.assertNotIn(marker, stderr.getvalue())

    def test_malformed_json_warning_is_redacted_and_stream_continues(self):
        marker = "SENSITIVE_MALFORMED_PAYLOAD_MARKER"
        lines = [
            f"data: {{{marker}",
            "",
            'data: {"after":"good"}',
            "",
        ]
        stderr = StringIO()

        with redirect_stderr(stderr):
            result = asyncio.run(self._parse(lines))

        self.assertEqual(result, [{"after": "good"}])
        self.assertEqual(
            stderr.getvalue(),
            "[external-llm-review] WARN: skipping malformed SSE payload\n",
        )
        self.assertNotIn(marker, stderr.getvalue())

    async def _parse(self, lines):
        return [chunk async for chunk in reviewer.parse_sse_lines(lines)]
