// 根后台活动显示 feature 公开入口（统一执行计划 F1/F5a/F5b/F6 / footer 子计划 T1/T5/T6）。
// 协议与 registry 一律经 package 公共出口 `pi-subagents-enhanced/tui/background-activity`
// 的 bare specifier 消费：不深引 package src，不在根重复实现 registry，也不反向
// 把 package 接到根源码。本文件只导出已创建模块：package 协议 re-export（F1）、
// layout（F5a）、detail-controller/presenter（F5b）；F6 的根 Host 入口
// `pi/extensions/background-activity.ts` 只消费本入口已有的 presenter factory
// （activityPresenterFactoryFor/defaultActivityPresenterUiDependencies）与协议握手 helper，
// 因此本阶段无新增模块可导出，也不提前 re-export 不存在的文件。

export * from "pi-subagents-enhanced/tui/background-activity";
export * from "./layout.ts";
export * from "./detail-controller.ts";
export * from "./presenter.ts";
