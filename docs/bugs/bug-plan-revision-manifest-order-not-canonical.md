# Plan Revision Manifest 字段顺序未固定

## 现象

`validateRevisionArtifacts` 使用解析后的 manifest 对象重新序列化，接受字段值不变但字段顺序被重排的 `manifest.json`。

## 影响

已发布 revision 的 manifest 字节不再是唯一表示，外部替换字段顺序后的文件仍可被读取或作为幂等 prepare 的既有 revision 接受。

## 复现

准备一个合法 revision，读取 `manifest.json`，以逆序字段重建并使用相同两空格缩进和末尾换行写回；随后调用 `readRevision` 与相同输入的 `prepareRevision`。

## 根因

校验逻辑通过 `JSON.stringify(manifest, null, 2)` 从攻击者输入对象生成所谓 canonical 字节；JavaScript 保留解析时的属性插入顺序，现有键集合检查也未约束顺序。

## 修复

由 Store 定义的固定字段列表重建 manifest，仅以该对象的 pretty JSON 字节与磁盘字节精确比较；artifact 与重新编译结果一致后，返回 compiler 的递归冻结 IR。

## 验证

新增测试覆盖字段逆序但值不变的 manifest 必须被 `readRevision` 和幂等 `prepareRevision` 拒绝，并断言合法 reread 的 IR 根、`nodes` 和首个 node 均被冻结；运行 revision store 与 IR 回归测试。
