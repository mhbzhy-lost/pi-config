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
from contextlib import redirect_stderr, redirect_stdout
from importlib import util
from io import StringIO
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
PLAYWRIGHT_PY = HERE / "playwright.py"
FAKE_MCP = HERE / "test_fake_mcp.py"
BASE = Path(tempfile.gettempdir()) / "pi-playwright-mcp"

SPEC = util.spec_from_file_location("playwright_wrapper", PLAYWRIGHT_PY)
WRAPPER = util.module_from_spec(SPEC)
SPEC.loader.exec_module(WRAPPER)


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


def isolated_env(home: Path, argv_file: Path | None = None) -> dict:
    env = fake_mcp_env()
    env["HOME"] = str(home)
    if argv_file is not None:
        env["PI_PLAYWRIGHT_TEST_ARGV_FILE"] = str(argv_file)
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


def start_detached_sleep(marker: Path) -> int:
    code = """import os
import sys

pid = os.fork()
if pid:
    with open(sys.argv[1], "w") as marker_file:
        marker_file.write(str(pid))
    sys.exit(0)
os.setsid()
os.execlp("sleep", "sleep", "1000")
"""
    launcher = subprocess.Popen([sys.executable, "-c", code, str(marker)])
    launcher.wait(timeout=5)
    return int(marker.read_text())


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

        marker_root = Path(tempfile.mkdtemp())
        stale_pid = start_detached_sleep(marker_root / "stale.pid")
        fresh_pid = start_detached_sleep(marker_root / "fresh.pid")

        def fake_instance(name: str, daemon_pid: int, activity: float):
            d = instance_dir(name)
            d.mkdir(parents=True, exist_ok=True)
            (d / "daemon.pid").write_text(str(daemon_pid))
            (d / "server.sock").touch()
            (d / "last_activity").write_text(f"{activity:.3f}")

        try:
            fake_instance(stale, stale_pid, time.time() - 10_000)
            fake_instance(fresh, fresh_pid, time.time())

            cli_start(new)

            with self.assertRaises(ProcessLookupError):
                os.kill(stale_pid, 0)
            self.assertFalse(instance_dir(stale).exists(), "expired state dir must be removed")
            os.kill(fresh_pid, 0)
            self.assertTrue(instance_dir(fresh).exists(), "fresh state dir must be kept")
        finally:
            for pid in (stale_pid, fresh_pid):
                stop_daemon(pid)
            cli_stop(new)
            for marker in marker_root.iterdir():
                marker.unlink()
            marker_root.rmdir()

    def test_start_waits_for_reaped_daemon_before_reusing_profile(self):
        profile_name = f"reap-{uuid.uuid4().hex[:8]}"
        stale = f"rs-{uuid.uuid4().hex[:8]}"
        new = f"rn-{uuid.uuid4().hex[:8]}"
        home_dir = tempfile.TemporaryDirectory()
        home = Path(home_dir.name)
        root = home / ".pi" / "playwright-profiles"
        root.mkdir(parents=True, mode=0o700)
        profile = root / profile_name
        profile.mkdir(mode=0o700)
        ready = home / "lock-ready"
        helper_code = (
            "import fcntl, os, signal, sys, time; "
            "pid=os.fork(); "
            "sys.exit(0) if pid else None; "
            "os.setsid(); "
            "lock=os.fdopen(os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600), 'r+'); "
            "fcntl.flock(lock, fcntl.LOCK_EX); "
            "open(sys.argv[2], 'w').write(str(os.getpid())); "
            "signal.signal(signal.SIGTERM, lambda *_: (time.sleep(0.5), sys.exit(0))); "
            "signal.pause()"
        )
        launcher = subprocess.Popen([
            sys.executable, "-c", helper_code,
            str(profile / ".pi-playwright.lock"), str(ready),
        ])
        deadline = time.time() + 5
        while time.time() < deadline and not ready.exists():
            time.sleep(0.05)
        self.assertTrue(ready.exists())
        launcher.wait(timeout=5)
        helper_pid = int(ready.read_text())
        stale_state = instance_dir(stale)
        stale_state.mkdir(parents=True)
        (stale_state / "daemon.pid").write_text(str(helper_pid))
        (stale_state / "server.sock").touch()
        (stale_state / "last_activity").write_text(str(time.time() - 100))
        self.created.extend([stale, new])

        try:
            result = subprocess.run(
                [sys.executable, str(PLAYWRIGHT_PY), "start", "--instance", new,
                 "--profile", profile_name],
                env={**isolated_env(home), "PI_PLAYWRIGHT_IDLE_TIMEOUT": "1"},
                capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            with self.assertRaises(ProcessLookupError):
                os.kill(helper_pid, 0)
            self.assertFalse(stale_state.exists())
        finally:
            try:
                stop_daemon(helper_pid)
            except ProcessLookupError:
                pass
            subprocess.run(
                [sys.executable, str(PLAYWRIGHT_PY), "stop", "--instance", new],
                env=isolated_env(home), capture_output=True, timeout=30,
            )
            home_dir.cleanup()

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


class PersistentProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.instances = []

    def tearDown(self):
        for name in self.instances:
            cli = subprocess.run(
                [sys.executable, str(PLAYWRIGHT_PY), "stop", "--instance", name],
                env=isolated_env(self.home), capture_output=True, timeout=30,
            )
            self.assertNotIn("Traceback", cli.stderr.decode())
            cleanup_instance(name)
        self.temp.cleanup()

    def run_cli(self, *args: str, argv_file: Path | None = None, check: bool = False):
        return subprocess.run(
            [sys.executable, str(PLAYWRIGHT_PY), *args],
            env=isolated_env(self.home, argv_file), capture_output=True,
            timeout=30, check=check,
        )

    def test_valid_profile_is_0700_and_passed_to_injected_mcp(self):
        name = f"profile-{uuid.uuid4().hex[:8]}"
        instance = f"p-{uuid.uuid4().hex[:8]}"
        argv_file = self.home / "mcp-argv.json"
        self.instances.append(instance)

        self.run_cli("start", "--instance", instance, "--profile", name,
                     "--headless", argv_file=argv_file, check=True)

        profile = self.home / ".pi" / "playwright-profiles" / name
        self.assertTrue(profile.is_dir())
        self.assertFalse(profile.is_symlink())
        self.assertEqual(profile.stat().st_mode & 0o777, 0o700)
        argv = json.loads(argv_file.read_text())
        self.assertEqual(argv, ["--headless", "--user-data-dir", str(profile)])

    def test_invalid_profile_name_is_rejected_without_creating_profile_root(self):
        result = self.run_cli("start", "--instance", "invalid-profile", "--profile", "../bad")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "error: invalid-profile-name")
        self.assertFalse((self.home / ".pi" / "playwright-profiles").exists())

    def test_symlink_profile_is_rejected_without_leaking_path(self):
        root = self.home / ".pi" / "playwright-profiles"
        root.mkdir(parents=True, mode=0o700)
        target = self.home / "target"
        target.mkdir()
        (root / "linked").symlink_to(target, target_is_directory=True)

        result = self.run_cli("start", "--instance", "symlink-profile", "--profile", "linked")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "error: unsafe-profile-directory")
        self.assertNotIn(str(self.home), result.stderr.decode())

    def test_symlink_profile_root_is_rejected(self):
        pi_dir = self.home / ".pi"
        pi_dir.mkdir(mode=0o700)
        target = self.home / "other-root"
        target.mkdir(mode=0o700)
        (pi_dir / "playwright-profiles").symlink_to(target, target_is_directory=True)

        result = self.run_cli("start", "--instance", "symlink-root", "--profile", "named")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "error: unsafe-profile-directory")
        self.assertFalse((target / "named").exists())

    def test_wrong_mode_profile_is_rejected(self):
        profile = self.home / ".pi" / "playwright-profiles" / "open-mode"
        profile.mkdir(parents=True, mode=0o755)
        profile.chmod(0o755)

        result = self.run_cli("start", "--instance", "mode-profile", "--profile", "open-mode")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "error: unsafe-profile-directory")

    def test_wrong_owner_profile_is_rejected(self):
        profile = self.home / "owned-elsewhere"
        profile.mkdir(mode=0o700)
        real_stat = profile.stat()
        fake_stat = mock.Mock(st_uid=os.getuid() + 1, st_mode=real_stat.st_mode)

        with mock.patch.object(Path, "lstat", return_value=fake_stat):
            with self.assertRaisesRegex(ValueError, "^unsafe-profile-directory$"):
                WRAPPER.validate_profile_directory(profile)

    def test_stop_preserves_profile_directory(self):
        name = f"keep-{uuid.uuid4().hex[:8]}"
        instance = f"k-{uuid.uuid4().hex[:8]}"
        self.instances.append(instance)
        self.run_cli("start", "--instance", instance, "--profile", name, check=True)

        marker = self.home / ".pi" / "playwright-profiles" / name / "marker"
        self.assertTrue(marker.parent.is_dir(), "start must create the persistent profile")
        marker.write_text("test-only")
        self.run_cli("stop", "--instance", instance, check=True)

        self.assertEqual(marker.read_text(), "test-only")

    def test_stop_waits_for_daemon_exit_and_allows_immediate_profile_reuse(self):
        name = f"reuse-{uuid.uuid4().hex[:8]}"
        first = f"r1-{uuid.uuid4().hex[:8]}"
        second = f"r2-{uuid.uuid4().hex[:8]}"
        self.instances.extend([first, second])
        self.run_cli("start", "--instance", first, "--profile", name, check=True)
        first_pid = read_pid_file(instance_dir(first) / "daemon.pid")

        self.run_cli("stop", "--instance", first, check=True)
        with self.assertRaises(ProcessLookupError):
            os.kill(first_pid, 0)

        result = self.run_cli("start", "--instance", second, "--profile", name)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_stop_waits_for_slow_daemon_before_releasing_authoritative_state(self):
        name = f"slow-{uuid.uuid4().hex[:8]}"
        first = f"s1-{uuid.uuid4().hex[:8]}"
        second = f"s2-{uuid.uuid4().hex[:8]}"
        self.instances.append(second)
        profile_root = self.home / ".pi" / "playwright-profiles"
        profile_root.mkdir(parents=True, mode=0o700)
        profile = profile_root / name
        profile.mkdir(mode=0o700)
        ready = self.home / "lock-ready"
        helper_code = (
            "import fcntl, os, signal, sys, time; "
            "pid=os.fork(); "
            "sys.exit(0) if pid else None; "
            "os.setsid(); "
            "lock=os.fdopen(os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600), 'r+'); "
            "fcntl.flock(lock, fcntl.LOCK_EX); "
            "open(sys.argv[2], 'w').write(str(os.getpid())); "
            "signal.signal(signal.SIGTERM, lambda *_: (time.sleep(0.5), sys.exit(0))); "
            "signal.pause()"
        )
        launcher = subprocess.Popen(
            [sys.executable, "-c", helper_code,
             str(profile / ".pi-playwright.lock"), str(ready)],
        )
        deadline = time.time() + 5
        while time.time() < deadline and not ready.exists():
            time.sleep(0.05)
        self.assertTrue(ready.exists())
        launcher.wait(timeout=5)
        helper_pid = int(ready.read_text())
        state = instance_dir(first)
        state.mkdir(parents=True)
        (state / "daemon.pid").write_text(str(helper_pid))
        (state / "server.sock").touch()

        try:
            stopped = self.run_cli("stop", "--instance", first)
            self.assertEqual(stopped.returncode, 0, stopped.stderr.decode())
            with self.assertRaises(ProcessLookupError):
                os.kill(helper_pid, 0)
            self.assertFalse(state.exists())

            reused = self.run_cli("start", "--instance", second, "--profile", name)
            self.assertEqual(reused.returncode, 0, reused.stderr.decode())
        finally:
            try:
                stop_daemon(helper_pid)
            except UnboundLocalError:
                launcher.terminate()
            cleanup_instance(first)

    def test_idle_exit_preserves_profile_directory(self):
        name = f"idle-{uuid.uuid4().hex[:8]}"
        instance = f"i-{uuid.uuid4().hex[:8]}"
        result = subprocess.run(
            [sys.executable, str(PLAYWRIGHT_PY), "start", "--instance", instance,
             "--profile", name],
            env={**isolated_env(self.home), "PI_PLAYWRIGHT_IDLE_TIMEOUT": "0.2"},
            capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())

        profile = self.home / ".pi" / "playwright-profiles" / name
        deadline = time.time() + 10
        while time.time() < deadline and (instance_dir(instance) / "server.sock").exists():
            time.sleep(0.1)

        self.assertFalse((instance_dir(instance) / "server.sock").exists())
        self.assertTrue(profile.is_dir())
        cleanup_instance(instance)

    def test_same_profile_is_rejected_while_first_daemon_holds_lock(self):
        name = f"lock-{uuid.uuid4().hex[:8]}"
        first = f"a-{uuid.uuid4().hex[:8]}"
        second = f"b-{uuid.uuid4().hex[:8]}"
        self.instances.extend([first, second])
        self.run_cli("start", "--instance", first, "--profile", name, check=True)

        result = self.run_cli("start", "--instance", second, "--profile", name)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "error: profile-in-use")
        self.assertNotIn(str(self.home), result.stderr.decode())


class StopAllLifecycleTests(unittest.TestCase):
    def test_stopall_waits_for_slow_daemon_before_clearing_state(self):
        name = f"all-{uuid.uuid4().hex[:8]}"
        home_dir = tempfile.TemporaryDirectory()
        home = Path(home_dir.name)
        ready = home / "slow-ready"
        helper_code = (
            "import os, signal, sys, time; "
            "pid=os.fork(); "
            "sys.exit(0) if pid else None; "
            "os.setsid(); "
            "open(sys.argv[1], 'w').write(str(os.getpid())); "
            "signal.signal(signal.SIGTERM, lambda *_: (time.sleep(0.5), sys.exit(0))); "
            "signal.pause()"
        )
        launcher = subprocess.Popen([sys.executable, "-c", helper_code, str(ready)])
        deadline = time.time() + 5
        while time.time() < deadline and not ready.exists():
            time.sleep(0.05)
        self.assertTrue(ready.exists())
        launcher.wait(timeout=5)
        helper_pid = int(ready.read_text())
        state = instance_dir(name)
        state.mkdir(parents=True)
        (state / "daemon.pid").write_text(str(helper_pid))
        (state / "server.sock").touch()

        try:
            stopped = subprocess.run(
                [sys.executable, str(PLAYWRIGHT_PY), "stopall"],
                env=isolated_env(home), capture_output=True, timeout=30,
            )
            self.assertEqual(stopped.returncode, 0, stopped.stderr.decode())
            with self.assertRaises(ProcessLookupError):
                os.kill(helper_pid, 0)
            self.assertFalse(state.exists())
        finally:
            stop_daemon(helper_pid)
            cleanup_instance(name)
            home_dir.cleanup()

    def test_stopall_keeps_unconfirmed_state_and_continues_other_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            failed = base / "failed"
            stopped = base / "stopped"
            for state, pid in ((failed, 101), (stopped, 202)):
                state.mkdir()
                (state / "daemon.pid").write_text(str(pid))
                (state / "server.sock").touch()

            stdout = StringIO()
            stderr = StringIO()
            with mock.patch.object(WRAPPER, "BASE_STATE_DIR", base), \
                    mock.patch.object(WRAPPER, "running_instances",
                                      return_value=[("failed", 101), ("stopped", 202)]), \
                    mock.patch.object(WRAPPER.os, "getpgid", side_effect=lambda pid: pid), \
                    mock.patch.object(WRAPPER.os, "killpg"), \
                    mock.patch.object(WRAPPER, "wait_for_process_exit",
                                      side_effect=[False, True]) as wait:
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    with self.assertRaises(SystemExit) as raised:
                        WRAPPER.do_stopall()

            self.assertEqual(raised.exception.code, 1)
            self.assertEqual(stderr.getvalue().strip(), "error: stop-failed")
            self.assertTrue(failed.exists(), "unconfirmed daemon state must remain authoritative")
            self.assertFalse(stopped.exists(), "confirmed daemon state must be cleaned")
            self.assertEqual(wait.call_args_list, [mock.call(101), mock.call(202)])


class InstanceValidationTests(unittest.TestCase):
    def test_help_documents_safe_named_profile_option(self):
        result = subprocess.run(
            [sys.executable, str(PLAYWRIGHT_PY)], capture_output=True, timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--profile <safe-name>", result.stdout.decode())

    def test_illegal_instance_is_rejected_before_state_creation(self):
        name = f"bad_{uuid.uuid4().hex[:8]}"
        result = subprocess.run(
            [sys.executable, str(PLAYWRIGHT_PY), "status", "--instance", name],
            capture_output=True, timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "error: invalid-instance")
        self.assertFalse(instance_dir(name).exists())

    def test_overlong_instance_is_rejected_before_state_creation(self):
        name = uuid.uuid4().hex + "x" * 120
        result = subprocess.run(
            [sys.executable, str(PLAYWRIGHT_PY), "start", "--instance", name],
            env=fake_mcp_env(), capture_output=True, timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "error: invalid-instance")
        self.assertFalse(instance_dir(name).exists())


if __name__ == "__main__":
    unittest.main()
