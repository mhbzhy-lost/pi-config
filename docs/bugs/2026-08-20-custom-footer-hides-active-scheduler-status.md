# Custom footer 隐藏活跃 scheduler 任务状态

## 问题

`pi-scheduler` 的 `scheduler: active` 只表示 scheduler runtime/lock active，并不表示存在 enabled 定时任务；曾因此在没有任务时误报。custom footer 也曾直接展示该旧 runtime 状态。

## 修复

adapter 保留精确上游 `scheduler_list` 定义，并仅将当前 session 返回的 `id/name/type/schedule/enabled/nextRunAt` 等展示字段投影为脱敏摘要：仅 `enabled === true` 的任务参与显示。一个任务显示 `⏱ <名称>`，多个显示 `⏱ <首个名称> +N`，无名称时回退到 type/schedule；控制字符、不可见 Unicode 和过长标签会被清理或截断。无 enabled 任务时通过 `setStatus("pi-scheduler", undefined)` 清除。

状态在 upstream `session_start` 完成、create/delete 返回后同步，并通过有界低频轮询反映自然执行造成的 enabled 变化。旧的 `scheduler: active/idle` runtime 状态不再作为 Footer 可见状态。

## 影响

Footer 仅展示真实活跃定时任务摘要，保持三行布局；没有活跃任务时第三行左侧为空。
