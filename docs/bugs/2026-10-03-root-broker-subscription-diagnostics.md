# Root Broker 订阅异步失败缺少诊断

合法订阅激活后，lease read rejection 或 subscription.ready socket.write 同步失败原实现仅吞掉异常。修复仅注入 diagnosticSink，保留订阅/lease 的原有安全与非阻塞语义，不把诊断失败变成主流程失败。
