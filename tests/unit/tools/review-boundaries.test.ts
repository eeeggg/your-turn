import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const eslint = new ESLint();

it.each([
  "import { Review } from '@/core/review/Review'; void Review;",
  "export { Review } from '@/core/review/Review';",
  "export * from '@/core/review/Takeovers';",
  "import { V1Guard } from '@/core/review/V1Guard'; void V1Guard;",
  "import { FollowedFiles } from '@/core/review/FollowedFiles'; void FollowedFiles;",
])('rejects external review mutation access: %s', async (source) => {
  const results = await eslint.lintText(source, { filePath: 'src/adapters/ExtensionActivation.ts' });
  expect(results.flatMap((result) => result.messages).some((message) => message.ruleId === 'no-restricted-syntax')).toBe(true);
});

it('preserves existing core import fences with the review mutation fence', async () => {
  const results = await eslint.lintText("import * as vscode from 'vscode'; void vscode;", { filePath: 'src/core/SessionCommands.ts' });
  expect(results.flatMap((result) => result.messages).some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
});
