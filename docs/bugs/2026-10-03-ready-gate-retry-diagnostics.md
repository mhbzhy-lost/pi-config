# C4 ready gate 旧代清理重试缺少诊断

合法入口为同一 Pi 的 extension replacement；旧代 beforeDispose 因资源故障拒绝后，新代主动重试失败由空 catch 吞掉。首个偏离点是 extension.ts 的 previous.debt.run catch；债务保留与 ready 阻断本身正确。分类为 production 诊断缺陷，不改变重试、债务与授权判断。

精确 RED：替换旧代清理失败时 diagnosticSink 未收到原 error/cause。回归同时验证 ready 仍拒绝、解除故障后能够重试启动。
