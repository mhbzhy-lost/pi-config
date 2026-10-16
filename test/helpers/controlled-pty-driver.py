#!/usr/bin/env python3
"""tests-only 受控 PTY driver（Python 3 标准库）。

边界（与 docs/plans/2026-10-15-runtime-closeout.md P0 一致）：
- 只服务 ``test/helpers/controlled-pty.mjs``，不是 production CLI，也不构成通用终端框架。
- 控制协议只有 start/write/resize/identity/signal/shutdown；没有任何 attach/接管外部 PID 的方法，
  请求中出现外部 PID 字段一律拒绝。
- driver 用 ``pty.fork()`` 直接创建 child，child 只 ``chdir + execve`` 调用方指定的可执行项；
  parent 始终持有**尚未 reap 的直接 child**，因此不存在 PID 复用窗口。
- 不安装异步 SIGCHLD reaper，不启用 signal 竞态路径；只在 EOF、shutdown、signal 前置校验这三个
  明确时点用 ``waitpid(pid, WNOHANG)`` 同步收割。
- 默认不发送任何信号；只有携带显式一次性许可且 lease/pid/birth/PPID 全部匹配时，才允许一次 SIGKILL。
- 不支持组杀、后代杀或任意 signal 字符串；``resize`` 只做 ``TIOCSWINSZ``，SIGWINCH 由内核投递。
- 超时/control EOF 时写残留 artifact 并保留现场，不杀 wrapper、不删临时根、不做 group kill。
"""

import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from datetime import datetime, timezone

POLL_SECONDS = 0.01
REAP_WAIT_SECONDS = 2.0
PS_TIMEOUT_SECONDS = 5.0
READ_CHUNK_BYTES = 65536
WINSZ_STRUCT = struct.Struct("HHHH")
# 请求里出现这些字段说明调用方想接管既有进程，直接拒绝。
FORBIDDEN_REQUEST_KEYS = (
    "pid",
    "attachPid",
    "attach",
    "existingPid",
    "pgid",
    "processGroup",
    "killGroup",
    "descendants",
)
# ps 读取 birth/PPID 时固定 C locale，只影响这一次采样，不改 child 环境。
PS_LOCALE = {"LANG": "C", "LC_ALL": "C"}


def _now():
    return datetime.now(timezone.utc).isoformat()


class ControlledPtyDriver:
    """单线程控制循环：stdin 收 JSONL 请求，stdout 发 JSONL 响应/事件，master fd 收 PTY raw 输出。"""

    def __init__(self):
        self.stdin_fd = sys.stdin.fileno()
        self.stdout = sys.stdout.buffer
        self.control_buffer = b""
        self.master_fd = None
        self.child_pid = None
        self.lease_id = None
        self.command = None
        self.args = []
        self.cwd = None
        self.artifact_dir = None
        self.reference_identity = None
        self.exit_info = None
        self.kill_delivered = False
        self.output_log = None
        self.output_log_path = None
        self.output_bytes = 0
        self.eof_seen = False
        self.should_exit = False

    # ---------- 输出协议 ----------

    def emit(self, event):
        line = json.dumps(event, ensure_ascii=False, default=str) + "\n"
        self.stdout.write(line.encode("utf-8"))
        self.stdout.flush()

    def respond(self, request, ok=True, **payload):
        self.emit({"type": "response", "id": request.get("id"), "ok": ok, **payload})

    # ---------- 身份采样（ps，仅 C locale） ----------

    def sample_identity(self, pid):
        if pid is None:
            return {"present": False, "reason": "no-child"}
        env = dict(os.environ)
        env.update(PS_LOCALE)
        try:
            proc = subprocess.run(
                ["ps", "-o", "lstart=,ppid=,comm=", "-p", str(pid)],
                capture_output=True,
                text=True,
                env=env,
                timeout=PS_TIMEOUT_SECONDS,
            )
        except Exception as error:  # 采样失败即身份未知，后续一律不发送信号
            return {"pid": pid, "present": False, "reason": type(error).__name__}
        rows = [row for row in proc.stdout.splitlines() if row.strip()]
        if not rows:
            return {"pid": pid, "present": False, "reason": "ps-empty"}
        parts = rows[0].strip().split(None, 6)
        if len(parts) < 6:
            return {"pid": pid, "present": False, "reason": "ps-unparsed"}
        try:
            ppid = int(parts[5])
        except ValueError:
            ppid = None
        return {
            "pid": pid,
            "present": True,
            # lstart 形如 "Wed Oct 15 09:58:12 2026"，占 5 个空白分隔字段。
            "birth": " ".join(parts[0:5]),
            "ppid": ppid,
            "command": parts[6] if len(parts) > 6 else "",
            "sampledAt": _now(),
        }

    def identity_matches(self, current):
        reference = self.reference_identity or {}
        return bool(
            current.get("present")
            and bool(reference.get("birth"))
            and current.get("birth") == reference.get("birth")
            and current.get("ppid") == os.getpid()
        )

    # ---------- 收割（只在明确时点同步执行） ----------

    def record_exit(self, pid, status, reason=None):
        if self.exit_info is not None:
            return self.exit_info
        info = {
            "pid": pid,
            "status": status,
            "code": None,
            "signal": None,
            "reapedAt": _now(),
        }
        if reason is not None:
            info["reason"] = reason
        if isinstance(status, int) and status >= 0:
            if os.WIFEXITED(status):
                info["code"] = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                info["signal"] = os.WTERMSIG(status)
        self.exit_info = info
        if self.output_log is not None:
            try:
                self.output_log.flush()
            except OSError:
                pass
        self.emit({"type": "exit", **info})
        return info

    def poll_exit(self):
        """非阻塞检查直接 child 是否已终止；已终止则记录 terminal 事实。"""
        if self.child_pid is None or self.exit_info is not None:
            return self.exit_info
        try:
            pid, status = os.waitpid(self.child_pid, os.WNOHANG)
        except ChildProcessError:
            return self.record_exit(self.child_pid, -1, reason="not-reapable")
        except InterruptedError:
            return None
        if pid == 0:
            return None
        return self.record_exit(pid, status)

    def await_reap(self, budget_seconds):
        """EOF 之后有界等待真实退出状态，期间继续排空 master，避免 child 写阻塞。"""
        deadline = time.monotonic() + max(0.0, budget_seconds)
        while self.exit_info is None and time.monotonic() < deadline:
            self.drain_master(POLL_SECONDS)
            self.poll_exit()
        return self.exit_info

    # ---------- master 读取 ----------

    def read_master(self):
        try:
            chunk = os.read(self.master_fd, READ_CHUNK_BYTES)
        except OSError as error:
            # macOS 上 child 退出后读取 master 抛 EIO，与 EOF 等价。
            if error.errno in (errno.EIO, errno.EBADF):
                chunk = b""
            else:
                self.emit({"type": "error", "reason": "master-read-failed", "error": type(error).__name__})
                chunk = b""
        if chunk:
            self.output_bytes += len(chunk)
            if self.output_log is not None:
                try:
                    self.output_log.write(chunk)
                    self.output_log.flush()
                except OSError:
                    pass
            self.emit({"type": "data", "base64": base64.b64encode(chunk).decode("ascii")})
            return
        self.eof_seen = True
        self.emit({"type": "eof", "outputBytes": self.output_bytes})
        self.await_reap(REAP_WAIT_SECONDS)

    def drain_master(self, timeout):
        if self.master_fd is None or self.eof_seen:
            time.sleep(timeout)
            return
        try:
            ready, _, _ = select.select([self.master_fd], [], [], timeout)
        except OSError:
            return
        if ready:
            self.read_master()

    # ---------- 残留 artifact ----------

    def write_residual(self, reason):
        if not self.artifact_dir or self.child_pid is None:
            return None
        payload = {
            "type": "residual",
            "reason": reason,
            "generatedAt": _now(),
            "driverPid": os.getpid(),
            "childPid": self.child_pid,
            "leaseId": self.lease_id,
            "command": self.command,
            "args": self.args,
            "cwd": self.cwd,
            "liveIdentity": self.sample_identity(self.child_pid),
            "referenceIdentity": self.reference_identity,
            "exit": self.exit_info,
            "outputBytes": self.output_bytes,
            "outputLog": self.output_log_path,
            "killDelivered": self.kill_delivered,
            "note": "driver 未发送任何组信号；driver 进程退出时内核可能向该 PTY 前台进程组投递 SIGHUP，是否处置由父层决定。",
        }
        try:
            os.makedirs(self.artifact_dir, exist_ok=True)
            path = os.path.join(self.artifact_dir, "residual-driver-%s.json" % self.child_pid)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
        except OSError as error:
            self.emit({"type": "error", "reason": "residual-write-failed", "error": type(error).__name__})
            return None
        self.emit({
            "type": "residual",
            "path": path,
            "reason": reason,
            "childPid": self.child_pid,
            "driverPid": os.getpid(),
            "leaseId": self.lease_id,
            "liveIdentity": payload["liveIdentity"],
            "exit": self.exit_info,
        })
        return path

    # ---------- 请求处理 ----------

    def handle_start(self, request):
        if self.child_pid is not None:
            return self.respond(request, ok=False, reason="already-started")
        for key in FORBIDDEN_REQUEST_KEYS:
            if key in request:
                return self.respond(request, ok=False, reason="external-pid-rejected", rejectedKey=key)
        command = request.get("command")
        args = request.get("args") or []
        if not isinstance(command, str) or not command:
            return self.respond(request, ok=False, reason="command-required")
        if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
            return self.respond(request, ok=False, reason="args-invalid")
        cwd = request.get("cwd") or os.getcwd()
        env = request.get("env")
        if env is not None and not isinstance(env, dict):
            return self.respond(request, ok=False, reason="env-invalid")
        try:
            cols = int(request.get("cols") or 80)
            rows = int(request.get("rows") or 24)
        except (TypeError, ValueError):
            return self.respond(request, ok=False, reason="geometry-invalid")
        artifact_dir = request.get("artifactDir")
        if artifact_dir is not None:
            try:
                os.makedirs(artifact_dir, exist_ok=True)
            except OSError as error:
                return self.respond(request, ok=False, reason="artifact-dir-failed", error=type(error).__name__)
            self.artifact_dir = artifact_dir
        try:
            pid, master_fd = pty.fork()
        except OSError as error:
            return self.respond(request, ok=False, reason="pty-fork-failed", error=type(error).__name__)
        if pid == 0:
            # child：先设定初始几何，再 chdir + execve 指定 launcher；任何失败都以 127 结束，不回到控制循环。
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, WINSZ_STRUCT.pack(rows, cols, 0, 0))
                os.chdir(cwd)
                os.execve(command, [command, *args], {str(k): str(v) for k, v in (env or os.environ).items()})
            except BaseException:
                os._exit(127)
        self.master_fd = master_fd
        self.child_pid = pid
        self.lease_id = os.urandom(8).hex()
        self.command = command
        self.args = list(args)
        self.cwd = cwd
        self.reference_identity = None  # 身份在 exec 稳定/ready 之后由 identity 请求采样
        try:
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, WINSZ_STRUCT.pack(rows, cols, 0, 0))
        except OSError as error:
            self.emit({"type": "error", "reason": "initial-winsize-failed", "error": type(error).__name__})
        if self.artifact_dir:
            self.output_log_path = os.path.join(self.artifact_dir, "pty-output.log")
            try:
                self.output_log = open(self.output_log_path, "ab")
            except OSError as error:
                self.output_log = None
                self.emit({"type": "error", "reason": "output-log-failed", "error": type(error).__name__})
        return self.respond(
            request,
            pid=pid,
            leaseId=self.lease_id,
            driverPid=os.getpid(),
            cols=cols,
            rows=rows,
            outputLog=self.output_log_path,
        )

    def handle_write(self, request):
        data = request.get("data")
        if not isinstance(data, str):
            return self.respond(request, ok=False, reason="data-required")
        if self.master_fd is None:
            return self.respond(request, ok=False, reason="no-pty")
        payload = data.encode("utf-8")
        written = 0
        try:
            while written < len(payload):
                written += os.write(self.master_fd, payload[written:])
        except OSError as error:
            if error.errno not in (errno.EIO, errno.EBADF, errno.EPIPE):
                return self.respond(request, ok=False, reason="write-failed", error=type(error).__name__)
            return self.respond(request, ok=False, reason="master-closed", bytesWritten=written)
        return self.respond(request, bytesWritten=written)

    def handle_resize(self, request):
        if self.master_fd is None:
            return self.respond(request, ok=False, reason="no-pty")
        try:
            cols = int(request.get("cols"))
            rows = int(request.get("rows"))
        except (TypeError, ValueError):
            return self.respond(request, ok=False, reason="geometry-invalid")
        if cols <= 0 or rows <= 0:
            return self.respond(request, ok=False, reason="geometry-invalid")
        try:
            # 只对本 PTY 调 TIOCSWINSZ；SIGWINCH 由内核投递给该 PTY 前台进程组，driver 不额外补发。
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, WINSZ_STRUCT.pack(rows, cols, 0, 0))
            applied = WINSZ_STRUCT.unpack(fcntl.ioctl(self.master_fd, termios.TIOCGWINSZ, b"\0" * 8))
        except OSError as error:
            return self.respond(request, ok=False, reason="resize-failed", error=type(error).__name__)
        return self.respond(request, cols=cols, rows=rows, appliedRows=applied[0], appliedCols=applied[1])

    def handle_identity(self, request):
        if self.child_pid is None:
            return self.respond(request, ok=False, reason="no-child")
        current = self.sample_identity(self.child_pid)
        if self.reference_identity is None:
            self.reference_identity = current
            recorded = True
        else:
            recorded = False
        return self.respond(
            request,
            identity=current,
            recorded=recorded,
            matches=self.identity_matches(current),
            driverPid=os.getpid(),
            exited=self.exit_info is not None,
        )

    def handle_signal(self, request):
        authorization = request.get("authorization")
        if not isinstance(authorization, dict) or authorization.get("explicitOneTimePermission") is not True:
            return self.respond(request, ok=False, delivered=False, reason="unauthorized-missing-permission")
        for key in ("group", "processGroup", "pgid", "killGroup", "descendants"):
            if authorization.get(key):
                return self.respond(request, ok=False, delivered=False, reason="group-kill-forbidden")
        if self.child_pid is None:
            return self.respond(request, ok=False, delivered=False, reason="no-child")
        if authorization.get("leaseId") != self.lease_id:
            return self.respond(request, ok=False, delivered=False, reason="lease-mismatch")
        if authorization.get("pid") != self.child_pid:
            return self.respond(request, ok=False, delivered=False, reason="pid-mismatch")
        if authorization.get("signal", "SIGKILL") != "SIGKILL":
            return self.respond(request, ok=False, delivered=False, reason="unsupported-signal")
        if self.kill_delivered:
            return self.respond(request, ok=False, delivered=False, reason="lease-already-consumed")
        # 已终止（含 zombie 已被收割）立即记 terminal 并拒 signal。
        if self.exit_info is not None or self.poll_exit() is not None:
            return self.respond(
                request, ok=False, delivered=False, reason="already-terminal", exit=self.exit_info
            )
        current = self.sample_identity(self.child_pid)
        if not current.get("present"):
            return self.respond(request, ok=False, delivered=False, reason="identity-unknown", identity=current)
        if self.reference_identity is None:
            return self.respond(
                request, ok=False, delivered=False, reason="identity-not-sampled", identity=current
            )
        if not self.identity_matches(current):
            return self.respond(request, ok=False, delivered=False, reason="identity-mismatch", identity=current)
        try:
            os.kill(self.child_pid, signal.SIGKILL)
        except OSError as error:
            return self.respond(request, ok=False, delivered=False, reason="kill-failed", error=type(error).__name__)
        self.kill_delivered = True
        self.await_reap(REAP_WAIT_SECONDS)
        return self.respond(
            request,
            delivered=True,
            signal="SIGKILL",
            identity=current,
            exit=self.exit_info,
            note="SIGKILL 的返回不代表退出证明；退出事实以 waitpid 收割结果为准。",
        )

    def handle_shutdown(self, request):
        try:
            timeout_ms = float(request.get("timeoutMs") or 0)
        except (TypeError, ValueError):
            timeout_ms = 0.0
        deadline = time.monotonic() + max(0.0, timeout_ms / 1000.0)
        while self.exit_info is None and time.monotonic() < deadline:
            self.drain_master(POLL_SECONDS)
            self.poll_exit()
        if self.exit_info is None:
            self.poll_exit()
        if self.exit_info is None:
            residual_path = self.write_residual("shutdown-deadline-exceeded")
            return self.respond(
                request,
                ok=False,
                reason="deadline-exceeded",
                childPid=self.child_pid,
                liveIdentity=self.sample_identity(self.child_pid),
                residualPath=residual_path,
                outputBytes=self.output_bytes,
            )
        exit_info = self.exit_info
        self.finish_child_resources()
        self.emit({"type": "driver-exit", "exit": exit_info, "outputBytes": self.output_bytes})
        self.should_exit = True
        return self.respond(request, exit=exit_info, outputBytes=self.output_bytes, outputLog=self.output_log_path)

    def finish_child_resources(self):
        if self.output_log is not None:
            try:
                self.output_log.flush()
                self.output_log.close()
            except OSError:
                pass
            self.output_log = None
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

    def handle_control_eof(self):
        """控制通道关闭：不擅自杀进程，只在 child 仍存活时写残留证据后退出。"""
        if self.exit_info is None and self.child_pid is not None:
            self.poll_exit()
        if self.exit_info is None and self.child_pid is not None:
            self.write_residual("control-eof")
            self.emit({
                "type": "driver-exit",
                "reason": "control-eof-with-live-child",
                "childPid": self.child_pid,
            })
        else:
            self.finish_child_resources()
            self.emit({"type": "driver-exit", "reason": "control-eof-after-exit", "exit": self.exit_info})
        try:
            self.stdout.flush()
        except Exception:
            pass
        self.should_exit = True

    # ---------- 控制循环 ----------

    def dispatch(self, line):
        try:
            request = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self.emit({"type": "error", "reason": "control-line-invalid", "error": type(error).__name__})
            return
        if not isinstance(request, dict):
            self.emit({"type": "error", "reason": "control-request-invalid"})
            return
        method = request.get("method")
        handlers = {
            "start": self.handle_start,
            "write": self.handle_write,
            "resize": self.handle_resize,
            "identity": self.handle_identity,
            "signal": self.handle_signal,
            "shutdown": self.handle_shutdown,
        }
        handler = handlers.get(method)
        if handler is None:
            return self.respond(request, ok=False, reason="method-unsupported", method=str(method))
        try:
            return handler(request)
        except Exception as error:  # driver 不因单个请求崩溃，保留现场
            return self.respond(request, ok=False, reason="driver-error", error=type(error).__name__)

    def run(self):
        self.emit({"type": "hello", "driverPid": os.getpid(), "protocol": 1})
        while not self.should_exit:
            read_fds = [self.stdin_fd]
            if self.master_fd is not None and not self.eof_seen:
                read_fds.append(self.master_fd)
            try:
                ready, _, _ = select.select(read_fds, [], [], POLL_SECONDS)
            except InterruptedError:
                continue
            except OSError as error:
                if error.errno == errno.EINTR:
                    continue
                self.emit({"type": "error", "reason": "select-failed", "error": type(error).__name__})
                break
            if self.stdin_fd in ready:
                try:
                    chunk = os.read(self.stdin_fd, READ_CHUNK_BYTES)
                except OSError:
                    chunk = b""
                if not chunk:
                    self.handle_control_eof()
                    break
                self.control_buffer += chunk
                while b"\n" in self.control_buffer:
                    line, self.control_buffer = self.control_buffer.split(b"\n", 1)
                    if line.strip():
                        self.dispatch(line)
                    if self.should_exit:
                        break
            if self.should_exit:
                break
            if self.master_fd is not None and self.master_fd in ready:
                self.read_master()
        self.finish_child_resources()
        return 0


def main():
    driver = ControlledPtyDriver()
    try:
        return driver.run()
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
