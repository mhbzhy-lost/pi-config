#!/usr/bin/env python3
"""Manage non-sensitive provider/model definitions and securely enter credentials."""

import getpass
import json
import os
import re
import secrets
import sys
import time
from argparse import ArgumentParser, RawDescriptionHelpFormatter
from contextlib import contextmanager
from pathlib import Path

SENSITIVE_HEADERS = {"authorization", "proxyauthorization", "cookie", "setcookie", "xapikey", "apikey"}


class SafeArgumentParser(ArgumentParser):
    """Do not echo rejected arguments: they may be mistakenly supplied credentials."""
    def error(self, message):
        self.exit(2, "Error: invalid command arguments.\n")


def get_agent_dir():
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent")


def _json_text(value):
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def _atomic_write(path, text, mode=None):
    """Write in the target directory, fsync, then atomically replace the target."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if mode else 0o666)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(temp, mode)
        os.replace(temp, path)
        if mode is not None:
            os.chmod(path, mode)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass  # A filesystem without directory fsync still received an atomic replace.
    except BaseException:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
        raise


@contextmanager
def _models_lock():
    directory = get_agent_dir()
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / ".models.json.lock"
    deadline = time.monotonic() + 10
    while True:
        try:
            fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise RuntimeError("models.json is busy; no changes were written")
            time.sleep(0.05)
    try:
        os.write(fd, str(os.getpid()).encode())
        yield
    finally:
        os.close(fd)
        try:
            os.unlink(lock)
        except FileNotFoundError:
            pass


def load_models_json():
    path = get_agent_dir() / "models.json"
    return json.loads(path.read_text()) if path.exists() else {"providers": {}}


def _save_models_json(config):
    _atomic_write(get_agent_dir() / "models.json", _json_text(config))


def save_models_json(config):
    with _models_lock():
        _save_models_json(config)


def load_auth_json():
    path = get_agent_dir() / "auth.json"
    return json.loads(path.read_text()) if path.exists() else {}


def save_auth_json(auth):
    _atomic_write(get_agent_dir() / "auth.json", _json_text(auth), 0o600)


def _update_models(change):
    with _models_lock():
        config = load_models_json()
        change(config)
        _save_models_json(config)


def _sensitive_header(name):
    return name.lower().replace("-", "").replace("_", "") in SENSITIVE_HEADERS


def _sensitive_header_value(value):
    """Reject credential-like header values before they reach models.json."""
    value = value.strip()
    if re.match(r"(?i)^(bearer|basic)\s+\S+", value):
        return True
    if re.match(r"(?i)^(?:sk|pk|rk|api[-_]?key|secret|token|key)[-_]", value):
        return True
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{32,}", value))


def cmd_list(args):
    providers = load_models_json().get("providers", {})
    if not providers:
        print("No custom providers configured.")
        return
    for name, provider in providers.items():
        print(f"\n[{name}] api={provider.get('api', '?')}")
        print(f"  baseUrl: {provider.get('baseUrl', '?')}")
        for key in provider.get("headers", {}):
            print(f"  header: {key}: [redacted]")
        if provider.get("metadataUserId"):
            print(f"  metadataUserId: {provider['metadataUserId']}")
        for model in provider.get("models", []):
            actual = f" → {model['actualModelId']}" if model.get("actualModelId") else ""
            print(f"  • {model['id']}{actual} ({model.get('contextWindow', '?')} ctx, {model.get('maxTokens', '?')} out)")


def cmd_add_provider(args):
    headers = {}
    for header in args.header or []:
        key, separator, value = header.partition(":")
        key = key.strip()
        if not separator or not key:
            raise ValueError("--header must use key:value")
        if _sensitive_header(key):
            raise ValueError("sensitive header must not be stored in models.json")
        if _sensitive_header_value(value):
            raise ValueError("sensitive header value must not be stored in models.json")
        headers[key] = value.strip()

    def change(config):
        providers = config.setdefault("providers", {})
        if args.name in providers:
            raise ValueError(f"provider '{args.name}' already exists. Remove it first.")
        provider = {"baseUrl": args.base_url, "api": args.api, "models": []}
        if args.auth_header:
            provider["authHeader"] = True
        if args.metadata_user_id:
            provider["metadataUserId"] = args.metadata_user_id
        if headers:
            provider["headers"] = headers
        if args.compat:
            provider["compat"] = {k: (v.lower() in ("true", "1", "yes") if v.lower() in ("true", "1", "yes", "false", "0", "no") else v)
                                  for k, _, v in (item.partition("=") for item in args.compat)}
        providers[args.name] = provider
    _update_models(change)
    print(f"Added provider '{args.name}' (api={args.api})")


def cmd_remove_provider(args):
    if args.confirm != args.name:
        raise ValueError("removal requires --confirm with the exact provider name")
    # Validate before changing auth, then roll it back if models replacement fails.
    config = load_models_json()
    if args.name not in config.get("providers", {}):
        raise ValueError(f"provider '{args.name}' not found")
    auth_path = get_agent_dir() / "auth.json"
    old_auth_text = auth_path.read_text() if auth_path.exists() else None
    auth = load_auth_json()
    had_auth = args.name in auth
    if had_auth:
        del auth[args.name]
        save_auth_json(auth)
    try:
        def change(current):
            del current["providers"][args.name]
        _update_models(change)
    except BaseException as error:
        if had_auth and old_auth_text is not None:
            _atomic_write(auth_path, old_auth_text, 0o600)
        raise RuntimeError(f"provider removal failed; auth rollback {'completed' if had_auth else 'not needed'}: {error}") from error
    print(f"Removed provider '{args.name}'" + (" (credential entry also removed)" if had_auth else ""))


def cmd_add_model(args):
    def change(config):
        providers = config.get("providers", {})
        if args.provider not in providers:
            raise ValueError(f"provider '{args.provider}' not found")
        models = providers[args.provider].setdefault("models", [])
        if any(model["id"] == args.id for model in models):
            raise ValueError(f"model '{args.id}' already exists in provider '{args.provider}'")
        model = {"id": args.id, "name": args.name or args.id, "input": args.input.split(","), "contextWindow": args.context, "maxTokens": args.max_tokens}
        if args.actual_model_id: model["actualModelId"] = args.actual_model_id
        if args.reasoning: model["reasoning"] = True
        models.append(model)
    _update_models(change)
    print(f"Added model '{args.id}' to provider '{args.provider}'")


def cmd_remove_model(args):
    if args.confirm != args.model_id:
        raise ValueError("removal requires --confirm with the exact model id")

    def change(config):
        providers = config.get("providers", {})
        if args.provider not in providers:
            raise ValueError(f"provider '{args.provider}' not found")
        models = providers[args.provider].get("models", [])
        remaining = [model for model in models if model["id"] != args.model_id]
        if len(remaining) == len(models):
            raise ValueError(f"model '{args.model_id}' not found in provider '{args.provider}'")
        providers[args.provider]["models"] = remaining
    _update_models(change)
    print(f"Removed model '{args.model_id}' from provider '{args.provider}'")


def _read_key_from_tty():
    try:
        with open("/dev/tty", "r+", encoding="utf-8") as tty:
            original_stdin = sys.stdin
            try:
                # getpass reads sys.stdin when a stream is supplied; bind both to /dev/tty.
                sys.stdin = tty
                key = getpass.getpass("API key (input hidden): ", stream=tty)
            finally:
                sys.stdin = original_stdin
    except OSError as error:
        raise RuntimeError("secure credential entry requires an interactive /dev/tty") from error
    if not key:
        raise ValueError("empty credential was not saved")
    return key


def cmd_set_key(args):
    key = _read_key_from_tty()
    auth = load_auth_json()
    auth[args.provider] = {"type": "api_key", "key": key}
    save_auth_json(auth)
    print(f"Updated credential for provider '{args.provider}'")


def main():
    parser = SafeArgumentParser(description="Manage non-sensitive pi provider and model definitions. Credentials require secure interactive entry.", formatter_class=RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("list", help="List non-sensitive custom provider and model definitions")
    ap = sub.add_parser("add-provider", help="Add a non-sensitive provider definition")
    ap.add_argument("name"); ap.add_argument("--api", required=True); ap.add_argument("--base-url", required=True)
    ap.add_argument("--auth-header", action="store_true"); ap.add_argument("--header", action="append")
    ap.add_argument("--metadata-user-id"); ap.add_argument("--compat", action="append")
    rp = sub.add_parser("remove-provider", help="Remove a provider definition and credential entry")
    rp.add_argument("name"); rp.add_argument("--confirm", required=True, help="Repeat the provider name to confirm deletion")
    am = sub.add_parser("add-model", help="Add a model")
    am.add_argument("provider"); am.add_argument("--id", required=True); am.add_argument("--name"); am.add_argument("--actual-model-id")
    am.add_argument("--context", type=int, required=True); am.add_argument("--max-tokens", type=int, required=True); am.add_argument("--reasoning", action="store_true"); am.add_argument("--input", default="text")
    rm = sub.add_parser("remove-model", help="Remove a model")
    rm.add_argument("provider"); rm.add_argument("model_id")
    rm.add_argument("--confirm", required=True, help="Repeat the model ID to confirm deletion")
    sk = sub.add_parser("set-key", help="Securely enter a credential from /dev/tty")
    sk.add_argument("provider", help="Provider name")
    args = parser.parse_args()
    if not args.command:
        parser.print_help(); return 1
    try:
        {"list": cmd_list, "add-provider": cmd_add_provider, "remove-provider": cmd_remove_provider, "add-model": cmd_add_model, "remove-model": cmd_remove_model, "set-key": cmd_set_key}[args.command](args)
    except (ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
