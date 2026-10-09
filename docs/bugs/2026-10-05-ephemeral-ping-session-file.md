# 新组合合法ephemeral ping被拒绝

分类1：官方1.0.2 physical CLI --no-session加载正式runtime，真实provider调用typed subagent，RPC ping由上游0.75 sessionData返回sessionFile:null、合法sessionId/cwd与完整安全capabilities。首偏离点是本仓negotiateCapabilities把null也视作缺失；现有assertSpawnCapabilities本就支持sessionId fallback，合同不一致。

完整链：physical CLI → synthetic provider规范toolCall → typed generic dispatch → RPC ping → upstream sessionData(getSessionFile()??null) → negotiateCapabilities拒绝sessionFile。未伪造身份或事件。C1证据在/tmp/joint-contact-e2e-bmNXiT，精准单元RED见j5-ephemeral-ping-red-22.log。

最小修复仅允许显式null表示ephemeral；字段缺失、空串、非法类型仍fail closed。仅改新组合候选，不修0.87.1基线。
