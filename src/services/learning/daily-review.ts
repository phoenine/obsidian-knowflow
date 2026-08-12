import type { DailyReviewQuestion, QuizAnswerState, QuizQuestion, ReviewQuestionPriority } from "../../types";

export interface ReviewQuestionCandidate {
  articlePath: string;
  articleTitle: string;
  quizPath: string;
  displayIndex: number;
  question: QuizQuestion;
  answerState: QuizAnswerState;
}

const CORRECT_COOLDOWN_DAYS = 7;
const ARTICLE_SOFT_LIMIT = 2;

export function getDailyReviewQuestionCount(bankSize: number, availableCount: number, questionCap: number): number {
  if (bankSize <= 0 || availableCount <= 0 || questionCap <= 0) return 0;
  const target = Math.min(questionCap, Math.max(5, Math.round(Math.sqrt(bankSize))));
  return Math.min(availableCount, target);
}

export function toEligibleReviewQuestion(
  candidate: ReviewQuestionCandidate,
  reviewDate: string
): DailyReviewQuestion | null {
  const priority = getReviewPriority(candidate.answerState, reviewDate);
  if (!priority) return null;
  return {
    key: createReviewQuestionKey(candidate.articlePath, candidate.question),
    articlePath: candidate.articlePath,
    articleTitle: candidate.articleTitle,
    quizPath: candidate.quizPath,
    displayIndex: candidate.displayIndex,
    priority,
    question: {
      ...candidate.question,
      notePath: candidate.articlePath
    }
  };
}

export function selectDailyReviewQuestions(
  candidates: DailyReviewQuestion[],
  bankSize: number,
  questionCap: number,
  options: {
    pinnedKeys?: string[];
    random?: () => number;
  } = {}
): DailyReviewQuestion[] {
  const count = getDailyReviewQuestionCount(bankSize, candidates.length, questionCap);
  if (count === 0) return [];

  const random = options.random ?? Math.random;
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const selected: DailyReviewQuestion[] = [];
  const selectedKeys = new Set<string>();
  const articleCounts = new Map<string, number>();
  const add = (candidate: DailyReviewQuestion): void => {
    if (selected.length >= count || selectedKeys.has(candidate.key)) return;
    selected.push(candidate);
    selectedKeys.add(candidate.key);
    articleCounts.set(candidate.articlePath, (articleCounts.get(candidate.articlePath) ?? 0) + 1);
  };

  for (const key of options.pinnedKeys ?? []) {
    const candidate = byKey.get(key);
    if (candidate?.priority === "wrong") add(candidate);
  }

  for (const priority of ["wrong", "unseen", "due"] as ReviewQuestionPriority[]) {
    const pool = shuffle(
      candidates.filter((candidate) => candidate.priority === priority && !selectedKeys.has(candidate.key)),
      random
    );
    const deferred: DailyReviewQuestion[] = [];
    for (const candidate of pool) {
      if ((articleCounts.get(candidate.articlePath) ?? 0) < ARTICLE_SOFT_LIMIT) add(candidate);
      else deferred.push(candidate);
    }
    for (const candidate of deferred) add(candidate);
    if (selected.length >= count) break;
  }

  return selected;
}

export function createReviewQuestionKey(articlePath: string, question: QuizQuestion): string {
  const source = [
    articlePath.trim().toLowerCase(),
    question.question.replace(/\s+/g, " ").trim().toLowerCase(),
    question.answerKey.trim().toUpperCase()
  ].join("\n");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `review-${(hash >>> 0).toString(36)}`;
}

function getReviewPriority(state: QuizAnswerState, reviewDate: string): ReviewQuestionPriority | null {
  if (!state.selectedKey) return "unseen";
  if (state.correct === false) return "wrong";
  if (state.correct !== true || !state.answeredAt) return "due";
  return daysBetween(state.answeredAt.slice(0, 10), reviewDate) >= CORRECT_COOLDOWN_DAYS ? "due" : null;
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return CORRECT_COOLDOWN_DAYS;
  return Math.floor((to - from) / 86_400_000);
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
