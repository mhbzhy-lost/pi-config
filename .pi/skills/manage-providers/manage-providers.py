#!/usr/bin/env python3
"""
Manage custom providers and models in pi's models.json and auth.json.

Usage:
  manage-providers.py list
  manage-providers.py add-provider <name> --api <type> --base-url <url> [--auth-header] [--key <key>] [options...]
  manage-providers.py remove-provider <name>
  manage-providers.py add-model <provider> --id <id> --context <tokens> --max-tokens <tokens> [options...]
  manage-providers.py remove-model <provider> <model-id>
  manage-providers.py set-key <provider> <key>
"""

import json
import sys
import os
from pathlib import Path
from argparse import ArgumentParser, RawDescriptionHelpFormatter


def get_agent_dir():
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent")


def load_models_json():
    path = get_agent_dir() / "models.json"
    if not path.exists():
        return {"providers": {}}
    return json.loads(path.read_text())


def save_models_json(config):
    path = get_agent_dir() / "models.json"
    path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")


def load_auth_json():
    path = get_agent_dir() / "auth.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_auth_json(auth):
    path = get_agent_dir() / "auth.json"
    path.write_text(json.dumps(auth, indent=2, ensure_ascii=False) + "\n")


def cmd_list(args):
    config = load_models_json()
    auth = load_auth_json()
    providers = config.get("providers", {})

    if not providers:
        print("No custom providers configured.")
        return

    for name, provider in providers.items():
        has_key = "✓" if name in auth else "✗"
        api = provider.get("api", "?")
        base_url = provider.get("baseUrl", "?")
        models = provider.get("models", [])
        print(f"\n[{name}] api={api} key={has_key}")
        print(f"  baseUrl: {base_url}")
        if provider.get("headers"):
            for k, v in provider["headers"].items():
                print(f"  header: {k}: {v}")
        if provider.get("metadataUserId"):
            print(f"  metadataUserId: {provider['metadataUserId']}")
        if provider.get("compat"):
            compat_keys = [k for k, v in provider["compat"].items() if v]
            if compat_keys:
                print(f"  compat: {', '.join(compat_keys)}")
        for m in models:
            actual = f" → {m['actualModelId']}" if m.get("actualModelId") else ""
            ctx = m.get("contextWindow", "?")
            max_t = m.get("maxTokens", "?")
            reasoning = " reasoning" if m.get("reasoning") else ""
            inputs = ",".join(m.get("input", ["text"]))
            print(f"  • {m['id']}{actual} ({ctx} ctx, {max_t} out, {inputs}{reasoning})")


def cmd_add_provider(args):
    config = load_models_json()
    providers = config.setdefault("providers", {})

    if args.name in providers:
        print(f"Error: provider '{args.name}' already exists. Remove it first.", file=sys.stderr)
        sys.exit(1)

    provider = {
        "baseUrl": args.base_url,
        "api": args.api,
    }

    if args.auth_header:
        provider["authHeader"] = True

    if args.metadata_user_id:
        provider["metadataUserId"] = args.metadata_user_id

    if args.header:
        headers = {}
        for h in args.header:
            k, _, v = h.partition(":")
            headers[k.strip()] = v.strip()
        if headers:
            provider["headers"] = headers

    if args.compat:
        compat = {}
        for c in args.compat:
            k, _, v = c.partition("=")
            if v.lower() in ("true", "1", "yes"):
                compat[k] = True
            elif v.lower() in ("false", "0", "no"):
                compat[k] = False
            else:
                compat[k] = v
        if compat:
            provider["compat"] = compat

    provider["models"] = []
    providers[args.name] = provider
    save_models_json(config)

    if args.key:
        auth = load_auth_json()
        auth[args.name] = {"type": "api_key", "key": args.key}
        save_auth_json(auth)

    print(f"Added provider '{args.name}' (api={args.api})")
    if args.key:
        print(f"  API key configured in auth.json")


def cmd_remove_provider(args):
    config = load_models_json()
    providers = config.get("providers", {})

    if args.name not in providers:
        print(f"Error: provider '{args.name}' not found.", file=sys.stderr)
        sys.exit(1)

    del providers[args.name]
    save_models_json(config)

    auth = load_auth_json()
    if args.name in auth:
        del auth[args.name]
        save_auth_json(auth)
        print(f"Removed provider '{args.name}' (auth key also removed)")
    else:
        print(f"Removed provider '{args.name}'")


def cmd_add_model(args):
    config = load_models_json()
    providers = config.get("providers", {})

    if args.provider not in providers:
        print(f"Error: provider '{args.provider}' not found.", file=sys.stderr)
        sys.exit(1)

    provider = providers[args.provider]
    models = provider.setdefault("models", [])

    if any(m["id"] == args.id for m in models):
        print(f"Error: model '{args.id}' already exists in provider '{args.provider}'.", file=sys.stderr)
        sys.exit(1)

    model = {
        "id": args.id,
        "name": args.name or args.id,
    }

    if args.actual_model_id:
        model["actualModelId"] = args.actual_model_id

    if args.reasoning:
        model["reasoning"] = True

    model["input"] = args.input.split(",") if args.input else ["text"]
    model["contextWindow"] = args.context
    model["maxTokens"] = args.max_tokens

    models.append(model)
    save_models_json(config)
    print(f"Added model '{args.id}' to provider '{args.provider}'")


def cmd_remove_model(args):
    config = load_models_json()
    providers = config.get("providers", {})

    if args.provider not in providers:
        print(f"Error: provider '{args.provider}' not found.", file=sys.stderr)
        sys.exit(1)

    provider = providers[args.provider]
    models = provider.get("models", [])
    original_len = len(models)
    provider["models"] = [m for m in models if m["id"] != args.model_id]

    if len(provider["models"]) == original_len:
        print(f"Error: model '{args.model_id}' not found in provider '{args.provider}'.", file=sys.stderr)
        sys.exit(1)

    save_models_json(config)
    print(f"Removed model '{args.model_id}' from provider '{args.provider}'")


def cmd_set_key(args):
    auth = load_auth_json()
    auth[args.provider] = {"type": "api_key", "key": args.key}
    save_auth_json(auth)
    print(f"Updated API key for provider '{args.provider}'")


def main():
    parser = ArgumentParser(
        description="Manage pi custom providers and models",
        formatter_class=RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    # list
    sub.add_parser("list", help="List all custom providers and models")

    # add-provider
    ap = sub.add_parser("add-provider", help="Add a new provider")
    ap.add_argument("name", help="Provider name (e.g. anthropic-idealab)")
    ap.add_argument("--api", required=True, help="API type (anthropic-messages, openai-completions, etc.)")
    ap.add_argument("--base-url", required=True, help="Base URL for the provider")
    ap.add_argument("--auth-header", action="store_true", help="Use Authorization: Bearer header")
    ap.add_argument("--key", help="API key (stored in auth.json)")
    ap.add_argument("--header", action="append", help="Custom header (key:value), can repeat")
    ap.add_argument("--metadata-user-id", help="Anthropic metadata.user_id to inject")
    ap.add_argument("--compat", action="append", help="Compat option (key=value), can repeat")

    # remove-provider
    rp = sub.add_parser("remove-provider", help="Remove a provider and its auth")
    rp.add_argument("name", help="Provider name to remove")

    # add-model
    am = sub.add_parser("add-model", help="Add a model to a provider")
    am.add_argument("provider", help="Provider name")
    am.add_argument("--id", required=True, help="Model ID")
    am.add_argument("--name", help="Display name (defaults to id)")
    am.add_argument("--actual-model-id", help="Actual model ID sent to API (for rewriting)")
    am.add_argument("--context", type=int, required=True, help="Context window size in tokens")
    am.add_argument("--max-tokens", type=int, required=True, help="Max output tokens")
    am.add_argument("--reasoning", action="store_true", help="Enable reasoning/thinking")
    am.add_argument("--input", default="text", help="Input types, comma-separated (default: text)")

    # remove-model
    rm = sub.add_parser("remove-model", help="Remove a model from a provider")
    rm.add_argument("provider", help="Provider name")
    rm.add_argument("model_id", help="Model ID to remove")

    # set-key
    sk = sub.add_parser("set-key", help="Set or update API key for a provider")
    sk.add_argument("provider", help="Provider name")
    sk.add_argument("key", help="API key")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "list": cmd_list,
        "add-provider": cmd_add_provider,
        "remove-provider": cmd_remove_provider,
        "add-model": cmd_add_model,
        "remove-model": cmd_remove_model,
        "set-key": cmd_set_key,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
