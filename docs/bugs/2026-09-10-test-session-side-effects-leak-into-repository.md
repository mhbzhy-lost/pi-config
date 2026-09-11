# 测试运行时副作用泄漏到仓库

## 分类

这是 **fixture-only / test harness leakage**，不是 production launcher 或 runtime 的缺陷。本任务只修 `test/`、fixture 和 harness，不增加 production fallback，不修改 launcher 默认路径，也不删除已有 `pi/sessions`、`var/sessions` 或其他历史残留。

## 来源与首个偏离点

异常来源是测试 harness 创建 runtime 时没有始终将 session、lease、registry、workspace 和 Goal state 显式指向同一个 `os.tmpdir()` 下的独立 `mkdtemp` 根目录；其中 watch fixture 曾使用临时目录下的固定 PID 名称并缺少清理。部分 Goal 测试的 `.state/goal-engine` 是临时项目目录内的测试 state，不应写入真实仓库，但必须由 fixture cleanup 回收。

## 生成调用链

测试 -> fixture/harness 创建独立临时根目录 -> 通过 `SessionManager.create`、`--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、`PI_SESSION_OWNER_REGISTRY`、`PI_CODING_WORKSPACE_DIR`、`PI_CODING_GOAL_DIR` 或显式 state root 注入子目录 -> Pi/session-owner/workspace/Goal 测试 runtime 写入副作用 -> `t.after` 或 `finally` 递归清理。

## 修复边界

修复仅限测试与测试辅助代码：统一临时根目录、为失败/abort/timeout 路径注册 cleanup，并增加仓库 runtime 路径文件集合回归检查。不得读取现有 session JSONL 内容，不通过 `.gitignore` 掩盖泄漏，不修改 production 实现或 launcher 默认路径。
