# Heartbeat fixture 显式类型检查尾项

## 来源与最小修复

显式编译两份自造fixture时，TypeScript5.9.3沿import进入production `process-birth-identity.ts`，三处向原生Error赋`code`触发TS2339。入口是正式tsc而非fixture制造的非法状态；运行时Error.code本来就被模块写入并由公开调用方消费，首偏离点是该模块没有声明Error扩展类型，不是birth/locale/identity语义错误。

最小修复仅给三个既有Error对象声明`Error & {code: <对应字面错误码>}`；不改变message/cause/argv/hash/identity判定，不加兼容或fallback，不改上游。

## 验收状态

- 最小修复：三处既有错误对象增加精确 `Error & { code: ... }` 类型断言；运行时行为不变。
- `node --test test/process-birth-identity.test.mjs`：exit0，8/8。
- package TypeScript5.9.3 显式编译两份 heartbeat fixture：exit0。
- 默认关闭heartbeat harness：exit0，2 pass/1 skip；未重复SIGKILL。
- 同一命令链实际 exit0；P3已另行以一次受控SIGKILL通过，不把P3当类型检查证明。
