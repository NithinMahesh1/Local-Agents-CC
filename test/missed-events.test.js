import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMissedEvents,
  projectName,
  summarizeMissedEvents,
  formatMissedSummary
} from '../src/missed-events.js';

const E = (when, session, cwd, model = 'local-model') => ({
  when,
  session_id: session,
  cwd,
  model,
  kind: 'missed-tool-call'
});

const TWO = [
  E('2026-10-28T17:00:00.000000Z', 's-1', '/work/app-one'),
  E('2026-10-28T17:05:00.000000Z', 's-2', 'C:\\work\\app-two')
];

test('parseMissedEvents', async (t) => {
  await t.test("1. '' -> deepEqual { events: [], skipped: 0 }", () => {
    assert.deepEqual(parseMissedEvents(''), { events: [], skipped: 0 });
  });

  await t.test(
    "2. TWO.map((event) => JSON.stringify(event)).join('\\n') + '\\n' " +
    "-> events deepEqual TWO, skipped 0",
    () => {
      const text = TWO.map((event) => JSON.stringify(event)).join('\n') + '\n';
      assert.deepEqual(parseMissedEvents(text), { events: TWO, skipped: 0 });
    }
  );

  await t.test("3. the same lines joined with '\\r\\n' -> events deepEqual TWO", () => {
    const text = TWO.map((event) => JSON.stringify(event)).join('\r\n') + '\r\n';
    assert.deepEqual(parseMissedEvents(text), { events: TWO, skipped: 0 });
  });

  await t.test("4. '\\n\\n  \\n' -> deepEqual { events: [], skipped: 0 }", () => {
    assert.deepEqual(parseMissedEvents('\n\n  \n'), { events: [], skipped: 0 });
  });

  await t.test("5. 'not json' -> skipped 1 and no events", () => {
    assert.deepEqual(parseMissedEvents('not json'), { events: [], skipped: 1 });
  });

  await t.test("6. the 3 lines '[1,2]', 'null' and '\"text\"' -> skipped 3", () => {
    assert.deepEqual(parseMissedEvents('[1,2]\nnull\n"text"'), { events: [], skipped: 3 });
  });

  await t.test(
    "7. the 2 lines '{\"kind\":\"missed-tool-call\"}' (no when) and " +
    "'{\"when\":\"w\",\"kind\":7}' -> skipped 2",
    () => {
      const input = '{"kind":"missed-tool-call"}\n{"when":"w","kind":7}';
      assert.deepEqual(parseMissedEvents(input), { events: [], skipped: 2 });
    }
  );

  await t.test(
    "8. '{\"when\":\"w\",\"kind\":\"k\",\"reply\":\"secret\",\"model\":42}' " +
    "-> events deepEqual [{ when: 'w', session_id: '', cwd: '', model: '', kind: 'k' }]",
    () => {
      const input = '{"when":"w","kind":"k","reply":"secret","model":42}';
      const expectedEvents = [{
        when: 'w',
        session_id: '',
        cwd: '',
        model: '',
        kind: 'k'
      }];
      assert.deepEqual(parseMissedEvents(input), {
        events: expectedEvents,
        skipped: 0
      });
    }
  );
});

test('projectName', async (t) => {
  await t.test("9. '/home/user/app-one' -> 'app-one'", () => {
    assert.strictEqual(projectName('/home/user/app-one'), 'app-one');
  });

  await t.test("10. 'C:\\work\\app-two\\' -> 'app-two'", () => {
    assert.strictEqual(projectName('C:\\work\\app-two\\'), 'app-two');
  });

  await t.test("11. 'C:/work/app-three' -> 'app-three'", () => {
    assert.strictEqual(projectName('C:/work/app-three'), 'app-three');
  });

  await t.test("12. '' -> '(unknown)'; '/' -> '(unknown)'; '\\\\' -> '(unknown)'", () => {
    assert.strictEqual(projectName(''), '(unknown)');
    assert.strictEqual(projectName('/'), '(unknown)');
    assert.strictEqual(projectName('\\\\'), '(unknown)');
  });
});

test('summarizeMissedEvents', async (t) => {
  await t.test(
    "13. TWO -> deepEqual { total: 2, duplicates: 0, byKind: [['missed-tool-call', 2]], " +
    "byModel: [['local-model', 2]], byProject: [['app-one', 1], ['app-two', 1]] }",
    () => {
      assert.deepEqual(summarizeMissedEvents(TWO), {
        total: 2,
        duplicates: 0,
        byKind: [['missed-tool-call', 2]],
        byModel: [['local-model', 2]],
        byProject: [['app-one', 1], ['app-two', 1]]
      });
    }
  );

  await t.test("14. [...TWO, { ...TWO[0] }] -> total 2, duplicates 1", () => {
    const events = [...TWO, { ...TWO[0] }];
    const summary = summarizeMissedEvents(events);
    assert.strictEqual(summary.total, 2);
    assert.strictEqual(summary.duplicates, 1);
  });

  await t.test(
    "15. [E('w1', 's-1', '/a/app-one'), E('w1', 's-2', '/a/app-one')] " +
    "(same when, other session) -> total 2, duplicates 0",
    () => {
      const events = [E('w1', 's-1', '/a/app-one'), E('w1', 's-2', '/a/app-one')];
      const summary = summarizeMissedEvents(events);
      assert.strictEqual(summary.total, 2);
      assert.strictEqual(summary.duplicates, 0);
    }
  );

  await t.test(
    "16. [E('w1', 's-1', '/a/app-one', '')] -> byModel deepEqual [['(unknown)', 1]]",
    () => {
      const events = [E('w1', 's-1', '/a/app-one', '')];
      const summary = summarizeMissedEvents(events);
      assert.deepEqual(summary.byModel, [['(unknown)', 1]]);
    }
  );

  await t.test(
    "17. 8 events with when 'w1' to 'w8' and session 's-1': model 'm-b' once, " +
    "'m-a' 3 times, 'm-c' twice, 'm-d' twice -> byModel deepEqual [['m-a', 3], " +
    "['m-c', 2], ['m-d', 2], ['m-b', 1]]",
    () => {
      const models = ['m-b', 'm-a', 'm-a', 'm-a', 'm-c', 'm-c', 'm-d', 'm-d'];
      const events = models.map((model, index) => E(`w${index + 1}`, 's-1', '/a/app', model));
      const summary = summarizeMissedEvents(events);
      assert.deepEqual(summary.byModel, [['m-a', 3], ['m-c', 2], ['m-d', 2], ['m-b', 1]]);
    }
  );

  await t.test(
    "18. [] -> deepEqual { total: 0, duplicates: 0, byKind: [], byModel: [], byProject: [] }",
    () => {
      assert.deepEqual(summarizeMissedEvents([]), {
        total: 0,
        duplicates: 0,
        byKind: [],
        byModel: [],
        byProject: []
      });
    }
  );
});

test('formatMissedSummary', async (t) => {
  await t.test(
    "19. formatMissedSummary(summarizeMissedEvents(TWO), " +
    "{ file: '/logs/missed-tool-events.jsonl', skipped: 0 }) -> exactly ...",
    () => {
      const summary = summarizeMissedEvents(TWO);
      const options = { file: '/logs/missed-tool-events.jsonl', skipped: 0 };
      const expected = 'Missed tool calls in /logs/missed-tool-events.jsonl\n' +
        'Total: 2\n\nBy kind:\n  missed-tool-call: 2\n\nBy model:\n  local-model: 2\n' +
        '\nBy project:\n  app-one: 1\n  app-two: 1\n';
      assert.strictEqual(formatMissedSummary(summary, options), expected);
    }
  );

  await t.test(
    "20. formatMissedSummary(summarizeMissedEvents([]), { file: 'F', skipped: 0 }) " +
    "-> exactly 'Missed tool calls in F\\nNo missed tool calls recorded yet.\\n'",
    () => {
      const summary = summarizeMissedEvents([]);
      const options = { file: 'F', skipped: 0 };
      const expected = 'Missed tool calls in F\nNo missed tool calls recorded yet.\n';
      assert.strictEqual(formatMissedSummary(summary, options), expected);
    }
  );

  await t.test(
    "21. formatMissedSummary(summarizeMissedEvents([...TWO, { ...TWO[0] }]), " +
    "{ file: 'F', skipped: 2 }) -> ends with ...",
    () => {
      const summary = summarizeMissedEvents([...TWO, { ...TWO[0] }]);
      const options = { file: 'F', skipped: 2 };
      const result = formatMissedSummary(summary, options);
      const expectedSuffix = '\n\nDuplicate lines counted once: 1\n' +
        'Lines skipped because they are not valid events: 2\n';
      assert.ok(result.endsWith(expectedSuffix));
    }
  );

  await t.test(
    "22. formatMissedSummary(summarizeMissedEvents([]), { file: 'F', skipped: 1 }) " +
    "-> exactly 'Missed tool calls in F\\nNo missed tool calls recorded yet.\\n' + " +
    '\\nLines skipped because they are not valid events: 1\\n',
    () => {
      const summary = summarizeMissedEvents([]);
      const options = { file: 'F', skipped: 1 };
      const expected = 'Missed tool calls in F\nNo missed tool calls recorded yet.\n' +
        '\nLines skipped because they are not valid events: 1\n';
      assert.strictEqual(formatMissedSummary(summary, options), expected);
    }
  );
});
