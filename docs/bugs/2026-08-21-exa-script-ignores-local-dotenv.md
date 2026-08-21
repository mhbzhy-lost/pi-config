# Exa 脚本忽略本地 dotenv

## 现象

当前 `skill-overrides/exa-search/.env` 已存在（候选 worktree 不包含该文件，本次未读取真实文件），但 `exa.py` 只读取 process environment 中的 `EXA_API_KEY`。因此用户必须先用 `source` 将配置注入子 shell，脚本无法自动使用同目录的 gitignored dotenv。

pressure RED（结论引用：`e827b210`）确认了这一行为：Skill 说明要求用户手动 source，未显式设置 process env 时脚本直接报缺少 `EXA_API_KEY`。

## 影响

直接运行 Exa Skill 命令时，本地 dotenv 中的配置不会生效；同时手动 source 的步骤容易造成使用方式不一致。

## 测试隔离边界

修复后的脚本将默认 sibling dotenv 路径定义为可替换的模块常量。测试模块加载后立即将该常量改为唯一且不存在的临时路径，因此常规认证、缺失 key 与空白 key 测试不会读取脚本同目录的 `.env`，即使该文件存在。

dotenv 专项测试仅将该常量替换为各自临时目录中的假 `.env`，以覆盖 fallback 行为；不再通过替换 `__file__` 间接控制路径。临时 sibling fixture 仅含假 key，并在 `finally` 中删除。修复不得记录、打印或提交 API key；真实 `.env` 不在本次变更中读取或修改。
