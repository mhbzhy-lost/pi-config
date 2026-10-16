// package 公开 TUI 出口（统一执行计划 F1/F2b / footer 子计划 T1/T2b）。
// 只导出已创建模块：background-activity 协议与 registry（F1/T1）、subagent
// provider 工厂与纯投影 helper（F2b/T2b）。footer-runtime 仍由薄 entry 直接
// 消费；F6 之前的 owner 接线能力不提前导出，未创建的模块不出现。

export * from "./background-activity.ts";
export * from "./subagent-activity.ts";
