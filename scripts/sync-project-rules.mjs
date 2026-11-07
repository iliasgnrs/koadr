#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';

/*
 * `.github/copilot-instructions.md` is the file editors attach to Copilot chats;
 * `app/lib/common/prompts/project-rules.md` is the copy the Koadr server inlines
 * into every system prompt. Keeping two files is unavoidable (the server cannot
 * read the repo), so this keeps them identical in one step.
 *
 * Usage: pnpm rules:sync
 */
const source = '.github/copilot-instructions.md';
const target = 'app/lib/common/prompts/project-rules.md';

if (!existsSync(source)) {
  console.error(`Missing ${source}`);
  process.exit(1);
}

copyFileSync(source, target);
console.log(`${source} -> ${target}`);
