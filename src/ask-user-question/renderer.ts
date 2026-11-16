import { MouseRegion, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { failedResultLine, resultStatus, setRenderStatus } from "../compact-tools/index.ts";

type Question = { question?: unknown; options?: unknown; multiSelect?: unknown };
type Option = { label?: unknown };
type Answer = { answer?: unknown; selected?: unknown };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function glyph(status: string | undefined, theme: any): string {
  if (status === "failure") return theme.fg("error", "✗");
  if (status === "loading") return theme.fg("warning", "…");
  if (status === "success") return theme.fg("success", "✓");
  return theme.fg("dim", "•");
}

// ●/○ 是 ambiguous width 字符（不同终端/locale 下占列不同），行是否超宽必须经 visibleWidth
// 判断，前缀（缩进+选中标记+空格）占几列不得硬编码；超宽行统一用 truncateToWidth 截断。
function fitLine(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
}

// 该问是否已有回答数据：多选以 selected 数组为准，单选以非空 answer 字符串为准。
function hasAnswerData(entry: Answer | null | undefined): boolean {
  if (entry === null || typeof entry !== "object") return false;
  if (Array.isArray(entry.selected)) return true;
  return typeof entry.answer === "string" && text(entry.answer) !== "";
}

// 防御退化：schema 已由运行时 tool 声明证实，此处仅对缺输入少显示（非兼容分支）。
// options 缺失或非数组，或任一 label 非 string 时，该问只渲染问题行，不渲染选项行。
function optionLabels(question: Question): string[] | undefined {
  if (!Array.isArray(question.options)) return undefined;
  const labels: string[] = [];
  for (const option of question.options as Option[]) {
    if (!option || typeof option !== "object" || typeof option.label !== "string") return undefined;
    labels.push(option.label);
  }
  return labels;
}

// 单问卡片块：问题行 + 选项行（选中标记）。自定义单选回答作为额外选项显示。
function questionLines(
  name: string,
  question: Question,
  entry: Answer | null | undefined,
  status: string | undefined,
  theme: any,
  width: number,
): string[] {
  const answered = hasAnswerData(entry);
  // 未回答（state.answers 无该问数据）：问题行 glyph 固定为 loading 态（…）。
  const head = `${answered ? glyph(status, theme) : glyph("loading", theme)} ${theme.bold(name)} ${text(question.question)}`;
  const labels = optionLabels(question);
  const selected = new Set<string>();
  let custom: string | undefined;
  if (answered && entry) {
    if (question.multiSelect === true) {
      // 多选：answer.selected 原文包含该 label → ●，未包含 → ○。
      for (const item of Array.isArray(entry.selected) ? entry.selected : []) {
        if (typeof item === "string") selected.add(item);
      }
    } else if (typeof entry.answer === "string") {
      // 单选：answer === 某 label → 该 label ●；answer 存在且不等于任何 label 时，
      // 将用户自定义输入作为额外的选项显示。
      if (labels?.includes(entry.answer)) selected.add(entry.answer);
      else custom = text(entry.answer);
    }
  }
  const lines = [fitLine(head, width)];
  if (labels) {
    for (const label of labels) {
      const isSelected = selected.has(label);
      // 选中标记：选中 ●（accent 色）、未选中 ○（dim 色）。
      // 显示层对 label 做空白归一化（text()），含换行的病态 label 不破坏单行假设；
      // 选中判定（selected/answer 与 label）仍用原文比对，显示与匹配解耦。
      lines.push(fitLine(`   ${theme.fg(isSelected ? "accent" : "dim", isSelected ? "●" : "○")} ${text(label)}`, width));
    }
    if (custom !== undefined) {
      lines.push(fitLine(`   ${theme.fg("accent", "●")} ${custom}`, width));
    }
  }
  return lines;
}

// content 全文：text 块 join("\n")，供失败展开视图与失败首行摘要共用。
function resultText(result: any): string {
  const content = typeof result?.content === "string"
    ? [result.content]
    : Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((block: any) => typeof block === "string" || block?.type === "text")
    .map((block: any) => (typeof block === "string" ? block : typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

// 卡片即全量信息：展开无增量内容，故吞掉左键 click 阻止 Host 的展开 toggle。
// Host 的 ToolExecutionComponent 会给每个工具组件强制包一层点击展开的 MouseRegion，其 handleMouse
// 先派发子组件，子组件返回 handled 即短路展开 toggle。失败态错误行不包此层，仍可点击展开看全文。
function swallowExpandClick(component: Component): MouseRegion {
  return new MouseRegion(component, (event) =>
    event.type === "click" && event.button === "left" ? { handled: true } : undefined,
  );
}

export function createAskUserQuestionRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "ask_user_question") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      // 卡片不随 expanded 变化：renderCall 不感知 expanded，折叠/展开渲染同一卡片。
      renderCall(args: any, theme: any, context: any) {
        const questions = Array.isArray(args?.questions) ? args.questions as Question[] : [];
        // state 机制复用现状：questions 写入 renderer state；answers 由 renderResult 写入同一 state，
        // 卡片在每次重绘时读取最新 answers。
        context.state.questions = questions;
        const card: Component = {
          render(width: number) {
            const answers = Array.isArray(context.state.answers) ? context.state.answers as (Answer | null)[] : [];
            const lines = questions.flatMap((question, index) =>
              questionLines(name, question, answers[index], context.state.status, theme, width),
            );
            // 无合法 questions 输入时退化为仅标题行，保证不崩。
            return lines.length ? lines : [fitLine(`${glyph(context.state.status, theme)} ${theme.bold(name)}`, width)];
          },
          invalidate() {},
        };
        return swallowExpandClick(card);
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        // answers 权威来源：details 优先，structuredContent 兜底（沿用现状）。
        const answers = result?.details?.answers ?? result?.structuredContent?.answers;
        if (Array.isArray(answers)) context.state.answers = answers;
        const status = resultStatus(result, options, context);
        setRenderStatus(context, status);
        if (status === "failure") {
          const full = resultText(result);
          if (options?.expanded) {
            // 失败展开：渲染 content 全文（text 块 join("\n") 的多行 Text）。
            return new Text(full, 0, 0);
          }
          // 失败折叠：单行错误首行，不吞点击（点击错误行可展开查看完整错误）。
          return failedResultLine({ truncateToWidth, text: full, theme });
        }
        // 成功/partial：卡片即全量信息，结果区收空。
        return new Text("", 0, 0);
      },
    };
  };
}
