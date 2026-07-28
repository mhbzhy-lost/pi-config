# Bug：Native child renderer 混淆主题缓存并拒绝后续有效 trusted root

## 1. 现象

`NativeChildConversationRenderer` 的 cache key 使用 `String(markdownTheme)` 作为主题身份。Pi 0.82.1 的真实 `getMarkdownTheme()` 对象没有 `identity` 或 `name`，字符串恒为 `[object Object]`，不同主题会命中同一渲染缓存。

同时，trusted roots 通过 `trustedRoots.map(realpathSync)` 一次性解析；只要列表中较早的 root 不存在，即使后面存在且包含合法 session file，也会立即返回 warning。

此外，`rendered` Map 以每个 fingerprint/render option 组合为永久 key。Child session 每次 append 都产生新 fingerprint，旧 fingerprint 对应的整份 conversation lines 永不淘汰。

## 2. 影响

主题切换后可能继续显示旧主题生成的 ANSI/Markdown 行，直到显式 invalidate 或 session fingerprint 改变。合法 child session 可能因为一个无关的缺失候选 root 无法打开，导致 native renderer 错误回退 Fleet 或只显示 warning。

长时间运行且持续 append 的 child 会为每个历史版本保留一份越来越长的 rendered lines，累计内存可能按 conversation 长度近似二次增长，直到 session/theme 显式 invalidate。

## 3. 稳定复现

- Theme：调用真实 `getMarkdownTheme()`，其 keys 不含 `identity/name`，`String(theme)` 为 `[object Object]`；另一个主题对象产生相同 key。
- Trusted root：创建合法 session 于 `sessions/`，以 `[missingRoot, sessions]` 调用 renderer；当前结果为 `ENOENT ... missing`，未继续检查有效 `sessions` root。
- Cache growth：对同一 session 连续 render 并 append 8 次后，`sessions.size` 仍为 1，但 `rendered.size` 增长到 8；每项都保留完整 lines。

三条独立 probe 均在 Pi 0.82.1 当前实现上复现。

## 4. 证据

`themeIdentity()` 当前返回 `String(theme.identity ?? theme.name ?? theme)`。真实 theme 进入最后分支，普通对象字符串不具备对象身份。

`checkPath()` 当前执行 `trustedRoots.map((root) => fs.realpathSync(root))`。`realpathSync()` 在第一个不存在 root 抛错，整个 render catch 立即返回 warning，未保留其他 existing roots。

`render()` 在每个新 key 后执行 `this.rendered.set(key, result)`，但只有 `invalidate()` 会 clear；fingerprint 更新时仅替换 `sessions` 中的当前 parsed items，不删除同 realPath 的历史 rendered entries。

现有 cache 测试只验证 open 次数，不检查不同主题对象或历史 fingerprint 的 cache 数量；安全测试只传单个 existing root，因此未覆盖这些分支。

## 5. 根因

缓存设计把“对象字符串表示”误当作“对象身份”，但 Pi MarkdownTheme 没有稳定字符串 ID。可信路径检查则把候选 root 的解析失败建模成整体失败，而计划合同要求 session realpath 位于至少一个 existing trusted root，意味着不存在的候选应被忽略，所有候选都无效时才失败。

同一缓存还把 fingerprint 纳入 key 却没有 per-session generation 淘汰策略，将“保留当前 session 解析结果”和“保留所有历史渲染版本”混为一体。

## 6. 修复与验证策略

先增加 RED 测试：两个结构相同但身份不同的 theme 必须分别渲染；`[missing, valid]` 必须允许合法 session；全部 roots 不存在或 session 不在任何 existing root 时仍 fail closed；连续 append/render 后每个 realPath 只保留当前 fingerprint 的 bounded render variants。最小实现可用 renderer-owned `WeakMap<object, id>` 提供进程内 theme identity，逐个解析 root 并忽略不存在/不可解析项，并在 fingerprint 变化时淘汰该 session 的旧 rendered keys。不得把 session path 自身加入 roots，也不得放宽 realpath containment、symlink 或大小边界。
