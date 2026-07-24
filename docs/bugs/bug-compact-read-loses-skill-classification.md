# Bug：Compact Read 丢失 SKILL.md 的 Skill 加载展示

## 1. 现象

启用 `compact-tools.ts` 后，agent 读取任意 `xxx/SKILL.md` 都显示为普通 `∗ read <path>`，折叠状态还会追加读取行数；Pi 原生的 Skill 加载标题消失。

## 2. 影响

用户无法在 transcript 中快速区分“加载工作流 Skill”和“读取普通文件”，Skill 加载还会产生无意义的折叠结果摘要，降低扫描效率。

## 3. 稳定复现

1. 启动启用 `compact-tools.ts` 的 Pi TUI。
2. 让 agent 调用 read 读取任意以 `SKILL.md` 结尾的路径。
3. 折叠状态显示 `∗ read .../SKILL.md` 和 `N lines`，而不是 Skill 名称。
4. 禁用 compact read override 后，Pi 原生 renderer 恢复 `[skill] <name>` 展示。

## 4. 证据

Pi 0.81.1 的原生 `read.js` 在折叠态调用 `getCompactReadClassification()`：文件名为 `SKILL.md` 时返回 `{ kind: "skill", label: <父目录名> }`，并隐藏折叠结果。当前 compact renderer 的 `read.renderCall()` 无条件调用 `pathCall("read", ...)`，`renderResult()` 也无条件生成行数摘要。

## 5. 根因

扩展完整替换了原生 read 的 call/result renderer，却只复刻了普通文件路径展示，没有复刻 `SKILL.md` 的分类及折叠结果抑制语义。已有测试只覆盖普通 read 标题和路径截断，因此未发现行为回归。

## 6. 修复与验证策略

在 compact read renderer 中按文件 basename 识别 `SKILL.md`。折叠态显示 `∗ skill <父目录名>` 并返回空结果组件；展开态继续显示普通 read 路径和完整内容。先增加三项失败断言，再实现最小分类逻辑，并执行 renderer、扩展加载和真实 TUI reload 验证。
