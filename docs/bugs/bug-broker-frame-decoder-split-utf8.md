# Bug: Broker frame decoder 破坏跨 chunk UTF-8 字符

## 症状

Subscription decoder 对每个 `Buffer` chunk 单独调用 `chunk.toString("utf8")` 后拼接字符串。若一个多字节 UTF-8 字符被 Unix stream 分到两个 data chunk，前后两段会分别解码为替换字符，最终 JSON 虽可能仍可解析，但 lifecycle 文本字段已被静默篡改。

## 影响

`ProcessTerminalV1.diagnostic` 等允许 Unicode 的字段可能与 broker发送值不一致，破坏 proof 的原样转发与dedupe稳定性。分割位置由transport决定，ASCII测试无法覆盖。

## 复现

构造包含中文 diagnostic 的合法 newline frame，将其 Buffer 恰好切在一个汉字的UTF-8字节中间，分两次push给当前decoder。返回line中的字符变为两个U+FFFD，与原始JSON不相等。

## 根因

NDJSON decoder持有的是已逐chunk解码的string buffer，没有使用可保留不完整多字节序列的增量UTF-8 decoder。网络chunk边界被错误当作字符边界。

## 修复

decoder对Buffer输入使用Node `StringDecoder("utf8")` 增量解码，再按newline拆帧。逐帧检查完整`line + newline`字节上限；没有newline的残余partial frame单独检查累积字节。字符串输入保留给纯测试，但生产socket路径使用Buffer。

## 验证

增加纯decoder RED：合法Unicode frame在多字节字符内部切分后，第一批无完整line，第二批必须返回与原始JSON逐字相同的line。与多合法帧aggregate RED、protocol frame上限和真实subscription回归共同验证。
