import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import pico from "picocolors";

const FULLWIDTH_COLON = "\uFF1A";

const commitRE =
  /^(revert: )?(feat|fix|docs|dx|style|refactor|perf|test|workflow|build|ci|chore|types|wip|release)(\(.+\))?: .{1,50}/;

// Accepts both half-width and full-width punctuation, so that commit messages
// written in Chinese with full-width `：`/`（）` (typical for AI-generated
// messages) can be normalized before validation instead of being rejected.
const headerRE =
  /^(?:(revert)\s*[:\uFF1A]\s*)?(feat|fix|docs|dx|style|refactor|perf|test|workflow|build|ci|chore|types|wip|release)\s*(?:[(\uFF08]([^)\uFF09]+)[)\uFF09])?\s*[:\uFF1A]\s*(.*)$/;

const firstLineOf = (text: string) => {
  const lineBreak = text.indexOf("\n");
  return lineBreak === -1 ? text : text.slice(0, lineBreak);
};

/**
 * Normalize the commit header (type/scope separator and scope brackets) to the
 * conventional-commit form. Only the first line is touched, the body is kept
 * byte-for-byte as the author wrote it.
 */
export function normalizeHeader(rawMessage: string): {
  message: string;
  changed: boolean;
} {
  const header = firstLineOf(rawMessage);
  const rest = rawMessage.slice(header.length);

  const matched = header.match(headerRE);
  if (!matched) {
    return { message: rawMessage, changed: false };
  }

  const [, revert, type, scope, subject] = matched;
  const normalizedHeader =
    `${revert ? "revert: " : ""}${type}` +
    `${scope ? `(${scope.trim()})` : ""}: ` +
    `${subject.replace(/^\s+/, "")}`;

  if (normalizedHeader === header) {
    return { message: rawMessage, changed: false };
  }

  return { message: `${normalizedHeader}${rest}`, changed: true };
}

const msgPath = path.resolve(process.argv[2] ?? ".git/COMMIT_EDITMSG");
const rawMessage = readFileSync(msgPath, "utf-8");
const { message, changed } = normalizeHeader(rawMessage);

if (changed) {
  writeFileSync(msgPath, message, "utf-8");
  console.error(
    `  ${pico.white(pico.bgYellow(" WARN "))} ${pico.yellow(`normalized commit header.`)}\n\n` +
      `    ${pico.dim(firstLineOf(rawMessage))}\n` +
      `    ${pico.green(firstLineOf(message))}\n\n`,
  );
}

const msg = message.trim();

if (!commitRE.test(msg)) {
  const colonHint = firstLineOf(message).includes(FULLWIDTH_COLON)
    ? pico.red(
        `  The separator after the type/scope must be a half-width colon ":". ` +
          `A full-width "：" is not accepted.\n`,
      )
    : "";

  console.error(
    `
  ${pico.white(pico.bgRed(" ERROR "))} ${pico.red(`invalid commit message format.`)}\n\n` +
      pico.red(
        `  Proper commit message format is required for automated changelog generation. Examples:\n\n`,
      ) +
      `    ${pico.green(`feat(api): add 'comments' option`)}\n` +
      `    ${pico.green(`fix(client): handle events on blur (close #28)`)}\n\n` +
      pico.red(
        `We refer to the vue3 scheme.\n` +
          `See https://github.com/vuejs/core/blob/main/.github/commit-convention.md for more details.\n`,
      ) +
      colonHint,
  );
  process.exit(1);
}
