# Bug：Native session snapshot 手工截断 JSONL 尾行并丢弃合法无换行记录

## 1. 现象

`materializeSnapshot()` 检查源文件最后一个字节；不是换行时就向后扫描最后一个 `\n`，只复制该位置之前的字节。完整 JSON record 如果文件末尾没有换行也会被当作 partial tail 丢弃；单条无换行 session 会复制为空文件。

## 2. 影响

合法 child session 的最后一条完整消息可能在 footer 中消失。实现还自行解释 JSONL framing，违反计划“只能使用公开 `SessionManager` parser，不自行解析 JSONL”的边界，增加与 Pi parser 语义漂移的风险。

## 3. 稳定复现

创建包含完整 JSON session record 但末尾无换行的 regular file，通过当前 snapshot 后得到 0 字节或只保留更早 records。相对地，真实 `SessionManager.open()` 对“完整 session + partial trailing JSON”可返回 2 个 context entries 并保留完整消息，已由独立 probe 验证。

## 4. 证据

`materializeSnapshot()` 从 `checked.size - 1` 读取最后字节，并在非 `0x0a` 时循环搜索最后换行，将 `copySize` 默认为 0。该逻辑不验证最后一段是否其实是完整 JSON，只按换行猜测。

现有 partial test 因完整 session records 本身带换行而通过，未覆盖“完整末行无换行”。

## 5. 根因

安全 snapshot 与 parser 容错职责混合。Snapshot 层应只复制经 fd/size 授权的字节；partial JSON 的识别和忽略属于 Pi `SessionManager.open()` 的公开 parser 语义。

## 6. 修复与验证策略

先增加无末尾换行完整 record 的 RED 测试，并保留“完整 session + partial tail”测试。删除 newline 扫描，严格复制 fstat 时确认的 `size` 字节，由公开 Pi parser 决定 partial/complete。不得引入 JSON.parse、字符串 framing 或其他自定义 JSONL 解析；继续保持 fd 绑定、64 MiB 上限、snapshot cleanup 和 cache-hit 不复制。
