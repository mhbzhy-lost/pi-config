"""YAML-backed configuration loader for external-llm-review providers.

Each provider is defined by a YAML file under ``providers/`` that contains
non-secret configuration (base_url, model, max_tokens, provider-specific
fields). Secrets are injected at runtime via ``${ENV_VAR}`` placeholders
that are replaced with values from environment variables — typically
populated from the skill's ``.env`` by ``python-dotenv`` before calling
this module.

Public API:
    load_provider_config(name, providers_dir=?, env=os.environ) -> dict
        Loads a YAML, interpolates ${VAR} references, raises on unresolved.

    get_provider(name, providers_dir=?, env=os.environ) -> BaseProvider
        Constructs the appropriate provider instance based on the "provider"
        field in the YAML (idealab-anthropic | idealab-openai | bailian).

    DEFAULT_PROVIDERS_DIR: Path
        Resolved at import time to this skill's bundled ``providers/`` dir.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml

from _provider import (
    BailianProvider,
    BaseProvider,
    IdealabAnthropicProvider,
    IdealabOpenAIProvider,
)

DEFAULT_PROVIDERS_DIR = Path(__file__).resolve().parent / "providers"

_PLACEHOLDER_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}", re.IGNORECASE)

_PROVIDER_CLS: dict[str, type[BaseProvider]] = {
    "idealab-anthropic": IdealabAnthropicProvider,
    "idealab-openai": IdealabOpenAIProvider,
    "bailian": BailianProvider,
    "deepseek": IdealabOpenAIProvider,
}


def _interpolate(value: Any, env: dict[str, str], path: list[str]) -> Any:
    if isinstance(value, str):
        missing: list[str] = []

        def repl(match: "re.Match[str]") -> str:
            name = match.group(1)
            if name not in env or env[name] == "":
                missing.append(name)
                return match.group(0)
            return env[name]

        new = _PLACEHOLDER_RE.sub(repl, value)
        if missing:
            raise RuntimeError(
                f"unresolved env var(s) in {('.'.join(path) or '<root>')}: "
                f"{', '.join(missing)}"
            )
        return new
    if isinstance(value, dict):
        return {k: _interpolate(v, env, [*path, k]) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v, env, [*path, f"[{i}]"]) for i, v in enumerate(value)]
    return value


def load_provider_config(
    name: str,
    *,
    providers_dir: Path | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Load and interpolate a provider YAML.

    Args:
        name: Provider YAML basename without ".yaml" (e.g. "bailian").
        providers_dir: Directory containing provider YAMLs. Defaults to
            ``<skill-dir>/providers``.
        env: Environment mapping for placeholder substitution. Defaults to
            ``os.environ``.
    """
    directory = Path(providers_dir) if providers_dir is not None else DEFAULT_PROVIDERS_DIR
    path = directory / f"{name}.yaml"
    if not path.is_file():
        raise FileNotFoundError(
            f"Provider config {name!r} not found at {path}"
        )
    with path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"Provider config {path} must contain a mapping at top level")
    resolved_env = dict(os.environ) if env is None else env
    return _interpolate(raw, resolved_env, [])


def get_provider(
    name: str,
    *,
    providers_dir: Path | None = None,
    env: dict[str, str] | None = None,
) -> BaseProvider:
    """Build a provider instance from the named YAML configuration."""
    cfg = load_provider_config(name, providers_dir=providers_dir, env=env)
    kind = cfg.get("provider")
    if not kind or kind not in _PROVIDER_CLS:
        raise ValueError(
            f"Unknown provider type {kind!r}"
            f" (allowed: {', '.join(sorted(_PROVIDER_CLS))})"
        )
    cls = _PROVIDER_CLS[kind]
    kwargs: dict[str, Any] = {
        "base_url": cfg["base_url"],
        "api_key": cfg["api_key"],
        "model": cfg["model"],
        "max_tokens": int(cfg.get("max_tokens", 16384)),
    }
    if cls is BailianProvider:
        if "enable_thinking" in cfg:
            kwargs["enable_thinking"] = bool(cfg["enable_thinking"])
        if "thinking_budget" in cfg:
            kwargs["thinking_budget"] = int(cfg["thinking_budget"])
    return cls(**kwargs)
