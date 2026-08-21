# Exa 脚本忽略本地 dotenv

## 现象

当前 `skill-overrides/exa-search/.env` 已存在（候选 worktree 不包含该文件，本次未读取真实文件），但 `exa.py` 只读取 process environment 中的 `EXA_API_KEY`。因此用户必须先用 `source` 将配置注入子 shell，脚本无法自动使用同目录的 gitignored dotenv。

pressure RED（结论引用：`e827b210`）确认了这一行为：Skill 说明要求用户手动 source，未显式设置 process env 时脚本直接报缺少 `EXA_API_KEY`。

## 影响

直接运行 Exa Skill 命令时，本地 dotenv 中的配置不会生效；同时手动 source 的步骤容易造成使用方式不一致。

## 安全边界

修复不得记录、打印或提交 API key；真实 `.env` 不在本次变更中读取或修改。
