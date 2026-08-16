# Repair 授权重放不确定

Reducer 使用 `Date.now()`，重载后同一事件会因环境时钟得到不同结果；challenge 创建时提前发放 capability，且消费事件未与业务效果绑定，导致可绕过一次性授权。reject/link 未精确绑定 challenge，失败证据也可被误认为 fresh，取消证明仅按长度校验。

## 复现

创建 challenge 后在未来时间重放 decision；或批准后跳过 consume 直接 link/reject；记录 PASS 后记录 failed，再以旧 PASS 支持关闭 Episode。

## 修复

将时间写入 decision event，challenge 仅保存公开绑定；批准后的 Host 显式时间 mint capability，消费事件携带 digest 与全部绑定并与 link/reject 同一计划。Reducer 精确验证 challenge、元数据、证据 streak 和取消证明。
