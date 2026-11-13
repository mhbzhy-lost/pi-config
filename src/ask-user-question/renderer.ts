import { Text } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";

type Question = { question?: unknown };
type Answer = { question?: unknown; answer?: unknown; selected?: unknown };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function answerText(answer: Answer | undefined): string {
  if (!answer) return "";
  if (typeof answer.answer === "string") return text(answer.answer);
  if (Array.isArray(answer.selected)) return answer.selected.map(text).filter(Boolean).join(", ");
  return "";
}

function glyph(status: string | undefined, theme: any): string {
  if (status === "failure") return theme.fg("error", "✗");
  if (status === "loading") return theme.fg("warning", "…");
  if (status === "success") return theme.fg("success", "✓");
  return theme.fg("dim", "•");
}

export function createAskUserQuestionRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "ask_user_question") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(args: any, theme: any, context: any) {
        const questions = Array.isArray(args?.questions) ? args.questions as Question[] : [];
        context.state.questions = questions;
        return {
          render: () => {
            const answers = Array.isArray(context.state.answers) ? context.state.answers as Answer[] : [];
            const lines = questions.map((question, index) => {
              const answer = answerText(answers[index]);
              return `${glyph(context.state.status, theme)} ${theme.bold(name)} ${text(question.question)}${answer ? ` ${answer}` : ""}`;
            });
            return lines.length ? lines : [`${glyph(context.state.status, theme)} ${theme.bold(name)}`];
          },
          invalidate() {},
        };
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        const failed = context.isError || result?.isError === true;
        const answers = result?.details?.answers ?? result?.structuredContent?.answers;
        if (Array.isArray(answers)) context.state.answers = answers;
        context.state.status = failed ? "failure" : options.isPartial ? "loading" : "success";
        context.invalidate();
        return new Text("", 0, 0);
      },
    };
  };
}
