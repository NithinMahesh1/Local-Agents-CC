// Checks the code style rule that needs no extra tools: every line of the JavaScript files in
// bin/, src/, test/ and plugin/hooks/ is at most 100 characters long (see CONTRIBUTING.md).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const MAX_LINE_LENGTH = 100;
const root = fileURLToPath(new URL('..', import.meta.url));

// The .js files in one folder of the repository, as paths relative to the repository root.
function jsFiles(folder) {
  return fs.readdirSync(path.join(root, folder))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(folder, name));
}

it(`keeps every line at most ${MAX_LINE_LENGTH} characters`, () => {
  const tooLong = [];
  for (const file of ['bin', 'src', 'test', path.join('plugin', 'hooks')].flatMap(jsFiles)) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.length > MAX_LINE_LENGTH) {
        tooLong.push(`${file}:${index + 1} has ${line.length} characters`);
      }
    });
  }
  assert.deepEqual(tooLong, []);
});
