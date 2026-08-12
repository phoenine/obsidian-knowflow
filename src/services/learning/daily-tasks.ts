import type { DailyTask, DailyTaskPlan } from "../../types";

export interface DailyTaskCandidate {
  path: string;
  title: string;
  learned: boolean;
}

interface CreateDailyTaskPlanOptions {
  date: string;
  scopePath: string;
  generatedAt: string;
  newArticleLimit: number;
  candidates: DailyTaskCandidate[];
  existingTasks?: DailyTask[];
  random?: () => number;
}

export function createDailyTaskPlan(options: CreateDailyTaskPlanOptions): DailyTaskPlan {
  const random = options.random ?? Math.random;
  const existingNewPaths = new Set(
    options.existingTasks?.filter((task) => task.type === "new_note").map((task) => task.targetPath) ?? []
  );
  const newTasks = selectTasks(
    options.candidates.filter((candidate) => !candidate.learned || existingNewPaths.has(candidate.path)),
    "new_note",
    options.newArticleLimit,
    random,
    options.existingTasks
  );
  return {
    generatorVersion: 3,
    date: options.date,
    scopePath: options.scopePath,
    generatedAt: options.generatedAt,
    newArticleLimit: options.newArticleLimit,
    tasks: newTasks
  };
}

function selectTasks(
  candidates: DailyTaskCandidate[],
  type: "new_note",
  limit: number,
  random: () => number,
  existingTasks: DailyTask[] = []
): DailyTask[] {
  const count = Math.min(Math.max(0, limit), candidates.length);
  const candidatesByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const preserved = existingTasks
    .filter((task) => task.type === type && task.targetPath && candidatesByPath.has(task.targetPath))
    .slice(0, count)
    .map((task) => ({ ...task }));
  const preservedPaths = new Set(preserved.map((task) => task.targetPath));
  const remaining = candidates.filter((candidate) => !preservedPaths.has(candidate.path));
  const added = sample(remaining, count - preserved.length, random)
    .map((candidate) => createNoteTask(candidate, type));
  return [...preserved, ...added];
}

function sample<T>(candidates: T[], limit: number, random: () => number): T[] {
  const pool = [...candidates];
  const selected: T[] = [];
  const count = Math.min(Math.max(0, limit), pool.length);
  while (selected.length < count) {
    const index = Math.floor(random() * pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }
  return selected;
}

function createNoteTask(candidate: DailyTaskCandidate, type: "new_note"): DailyTask {
  return {
    id: `${type}:${candidate.path}`,
    type,
    title: candidate.title,
    targetPath: candidate.path,
    status: "pending",
    completedAt: null
  };
}
