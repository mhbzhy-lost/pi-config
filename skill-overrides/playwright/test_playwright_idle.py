"""Tests for the idle-timeout auto-reclaim behavior of playwright.py.

Run from the repo root:
    python3 -m unittest discover -s skill-overrides/playwright -p 'test_*.py' -v

These tests spawn real daemon subprocesses with the fake MCP injected via
PI_PLAYWRIGHT_MCP_CMD, so no npx invocation or network access is required.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLAYWRIGHT_PY = HERE / "playwright.py"
FAKE_MCP = HERE / "test_fake_mcp.py"
BASE = Path(tempfile.gettempdir()) / "pi-playwright-mcp"


def instance_dir(name: str) -> Path:
    return BASE / name


def read_pid_file(path: Path) -> int:
    return int(path.read_text().strip())


def wait_for_socket(name: str, timeout: float = 15.0) -> None:
    sock = instance_dir(name) / "server.sock"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if sock.exists():
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(1.0)
                s.connect(str(sock))
                s.close()
                return
            except OSError:
                pass
        time.sleep(0.1)
    raise TimeoutError(f"daemon socket for instance {name!r} never became ready")


def send_req(name: str, method: str, req_id: int) -> dict:
    """Send one JSON-RPC request to the daemon and return its response."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10.0)
    s.connect(str(instance_dir(name) / "server.sock"))
    try:
        s.sendall((json.dumps({"jsonrpc": "2.0", "method": method, "id": req_id}) + "\n").encode())
        data = b""
        while b"\n" not in data:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        return json.loads(data.decode().strip())
    finally:
        s.close()


def fake_mcp_env() -> dict:
    env = dict(os.environ)
    env["PI_PLAYWRIGHT_MCP_CMD"] = f"{sys.executable} {FAKE_MCP}"
    return env


def start_daemon(name: str, idle: int = 1) -> subprocess.Popen:
    """Start a daemon subprocess in its own session with the fake MCP."""
    cmd = [
        sys.executable, str(PLAYWRIGHT_PY), "_daemon",
        "--instance", name,
        "--idle-timeout", str(idle),
    ]
    return subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=fake_mcp_env(),
    )


def stop_daemon(pid: int) -> None:
    """SIGTERM the daemon's process group (safe: started with start_new_session)."""
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass


def cleanup_instance(name: str) -> None:
    d = instance_dir(name)
    if d.exists():
        for f in ["daemon.pid", "server.sock", "mcp.pid", "last_activity", "daemon.log"]:
            (d / f).unlink(missing_ok=True)
        try:
            d.rmdir()
        except OSError:
            pass


def cli_start(name: str) -> None:
    subprocess.run(
        [sys.executable, str(PLAYWRIGHT_PY), "start", "--instance", name],
        env=fake_mcp_env(), capture_output=True, timeout=30, check=True,
    )


def cli_stop(name: str) -> None:
    subprocess.run(
        [sys.executable, str(PLAYWRIGHT_PY), "stop", "--instance", name],
        env=fake_mcp_env(), capture_output=True, timeout=30,
    )


class IdleTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.created = []
        self.daemons = []

    def tearDown(self):
        for proc in self.daemons:
            if proc.poll() is None:
                stop_daemon(proc.pid)
            proc.wait(timeout=5)
        for name in self.created:
            d = instance_dir(name)
            pid = None
            try:
                pid = read_pid_file(d / "daemon.pid")
            except (OSError, ValueError):
                pass
            if pid is not None:
                stop_daemon(pid)
            cleanup_instance(name)

    def test_daemon_exits_and_cleans_after_idle_timeout(self):
        """T1: with no client connections the daemon exits on its own and
        tears down the socket and the mcp child process."""
        name = f"t1-{uuid.uuid4().hex[:8]}"
        self.created.append(name)
        daemon = start_daemon(name, idle=1)
        self.daemons.append(daemon)
        wait_for_socket(name)
        mcp_pid = read_pid_file(instance_dir(name) / "mcp.pid")

        daemon.wait(timeout=15)  # TimeoutExpired here = feature missing (RED)

        self.assertFalse((instance_dir(name) / "server.sock").exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(mcp_pid, 0)

    def test_daemon_survives_activity_and_tracks_last_activity(self):
        """T2: an actively used daemon keeps running past the idle threshold,
        and writes a fresh last_activity file on each connection."""
        name = f"t2-{uuid.uuid4().hex[:8]}"
        self.created.append(name)
        daemon = start_daemon(name, idle=1)
        self.daemons.append(daemon)
        wait_for_socket(name)

        for i in range(8):  # ~3.2s total, each request refreshes activity
            resp = send_req(name, "tools/list", req_id=1000 + i)
            self.assertEqual(resp["id"], 1000 + i)
            time.sleep(0.4)

        act_file = instance_dir(name) / "last_activity"
        self.assertTrue(act_file.exists(), "last_activity file must be written")
        stamp = float(act_file.read_text().strip())
        self.assertGreaterEqual(stamp, time.time() - 5)
        self.assertIsNone(daemon.poll(), "daemon must not exit while active")

    def test_start_reaps_expired_instances_only(self):
        """T3: `start` reaps other instances whose daemon is alive but whose
        last activity is older than the idle timeout, while keeping fresh
        instances untouched."""
        stale = f"s-{uuid.uuid4().hex[:8]}"
        fresh = f"f-{uuid.uuid4().hex[:8]}"
        new = f"n-{uuid.uuid4().hex[:8]}"
        self.created += [stale, fresh, new]

        stale_proc = subprocess.Popen(["sleep", "1000"], start_new_session=True)
        fresh_proc = subprocess.Popen(["sleep", "1000"], start_new_session=True)

        def fake_instance(name: str, daemon_pid: int, activity: float):
            d = instance_dir(name)
            d.mkdir(parents=True, exist_ok=True)
            (d / "daemon.pid").write_text(str(daemon_pid))
            (d / "server.sock").touch()
            (d / "last_activity").write_text(f"{activity:.3f}")

        try:
            fake_instance(stale, stale_proc.pid, time.time() - 10_000)
            fake_instance(fresh, fresh_proc.pid, time.time())

            cli_start(new)

            self.assertIsNotNone(stale_proc.poll(), "expired instance must be reaped")
            self.assertFalse(instance_dir(stale).exists(), "expired state dir must be removed")
            self.assertIsNone(fresh_proc.poll(), "fresh instance must be kept")
            self.assertTrue(instance_dir(fresh).exists(), "fresh state dir must be kept")
        finally:
            for proc in (stale_proc, fresh_proc):
                if proc.poll() is None:
                    stop_daemon(proc.pid)
                proc.wait(timeout=5)
            cli_stop(new)

    def test_stop_cleans_state_directory_fully(self):
        """T5: `stop` removes the state directory including the
        last_activity file introduced by the idle feature."""
        name = f"t5-{uuid.uuid4().hex[:8]}"
        self.created.append(name)

        cli_start(name)
        send_req(name, "tools/list", req_id=42)  # forces last_activity write
        cli_stop(name)

        self.assertFalse(instance_dir(name).exists(), "state dir must be fully removed")

    def test_reap_skips_legacy_instance_without_activity_file(self):
        """T4: instances created before the last_activity feature (no
        activity file) must not be reaped."""
        legacy = f"l-{uuid.uuid4().hex[:8]}"
        new = f"n-{uuid.uuid4().hex[:8]}"
        self.created += [legacy, new]

        legacy_proc = subprocess.Popen(["sleep", "1000"], start_new_session=True)

        d = instance_dir(legacy)
        d.mkdir(parents=True, exist_ok=True)
        (d / "daemon.pid").write_text(str(legacy_proc.pid))
        (d / "server.sock").touch()

        try:
            cli_start(new)
            self.assertIsNone(legacy_proc.poll(), "legacy instance must not be reaped")
            self.assertTrue(instance_dir(legacy).exists())
        finally:
            if legacy_proc.poll() is None:
                stop_daemon(legacy_proc.pid)
            legacy_proc.wait(timeout=5)
            cli_stop(new)


if __name__ == "__main__":
    unittest.main()
