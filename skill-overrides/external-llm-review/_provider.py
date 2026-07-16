"""Provider abstraction for external LLM review.

Encapsulates provider-specific API quirks so `reviewer.py` can speak the
same wire protocol (OpenAI Chat Completions or Anthropic Messages) while
each provider handles its own non-standard parameters.

Three providers:
  - IdealabAnthropicProvider: Idealab Anthropic Messages API (claude-opus-4-6)
  - IdealabOpenAIProvider: Idealab OpenAI-compatible Chat Completions
  - BailianProvider: Bailian (DashScope) qwen3.7-max with non-standard
    extensions (enable_thinking, stream, thinking_budget, reasoning_content)
"""

import json
import sys
from typing import Protocol


class ChatProvider(Protocol):
    """Protocol for all providers. Each must expose:
      - build_headers()
      - build_payload(messages, spec)
      - request_path
      - extract_content(response_json) — for non-streaming
      - async extract_stream_content(chunks) — for streaming
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
        """Send a chat completion request and return the response content.

        Default implementation: non-streaming POST. Override for streaming.
        """
        url = f"{self.base_url.rstrip('/')}{self.request_path}"
        headers = self.build_headers()
        payload = self.build_payload(messages, spec)
        timeout = spec.get("timeout", 120.0)
        response = await client.post(url=url, json=payload, headers=headers, timeout=timeout)
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
        """Build Anthropic Messages API payload.

        Anthropic uses a separate `system` field at payload top-level, not
        a system message in the messages array. We extract the system message
        here so the caller can pass the full messages list.
        """
        system = ""
        user_messages = []
        for m in messages:
            if m.get("role") == "system":
                system = m.get("content", "")
            else:
                user_messages.append(m)

        payload: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": spec.get("temperature", 0.2),
            "messages": user_messages,
        }
        if system:
            payload["system"] = system
        return payload

    def extract_content(self, response: dict) -> str:
        """Extract text from Anthropic Messages API response.

        Response shape: `{"content": [{"type": "text", "text": "..."}]}`
        """
        content = response.get("content")
        if not content:
            raise RuntimeError(f"idealab-anthropic response has no content: {response}")
        for block in content:
            if block.get("type") == "text":
                return block.get("text", "")
        raise RuntimeError(f"idealab-anthropic response has no text block: {content}")

    async def extract_stream_content(self, chunks):
        raise NotImplementedError("idealab-anthropic streaming not required by external-llm-review")


class IdealabOpenAIProvider(BaseProvider):
    """Idealab OpenAI-compatible provider (standard Chat Completions)."""

    request_path = "/chat/completions"

    def build_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "content-type": "application/json",
        }

    def build_payload(self, messages: list, spec: dict) -> dict:
        return {
            "model": self.model,
            "messages": messages,
            "temperature": spec.get("temperature", 0.2),
            "max_tokens": self.max_tokens,
        }

    def extract_content(self, response: dict) -> str:
        choices = response.get("choices")
        if not choices:
            raise RuntimeError(f"idealab-openai response has no choices: {response}")
        message = choices[0].get("message") or {}
        content = message.get("content") or ""
        if content:
            return content
        raise RuntimeError(
            f"idealab-openai response returned empty content"
            f" finish_reason={choices[0].get('finish_reason')}"
            f" message={message}"
        )

    async def extract_stream_content(self, chunks):
        raise NotImplementedError("idealab-openai streaming not required by external-llm-review")


class BailianProvider(BaseProvider):
    """Qwen3.7-max (Bailian) provider.

    Bailian's OpenAI-compatible endpoint has non-standard extensions:
      - `enable_thinking` (bool): turn reasoning on/off
      - `thinking_budget` (int): cap reasoning tokens
      - `reasoning_content` in response: returned when thinking is enabled
      - Non-streaming calls have a hard 300s server-side timeout, so we
        force streaming (300s doesn't apply to streams).
    """

    request_path = "/chat/completions"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int = 16384,
        enable_thinking: bool = False,
        thinking_budget: int | None = None,
    ):
        super().__init__(
            base_url=base_url,
            api_key=api_key,
            model=model,
            max_tokens=max_tokens,
        )
        self.enable_thinking = enable_thinking
        self.thinking_budget = thinking_budget

    def build_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "content-type": "application/json",
        }

    def build_payload(self, messages: list, spec: dict) -> dict:
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": spec.get("temperature", 0.2),
            "enable_thinking": self.enable_thinking,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if self.max_tokens > 0:
            payload["max_tokens"] = self.max_tokens
        if self.thinking_budget is not None:
            payload["thinking_budget"] = self.thinking_budget
        return payload

    def extract_content(self, response: dict) -> str:
        choices = response.get("choices")
        if not choices:
            raise RuntimeError(f"Bailian response has no choices: {response}")
        message = choices[0].get("message") or {}
        content = message.get("content") or ""
        reasoning = message.get("reasoning_content") or ""
        if content:
            return content
        if reasoning:
            return reasoning
        raise RuntimeError(
            f"Bailian response returned empty content"
            f" finish_reason={choices[0].get('finish_reason')}"
            f" message={message}"
        )

    async def extract_stream_content(self, chunks) -> str:
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        finish_reason = None

        async for chunk in chunks:
            if not isinstance(chunk, dict):
                print(
                    f"[BailianProvider] WARN: skipping malformed SSE chunk: {chunk!r}",
                    file=sys.stderr,
                )
                continue
            choices = chunk.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            delta = choice.get("delta") or {}
            if delta.get("content"):
                content_parts.append(delta["content"])
            if delta.get("reasoning_content"):
                reasoning_parts.append(delta["reasoning_content"])
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]

        content = "".join(content_parts)
        if content:
            return content
        reasoning = "".join(reasoning_parts)
        if reasoning:
            return reasoning
        raise RuntimeError(
            f"Bailian stream response returned empty content"
            f" finish_reason={finish_reason!r}"
            f" reasoning_len={len(reasoning)}"
        )

    async def send_chat(self, client, messages: list, spec: dict) -> str:
        url = f"{self.base_url.rstrip('/')}{self.request_path}"
        headers = self.build_headers()
        payload = self.build_payload(messages, spec)
        timeout = spec.get("timeout", 120.0)

        async with client.stream(
            "POST", url, json=payload, headers=headers, timeout=timeout
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                response.raise_for_status()
            chunks = self._parse_stream_response(response.aiter_lines())
            return await self.extract_stream_content(chunks)

    async def _parse_stream_response(self, lines):
        """Parse Server-Sent Events stream from Bailian API."""
        async for line in lines:
            if not line or not line.startswith("data: "):
                continue
            data = line[6:]  # Strip "data: " prefix
            if data.strip() == "[DONE]":
                break
            try:
                chunk = json.loads(data)
                yield chunk
            except json.JSONDecodeError:
                print(
                    f"[BailianProvider] WARN: skipping unparseable SSE data: {data!r}",
                    file=sys.stderr,
                )
                continue


def build_provider(
    *,
    base_url: str,
    api_key: str,
    model: str,
    max_tokens: int = 16384,
) -> BaseProvider:
    """Factory: pick provider class by base_url heuristic.

    - Bailian: base_url contains "bailian"
    - Idealab Anthropic: base_url contains "idealab" AND "anthropic"
    - Idealab OpenAI: base_url contains "idealab" AND "openai"
    - Fallback: IdealabOpenAIProvider (most common OpenAI-compatible path)
    """
    lowered_url = base_url.lower()
    if "bailian" in lowered_url:
        return BailianProvider(
            base_url=base_url,
            api_key=api_key,
            model=model,
            max_tokens=max_tokens,
        )
    if "idealab" in lowered_url and "anthropic" in lowered_url:
        return IdealabAnthropicProvider(
            base_url=base_url,
            api_key=api_key,
            model=model,
            max_tokens=max_tokens,
        )
    if "idealab" in lowered_url and "openai" in lowered_url:
        return IdealabOpenAIProvider(
            base_url=base_url,
            api_key=api_key,
            model=model,
            max_tokens=max_tokens,
        )
    # Default fallback: treat as generic OpenAI-compatible via idealab path
    return IdealabOpenAIProvider(
        base_url=base_url,
        api_key=api_key,
        model=model,
        max_tokens=max_tokens,
    )
