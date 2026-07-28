# a1 feedback 命令参考

`a1 feedback` 用于向 a1、Devix 等内部产品各自的 Aone 反馈空间提交 bug 或需求，也可查询已提交的反馈。

## 路由与默认值

- 默认目标是 a1 自身的 Aone Cli 反馈空间 `2155669`。
- 其他产品必须用 `--project <space-id>` 指定其反馈空间，避免把问题写入 a1 空间。
- `--project` 和 `--assignee` 也可分别由 `A1_FEEDBACK_PROJECT_ID`、`A1_FEEDBACK_ASSIGNEE` 设置。
- 取值优先级是命令行 flag > 环境变量 > 内置默认值。
- `--assignee` 必须是目标空间的已注册成员；否则服务端会静默回落到 creator。提交前确认人员属于目标空间，避免反馈归属错误。

## 提交 bug

bug 是默认类型。`--product`、`--model`、`--command`、`--actual`、`--expected` 均为必填信息；它们用于复现和判断预期，不能只提交标题。

```bash
a1 feedback "project link 搜索失败" \
  --product "Claude Code" \
  --model "claude-opus-4-7" \
  --command 'a1 project link "Aone AI"' \
  --actual "No results" \
  --expected "应返回项目并完成绑定"
```

切换产品反馈空间或指定负责人：

```bash
a1 feedback "..." \
  --project 2161397 \
  --assignee 368136 \
  --product "..." \
  --model "..." \
  --command "..." \
  --actual "..." \
  --expected "..."
```

## 提交需求

需求使用 `--req`，其余复现和预期字段仍需提供完整上下文：

```bash
a1 feedback "希望支持按负责人过滤" \
  --req \
  --product "..." \
  --model "..." \
  --command "..." \
  --actual "..." \
  --expected "..."
```

## 查询反馈

```bash
a1 feedback list --me
a1 feedback list --me --status New
a1 feedback list --query "关键字" --project <space-id>
```

不确定当前版本支持的筛选或写入 flag 时，执行 `a1 feedback --help` 或 `a1 feedback list --help`，不要猜测参数名。

## 用户交流群

用户想加入 a1 用户交流、反馈问题或获取最新动态时，引导其加入钉钉群，群号 `185280011056`。
