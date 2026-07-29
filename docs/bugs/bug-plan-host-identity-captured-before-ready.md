# Standalone Plan Host在就绪前捕获进程身份

## 1. 现象

完整聚焦套件并行运行时，`default Host identity fencing recognizes only the spawned process token` 间歇失败；单独运行通常通过。Host在keeper shell执行真正的Pi进程前便读取了进程命令信息，得到的是即将被替换的shell身份。

## 2. 影响范围

- 新建Plan Runner可能在首次reconcile时被误判为PID复用或身份不匹配。
- 启动阶段失败时可能对尚未取得session proof的进程绑定不稳定身份。
- 该问题影响使用默认身份捕获的Standalone Plan Host，不改变已有PID fencing规则。

## 3. 复现步骤

1. 启动Standalone Host，使keeper shell在同一PID上`exec`真实Pi。
2. 在`ready`承诺完成前调用默认`captureHostIdentity`。
3. 等待Pi输出`session`事件后执行identity fencing；重复并行聚焦套件可观察到不匹配。

## 4. 根因

`spawnPlanRunner`在等待`result.ready`之前调用`captureHostIdentity`。默认身份包含`lstart`和command；`exec`保持PID与启动时间不变却改变command，因此捕获到的shell token不再属于就绪后的Pi进程。

## 5. 修复方案

先校验spawn结果的PID，再等待`ready`取得session proof；若启动失败则停止Host且不捕获身份。启动成功后才采用直接身份或捕获默认身份；身份捕获失败仍停止Host。最后再解析session文件并构造handle。

## 6. 验证方式

- 使用可控deferred `ready`的注入式测试，断言identity仅在ready完成后捕获；旧顺序稳定失败。
- 验证ready拒绝时调用`stopHost`且不调用`captureHostIdentity`，包括spawn直接提供身份的场景。
- 验证ready成功后identity捕获失败仍清理Host。
- 连续五轮运行Task 3完整聚焦套件，并执行指定单测、回归、diff与工作树检查。
