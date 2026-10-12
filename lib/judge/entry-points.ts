import type { JudgeLanguage, ProblemJudgingSpec } from "./types";

function snakeCase(name: string): string {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();
}

export function pythonEntryPoints(names: string[]): string[] {
  return [...new Set(names.flatMap(name => {
    const snake = snakeCase(name);
    return [name, snake, snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  }))];
}

export function judgeSignature(problem: ProblemJudgingSpec, language: JudgeLanguage): string {
  const name = problem.entryPoints[language][0];
  const parameters = problem.parameters ?? problem.cases[0]?.args.map((_, index) => `arg${index + 1}`) ?? [];
  return language === "python" ? `def ${snakeCase(name)}(${parameters.join(", ")}):` : `function ${name}(${parameters.join(", ")})`;
}
