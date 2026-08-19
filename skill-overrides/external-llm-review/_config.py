"""YAML-backed configuration loader for external-llm-review providers.

Each provider is defined by a YAML file under ``providers/`` that contains
non-secret configuration (base_url, model, max_tokens, provider-specific
fields). Secrets are injected at runtime via ``${ENV_VAR}`` placeholders
that are replaced with values from environment variables -- typically
populated from the skill's ``.env`` by ``python-dotenv`` before calling
this module.

Public API:
    load_provider_config(name, providers_dir=?, env=os.environ) -> dict
        Loads a YAML, interpolates ${VAR} references, raises on unresolved.

    get_provider(name, providers_dir=?, env=os.environ) -> BaseProvider
        Constructs the appropriate provider instance based on the "provider"
        field in the YAML (idealab-anthropic | idealab-openai).

    DEFAULT_PROVIDERS_DIR: Path
        Resolved at import time to this skill's bundled ``providers/`` dir.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

from _provider import (
    BaseProvider,
    IdealabAnthropicProvider,
    IdealabOpenAIProvider,
    build_provider,
)

DEFAULT_PROVIDERS_DIR = Path(__file__).resolve().parent / "providers"

_PLACEHOLDER_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}", re.IGNORECASE)

_PROVIDER_CLS: dict[str, type[BaseProvider]] = {
    "idealab-anthropic": IdealabAnthropicProvider,
    "idealab-openai": IdealabOpenAIProvider,
}

_IDEALAB_OPENAI_KEY = "IDEALAB_OPENAI_API_KEY"


def _interpolate(value: Any, env: dict[str, str], path: list[str]) -> Any:
    if isinstance(value, str):
        missing: list[str] = []

        def replace(match: re.Match[str]) -> str:
            name = match.group(1)
            if not env.get(name):
                missing.append(name)
                return match.group(0)
            return env[name]

        resolved = _PLACEHOLDER_RE.sub(replace, value)
        if missing:
            raise RuntimeError(
                f"unresolved env var(s) in {('.'.join(path) or '<root>')}: "
                f"{', '.join(missing)}"
            )
        return resolved
    if isinstance(value, dict):
        return {key: _interpolate(item, env, [*path, key]) for key, item in value.items()}
    if isinstance(value, list):
        return [
            _interpolate(item, env, [*path, f"[{index}]"])
            for index, item in enumerate(value)
        ]
    return value


def _resolve_idealab_openai_pi_auth(env: dict[str, str]) -> str | None:
    """Prefer Pi-managed Idealab OpenAI auth without exposing command output."""
    command = [
        env.get("PI_REAL_BIN") or "pi",
        "auth",
        "print-api-key",
        "--provider",
        "openai-idealab",
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "timeout"
    except OSError:
        return "could-not-execute"
    if result.returncode != 0:
        return "nonzero-exit"
    key = result.stdout.strip()
    if not key:
        return "empty-output"
    env[_IDEALAB_OPENAI_KEY] = key
    return None


def load_provider_config(
    name: str,
    *,
    providers_dir: Path | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Load and interpolate a provider YAML.

    Args:
        name: Provider YAML basename without ".yaml".
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
    with path.open("r", encoding="utf-8") as file:
        raw = yaml.safe_load(file) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"Provider config {path} must contain a mapping at top level")

    resolved_env = dict(os.environ) if env is None else dict(env)
    if name == "idealab-openai" and raw.get("api_key") == "${IDEALAB_OPENAI_API_KEY}":
        failure = _resolve_idealab_openai_pi_auth(resolved_env)
        if failure and not resolved_env.get(_IDEALAB_OPENAI_KEY):
            raise RuntimeError(
                "idealab-openai Pi auth lookup "
                f"{failure}; {_IDEALAB_OPENAI_KEY} fallback unavailable"
            )
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
    if kind is None:
        raise ValueError(f"Provider config {name!r} missing required 'provider' field")
    if kind not in _PROVIDER_CLS:
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
    provider = build_provider(**kwargs)
    if not isinstance(provider, cls):
        raise ValueError("provider kind mismatch")
    return provider
