import projectRules from './project-rules.md?raw';

/*
 * The rulebook is a real file (`project-rules.md`) rather than a string literal so
 * it stays diffable and can be mirrored to `.github/copilot-instructions.md`
 * (`pnpm rules:sync`). Vite inlines it at build time for the browser and the
 * Workers/Node server alike, so there is no filesystem read at request time.
 */
const RULES_TAG = '<project_rules>';
const RULES_TAG_CLOSE = '<' + '/project_rules>';

export const PROJECT_RULES = projectRules.trim();

/** Wraps the rulebook for the system prompt; empty input yields no block at all. */
export function withProjectRules(prompt: string, rules: string = PROJECT_RULES): string {
  const trimmed = rules.trim();

  if (!trimmed || prompt.includes(RULES_TAG)) {
    return prompt;
  }

  return `${prompt}

${RULES_TAG}
The following project rules are binding for every response in this workspace. Follow them unless the user explicitly overrides a rule for the current request.
${trimmed}
${RULES_TAG_CLOSE}`;
}
