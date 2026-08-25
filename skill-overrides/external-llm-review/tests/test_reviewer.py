import unittest
import sys
import subprocess
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import shlex
import asyncio
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory

import reviewer


class ReviewerProtocolAndBackendTest(unittest.TestCase):
    def test_exhaustive_protocol_asks_for_broad_single_pass_report(self):
        protocol = reviewer.build_review_protocol(
            review_depth="exhaustive",
            review_round=1,
            max_issues=25,
        )

        self.assertIn("最多报告 25 个问题", protocol)
        self.assertIn("不要只报告 top 3", protocol)
        self.assertIn("逐项检查清单", protocol)
        self.assertIn("已检查但未发现问题", protocol)

    def test_second_round_protocol_limits_scope(self):
        protocol = reviewer.build_review_protocol(
            review_depth="exhaustive",
            review_round=2,
            max_issues=25,
        )

        self.assertIn("第二轮", protocol)
        self.assertIn("只验证上一轮已修复项", protocol)
        self.assertIn("不要扩展到无关历史问题", protocol)

    def test_review_user_prompt_includes_protocol_before_diff(self):
        prompt = reviewer.build_review_user_prompt(
            base_sha="abcdef123",
            head_sha="123456abc",
            diff="+changed",
            truncated=False,
            review_depth="exhaustive",
            review_round=1,
            max_issues=25,
        )

        self.assertLess(prompt.index("## Review Protocol"), prompt.index("## Git Diff"))
        self.assertIn("最多报告 25 个问题", prompt)
        self.assertIn("+changed", prompt)

    def test_parser_rejects_review_round_above_two(self):
        parser = reviewer.build_arg_parser()

        with self.assertRaises(SystemExit):
            parser.parse_args(["base", "head", "--review-round", "3"])

    def test_parser_defaults_api_timeout_to_600_seconds(self):
        args = reviewer.build_arg_parser().parse_args(["base", "head"])

        self.assertEqual(args.api_timeout_seconds, 600)

    def test_build_git_diff_command_supports_worktree_head(self):
        self.assertEqual(
            reviewer.build_git_diff_command("/repo", "abc123", "WORKTREE"),
            ["git", "-C", "/repo", "diff", "--diff-filter=ACM", "abc123"],
        )

    def test_build_git_diff_command_keeps_commit_range_for_regular_head(self):
        self.assertEqual(
            reviewer.build_git_diff_command("/repo", "abc123", "def456"),
            ["git", "-C", "/repo", "diff", "--diff-filter=ACM", "abc123..def456"],
        )

    def test_review_provider_defaults_to_idealab_anthropic(self):
        args = Namespace(provider=None)
        self.assertEqual(reviewer.resolve_provider(args, env={}), "idealab-anthropic")

    def test_review_provider_accepts_known_providers(self):
        args = Namespace(provider="idealab-anthropic")
        self.assertEqual(reviewer.resolve_provider(args, env={}), "idealab-anthropic")

        args = Namespace(provider="idealab-openai")
        self.assertEqual(reviewer.resolve_provider(args, env={}), "idealab-openai")

    def test_review_provider_rejects_retired_providers_from_args_and_env(self):
        for provider in ("bailian", "deepseek"):
            with self.subTest(provider=provider):
                with self.assertRaisesRegex(ValueError, "idealab-openai"):
                    reviewer.resolve_provider(Namespace(provider=provider), env={})
                with self.assertRaisesRegex(ValueError, "idealab-openai"):
                    reviewer.resolve_provider(
                        Namespace(provider=None),
                        env={"EXTERNAL_LLM_REVIEW_PROVIDER": provider},
                    )

    def test_arg_parser_rejects_retired_providers(self):
        parser = reviewer.build_arg_parser()
        for provider in ("bailian", "deepseek"):
            with self.subTest(provider=provider):
                with self.assertRaises(SystemExit):
                    parser.parse_args(["base", "head", "--provider", provider])

    def test_review_provider_reads_env(self):
        args = Namespace(provider=None)
        self.assertEqual(
            reviewer.resolve_provider(args, env={"EXTERNAL_LLM_REVIEW_PROVIDER": "idealab-openai"}),
            "idealab-openai"
        )

    def test_review_provider_rejects_unknown_values(self):
        with self.assertRaisesRegex(ValueError, "EXTERNAL_LLM_REVIEW_PROVIDER"):
            reviewer.resolve_provider(
                Namespace(provider=None),
                env={"EXTERNAL_LLM_REVIEW_PROVIDER": "ollama"},
            )

    def test_anthropic_user_agent_is_deceptive(self):
        self.assertEqual(
            reviewer.ANTHROPIC_USER_AGENT,
            "claude-cli/2.1.156 (external, sdk-cli)",
        )

    def test_build_anthropic_messages_payload_includes_system_and_user(self):
        payload = reviewer.build_anthropic_messages_payload(
            system_prompt="system content",
            user_prompt="user content",
            model="claude-opus-4-7",
            max_tokens=16000,
        )

        self.assertEqual(payload["model"], "claude-opus-4-7")
        self.assertEqual(payload["messages"][0]["role"], "user")
        self.assertEqual(payload["messages"][0]["content"], "user content")
        self.assertEqual(payload["system"], "system content")
        self.assertEqual(payload["max_tokens"], 16000)

    def test_build_anthropic_messages_payload_omits_max_tokens_when_zero(self):
        payload = reviewer.build_anthropic_messages_payload(
            system_prompt="system",
            user_prompt="user",
            model="claude-opus-4-7",
            max_tokens=0,
        )

        self.assertNotIn("max_tokens", payload)

    def test_extract_anthropic_text_extracts_first_text_block(self):
        class Response:
            content = [
                {"type": "text", "text": "review output"},
            ]

        self.assertEqual(
            reviewer.extract_anthropic_text(Response()),
            "review output",
        )

    def test_extract_anthropic_text_rejects_empty_content(self):
        class Response:
            content = []

        with self.assertRaisesRegex(RuntimeError, "empty content"):
            reviewer.extract_anthropic_text(Response())

    def test_extract_anthropic_text_rejects_no_text_block(self):
        class Response:
            content = [{"type": "tool_use", "id": "1"}]

        with self.assertRaisesRegex(RuntimeError, "no text block"):
            reviewer.extract_anthropic_text(Response())

    def test_default_chat_messages_are_plain_strings(self):
        messages = reviewer.build_chat_messages(
            user_prompt="review this diff",
            spec_block="## Spec\nstable requirements",
        )

        self.assertEqual(messages[0]["role"], "system")
        self.assertIsInstance(messages[0]["content"], str)
        self.assertIn("stable requirements", messages[1]["content"])
        self.assertTrue(messages[1]["content"].endswith("review this diff"))

    def test_plain_user_prompt_includes_stable_context(self):
        user_prompt = reviewer.build_plain_user_prompt(
            user_prompt="review this diff",
            spec_block="## Spec\nstable requirements",
        )

        self.assertIn("stable requirements", user_prompt)
        self.assertTrue(user_prompt.endswith("review this diff"))

    def test_extract_openai_content_rejects_empty_choices(self):
        class Response:
            choices = []

        with self.assertRaisesRegex(RuntimeError, "empty choices"):
            reviewer.extract_openai_content(Response())

    def test_extract_openai_content_falls_back_to_reasoning_content(self):
        class Message:
            content = ""
            reasoning_content = "thinking result..."

        class Choice:
            message = Message()
            finish_reason = "length"

        class Response:
            choices = [Choice()]

        result = reviewer.extract_openai_content(Response())
        self.assertEqual(result, "thinking result...")

    def test_extract_openai_content_rejects_empty_content_and_no_reasoning(self):
        class UsageDetails:
            reasoning_tokens = 32

        class Usage:
            completion_tokens = 32
            completion_tokens_details = UsageDetails()

        class Message:
            content = ""
            reasoning_content = ""

        class Choice:
            message = Message()
            finish_reason = "length"

        class Response:
            choices = [Choice()]
            usage = Usage()

        with self.assertRaisesRegex(
            RuntimeError,
            "empty content.*finish_reason=length.*reasoning_tokens=32",
        ):
            reviewer.extract_openai_content(Response())

    def test_extract_openai_stream_content_concatenates_content_chunks(self):
        chunks = [
            {"choices": [{"delta": {"role": "assistant"}, "index": 0}]},
            {"choices": [{"delta": {"reasoning_content": "thinking "}, "index": 0}]},
            {"choices": [{"delta": {"reasoning_content": "done"}, "index": 0}]},
            {"choices": [{"delta": {"content": "Hello "}, "index": 0}]},
            {"choices": [{"delta": {"content": "world."}, "index": 0}]},
            {
                "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}],
                "usage": {"completion_tokens": 5},
            },
        ]

        async def run():
            return await reviewer.extract_openai_stream_content(iter(chunks))

        result = asyncio.run(run())

        self.assertEqual(result["content"], "Hello world.")
        self.assertEqual(result["reasoning_content"], "thinking done")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["usage"]["completion_tokens"], 5)

    def test_extract_openai_stream_content_falls_back_to_reasoning_when_content_empty(self):
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "actual answer"}, "finish_reason": "stop", "index": 0}]},
        ]

        async def run():
            return await reviewer.extract_openai_stream_content(iter(chunks))

        result = asyncio.run(run())

        self.assertEqual(result["content"], "")
        self.assertEqual(result["reasoning_content"], "actual answer")

    def test_extract_openai_stream_content_raises_on_empty_chunks(self):
        async def run():
            return await reviewer.extract_openai_stream_content(iter([]))

        with self.assertRaises(RuntimeError):
            asyncio.run(run())

    def test_parse_sse_lines_yields_data_objects_and_skips_done(self):
        lines = [
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
            "",
            "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}",
            "",
            "data: [DONE]",
            "",
        ]

        async def run():
            return [chunk async for chunk in reviewer.parse_sse_lines(iter(lines))]

        result = asyncio.run(run())

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["choices"][0]["delta"]["content"], "Hello")
        self.assertEqual(result[1]["choices"][0]["delta"]["content"], " world")

    def test_parse_sse_lines_ignores_non_data_prefixes(self):
        lines = [
            ":comment line",
            "event: message",
            "id: 1",
            "data: {\"ok\":true}",
            "",
        ]

        async def run():
            return [chunk async for chunk in reviewer.parse_sse_lines(iter(lines))]

        result = asyncio.run(run())

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], {"ok": True})

    def test_parse_sse_lines_concatenates_multiline_data_in_single_event(self):
        lines = [
            "data: {\"choices\":",
            "data: [{\"delta\":{\"content\":\"hi\"}}]}",
            "",
            "data: [DONE]",
        ]

        async def run():
            return [c async for c in reviewer.parse_sse_lines(iter(lines))]

        result = asyncio.run(run())

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["choices"][0]["delta"]["content"], "hi")

    def test_parse_sse_lines_skips_malformed_json_and_continues(self):
        lines = [
            "data: {\"ok\":true}",
            "",
            "data: {not valid json",
            "",
            "data: {\"after\":\"good\"}",
            "",
            "data: [DONE]",
        ]

        async def run():
            return [c async for c in reviewer.parse_sse_lines(iter(lines))]

        result = asyncio.run(run())

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {"ok": True})
        self.assertEqual(result[1], {"after": "good"})

    def test_extract_openai_stream_content_processes_chunks_incrementally(self):
        seen = []

        async def gen():
            for i in range(3):
                seen.append(i)
                yield {"choices": [{"delta": {"content": f"x{i}"}, "index": 0}]}
            yield {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]}

        async def run():
            return await reviewer.extract_openai_stream_content(gen())

        result = asyncio.run(run())

        self.assertEqual(result["content"], "x0x1x2")
        self.assertEqual(result["finish_reason"], "stop")

    def test_extract_openai_stream_content_tolerates_malformed_chunk(self):
        chunks = [
            {"choices": [{"delta": {"content": "good"}, "index": 0}]},
            "not a dict at all",
            {"choices": []},
            {"choices": [{"delta": {"content": " also good"}, "finish_reason": "stop", "index": 0}]},
        ]

        async def run():
            return await reviewer.extract_openai_stream_content(iter(chunks))

        result = asyncio.run(run())

        self.assertEqual(result["content"], "good also good")
        self.assertEqual(result["finish_reason"], "stop")

    def test_arg_parser_defaults_to_reasoning_safe_output_budget(self):
        parser = reviewer.build_arg_parser()
        args = parser.parse_args(["base", "head"])

        self.assertEqual(args.max_output_tokens, 32768)

    def test_read_text_block_rejects_paths_outside_allowed_roots(self):
        with TemporaryDirectory() as root, TemporaryDirectory() as outside:
            secret_path = Path(outside) / "secret.txt"
            secret_path.write_text("secret", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "outside allowed roots"):
                reviewer.read_text_block(
                    str(secret_path),
                    label="Spec",
                    allowed_roots=[Path(root)],
                )

    def test_describe_api_exception_includes_only_safe_diagnostics(self):
        class Response:
            status_code = 400
            text = '{"error":"raw response body"}'
            headers = {"x-request-id": "header-request-id"}

        class ApiError(Exception):
            response = Response()
            code = "invalid_request"
            type = "request_error"
            param = "model"
            request_id = "req-123.abc"

        detail = reviewer.describe_api_exception(ApiError("raw exception message"))

        self.assertIn("ApiError", detail)
        self.assertIn("status_code=400", detail)
        self.assertIn("code=invalid_request", detail)
        self.assertIn("type=request_error", detail)
        self.assertIn("param=model", detail)
        self.assertIn("request_id=req-123.abc", detail)
        self.assertNotIn("raw exception message", detail)
        self.assertNotIn("raw response body", detail)
        self.assertNotIn("header-request-id", detail)

    def test_describe_api_exception_omits_unsafe_fields_and_status(self):
        class Response:
            status_code = "500"

        class ApiError(Exception):
            response = Response()
            code = "unsafe value"
            request_id = "req/unsafe"

        detail = reviewer.describe_api_exception(ApiError("sensitive"))

        self.assertEqual(detail, "ApiError")

    def test_run_review_rejects_legacy_api_format_env(self):
        import asyncio
        from io import StringIO
        from unittest.mock import patch

        args = reviewer.build_arg_parser().parse_args(["base", "head"])
        skill_dir = Path(__file__).resolve().parent.parent
        with patch.dict(
            "os.environ",
            {"EXTERNAL_LLM_API_FORMAT": "anthropic"},
            clear=True,
        ), patch("sys.stderr", new_callable=StringIO) as stderr:
            exit_code = asyncio.run(
                reviewer.run_review(args=args, skill_dir=skill_dir)
            )

        self.assertEqual(exit_code, 1)
        self.assertIn("EXTERNAL_LLM_API_FORMAT", stderr.getvalue())
        self.assertIn("no longer read", stderr.getvalue())




class IdealabAnthropicProviderTest(unittest.TestCase):
    def test_payload_includes_system_and_messages(self):
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://anthropic.example.test",
            api_key="sk-ant-test",
            model="claude-opus-4-6",
            max_tokens=16000,
        )
        messages = [
            {"role": "system", "content": "You are a critic."},
            {"role": "user", "content": "Review this code."},
        ]
        payload = provider.build_payload(messages=messages, spec={"temperature": 0.3})

        self.assertEqual(payload["model"], "claude-opus-4-6")
        self.assertEqual(payload["max_tokens"], 16000)
        self.assertNotIn("temperature", payload)  # Anthropic provider omits temperature
        self.assertEqual(payload["system"], "You are a critic.")
        self.assertEqual(len(payload["messages"]), 1)
        self.assertEqual(payload["messages"][0]["role"], "user")

    def test_payload_uses_spec_max_tokens_and_omits_non_positive_values(self):
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://anthropic.example.test",
            api_key="test-key",
            model="claude-opus-4-6",
            max_tokens=16000,
        )
        messages = [{"role": "user", "content": "Review this code."}]

        self.assertEqual(
            provider.build_payload(messages, {"max_tokens": 2000})["max_tokens"],
            2000,
        )
        self.assertNotIn("max_tokens", provider.build_payload(messages, {"max_tokens": 0}))
        self.assertEqual(provider.build_payload(messages, {})["max_tokens"], 16000)

    def test_extract_content_returns_text_block(self):
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://x", api_key="k", model="m"
        )
        response = {
            "content": [
                {"type": "text", "text": "review result"},
            ]
        }
        self.assertEqual(provider.extract_content(response), "review result")

    def test_extract_content_raises_on_empty(self):
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://x", api_key="k", model="m"
        )
        with self.assertRaisesRegex(RuntimeError, "idealab-anthropic response has no content"):
            provider.extract_content({})

    def test_extract_content_rejects_empty_text_without_echoing_response(self):
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://x", api_key="k", model="m"
        )
        response = {"content": [{"type": "text", "text": ""}]}

        with self.assertRaisesRegex(RuntimeError, "empty text") as raised:
            provider.extract_content(response)

        self.assertNotIn("content", str(raised.exception))

    def test_extract_content_rejects_malformed_blocks_without_echoing_response(self):
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://x", api_key="k", model="m"
        )
        response = {"content": [{"type": "tool_use", "input": "sensitive block"}]}

        with self.assertRaisesRegex(RuntimeError, "no text block") as raised:
            provider.extract_content(response)

        self.assertNotIn("sensitive block", str(raised.exception))

    def test_headers_include_claude_user_agent(self):
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://x", api_key="my-key", model="m"
        )
        headers = provider.build_headers()
        self.assertEqual(headers["x-api-key"], "my-key")
        self.assertIn("claude-cli", headers["user-agent"])
        self.assertEqual(headers["anthropic-version"], "2023-06-01")


class IdealabOpenAIProviderTest(unittest.TestCase):
    def test_payload_is_plain_openai_format(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://openai.example.test",
            api_key="sk-oa-test",
            model="gpt-4o",
            max_tokens=8000,
        )
        messages = [
            {"role": "system", "content": "system msg"},
            {"role": "user", "content": "hi"},
        ]
        payload = provider.build_payload(messages=messages, spec={})

        self.assertEqual(payload["model"], "gpt-4o")
        self.assertEqual(payload["max_tokens"], 8000)
        # Both system and user messages are preserved (not extracted out)
        self.assertEqual(len(payload["messages"]), 2)
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["stream_options"], {"include_usage": True})

    def test_payload_uses_spec_max_tokens_and_omits_non_positive_values(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://openai.example.test",
            api_key="test-key",
            model="qwen3.8-max",
            max_tokens=8000,
        )
        messages = [{"role": "user", "content": "Review this code."}]

        self.assertEqual(
            provider.build_payload(messages, {"max_tokens": 2000})["max_tokens"],
            2000,
        )
        self.assertNotIn("max_tokens", provider.build_payload(messages, {"max_tokens": -1}))
        self.assertEqual(provider.build_payload(messages, {})["max_tokens"], 8000)

    def test_extract_content_returns_message_content(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://x", api_key="k", model="m"
        )
        response = {
            "choices": [{"message": {"content": "gpt review"}}]
        }
        self.assertEqual(provider.extract_content(response), "gpt review")

    def test_extract_content_raises_on_empty(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://x", api_key="k", model="m"
        )
        response = {"choices": [{"message": {"content": ""}, "finish_reason": "stop"}]}
        with self.assertRaisesRegex(RuntimeError, "idealab-openai response returned empty content"):
            provider.extract_content(response)

    def test_extract_content_falls_back_to_reasoning_content(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://x", api_key="k", model="m"
        )
        response = {
            "choices": [{"message": {"content": "", "reasoning_content": "review"}}]
        }
        self.assertEqual(provider.extract_content(response), "review")

    def test_extract_content_prefers_content_over_reasoning_content(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://x", api_key="k", model="m"
        )
        response = {
            "choices": [
                {"message": {"content": "final review", "reasoning_content": "thinking"}}
            ]
        }

        self.assertEqual(provider.extract_content(response), "final review")

    def test_send_chat_streams_and_falls_back_to_reasoning_content(self):
        from unittest.mock import MagicMock
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://openai.test", api_key="sk-oa", model="qwen3.8-max"
        )
        mock_client = MagicMock()

        async def sse_lines():
            yield 'data: {"choices":[{"delta":{"reasoning_content":"review"}}]}'
            yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
            yield "data: [DONE]"

        class MockStreamResponse:
            status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def raise_for_status(self):
                pass

            def aiter_lines(self):
                return sse_lines()

        mock_client.stream.return_value = MockStreamResponse()

        async def run():
            return await provider.send_chat(
                mock_client,
                messages=[{"role": "user", "content": "Review"}],
                spec={},
            )

        self.assertEqual(asyncio.run(run()), "review")
        _, _, kwargs = mock_client.stream.mock_calls[0]
        self.assertTrue(kwargs["json"]["stream"])
        self.assertEqual(kwargs["json"]["stream_options"], {"include_usage": True})
        self.assertNotIn("enable_thinking", kwargs["json"])

    def test_send_chat_streams_prefers_content_over_reasoning_content(self):
        from unittest.mock import MagicMock
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://openai.test", api_key="sk-oa", model="qwen3.8-max"
        )
        mock_client = MagicMock()

        async def sse_lines():
            yield 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}'
            yield 'data: {"choices":[{"delta":{"content":"final "}}]}'
            yield 'data: {"choices":[{"delta":{"content":"review"}}]}'
            yield "data: [DONE]"

        class MockStreamResponse:
            status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def raise_for_status(self):
                pass

            def aiter_lines(self):
                return sse_lines()

        mock_client.stream.return_value = MockStreamResponse()

        async def run():
            return await provider.send_chat(
                mock_client,
                messages=[{"role": "user", "content": "Review"}],
                spec={},
            )

        self.assertEqual(asyncio.run(run()), "final review")

    def test_stream_ignores_usage_only_and_empty_choices(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://openai.test", api_key="test-key", model="qwen3.8-max"
        )

        async def chunks():
            yield {"choices": [], "usage": {"completion_tokens": 4}}
            yield {"usage": {"completion_tokens": 5}}
            yield {"choices": [{"delta": {"content": "review"}}]}

        self.assertEqual(asyncio.run(provider.extract_stream_content(chunks())), "review")

    def test_sse_error_event_reports_only_whitelisted_diagnostics(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://openai.test", api_key="test-key", model="qwen3.8-max"
        )

        async def lines():
            yield (
                'data: {"error":{"code":"invalid_request","type":"request_error",'
                '"param":"model","message":"sensitive-message",'
                '"credential":"sensitive-value"}}'
            )

        async def run():
            async for _ in provider._parse_sse(lines()):
                pass

        with self.assertRaisesRegex(
            RuntimeError,
            "code=invalid_request type=request_error param=model",
        ) as raised:
            asyncio.run(run())

        message = str(raised.exception)
        self.assertNotIn("sensitive-message", message)
        self.assertNotIn("sensitive-value", message)

    def test_sse_error_event_omits_unstable_diagnostic_values(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://openai.test", api_key="test-key", model="qwen3.8-max"
        )

        async def lines():
            yield 'data: {"error":{"code":"unsafe value","message":"sensitive-message"}}'

        async def run():
            async for _ in provider._parse_sse(lines()):
                pass

        with self.assertRaisesRegex(RuntimeError, "stream error event") as raised:
            asyncio.run(run())

        self.assertNotIn("unsafe value", str(raised.exception))
        self.assertNotIn("sensitive-message", str(raised.exception))

    def test_headers_use_bearer_token(self):
        from _provider import IdealabOpenAIProvider
        provider = IdealabOpenAIProvider(
            base_url="https://x", api_key="bearer-token", model="m"
        )
        headers = provider.build_headers()
        self.assertEqual(headers["Authorization"], "Bearer bearer-token")


class BuildProviderFactoryTest(unittest.TestCase):

    def test_build_provider_returns_idealab_anthropic_when_endpoint_is_idealab_anthropic(self):
        from _provider import build_provider, IdealabAnthropicProvider
        provider = build_provider(
            base_url="https://idealab.alibaba-inc.com/api/anthropic",
            api_key="sk",
            model="claude-opus-4-6",
            max_tokens=1000,
        )
        self.assertIsInstance(provider, IdealabAnthropicProvider)

    def test_build_provider_returns_idealab_openai_when_endpoint_is_idealab_openai(self):
        from _provider import build_provider, IdealabOpenAIProvider
        provider = build_provider(
            base_url="https://idealab.alibaba-inc.com/api/openai/v1",
            api_key="sk",
            model="qwen3.8-max",
            max_tokens=1000,
        )
        self.assertIsInstance(provider, IdealabOpenAIProvider)

    def test_build_provider_rejects_unknown_or_generic_endpoint_without_echoing_url(self):
        from _provider import build_provider
        for base_url in (
            "https://api.openai.com/v1",
            "https://idealab.alibaba-inc.com/unknown",
        ):
            with self.subTest(base_url=base_url):
                with self.assertRaisesRegex(ValueError, "unsupported provider endpoint") as raised:
                    build_provider(base_url=base_url, api_key="sk", model="model")
                self.assertNotIn(base_url, str(raised.exception))

    def test_build_provider_rejects_noncanonical_approved_endpoint_variants(self):
        from _provider import build_provider

        for base_url in (
            "http://idealab.alibaba-inc.com/api/anthropic",
            "ftp://idealab.alibaba-inc.com/api/anthropic",
            "idealab.alibaba-inc.com/api/anthropic",
            "//idealab.alibaba-inc.com/api/anthropic",
            "https://idealab.alibaba-inc.com:443/api/anthropic",
            "https://idealab.alibaba-inc.com:444/api/anthropic",
            "https://idealab.alibaba-inc.com:/api/anthropic",
            "https://idealab.alibaba-inc.com:invalid/api/anthropic",
            "https://user@idealab.alibaba-inc.com/api/anthropic",
            "https://user:password@idealab.alibaba-inc.com/api/anthropic",
            "https://idealab.alibaba-inc.com/api/anthropic?debug=true",
            "https://idealab.alibaba-inc.com/api/anthropic?",
            "https://idealab.alibaba-inc.com/api/anthropic#fragment",
            "https://idealab.alibaba-inc.com/api/anthropic#",
            "HTTPS://idealab.alibaba-inc.com/api/anthropic",
            "https://IDEALAB.ALIBABA-INC.COM/api/anthropic",
            "https://idealab.alibaba-inc.com/api/anthropic/",
        ):
            with self.subTest(base_url=base_url):
                with self.assertRaisesRegex(ValueError, "unsupported provider endpoint") as raised:
                    build_provider(base_url=base_url, api_key="sk", model="model")
                self.assertNotIn(base_url, str(raised.exception))
                self.assertNotIn("user", str(raised.exception))
                self.assertNotIn("password", str(raised.exception))
                self.assertNotIn("debug", str(raised.exception))
                self.assertNotIn("fragment", str(raised.exception))


class ProviderSendChatTest(unittest.TestCase):
    def test_idealab_anthropic_send_chat_makes_request_and_extracts_content(self):
        from unittest.mock import AsyncMock, MagicMock
        from _provider import IdealabAnthropicProvider
        provider = IdealabAnthropicProvider(
            base_url="https://anthropic.test",
            api_key="sk-ant",
            model="claude-opus-4-6",
            max_tokens=16000,
        )
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "content": [{"type": "text", "text": "Review result from Anthropic"}]
        }
        mock_client.post.return_value = mock_response

        async def run():
            return await provider.send_chat(
                mock_client,
                messages=[{"role": "user", "content": "Review this"}],
                spec={"temperature": 0.3},
            )

        result = asyncio.run(run())
        self.assertEqual(result, "Review result from Anthropic")
        mock_client.post.assert_called_once()




from unittest.mock import ANY, AsyncMock, MagicMock


class ProviderConfigLoaderTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmpdir = tempfile.mkdtemp()
        import pathlib
        self.providers_dir = pathlib.Path(self.tmpdir) / "providers"
        self.providers_dir.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def write_provider(self, name: str, content: str):
        (self.providers_dir / f"{name}.yaml").write_text(content)

    def test_load_provider_yaml_parses_env_placeholders(self):
        from _config import load_provider_config
        self.write_provider(
            "idealab-anthropic",
            "provider: idealab-anthropic\n"
            "base_url: https://idealab.alibaba-inc.com/api/anthropic\n"
            "api_key: ${ANTHROPIC_API_KEY}\n"
            "model: claude-opus-4-6\n"
            "max_tokens: 16000\n",
        )
        cfg = load_provider_config(
            "idealab-anthropic",
            providers_dir=self.providers_dir,
            env={"ANTHROPIC_API_KEY": "sk-ant-secret"},
        )
        self.assertEqual(cfg["provider"], "idealab-anthropic")
        self.assertEqual(cfg["api_key"], "sk-ant-secret")
        self.assertEqual(
            cfg["base_url"], "https://idealab.alibaba-inc.com/api/anthropic"
        )
        self.assertEqual(cfg["model"], "claude-opus-4-6")
        self.assertEqual(cfg["max_tokens"], 16000)

    def test_load_provider_yaml_raises_on_missing_file(self):
        from _config import load_provider_config
        with self.assertRaisesRegex(FileNotFoundError, "not found"):
            load_provider_config(
                "ghost",
                providers_dir=self.providers_dir,
                env={},
            )



    def test_load_provider_yaml_accepts_literal_non_secret_values(self):
        from _config import load_provider_config
        self.write_provider(
            "idealab-openai",
            "provider: idealab-openai\n"
            "base_url: https://default.test\n"
            "api_key: sk-in-yaml\n"
            "model: gpt-4o\n",
        )
        cfg = load_provider_config(
            "idealab-openai",
            providers_dir=self.providers_dir,
            env={},
        )
        self.assertEqual(cfg["api_key"], "sk-in-yaml")
        self.assertEqual(cfg["base_url"], "https://default.test")


class GetProviderDispatchTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmpdir = tempfile.mkdtemp()
        import pathlib
        self.providers_dir = pathlib.Path(self.tmpdir) / "providers"
        self.providers_dir.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def write_provider(self, name: str, content: str):
        (self.providers_dir / f"{name}.yaml").write_text(content)

    def test_get_provider_returns_idealab_anthropic(self):
        from _config import get_provider
        from _provider import IdealabAnthropicProvider
        self.write_provider(
            "idealab-anthropic",
            "provider: idealab-anthropic\n"
            "base_url: https://idealab.alibaba-inc.com/api/anthropic\n"
            "api_key: ${ANT_API}\n"
            "model: claude-opus-4-6\n"
            "max_tokens: 16000\n",
        )
        provider = get_provider(
            "idealab-anthropic",
            providers_dir=self.providers_dir,
            env={"ANT_API": "sk-ant"},
        )
        self.assertIsInstance(provider, IdealabAnthropicProvider)
        self.assertEqual(provider.api_key, "sk-ant")
        self.assertEqual(provider.model, "claude-opus-4-6")

    def test_get_provider_returns_idealab_openai(self):
        from _config import get_provider
        from _provider import IdealabOpenAIProvider
        self.write_provider(
            "idealab-openai",
            "provider: idealab-openai\n"
            "base_url: https://idealab.alibaba-inc.com/api/openai/v1\n"
            "api_key: ${OA_API}\n"
            "model: qwen3.8-max\n"
            "max_tokens: 8000\n",
        )
        provider = get_provider(
            "idealab-openai",
            providers_dir=self.providers_dir,
            env={"OA_API": "sk-oa"},
        )
        self.assertIsInstance(provider, IdealabOpenAIProvider)
        self.assertEqual(provider.api_key, "sk-oa")

    def test_get_provider_rejects_approved_endpoint_with_unapproved_model_without_echoing_values(self):
        from _config import get_provider

        cases = (
            (
                "idealab-anthropic",
                "https://idealab.alibaba-inc.com/api/anthropic",
                "gpt-4o",
            ),
            (
                "idealab-openai",
                "https://idealab.alibaba-inc.com/api/openai/v1",
                "gpt-4o",
            ),
        )
        for name, base_url, model in cases:
            with self.subTest(name=name, model=model):
                self.write_provider(
                    name,
                    f"provider: {name}\n"
                    f"base_url: {base_url}\n"
                    "api_key: test-key\n"
                    f"model: {model}\n",
                )
                with self.assertRaisesRegex(ValueError, "unsupported provider endpoint") as raised:
                    get_provider(name, providers_dir=self.providers_dir, env={})
                self.assertNotIn(base_url, str(raised.exception))
                self.assertNotIn(model, str(raised.exception))

    def test_get_provider_rejects_unapproved_openai_or_unknown_endpoint_without_echoing_url(self):
        from _config import get_provider

        for base_url in (
            "https://api.openai.com/v1",
            "https://idealab.alibaba-inc.com/api/unknown",
        ):
            with self.subTest(base_url=base_url):
                self.write_provider(
                    "idealab-openai",
                    "provider: idealab-openai\n"
                    f"base_url: {base_url}\n"
                    "api_key: test-key\n"
                    "model: qwen3.8-max\n",
                )
                with self.assertRaisesRegex(ValueError, "unsupported provider endpoint") as raised:
                    get_provider("idealab-openai", providers_dir=self.providers_dir, env={})
                self.assertNotIn(base_url, str(raised.exception))

    def test_get_provider_rejects_kind_endpoint_mismatch_without_echoing_url(self):
        from _config import get_provider

        base_url = "https://idealab.alibaba-inc.com/api/anthropic"
        self.write_provider(
            "idealab-openai",
            "provider: idealab-openai\n"
            f"base_url: {base_url}\n"
            "api_key: test-key\n"
            "model: claude-opus-4-6\n",
        )

        with self.assertRaisesRegex(ValueError, "provider kind mismatch") as raised:
            get_provider("idealab-openai", providers_dir=self.providers_dir, env={})
        self.assertNotIn(base_url, str(raised.exception))


    def test_get_provider_raises_on_unknown_provider_type(self):
        from _config import get_provider
        self.write_provider(
            "mystery",
            "provider: unknown-vendor\n"
            "base_url: https://x.test\n"
            "api_key: sk\n"
            "model: m\n",
        )
        with self.assertRaisesRegex(ValueError, "Unknown provider type 'unknown-vendor'"):
            get_provider(
                "mystery",
                providers_dir=self.providers_dir,
                env={},
            )

    def test_get_provider_raises_when_provider_field_is_missing(self):
        from _config import get_provider
        self.write_provider(
            "missing-provider",
            "base_url: https://x.test\n"
            "api_key: test-key\n"
            "model: test-model\n",
        )
        with self.assertRaisesRegex(ValueError, "missing required 'provider' field"):
            get_provider(
                "missing-provider",
                providers_dir=self.providers_dir,
                env={},
            )

    def test_idealab_openai_prefers_pi_auth_key(self):
        import _config
        from _config import get_provider
        self.write_provider(
            "idealab-openai",
            "provider: idealab-openai\n"
            "base_url: https://idealab.alibaba-inc.com/api/openai/v1\n"
            "api_key: ${IDEALAB_OPENAI_API_KEY}\n"
            "model: qwen3.8-max\n",
        )
        result = subprocess.CompletedProcess([], 0, stdout="pi-auth-key\n", stderr="")
        with patch.object(_config.subprocess, "run", return_value=result) as run:
            provider = get_provider(
                "idealab-openai",
                providers_dir=self.providers_dir,
                env={"IDEALAB_OPENAI_API_KEY": "env-fallback-key"},
            )

        self.assertEqual(provider.api_key, "pi-auth-key")
        run.assert_called_once_with(
            ["pi", "auth", "print-api-key", "--provider", "openai-idealab"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def test_idealab_openai_uses_env_key_when_pi_auth_is_unavailable(self):
        import _config
        from _config import get_provider
        self.write_provider(
            "idealab-openai",
            "provider: idealab-openai\n"
            "base_url: https://idealab.alibaba-inc.com/api/openai/v1\n"
            "api_key: ${IDEALAB_OPENAI_API_KEY}\n"
            "model: qwen3.8-max\n",
        )
        result = subprocess.CompletedProcess([], 1, stdout="", stderr="unavailable")
        with patch.object(_config.subprocess, "run", return_value=result):
            provider = get_provider(
                "idealab-openai",
                providers_dir=self.providers_dir,
                env={"IDEALAB_OPENAI_API_KEY": "env-fallback-key"},
            )

        self.assertEqual(provider.api_key, "env-fallback-key")

    def test_idealab_openai_pi_auth_failures_use_fallback(self):
        import _config
        from _config import get_provider
        self.write_provider(
            "idealab-openai",
            "provider: idealab-openai\n"
            "base_url: https://idealab.alibaba-inc.com/api/openai/v1\n"
            "api_key: ${IDEALAB_OPENAI_API_KEY}\n"
            "model: qwen3.8-max\n",
        )
        failures = (
            ("nonzero-exit", subprocess.CompletedProcess([], 7, stdout="", stderr="hidden")),
            ("empty-output", subprocess.CompletedProcess([], 0, stdout="   ", stderr="hidden")),
            ("timeout", subprocess.TimeoutExpired(["pi"], 10, output="hidden", stderr="hidden")),
            ("could-not-execute", OSError("hidden")),
        )
        for reason, failure in failures:
            with self.subTest(reason=reason), patch.object(_config.subprocess, "run") as run:
                if isinstance(failure, subprocess.CompletedProcess):
                    run.return_value = failure
                else:
                    run.side_effect = failure
                provider = get_provider(
                    "idealab-openai",
                    providers_dir=self.providers_dir,
                    env={"IDEALAB_OPENAI_API_KEY": "env-fallback-key"},
                )

            self.assertEqual(provider.api_key, "env-fallback-key")

    def test_idealab_openai_missing_auth_reports_sanitized_failure_reason(self):
        import _config
        from _config import get_provider
        self.write_provider(
            "idealab-openai",
            "provider: idealab-openai\n"
            "base_url: https://idealab.alibaba-inc.com/api/openai/v1\n"
            "api_key: ${IDEALAB_OPENAI_API_KEY}\n"
            "model: qwen3.8-max\n",
        )
        failures = (
            ("nonzero-exit", subprocess.CompletedProcess([], 7, stdout="hidden", stderr="hidden")),
            ("empty-output", subprocess.CompletedProcess([], 0, stdout="   ", stderr="hidden")),
            ("timeout", subprocess.TimeoutExpired(["pi"], 10, output="hidden", stderr="hidden")),
            ("could-not-execute", OSError("hidden")),
        )
        for reason, failure in failures:
            with self.subTest(reason=reason), patch.object(_config.subprocess, "run") as run:
                if isinstance(failure, subprocess.CompletedProcess):
                    run.return_value = failure
                else:
                    run.side_effect = failure
                with self.assertRaisesRegex(RuntimeError, reason) as raised:
                    get_provider("idealab-openai", providers_dir=self.providers_dir, env={})

            message = str(raised.exception)
            self.assertIn("IDEALAB_OPENAI_API_KEY", message)
            self.assertNotIn("hidden", message)

    def test_default_providers_dir_constant(self):
        from _config import DEFAULT_PROVIDERS_DIR
        self.assertEqual(DEFAULT_PROVIDERS_DIR.name, "providers")



if __name__ == "__main__":
    unittest.main()
