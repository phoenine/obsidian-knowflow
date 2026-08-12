import type { DailyReviewSession } from "../../types";

export interface WeeklyReviewActivity {
  dailyQuestions: number[];
  sessionCount: number;
  averageAccuracy: number | null;
}

export function summarizeWeeklyReviewActivity(
  sessions: DailyReviewSession[],
  weekStart: Date,
  scopePath: string,
  articleRootPath: string
): WeeklyReviewActivity {
  const dailyQuestions = Array.from({ length: 7 }, () => 0);
  let sessionCount = 0;
  let answeredCount = 0;
  let correctCount = 0;
  const articleRootScope = scopePath === articleRootPath;

  for (const session of sessions) {
    if (!session.completedAt) continue;
    const questions = articleRootScope
      ? session.questions
      : session.questions.filter((question) => question.articlePath.startsWith(`${scopePath}/`));
    if (questions.length === 0) continue;

    sessionCount += 1;
    for (const question of questions) {
      const answer = session.answers[question.key];
      if (!answer) continue;
      answeredCount += 1;
      if (answer.correct) correctCount += 1;
    }

    const completedAt = new Date(session.completedAt);
    const localDay = new Date(completedAt.getFullYear(), completedAt.getMonth(), completedAt.getDate());
    const index = Math.round((localDay.getTime() - weekStart.getTime()) / 86_400_000);
    if (index >= 0 && index < dailyQuestions.length) dailyQuestions[index] += questions.length;
  }

  return {
    dailyQuestions,
    sessionCount,
    averageAccuracy: answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : null
  };
}
