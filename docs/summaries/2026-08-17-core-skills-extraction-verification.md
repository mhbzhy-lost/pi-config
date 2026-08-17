# 三个核心 Skill 本地化与 Superpowers 解耦验收总结

## 结论

`test-driven-development`、`writing-skills`、`writing-plans` 已迁入 `skill-overrides/`，三者的项目规则已从 `pi/AGENTS.md` 合并到对应 Skill。共享 Skill 解析器不再回退到 vendor；`.gitmodules` 与 `vendor/superpowers` 已移除。

## TDD 与迁移证据

- 问题记录：`docs/bugs/bug-superpowers-skill-source-coupling.md`
- 初始 RED：`test/core-skills-local.test.mjs` 五项迁移契约最初全部按预期失败，原因分别为本地 Skill 缺失、AGENTS 仍含 Override、子模块与 vendor 解析仍存在。
- GREEN：三个 Skill、AGENTS 收敛、单一解析根和活动文档无 vendor 引用均已转绿。
- TDD 豁免冲突曾被主验证发现并补回归断言：本地 TDD 只保留单行改动、纯文档、已有测试覆盖三类豁免，且必须显式声明理由。
- 白名单 README 曾因并发旧版本覆盖重新出现 vendor 文案；新增活动文件扫描先复现 RED，再恢复单一来源并转绿。

## 机械验收

用户明确要求不运行 Goal Engine 测试，因此最终验收未把全量 `npm test` 作为门禁；采用与本迁移直接相关的测试集合：

```bash
node --test \
  test/core-skills-local.test.mjs \
  test/global-rules.test.mjs \
  test/skill-list.test.mjs \
  test/migration-contract.test.mjs \
  test/init-pi.test.mjs
```

结果：29 项通过，0 失败，0 skipped，0 cancelled，0 todo。

```bash
npm run doctor
```

结果：通过；输出 `[ok] Pi Skill allowlist extension is ready` 和 `[ok] Root subagent broker: ready`。Doctor 同时报告已有 preserved/unmanaged/dirty worktree 警告，本任务未清理或修改这些受管理资源。

曾尝试运行一次全量 `npm test`，其中混入正在并发修改的 Pi 0.84.2/TUI 与 Goal Engine 测试并中止；按用户指示未继续运行 Goal Engine 测试，也未处理这些任务外失败。

## 运行时来源

```text
test-driven-development -> /Users/mhbzhy/pi-config/skill-overrides/test-driven-development
writing-skills          -> /Users/mhbzhy/pi-config/skill-overrides/writing-skills
writing-plans           -> /Users/mhbzhy/pi-config/skill-overrides/writing-plans
```

- `.gitmodules`：不存在
- `vendor/superpowers`：不存在
- 三个本地 Skill：无 `superpowers:`、`../using-superpowers/` 或 `vendor/superpowers` 引用
- `scripts/lib/skill-whitelist.mjs`：只解析 `skill-overrides/<name>`，保留 realpath 边界和 frontmatter fail-closed 校验
- Git staged changes：无

## 行为验收

### TDD

证据：`docs/summaries/artifacts/core-skills-extraction/tdd-behavior.md`

- 两行生产 bug 不允许直接实现；先建立 `docs/bugs/bug-*.md`，观察正确 RED，再写最小 GREEN。
- 一行纯文档可豁免，但必须显式声明“纯文档变更”这一理由。

### writing-skills

证据：`docs/summaries/artifacts/core-skills-extraction/writing-skills-behavior.md`

- 正确描述 `subagent-dispatch` + fresh-context 的 WITHOUT Skill RED、独立 WITH Skill GREEN、发现新合理化后的 REFACTOR/re-verify 闭环。
- 确认 Skill 内容允许全英文。
- 残余限制：这是隔离 spark 会话中的流程复核，不是实际完成 WITHOUT/WITH 两轮模型对照实验；报告已明确披露。

### writing-plans

证据：`docs/summaries/artifacts/core-skills-extraction/writing-plans-behavior.md`

- 中文计划包含正式 T0 接口契约任务。
- DAG 为 `T0 → T1/T2 → T3`；T1/T2 在 T0 后并行，T3 只消费 parser/formatter 两份契约符合性证据。
- 每项均包含 `Deps`、`WritePaths`、`Resources`、接口产物和可观察验收；DAG、三层 Wave 与关键路径一致。
- 提供 Subagent-Driven、Inline Execution、Goal Engine 三种交接方式；本次仅声明，未运行 Goal Engine。

## 范围与并发保护

- 没有创建 commit、push 或 staged changes。
- 没有清理 `.git/modules`、受管理 worktree 或历史 `docs/superpowers/` 归档。
- 当前工作区存在其他并行任务修改；本总结只确认本迁移声明路径和测试，不把任务外 diff 归入本次交付。
