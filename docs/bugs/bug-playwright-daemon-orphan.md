# Bug: playwright.py daemon 孤儿残留导致 CPU 空转与系统睡眠被阻止

## 现象

- `/Users/mhbzhy/pi-config/skill-overrides/playwright/playwright.py` 启动的 daemon → `npx @playwright/mcp` → Chrome 整条进程链在调用方退出后永久存活：
  - 本机实测两个残留实例 `werewolf-manual-play`（5 天）、`hz-iperf`（3.8 天），父进程早已退出（PPID=1）
  - 残留 Chrome 的 audio helper 持有 `BuiltInSpeakerDevice` 音频输出，触发 coreaudiod 的 `PreventUserIdleSystemSleep` 断言（实测持续 5 小时 22 分），系统无法进入睡眠
  - 残留 renderer 持续空转：单个 renderer 累计 9.3 小时 CPU 时间，家族合计 6.5% CPU 常驻

## 影响

- 每残留一个实例持续消耗 CPU（实测 ~6.5% 家族级）
- 阻止系统睡眠，无人值守时电池持续放电至 1% 被强制休眠（8/5、8/6 两次实测）
- 状态目录 `/tmp/pi-playwright-mcp/<instance>/` 永久累积

## 根因

`run_daemon()` 的主循环为：

```python
while mcp.poll() is None:
    try:
        conn, _ = server.accept()
    except socket.timeout:
        continue
```

**没有任何空闲/超时/孤儿判定**。daemon 设计为「持久服务 + 显式 `stop`」，生命周期完全依赖调用方（agent 会话）记得收尾；调用方异常退出或遗忘 `stop` 时（`start_new_session=True` 使 daemon 脱离会话、父进程退出后由 launchd 收养），链条永久存活。`@playwright/mcp` 0.0.78 亦无内置 idle/browser-timeout 参数（已核实 `--help` 全量选项），回收责任只能落在 wrapper 层。

## 触发条件

- 调用方（agent 会话）在 `start` 后异常退出、崩溃、或遗忘执行 `stop`/`stopall`，且 daemon 未被任何后续流程清理

## 修复方案

在 `playwright.py` 增加两层自动回收：

1. **daemon 空闲超时自愈**：daemon 记录 `last_activity`（内存 + 持久化到状态文件），主循环 `socket.timeout` 节拍中检查「无客户端连接超过阈值且无 pending 请求」→ 退出并走现有 finally 清理（socket unlink + mcp terminate）。阈值优先级：`--idle-timeout` 参数 > 环境变量 `PI_PLAYWRIGHT_IDLE_TIMEOUT` > 默认 1800s
2. **start 前 reap 兜底**：`do_start` 遍历其他实例，对「daemon 存活且 last_activity 过期」的实例执行与 `do_stop` 相同的清理；无 `last_activity` 文件的旧版实例保守跳过
3. **stop/stopall/reap 完整清理状态目录**：清理列表补齐 `last_activity` 与 `daemon.log`（原 do_stop/do_stopall 从不删除 daemon.log，导致 rmdir 失败、状态目录永久残留——本机 `/tmp/pi-playwright-mcp` 下历史遗留目录即此因）
4. 测试钩子：环境变量 `PI_PLAYWRIGHT_MCP_CMD` 注入 mcp 子进程命令（测试用 fake MCP，不依赖 npx/网络）

## 验证方法

- `skill-overrides/playwright/test_playwright_idle.py`（unittest，5 用例）：
  - T1 无连接时 daemon 到点自动退出且 socket/mcp 清理干净
  - T2 有活动连接时不过期且 last_activity 文件被写入
  - T3 `start` reap 过期实例、保留活跃实例
  - T4 无 last_activity 文件的旧实例不被误杀
  - T5 `stop` 完整移除状态目录（含 last_activity 与 daemon.log）
- 真实实例冒烟：`start → status → call → stop` 流程与输出格式保持兼容
