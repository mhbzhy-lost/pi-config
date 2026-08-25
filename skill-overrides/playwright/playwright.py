#!/usr/bin/env python3
"""
Playwright MCP wrapper for pi skill.
Manages a persistent Playwright MCP server process, proxies via Unix socket.
Each start creates an independent browser instance automatically.

Usage:
  playwright.py [--instance <name>] [--profile <safe-name>] start [--headless]
  playwright.py [--instance <name>] call <tool> [args]
  playwright.py [--instance <name>] stop
  playwright.py [--instance <name>] status
  playwright.py [--instance <name>] tools
  playwright.py instances
  playwright.py stopall
"""

import json
import fcntl
import os
import re
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

BASE_STATE_DIR = Path(tempfile.gettempdir()) / "pi-playwright-mcp"
CLIENT_TIMEOUT = 60.0
IDLE_TIMEOUT_DEFAULT = 1800.0
STOP_TIMEOUT = 5.0
SOCKET_PATH_BUDGET = 100
SAFE_NAME_RE = re.compile(r"[a-z0-9-]{1,32}\Z")

_instance_name: str | None = None
_instance_explicit = False
_profile_name: str | None = None


def state_dir() -> Path:
    return BASE_STATE_DIR / _instance_name


def socket_path() -> Path:
    return state_dir() / "server.sock"


def pid_file() -> Path:
    return state_dir() / "daemon.pid"


def log_file() -> Path:
    return state_dir() / "daemon.log"


def last_activity_file() -> Path:
    return state_dir() / "last_activity"


def startup_error_file() -> Path:
    return state_dir() / "startup.error"


def idle_timeout_from_env() -> float:
    """Idle timeout from PI_PLAYWRIGHT_IDLE_TIMEOUT, else the default."""
    raw = os.environ.get("PI_PLAYWRIGHT_IDLE_TIMEOUT")
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass
    return IDLE_TIMEOUT_DEFAULT


def mcp_pid_file() -> Path:
    return state_dir() / "mcp.pid"


def ensure_state_dir():
    state_dir().mkdir(parents=True, exist_ok=True)


def fail(reason: str) -> None:
    print(f"error: {reason}", file=sys.stderr)
    raise SystemExit(1)


def validate_instance(name: str) -> None:
    if not SAFE_NAME_RE.fullmatch(name):
        raise ValueError("invalid-instance")
    candidate = BASE_STATE_DIR / name / "server.sock"
    if len(os.fsencode(candidate)) >= SOCKET_PATH_BUDGET:
        raise ValueError("invalid-instance")


def validate_profile_name(name: str) -> None:
    if not SAFE_NAME_RE.fullmatch(name):
        raise ValueError("invalid-profile-name")


def validate_profile_directory(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        raise ValueError("unsafe-profile-directory") from exc
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("unsafe-profile-directory")


def prepare_profile(name: str) -> Path:
    validate_profile_name(name)
    root = Path.home() / ".pi" / "playwright-profiles"
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise ValueError("unsafe-profile-directory") from exc
    validate_profile_directory(root)
    profile = root / name
    try:
        profile.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except OSError as exc:
        raise ValueError("unsafe-profile-directory") from exc
    validate_profile_directory(profile)
    return profile


def acquire_profile_lock(profile: Path):
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(profile / ".pi-playwright.lock", flags, 0o600)
        lock = os.fdopen(fd, "r+")
        info = os.fstat(lock.fileno())
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            lock.close()
            raise ValueError("unsafe-profile-directory")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock
    except BlockingIOError as exc:
        raise ValueError("profile-in-use") from exc
    except ValueError:
        raise
    except OSError as exc:
        raise ValueError("unsafe-profile-directory") from exc


def read_pid(path: Path) -> int | None:
    try:
        pid = int(path.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return None


def wait_for_process_exit(pid: int, timeout: float = STOP_TIMEOUT) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        time.sleep(0.05)
    return False


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


def do_start(headless: bool = False, profile_name: str | None = None):
    global _instance_name

    if _instance_name is None:
        _instance_name = uuid.uuid4().hex[:8]
    validate_instance(_instance_name)

    profile = prepare_profile(profile_name) if profile_name else None

    reaped = reap_idle_instances(idle_timeout_from_env())
    if reaped:
        print(f"Reaped idle instances: {', '.join(reaped)}")

    if profile is not None:
        lock = acquire_profile_lock(profile)
        lock.close()

    ensure_state_dir()

    if is_running():
        print(f"Already running (instance={_instance_name})")
        return

    cmd = [sys.executable, __file__, "_daemon", "--instance", _instance_name]
    if headless:
        cmd.append("--headless")
    if profile_name:
        cmd.extend(["--profile", profile_name])

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
        if startup_error_file().exists():
            try:
                reason = startup_error_file().read_text().strip()
            except OSError:
                reason = "daemon-start-failed"
            do_stop(announce=False)
            fail(reason if reason in {
                "profile-in-use", "unsafe-profile-directory", "invalid-profile-name"
            } else "daemon-start-failed")
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

    do_stop(announce=False)
    fail("daemon-start-failed")


def reap_idle_instances(idle_timeout: float) -> list[str]:
    """Stop other instances whose daemon is alive but idle past the timeout.

    Instances without a last_activity file (created before this feature) are
    conservatively skipped.  Returns the names of reaped instances.
    """
    reaped = []
    if not BASE_STATE_DIR.exists():
        return reaped
    for d in sorted(BASE_STATE_DIR.iterdir()):
        if not d.is_dir() or d.name == _instance_name:
            continue
        pid = read_pid(d / "daemon.pid")
        if pid is None or not (d / "server.sock").exists():
            continue
        act = d / "last_activity"
        if not act.exists():
            continue
        try:
            stamp = float(act.read_text().strip())
        except (OSError, ValueError):
            continue
        if time.time() - stamp < idle_timeout:
            continue
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        if not wait_for_process_exit(pid):
            continue
        for f in ["daemon.pid", "server.sock", "mcp.pid", "last_activity", "daemon.log", "startup.error"]:
            (d / f).unlink(missing_ok=True)
        try:
            d.rmdir()
        except OSError:
            pass
        reaped.append(d.name)
    return reaped


def do_stop(announce: bool = True):
    resolve_instance()
    pid = read_pid(pid_file())
    if pid:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        if not wait_for_process_exit(pid):
            fail("stop-failed")

    for f in [pid_file(), socket_path(), mcp_pid_file(), last_activity_file(), log_file(), startup_error_file()]:
        f.unlink(missing_ok=True)

    try:
        state_dir().rmdir()
    except OSError:
        pass

    if announce:
        print(f"Stopped (instance={_instance_name})")


def do_stopall():
    """Stop all running instances."""
    instances = running_instances()
    if not instances:
        print("No running instances")
        return
    stop_failed = False
    for name, pid in instances:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        if not wait_for_process_exit(pid):
            stop_failed = True
            continue
        d = BASE_STATE_DIR / name
        for f in ["daemon.pid", "server.sock", "mcp.pid", "last_activity", "daemon.log", "startup.error"]:
            (d / f).unlink(missing_ok=True)
        try:
            d.rmdir()
        except OSError:
            pass
        print(f"  Stopped {name} (pid={pid})")
    if stop_failed:
        fail("stop-failed")


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


def run_daemon(headless: bool, idle_timeout: float = IDLE_TIMEOUT_DEFAULT,
               profile_name: str | None = None):
    """Daemon: manages MCP subprocess and proxies via Unix socket with threads.

    Exits on its own when no client connects for idle_timeout seconds and no
    request is waiting for an MCP response.  Each accepted connection refreshes
    the activity timestamp (also persisted to the last_activity state file so
    other processes can reap this instance).
    """
    ensure_state_dir()
    socket_path().unlink(missing_ok=True)

    profile = prepare_profile(profile_name) if profile_name else None
    profile_lock = acquire_profile_lock(profile) if profile is not None else None

    injected = os.environ.get("PI_PLAYWRIGHT_MCP_CMD")
    if injected:
        mcp_cmd = shlex.split(injected)
    else:
        mcp_cmd = ["npx", "-y", "@playwright/mcp"]
    if headless:
        mcp_cmd.append("--headless")
    if profile is not None:
        mcp_cmd.extend(["--user-data-dir", str(profile)])

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

    last_activity = time.time()

    def touch_activity():
        nonlocal last_activity
        last_activity = time.time()
        try:
            last_activity_file().write_text(f"{last_activity:.3f}")
        except OSError:
            pass

    try:
        while mcp.poll() is None:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                if pending or time.time() - last_activity < idle_timeout:
                    continue
                break
            touch_activity()
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
        if profile_lock is not None:
            profile_lock.close()


def parse_options(argv: list[str]) -> list[str]:
    """Extract global instance/profile options and return remaining args."""
    global _instance_name, _instance_explicit, _profile_name
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--instance":
            if i + 1 >= len(argv):
                raise ValueError("invalid-instance")
            _instance_name = argv[i + 1]
            validate_instance(_instance_name)
            _instance_explicit = True
            i += 2
        elif argv[i] == "--profile":
            if i + 1 >= len(argv):
                raise ValueError("invalid-profile-name")
            _profile_name = argv[i + 1]
            validate_profile_name(_profile_name)
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
    try:
        argv = parse_options(sys.argv[1:])
    except ValueError as exc:
        fail(str(exc))

    if len(argv) < 1:
        print(__doc__)
        sys.exit(1)

    cmd = argv[0]

    if cmd == "start":
        headless = "--headless" in argv
        try:
            do_start(headless, _profile_name)
        except ValueError as exc:
            fail(str(exc))
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
        idle_timeout = idle_timeout_from_env()
        if "--idle-timeout" in argv:
            try:
                idle_timeout = float(argv[argv.index("--idle-timeout") + 1])
            except (IndexError, ValueError):
                pass
        try:
            run_daemon(headless, idle_timeout, _profile_name)
        except ValueError as exc:
            ensure_state_dir()
            startup_error_file().write_text(str(exc))
            fail(str(exc))
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
