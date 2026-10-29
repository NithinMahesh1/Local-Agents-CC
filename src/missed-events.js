// Reads the missed tool call log that the Stop hook of --all-local sessions writes (see
// stop-nudge.js) and counts the events, for `claude-agents --missed-tool-calls`.

/**
 * One line of the log.
 * @typedef {{ when: string, session_id: string, cwd: string, model: string, kind: string }}
 *   MissedEvent
 */

/**
 * Parses the text of the log: one JSON object per line. Lines end with "\n" or "\r\n".
 *   - An empty line (after trimming) is ignored and not counted.
 *   - A line that is not valid JSON, or whose value is not a plain object with a string `when`
 *     and a string `kind`, is skipped and counted in `skipped`.
 *   - A kept event has exactly the 5 keys of MissedEvent. `session_id`, `cwd` and `model` are
 *     the line's values when they are strings, else ''. Other keys of the line are dropped.
 * Never throws.
 * @param {string} text
 * @returns {{ events: MissedEvent[], skipped: number }}
 */
export function parseMissedEvents(text) {
  const lines = text.split(/\r?\n/);
  const events = [];
  let skipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }

    try {
      const value = JSON.parse(trimmed);
      const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);

      if (isPlainObject && typeof value.when === 'string' && typeof value.kind === 'string') {
        events.push({
          when: value.when,
          session_id: typeof value.session_id === 'string' ? value.session_id : '',
          cwd: typeof value.cwd === 'string' ? value.cwd : '',
          model: typeof value.model === 'string' ? value.model : '',
          kind: value.kind,
        });
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  return { events, skipped };
}

/**
 * The project name for a working folder: the last part of the path. Both "/" and "\" separate
 * the parts, and separators at the end are ignored. So "C:\work\app-one\" and "/home/u/app-one"
 * both give "app-one". An empty value, or one with only separators, gives "(unknown)".
 * @param {string} cwd
 * @returns {string}
 */
export function projectName(cwd) {
  const parts = cwd.split(/[\\/]+/).filter((part) => part !== '');
  return parts.length > 0 ? parts[parts.length - 1] : '(unknown)';
}

/**
 * Counts the events. Events with the same `when` and the same `session_id` are one event: the
 * first one counts, and each later one adds 1 to `duplicates`.
 * Each list holds [name, count] pairs, sorted by count (highest first), then by name (plain
 * `<` comparison of the strings). byKind uses `kind`. byModel uses `model`, or "(unknown)" when
 * it is ''. byProject uses projectName(cwd).
 * @param {MissedEvent[]} events
 * @returns {{ total: number, duplicates: number, byKind: Array<[string, number]>,
 *   byModel: Array<[string, number]>, byProject: Array<[string, number]> }} total does not
 *   count the duplicates
 */
export function summarizeMissedEvents(events) {
  const seen = new Set();
  let duplicates = 0;
  let total = 0;

  const kindCounts = new Map();
  const modelCounts = new Map();
  const projectCounts = new Map();

  for (const event of events) {
    const key = `${event.when}|${event.session_id}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
      total++;

      const kind = event.kind;
      const model = event.model === '' ? '(unknown)' : event.model;
      const project = projectName(event.cwd);

      kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
      modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
      projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
    }
  }

  const sortFn = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

  return {
    total,
    duplicates,
    byKind: Array.from(kindCounts.entries()).sort(sortFn),
    byModel: Array.from(modelCounts.entries()).sort(sortFn),
    byProject: Array.from(projectCounts.entries()).sort(sortFn),
  };
}

/**
 * The report that `claude-agents --missed-tool-calls` prints. Each line ends with "\n".
 *   1. "Missed tool calls in <file>"
 *   2. When summary.total is 0: "No missed tool calls recorded yet."
 *      Otherwise: "Total: <total>", then for each of ["By kind", byKind], ["By model", byModel]
 *      and ["By project", byProject]: an empty line, "<title>:", and one line
 *      "  <name>: <count>" per pair (2 spaces first).
 *   3. Notes, only when there are any: an empty line, then
 *      "Duplicate lines counted once: <duplicates>" when duplicates > 0, then
 *      "Lines skipped because they are not valid events: <skipped>" when skipped > 0.
 * @param {ReturnType<typeof summarizeMissedEvents>} summary
 * @param {{ file: string, skipped: number }} options
 * @returns {string}
 */
export function formatMissedSummary(summary, { file, skipped }) {
  const lines = [`Missed tool calls in ${file}`];

  if (summary.total === 0) {
    lines.push('No missed tool calls recorded yet.');
  } else {
    lines.push(`Total: ${summary.total}`);

    const sections = [
      { title: 'By kind', data: summary.byKind },
      { title: 'By model', data: summary.byModel },
      { title: 'By project', data: summary.byProject },
    ];

    for (const { title, data } of sections) {
      if (data.length > 0) {
        lines.push('', title + ':');
        for (const [name, count] of data) {
          lines.push(`  ${name}: ${count}`);
        }
      }
    }
  }

  if (summary.duplicates > 0 || skipped > 0) {
    lines.push('');
    if (summary.duplicates > 0) {
      lines.push(`Duplicate lines counted once: ${summary.duplicates}`);
    }
    if (skipped > 0) {
      lines.push(`Lines skipped because they are not valid events: ${skipped}`);
    }
  }

  return lines.join('\n') + '\n';
}
