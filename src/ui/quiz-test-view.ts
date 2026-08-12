import { applyActionLayout, button, row, section, setStyles, text } from "./dom";
import { renderShell } from "./shell";
import type { QuizSession } from "../types";

interface QuizTestViewProps {
  session: QuizSession;
  sourceLabel?: string;
  onOpenSource?: () => void;
  onBack: () => void;
  onSelect: (key: string) => void;
  onSubmit: () => Promise<void>;
  onNext: () => void;
  onFinish: () => void;
}

export function renderQuizTestView(root: HTMLElement, props: QuizTestViewProps): void {
  const { session } = props;
  const content = renderShell(root, "Quiz", `${session.index + 1}/${session.questions.length}`, props.onBack);
  const question = session.questions[session.index];
  const card = section(content, "kf-quiz-test");
  const difficulty = row(card);
  setStyles(difficulty, { justifyContent: "flex-end" });
  text(difficulty, `难度 ${question.difficulty}/5`, "kf-pill");
  const questionRow = row(card);
  setStyles(questionRow, { alignItems: "flex-start", gap: "6px" });
  setStyles(questionRow.createSpan({ text: `${session.index + 1}.` }), {
    flex: "0 0 auto",
    fontSize: "15px",
    fontWeight: "650",
    lineHeight: "1.35"
  });
  setStyles(text(questionRow, question.question, "kf-card-title"), {
    minWidth: "0",
    overflowWrap: "anywhere",
    textAlign: "left",
    whiteSpace: "normal"
  });

  const options = card.createDiv({ cls: "kf-quiz-options" });
  setStyles(options, {
    display: "flex",
    flexDirection: "column",
    gap: "8px"
  });
  for (const option of question.options) {
    const selected = session.selectedKey === option.key;
    const isCorrect = session.submitted && option.key === question.answerKey;
    const isWrong = session.submitted && selected && option.key !== question.answerKey;
    const optionButton = options.createEl("button");
    setStyles(optionButton, {
      alignItems: "flex-start",
      backgroundColor: isCorrect
        ? "color-mix(in srgb, var(--interactive-accent) 18%, var(--background-primary))"
        : isWrong
          ? "color-mix(in srgb, var(--text-error) 12%, var(--background-primary))"
          : selected
            ? "color-mix(in srgb, var(--interactive-accent) 10%, var(--background-primary))"
            : "var(--background-primary)",
      border: `1px solid ${isCorrect ? "var(--interactive-accent)" : "color-mix(in srgb, var(--interactive-accent) 22%, var(--background-modifier-border))"}`,
      borderRadius: "8px",
      color: "var(--text-normal)",
      cursor: session.submitted ? "default" : "pointer",
      display: "flex",
      fontSize: "13px",
      height: "auto",
      justifyContent: "flex-start",
      lineHeight: "1.45",
      padding: "9px 10px",
      textAlign: "left",
      whiteSpace: "normal",
      width: "100%",
      wordBreak: "break-word"
    });
    setStyles(optionButton.createSpan({ text: `${option.key}.` }), {
      flex: "0 0 auto",
      lineHeight: "1.45"
    });
    setStyles(optionButton.createSpan({ text: option.content }), {
      minWidth: "0",
      overflowWrap: "anywhere",
      textAlign: "left",
      whiteSpace: "normal"
    });
    optionButton.disabled = session.submitted;
    optionButton.addEventListener("click", () => props.onSelect(option.key));
  }

  if (session.submitted) {
    const isCorrect = session.selectedKey === question.answerKey;
    const correctOption = question.options.find((option) => option.key === question.answerKey);
    const accentColor = isCorrect ? "var(--interactive-accent)" : "var(--text-error)";

    const explanation = card.createDiv({ cls: "kf-quiz-explanation" });
    setStyles(explanation, {
      backgroundColor: `color-mix(in srgb, ${accentColor} 8%, var(--background-secondary))`,
      border: `1px solid color-mix(in srgb, ${accentColor} 22%, var(--background-modifier-border))`,
      borderRadius: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "10px 12px"
    });
    setStyles(explanation.createDiv({ text: `${isCorrect ? "✓" : "✗"} 正确答案：${question.answerKey}. ${correctOption?.content ?? ""}` }), {
      color: accentColor,
      fontSize: "13px",
      fontWeight: "650",
      lineHeight: "1.45"
    });
    if (question.explanation) {
      text(explanation, question.explanation, "kf-muted");
    }
    if (props.sourceLabel && props.onOpenSource) {
      const source = explanation.createEl("button", {
        text: `查看原文 · ${props.sourceLabel}`
      });
      setStyles(source, {
        alignSelf: "flex-start",
        backgroundColor: "transparent",
        border: "0",
        color: "var(--interactive-accent)",
        cursor: "pointer",
        fontSize: "12px",
        height: "auto",
        padding: "2px 0"
      });
      source.addEventListener("click", props.onOpenSource);
    }
  }

  const actions = row(card, "kf-actions");
  applyActionLayout(actions);
  if (!session.submitted) {
    button(actions, "提交答案", props.onSubmit, true);
  } else if (session.index < session.questions.length - 1) {
    button(actions, "下一题", props.onNext, true);
  } else {
    button(actions, "完成测试", props.onFinish, true);
  }
}
