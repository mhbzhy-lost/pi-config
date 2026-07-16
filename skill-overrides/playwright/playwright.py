#!/usr/bin/env python3
"""
Playwright MCP wrapper for pi skill.
Manages a persistent Playwright MCP server process, proxies via Unix socket.

Usage:
  playwright.py start [--headless]   Start the MCP server daemon
  playwright.py call <tool> [args]   Call an MCP tool (args as JSON string)
  playwright.py stop                 Stop the MCP server daemon
  playwright.py status               Check if server is running
  playwright.py tools                List available tools
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
from pathlib import Path

STATE_DIR = Path(tempfile.gettempdir()) / "pi-playwright-mcp"
SOCKET_PATH = STATE_DIR / "server.sock"
PID_FILE = STATE_DIR / "daemon.pid"
LOG_FILE = STATE_DIR / "daemon.log"
MCP_PID_FILE = STATE_DIR / "mcp.pid"

CLIENT_TIMEOUT = 60.0


def ensure_state_dir():
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def read_pid(path: Path) -> int | None:
    try:
        pid = int(path.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return None


def is_running() -> bool:
    return read_pid(PID_FILE) is not None and SOCKET_PATH.exists()


def do_status():
    pid = read_pid(PID_FILE)
    if pid and SOCKET_PATH.exists():
        print(f"Running (daemon pid={pid})")
    else:
        print("Not running")


def do_start(headless: bool = False):
    ensure_state_dir()

    if is_running():
        print("Already running")
        return

    cmd = [sys.executable, __file__, "_daemon"]
    if headless:
        cmd.append("--headless")

    log = open(LOG_FILE, "a")
    proc = subprocess.Popen(
        cmd,
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    PID_FILE.write_text(str(proc.pid))

    for _ in range(50):
        if SOCKET_PATH.exists():
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(str(SOCKET_PATH))
                s.close()
                print(f"Started (pid={proc.pid}, headless={headless})")
                return
            except (ConnectionRefusedError, FileNotFoundError):
                pass
        time.sleep(0.1)

    print(f"Failed to start (check log: {LOG_FILE})", file=sys.stderr)
    sys.exit(1)


def do_stop():
    pid = read_pid(PID_FILE)
    if pid:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    for f in [PID_FILE, SOCKET_PATH, MCP_PID_FILE]:
        f.unlink(missing_ok=True)

    print("Stopped")


def send_request(req: dict, timeout: float = CLIENT_TIMEOUT) -> dict:
    if not is_running():
        print("Server not running. Start with: playwright.py start [--headless]", file=sys.stderr)
        sys.exit(1)

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(str(SOCKET_PATH))

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
    req = {"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 1}
    result = send_request(req)
    tools = result.get("result", {}).get("tools", [])
    for t in tools:
        desc = t["description"][:80]
        print(f"  {t['name']:30s} {desc}")


def run_daemon(headless: bool):
    """Daemon: manages MCP subprocess and proxies via Unix socket with threads."""
    SOCKET_PATH.unlink(missing_ok=True)

    mcp_cmd = ["npx", "-y", "@playwright/mcp"]
    if headless:
        mcp_cmd.append("--headless")

    mcp = subprocess.Popen(
        mcp_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    MCP_PID_FILE.write_text(str(mcp.pid))

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
    pending_event = threading.Event()

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
    server.bind(str(SOCKET_PATH))
    server.listen(5)
    server.settimeout(1.0)
    print(f"Listening on {SOCKET_PATH}", flush=True)

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
        SOCKET_PATH.unlink(missing_ok=True)
        mcp.terminate()
        try:
            mcp.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mcp.kill()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "start":
        headless = "--headless" in sys.argv
        do_start(headless)
    elif cmd == "stop":
        do_stop()
    elif cmd == "status":
        do_status()
    elif cmd == "call":
        if len(sys.argv) < 3:
            print("Usage: playwright.py call <tool_name> [args_json]", file=sys.stderr)
            sys.exit(1)
        tool_name = sys.argv[2]
        args_json = sys.argv[3] if len(sys.argv) > 3 else "{}"
        do_call(tool_name, args_json)
    elif cmd == "tools":
        do_tools()
    elif cmd == "_daemon":
        headless = "--headless" in sys.argv
        run_daemon(headless)
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
