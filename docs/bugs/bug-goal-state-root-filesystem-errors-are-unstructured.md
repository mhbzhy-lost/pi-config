# Bug：Goal 全局状态根文件系统错误缺少稳定合同

## 现象

当 `PI_CODING_GOAL_DIR` 的父路径不可写、不是目录或无法访问时，`ensureGoalStateIdentity()` 直接泄漏 `mkdirSync()`/`lstatSync()` 的原生 `EACCES`、`ENOENT` 或 `ENOTDIR`，没有 Goal Engine 稳定错误码。

## 影响

- 调用方无法区分全局状态根不可用与 identity 内容冲突。
- 不同平台返回的原生错误文本不同，自动恢复和测试无法依赖。
- 用户只能看到底层 syscall，而没有明确的目标路径和“修复目录访问权限后重试”边界。

## 根因

identity 内容和权限验证已有结构化错误，但 namespace 目录创建及首次 `lstat` 位于其 try/catch 之外。实现假设 `mkdirSync({ recursive: true })` 必然成功，没有把环境变量指向的外部文件系统视为可失败边界。

## 触发条件

1. 配置绝对 `PI_CODING_GOAL_DIR`；
2. 该路径或其父路径不可写、不可遍历或不是目录；
3. 调用会创建新 global namespace 的 `goal_init`。

## 修复方案

把 namespace 的 `mkdirSync` 与首次 `lstatSync` 纳入单一边界，原生文件系统异常转换为 `GOAL_STATE_ROOT_UNAVAILABLE`，错误中包含目标 namespace 路径。不得自动 chmod、删除、改名或回退 legacy root。

## 验证方法

- 在测试自有临时目录内创建不可写父目录，并让 preferred root 指向其子目录。
- RED 确认旧实现泄漏原生 `EACCES`；GREEN 后确认稳定错误码且没有创建 namespace。
- 恢复 fixture 权限后由测试自身清理；正常 identity 创建、幂等和权限门禁继续通过。
