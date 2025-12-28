import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const htmlPath = path.resolve(process.cwd(), 'webapp/notifications.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function extractFunctionSource(name) {
  const start = html.indexOf(`function ${name}`);
  assert.ok(start !== -1, `Missing function ${name}`);
  const braceStart = html.indexOf('{', start);
  assert.ok(braceStart !== -1, `Missing opening brace for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces for ${name}`);
}

const functionNames = [
  'isRevertRelated',
  'isBotAuthor',
  'isBotInteractionComment',
  'isUninterestingComment',
];

const sources = functionNames.map((name) => extractFunctionSource(name)).join('\n');
const context = {};
vm.createContext(context);
vm.runInContext(sources, context);

const { isUninterestingComment } = context;

function makeComment({ author, body }) {
  return {
    user: author ? { login: author } : undefined,
    body,
  };
}

test('revert-related comments are interesting', () => {
  const comment = makeComment({ author: 'reviewer', body: 'Reverted in #123' });
  assert.equal(isUninterestingComment(comment), false);
});

test('bot authors ending with [bot] are uninteresting', () => {
  const comment = makeComment({ author: 'dependabot[bot]', body: 'Bumps deps' });
  assert.equal(isUninterestingComment(comment), true);
});

test('known bot authors are uninteresting', () => {
  const comment = makeComment({ author: 'bors', body: 'bors r+' });
  assert.equal(isUninterestingComment(comment), true);
});

test('slash command bot interactions are uninteresting', () => {
  const comment = makeComment({ author: 'human', body: '/label feature' });
  assert.equal(isUninterestingComment(comment), true);
});

test('at-mention bot interactions are uninteresting', () => {
  const comment = makeComment({ author: 'human', body: '@pytorchbot label XX' });
  assert.equal(isUninterestingComment(comment), true);
});

test('non-bot human comments are interesting', () => {
  const comment = makeComment({
    author: 'human',
    body: 'Please take a look at this change.',
  });
  assert.equal(isUninterestingComment(comment), false);
});
