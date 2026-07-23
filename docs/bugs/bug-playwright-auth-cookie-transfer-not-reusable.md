# Bug：Playwright 登录态提取缺少可复用安全流程

## 1. 现象

需要 Motu、钉钉文档等登录态时，自动化经常在 Cookie 过期后中断。每次临时编写 Cookie
导出、接收、校验和清理逻辑，且容易在 headless、headed、浏览器持久化目录之间误判登录状态。

## 2. 影响

- 长链路任务在运行中才发现 Cookie 已失效，前置步骤和等待时间被浪费。
- 临时方案可能把 Cookie 放入工具参数、标准输出、日志、磁盘或对话上下文。
- 不同站点重复实现相同流程，缺少域名最小化、有效性门禁和清理约束。

## 3. 稳定复现

1. 使用 headless Playwright 访问已过期登录态的目标站点。
2. 页面跳转到 SSO，或业务 API 返回 HTTP 200 但业务码表示重定向。
3. 尝试从 OSS 或本机 Chrome 复用旧 Cookie，目标 API仍拒绝认证。
4. 自动化无法继续，只能临时切换 headed 浏览器并重新设计 Cookie 转交流程。

## 4. 证据

- Motu SQL schema 探测连续使用 OSS Cookie和 Chrome Cookie，均返回业务码 `302` 与
  `JSON request has been redirect`。
- Playwright skill 只规定不得返回 Cookie，未说明如何安全地将登录态交给目标服务。
- 现有成功案例依赖一次性 localhost 接收器，但该模式未形成域名、有效性、输出和清理契约。

## 5. 根因

Playwright skill 缺少完整的登录态生命周期：先验证已有会话、必要时由用户在 headed 浏览器
登录、按目标 origin 最小化提取 Cookie、在浏览器进程内直接传给受控消费者、验证目标 API，
最后停止浏览器并清理临时接收器。只有“不要输出凭据”的禁令，不能指导 agent 完成安全交付。

## 6. 修复与验证策略

- 先运行不读取修改后 skill 的压力场景，记录 agent 在登录模式、Cookie 作用域、传输和清理上的
  缺口。
- 在 Playwright skill 增加站点无关的登录态获取与安全转交流程，覆盖 Cookie、localStorage 和
  sessionStorage 的不同边界，但默认只提取完成任务所需的最小凭据。
- 禁止将凭据放入工具参数、返回值、日志、截图、网络转储或持久化临时文件；使用仅监听
  `127.0.0.1` 的一次性内存消费者，返回计数和校验状态。
- 用 Motu 和文档站点两个场景复测，验证登录、域名最小化、有效性门禁、失败分类和清理步骤。
