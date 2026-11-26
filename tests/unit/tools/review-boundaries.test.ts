import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const eslint = new ESLint();

it.each([
  ["export type Versions = import('@/shared/WebviewMessages').ContentVersions;", ['@typescript-eslint/consistent-type-imports']],
  ["import { ContentVersions } from '@/shared/WebviewMessages'; export type Versions = ContentVersions;", ['@typescript-eslint/consistent-type-imports']],
  ["import type { ContentVersions } from '@/shared/WebviewMessages'; export type Versions = ContentVersions;", []],
  ["export const loadPath = () => import('node:path');", []],
])('enforces explicit type imports without blocking runtime imports: %s', async (source, rules) => {
  const [result] = await eslint.lintText(source, { filePath: 'src/adapters/ExtensionActivation.ts' });
  expect(result?.messages.map(({ ruleId }) => ruleId)).toEqual(rules);
});

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
  const results = await eslint.lintText("import * as vscode from 'vscode'; void vscode;", { filePath: 'src/core/sessions/Commands.ts' });
  expect(results.flatMap((result) => result.messages).some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
});

it.each([
  ['src/core/sessions/Manager.ts', "import type { SessionTabs } from '@/core/sessions/Tabs'; export type Tab = SessionTabs;"],
  ['src/core/sessions/States.ts', "export * from '@/core/sessions/Commands';"],
  ['src/core/sessions/Content.ts', "export type { ChatViewController } from '@/core/ChatViewController';"],
  ['src/core/sessions/Interactions.ts', "export * from '@/shared/WebviewMessages';"],
  ['src/core/acp/ConnectionManager.ts', "export * from '@/core/sessions/Startup';"],
  ['src/core/review/Reviews.ts', "export type { SessionManager } from '@/core/sessions/Manager';"],
  ['src/core/review/ReviewControls.ts', "export * from '@/core/sessions/List';"],
  ['src/core/sessions/Tabs.ts', "export type { SessionInfo } from '@/core/sessions/Manager';"],
])('rejects an ownership dependency from %s: %s', async (filePath, source) => {
  const [result] = await eslint.lintText(source, { filePath });
  expect(result?.messages).toEqual([expect.objectContaining({ ruleId: 'no-restricted-imports' })]);
});

it.each([
  ['src/core/review/Reviews.ts', "export type { SessionIdentity } from '@/core/sessions/UpdateHandler';"],
  ['src/core/sessions/Manager.ts', "export type { SessionStateView } from '@/core/sessions/States';"],
  ['src/core/sessions/Commands.ts', "export type { SessionManager } from '@/core/sessions/Manager';"],
  ['src/core/ChatViewController.ts', "export type { SessionTabsSnapshot } from '@/shared/WebviewMessages';"],
])('allows the ownership dependency from %s: %s', async (filePath, source) => {
  const [result] = await eslint.lintText(source, { filePath });
  expect(result?.messages).toEqual([]);
});
