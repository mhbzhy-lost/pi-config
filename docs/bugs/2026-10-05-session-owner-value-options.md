# session-owner未消费1.0.2 CLI新值参数

来源分类1。入口为wrapper脚本调用classifyPiLaunch，输入合法Pi1.0.2 CLI `-n -c`；官方parseArgs证明`-c`是name值而非continue操作。首偏离点为VALUE_OPTIONS未含-n/-t/-xt/--use-theme/--tui-mode。身份和调用顺序均来自合法wrapper输入，无模拟事件或倒退时间。

精确RED：j4-session-red-22.log：-n的值-c错误生成continue intent。修复仅补官方值参数集，不扩大session-owner到SDK/bare binary/官方RPC。
