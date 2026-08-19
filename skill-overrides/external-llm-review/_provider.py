"""Provider abstraction for external LLM review.

Encapsulates provider-specific API quirks so `reviewer.py` can use the same
interface while each provider handles its own wire protocol.

Supported providers:
  - IdealabAnthropicProvider: Idealab Anthropic Messages API (claude-opus-4-6)
  - IdealabOpenAIProvider: Idealab OpenAI-compatible Qwen 3.8 streaming API
"""

import json
import re
import sys
from typing import Protocol


class ChatProvider(Protocol):
    """Protocol for all providers.

    Each implementation exposes ``build_headers()``, ``build_payload()``,
    ``request_path``, and response extraction methods.
    """

    ...


class BaseProvider:
    base_url: str
    api_key: str
    model: str
    max_tokens: int
    request_path: str  # "/v1/messages" or "/chat/completions"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int = 16384,
    ):
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.max_tokens = max_tokens

    def build_headers(self) -> dict:
        raise NotImplementedError("Subclasses must implement build_headers")

    def build_payload(self, messages: list, spec: dict) -> dict:
        raise NotImplementedError("Subclasses must implement build_payload")

    def extract_content(self, response: dict) -> str:
        raise NotImplementedError("Subclasses must implement extract_content")

    async def send_chat(self, client, messages: list, spec: dict) -> str:
        """Send a non-streaming chat request and return its response content.

        Providers requiring streaming override this method.
        """
        url = f"{self.base_url.rstrip('/')}{self.request_path}"
        headers = self.build_headers()
        payload = self.build_payload(messages, spec)
        timeout = spec.get("timeout", 120.0)
        response = await client.post(
            url=url,
            json=payload,
            headers=headers,
            timeout=timeout,
        )
        response.raise_for_status()
        return self.extract_content(response.json())


class IdealabAnthropicProvider(BaseProvider):
    """Idealab Anthropic Messages API provider (claude-opus-4-6)."""

    request_path = "/v1/messages"

    def build_headers(self) -> dict:
        return {
            "x-api-key": self.api_key,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "user-agent": "claude-cli/2.1.156 (external, sdk-cli)",
        }

    def build_payload(self, messages: list, spec: dict) -> dict:
        """Build an Anthropic Messages API payload.

        Anthropic uses a separate ``system`` field at payload top level rather
        than a system message in the messages array.
        """
        system = ""
        user_messages = []
        for message in messages:
            if message.get("role") == "system":
                system = message.get("content", "")
            else:
                user_messages.append(message)

        max_tokens = spec.get("max_tokens", self.max_tokens)
        payload: dict = {
            "model": self.model,
            "messages": user_messages,
        }
        if max_tokens > 0:
            payload["max_tokens"] = max_tokens
        if system:
            payload["system"] = system
        return payload

    def extract_content(self, response: dict) -> str:
        """Extract text from an Anthropic Messages API response."""
        content = response.get("content")
        if not isinstance(content, list) or not content:
            raise RuntimeError("idealab-anthropic response has no content")
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                return text
            raise RuntimeError("idealab-anthropic response has empty text")
        raise RuntimeError("idealab-anthropic response has no text block")

    async def extract_stream_content(self, chunks):
        raise NotImplementedError(
            "idealab-anthropic streaming not required by external-llm-review"
        )


class IdealabOpenAIProvider(BaseProvider):
    """Idealab Qwen 3.8 OpenAI-compatible provider using streaming completions."""

    request_path = "/chat/completions"

    def build_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "content-type": "application/json",
        }

    def build_payload(self, messages: list, spec: dict) -> dict:
        max_tokens = spec.get("max_tokens", self.max_tokens)
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": spec.get("temperature", 0.2),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if max_tokens > 0:
            payload["max_tokens"] = max_tokens
        return payload

    def extract_content(self, response: dict) -> str:
        """Extract content, falling back to reasoning content when necessary."""
        choices = response.get("choices") or []
        if not choices:
            raise RuntimeError("idealab-openai response has no choices")
        message = choices[0].get("message") or {}
        content = message.get("content") or message.get("reasoning_content") or ""
        if content:
            return content
        raise RuntimeError(
            "idealab-openai response returned empty content"
            f" finish_reason={choices[0].get('finish_reason')}"
        )

    async def send_chat(self, client, messages: list, spec: dict) -> str:
        """Send a streaming chat request and return aggregated response text."""
        url = f"{self.base_url.rstrip('/')}{self.request_path}"
        headers = self.build_headers()
        payload = self.build_payload(messages, spec)
        timeout = spec.get("timeout", 120.0)

        async with client.stream(
            "POST",
            url,
            json=payload,
            headers=headers,
            timeout=timeout,
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                response.raise_for_status()
            chunks = self._parse_sse(response.aiter_lines())
            return await self.extract_stream_content(chunks)

    async def _parse_sse(self, lines):
        """Parse Server-Sent Events and surface provider error events."""
        async for line in lines:
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].lstrip()
            if data == "[DONE]":
                return
            try:
                event = json.loads(data)
            except json.JSONDecodeError:
                print("[idealab-openai] WARN: skipping malformed SSE event", file=sys.stderr)
                continue
            if isinstance(event, dict) and event.get("error"):
                raise RuntimeError(_format_sse_error(event["error"]))
            yield event

    async def extract_stream_content(self, chunks) -> str:
        """Aggregate SSE deltas, preferring content over reasoning content."""
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        async for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            if delta.get("content"):
                content_parts.append(delta["content"])
            if delta.get("reasoning_content"):
                reasoning_parts.append(delta["reasoning_content"])

        content = "".join(content_parts) or "".join(reasoning_parts)
        if content:
            return content
        raise RuntimeError("idealab-openai stream response returned empty content")


_SAFE_SSE_DIAGNOSTIC = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

_PROVIDER_CLASSES: dict[tuple[str, str], type[BaseProvider]] = {
    (
        "https://idealab.alibaba-inc.com/api/anthropic",
        "claude-opus-4-6",
    ): IdealabAnthropicProvider,
    (
        "https://idealab.alibaba-inc.com/api/openai/v1",
        "qwen3.8-max",
    ): IdealabOpenAIProvider,
}


def _format_sse_error(error) -> str:
    """Return only stable, non-sensitive diagnostics from an SSE error."""
    diagnostics = ["idealab-openai stream error event"]
    if not isinstance(error, dict):
        return diagnostics[0]
    for field in ("code", "type", "param"):
        value = error.get(field)
        if isinstance(value, str) and _SAFE_SSE_DIAGNOSTIC.fullmatch(value):
            diagnostics.append(f"{field}={value}")
    return " ".join(diagnostics)


def build_provider(
    *,
    base_url: str,
    api_key: str,
    model: str,
    max_tokens: int = 16384,
) -> BaseProvider:
    """Pick a provider from the exact, approved Idealab endpoint/model pairs."""
    cls = (
        _PROVIDER_CLASSES.get((base_url, model))
        if isinstance(base_url, str) and isinstance(model, str)
        else None
    )
    if cls is None:
        raise ValueError("unsupported provider endpoint")
    return cls(
        base_url=base_url,
        api_key=api_key,
        model=model,
        max_tokens=max_tokens,
    )
