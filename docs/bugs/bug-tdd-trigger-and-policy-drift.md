# TDD 触发与规则漂移

## 问题描述

TDD Skill 的触发描述只覆盖 feature 和 bugfix，AGENTS 缺少最小加载门禁；同时 Skill 把所有生产或 Skill 逻辑变更都要求写 `docs/bugs/bug-*.md`，与 AGENTS 仅对 bug/issue/incident 使用 `docs/bugs/<日期>-<摘要>.md` 的规则冲突。

## 复现步骤

1. 阅读 TDD Skill 的 front matter，确认没有 production code、configuration、Skill behavior、refactor、behavior change，以及先实现后补失败测试或仅手测等触发症状。
2. 阅读 `pi/AGENTS.md` 的 Bugfix 段后内容，确认没有首次逻辑修改前加载 TDD Skill 的最小路由。
3. 阅读 TDD Skill 的本地化规则，确认它要求所有生产或 Skill 逻辑变更建立 `docs/bugs/bug-*.md`，包括 feature、refactor、configuration 和非 bug Skill 变更。
4. 新增路由策略测试并运行，观察其在旧规则上失败。

## 修复方案

1. 扩充 TDD description，使其覆盖生产代码、配置、Skill 逻辑或行为、feature、bugfix、refactor、行为变更，以及先实现后补失败测试或仅手测的症状。
2. 在 AGENTS 的 Bugfix 段后只增加首次修改前加载 Skill 的路由；RED-GREEN-REFACTOR 流程和豁免规则仅保留在 Skill。
3. 让三类显式豁免先判定；铁律和 No exceptions 仅约束非豁免变更。
4. 仅对 bug/issue/incident 修复要求 AGENTS 规定格式的文档；feature、refactor、configuration、Skill 非 bug 变更不创建伪 bug 文档。

## 真实 RED 摘要

执行 `node --test test/tdd-routing-policy.test.mjs`（新增测试后、实现前）实际为 3 项失败、0 项通过：旧 TDD description 不含 `production code`，AGENTS 的 Bugfix 段后没有 `## 逻辑变更` 路由，且 Skill 没有“三类显式豁免优先”门禁。失败发生在策略文本断言，而不是测试运行错误。
