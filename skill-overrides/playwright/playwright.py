#!/usr/bin/env python3
"""
Playwright MCP wrapper for pi skill.
Manages a persistent Playwright MCP server process, proxies via Unix socket.
Each start creates an independent browser instance automatically.

Usage:
  playwright.py start [--headless]   Start a new browser instance
  playwright.py call <tool> [args]   Call an MCP tool (auto-detects instance)
  playwright.py stop                 Stop the browser instance
  playwright.py status               Check running instance
  playwright.py tools                List available tools
  playwright.py instances            List all running instances
  playwright.py stopall              Stop all running instances
"""

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

BASE_STATE_DIR = Path(tempfile.gettempdir()) / "pi-playwright-mcp"
CLIENT_TIMEOUT = 60.0

_instance_name: str | None = None
_instance_explicit = False


def state_dir() -> Path:
    return BASE_STATE_DIR / _instance_name


def socket_path() -> Path:
    return state_dir() / "server.sock"


def pid_file() -> Path:
    return state_dir() / "daemon.pid"


def log_file() -> Path:
    return state_dir() / "daemon.log"


def mcp_pid_file() -> Path:
    return state_dir() / "mcp.pid"


def ensure_state_dir():
    state_dir().mkdir(parents=True, exist_ok=True)


def read_pid(path: Path) -> int | None:
    try:
        pid = int(path.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return None


def running_instances() -> list[tuple[str, int]]:
    """Return list of (instance_name, pid) for all running instances."""
    if not BASE_STATE_DIR.exists():
        return []
    results = []
    for d in sorted(BASE_STATE_DIR.iterdir()):
        if d.is_dir():
            pid = read_pid(d / "daemon.pid")
            if pid and (d / "server.sock").exists():
                results.append((d.name, pid))
    return results


def resolve_instance():
    """Auto-resolve instance when not explicitly specified."""
    global _instance_name
    if _instance_name is not None:
        return

    instances = running_instances()
    if len(instances) == 1:
        _instance_name = instances[0][0]
    elif len(instances) == 0:
        print("No running instances. Start one with: playwright.py start [--headless]", file=sys.stderr)
        sys.exit(1)
    else:
        print("Multiple instances running. Specify with --instance <name>:", file=sys.stderr)
        for name, pid in instances:
            print(f"  {name} (pid={pid})", file=sys.stderr)
        sys.exit(1)


def is_running() -> bool:
    return read_pid(pid_file()) is not None and socket_path().exists()


def do_status():
    resolve_instance()
    pid = read_pid(pid_file())
    if pid and socket_path().exists():
        print(f"Running (instance={_instance_name}, pid={pid})")
    else:
        print(f"Not running (instance={_instance_name})")


def do_start(headless: bool = False):
    global _instance_name

    if _instance_name is None:
        _instance_name = uuid.uuid4().hex[:8]

    ensure_state_dir()

    if is_running():
        print(f"Already running (instance={_instance_name})")
        return

    cmd = [sys.executable, __file__, "_daemon", "--instance", _instance_name]
    if headless:
        cmd.append("--headless")

    log = open(log_file(), "a")
    proc = subprocess.Popen(
        cmd,
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    pid_file().write_text(str(proc.pid))

    for _ in range(50):
        if socket_path().exists():
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(str(socket_path()))
                s.close()
                print(f"Started (instance={_instance_name}, pid={proc.pid}, headless={headless})")
                return
            except (ConnectionRefusedError, FileNotFoundError):
                pass
        time.sleep(0.1)

    print(f"Failed to start (check log: {log_file()})", file=sys.stderr)
    sys.exit(1)


def do_stop():
    resolve_instance()
    pid = read_pid(pid_file())
    if pid:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    for f in [pid_file(), socket_path(), mcp_pid_file()]:
        f.unlink(missing_ok=True)

    try:
        state_dir().rmdir()
    except OSError:
        pass

    print(f"Stopped (instance={_instance_name})")


def do_stopall():
    """Stop all running instances."""
    instances = running_instances()
    if not instances:
        print("No running instances")
        return
    for name, pid in instances:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        d = BASE_STATE_DIR / name
        for f in ["daemon.pid", "server.sock", "mcp.pid"]:
            (d / f).unlink(missing_ok=True)
        try:
            d.rmdir()
        except OSError:
            pass
        print(f"  Stopped {name} (pid={pid})")


def send_request(req: dict, timeout: float = CLIENT_TIMEOUT) -> dict:
    if not is_running():
        print("Server not running. Start with: playwright.py start [--headless]", file=sys.stderr)
        sys.exit(1)

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(str(socket_path()))

    try:
        payload = json.dumps(req) + "\n"
        s.sendall(payload.encode("utf-8"))

        data = b""
        while b"\n" not in data:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk

        return json.loads(data.decode("utf-8").strip())
    finally:
        s.close()


def do_call(tool_name: str, args_json: str = "{}"):
    resolve_instance()

    try:
        args = json.loads(args_json)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON args: {e}", file=sys.stderr)
        sys.exit(1)

    req = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": args},
        "id": int(time.time() * 1000) % 1000000,
    }

    result = send_request(req)

    if "error" in result:
        print(json.dumps(result["error"], indent=2, ensure_ascii=False))
        sys.exit(1)

    content = result.get("result", {}).get("content", [])
    if content:
        texts = []
        for item in content:
            if item.get("type") == "text":
                texts.append(item["text"])
            elif item.get("type") == "image":
                texts.append(f"[image: {item.get('mimeType', 'image')}]")
        print("\n".join(texts))
    else:
        print(json.dumps(result.get("result", {}), indent=2, ensure_ascii=False))


def do_tools():
    resolve_instance()
    req = {"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 1}
    result = send_request(req)
    tools = result.get("result", {}).get("tools", [])
    for t in tools:
        desc = t["description"][:80]
        print(f"  {t['name']:30s} {desc}")


def run_daemon(headless: bool):
    """Daemon: manages MCP subprocess and proxies via Unix socket with threads."""
    ensure_state_dir()
    socket_path().unlink(missing_ok=True)

    mcp_cmd = ["npx", "-y", "@playwright/mcp"]
    if headless:
        mcp_cmd.append("--headless")

    mcp = subprocess.Popen(
        mcp_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    mcp_pid_file().write_text(str(mcp.pid))

    init_req = json.dumps({
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "pi-playwright-skill", "version": "1.0"},
        },
        "id": 0,
    }) + "\n"
    mcp.stdin.write(init_req.encode())
    mcp.stdin.flush()

    init_resp = mcp.stdout.readline().decode().strip()
    print(f"MCP initialized: {init_resp}", flush=True)

    notif = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
    mcp.stdin.write(notif.encode())
    mcp.stdin.flush()

    stdin_lock = threading.Lock()
    pending = {}
    pending_lock = threading.Lock()

    def read_mcp_stdout():
        """Read MCP responses and dispatch to waiting clients."""
        for line in mcp.stdout:
            line = line.decode().strip()
            if not line:
                continue
            try:
                resp = json.loads(line)
            except json.JSONDecodeError:
                continue

            resp_id = resp.get("id")
            if resp_id is None:
                continue

            with pending_lock:
                conn = pending.pop(resp_id, None)

            if conn:
                try:
                    conn.sendall((json.dumps(resp) + "\n").encode())
                    conn.close()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

    reader_thread = threading.Thread(target=read_mcp_stdout, daemon=True)
    reader_thread.start()

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path()))
    server.listen(5)
    server.settimeout(1.0)
    print(f"Listening on {socket_path()} (instance={_instance_name})", flush=True)

    def handle_client(conn):
        """Read request from client, forward to MCP stdin."""
        try:
            data = b""
            conn.settimeout(CLIENT_TIMEOUT)
            while b"\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk

            if not data.strip():
                conn.close()
                return

            req = json.loads(data.decode().strip())
            req_id = req.get("id", int(time.time() * 1000))
            req["id"] = req_id

            with pending_lock:
                pending[req_id] = conn

            with stdin_lock:
                mcp.stdin.write((json.dumps(req) + "\n").encode())
                mcp.stdin.flush()

        except (json.JSONDecodeError, ConnectionResetError, OSError):
            conn.close()

    try:
        while mcp.poll() is None:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue

            t = threading.Thread(target=handle_client, args=(conn,), daemon=True)
            t.start()

    finally:
        server.close()
        socket_path().unlink(missing_ok=True)
        mcp.terminate()
        try:
            mcp.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mcp.kill()


def parse_instance(argv: list[str]) -> list[str]:
    """Extract --instance <name> from argv, set global, return remaining args."""
    global _instance_name, _instance_explicit
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--instance" and i + 1 < len(argv):
            _instance_name = argv[i + 1]
            _instance_explicit = True
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    return rest


def do_list_instances():
    """List all running instances."""
    instances = running_instances()
    if not instances:
        print("No running instances")
        return
    for name, pid in instances:
        print(f"  {name} (pid={pid})")


def main():
    argv = parse_instance(sys.argv[1:])

    if len(argv) < 1:
        print(__doc__)
        sys.exit(1)

    cmd = argv[0]

    if cmd == "start":
        headless = "--headless" in argv
        do_start(headless)
    elif cmd == "stop":
        do_stop()
    elif cmd == "stopall":
        do_stopall()
    elif cmd == "status":
        do_status()
    elif cmd == "instances":
        do_list_instances()
    elif cmd == "call":
        if len(argv) < 2:
            print("Usage: playwright.py call <tool_name> [args_json]", file=sys.stderr)
            sys.exit(1)
        tool_name = argv[1]
        args_json = argv[2] if len(argv) > 2 else "{}"
        do_call(tool_name, args_json)
    elif cmd == "tools":
        do_tools()
    elif cmd == "_daemon":
        headless = "--headless" in argv
        run_daemon(headless)
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
