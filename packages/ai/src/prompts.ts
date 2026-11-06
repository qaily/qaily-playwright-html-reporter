// Prompts and context packs. The agent runs on the user's machine and cannot read the report's files,
// so everything it needs about the failure goes into the prompt, capped at settings.ai.contextCapKb.

import { AI_CATEGORIES, type AiKind, type PathMapping, type RunRow, type ErrorRecord, type TestDetailsRecord, type TestSummaryRecord } from '@qaily/contracts';

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string | null | undefined) => (s ?? '').replace(ANSI, '');

/** Rewrites CI paths (e.g. /runner/_work/repo/repo/) to the local checkout, longest prefix first. */
export function mapPaths(text: string, pathMap: PathMapping[]): string {
  let out = text;
  for (const m of [...pathMap].sort((a, b) => b.from.length - a.from.length)) {
    if (m.from) out = out.split(m.from).join(m.to);
  }
  return out;
}

function clip(text: string, max: number, keep: 'head' | 'tail' = 'head'): string {
  if (text.length <= max) return text;
  return keep === 'head' ? `${text.slice(0, max)}\n… (cut, ${text.length - max} more characters)` : `… (cut, ${text.length - max} earlier characters)\n${text.slice(-max)}`;
}

interface Section {
  title: string;
  body: string;
  /** Lower = more important; trimmed last. */
  priority: number;
  /** Smallest useful size when trimming. */
  min: number;
  keep?: 'head' | 'tail';
}

/** Joins sections, shrinking the least important ones first until the pack fits the cap. */
export function packSections(sections: Section[], capBytes: number): string {
  const render = (list: Section[]) => list.filter((s) => s.body.trim()).map((s) => `### ${s.title}\n${s.body.trim()}`).join('\n\n');
  const list = sections.map((s) => ({ ...s }));
  let out = render(list);
  for (const s of [...list].sort((a, b) => b.priority - a.priority)) {
    if (out.length <= capBytes) break;
    const over = out.length - capBytes;
    s.body = clip(s.body, Math.max(s.min, s.body.length - over - 60), s.keep);
    out = render(list);
  }
  return out.length <= capBytes ? out : clip(out, capBytes);
}

export interface TestContextInput {
  run: RunRow | null;
  summary: TestSummaryRecord;
  attempts: { detail: TestDetailsRecord | null; errors: ErrorRecord[] }[];
  history: { started_at: number; status: string; branch: string | null }[];
  errorContext?: string;
  networkLog?: string;
  pathMap: PathMapping[];
  capBytes: number;
}

export function buildTestContext(i: TestContextInput): string {
  const s = i.summary;
  const failing = [...i.attempts].reverse().find((a) => a.errors.length) ?? i.attempts[i.attempts.length - 1];
  const err = failing?.errors[0];
  const steps = failing?.detail?.steps ?? [];
  const failedIdx = failing?.detail?.failed_step_idx ?? steps.findIndex((st) => st.status !== 'passed' && st.status !== 'skipped');
  const stepLines = steps.map((st) => `${st.idx === failedIdx ? '>>' : '  '} ${st.idx}. [${st.status}] ${st.title} (${st.dur_ms} ms)`);

  const ran = i.history.filter((h) => h.status !== 'skipped');
  const ok = ran.filter((h) => h.status === 'passed' || h.status === 'flaky').length;
  const historyLine = i.history.map((h) => ({ passed: 'P', failed: 'F', flaky: 'f', skipped: '-' })[h.status] ?? '?').join('');

  const sections: Section[] = [
    {
      title: 'Test',
      priority: 0,
      min: 400,
      body: [
        `Title: ${s.title}`,
        `File: ${mapPaths(s.file, i.pathMap)}${failing?.detail?.line_num ? `:${failing.detail.line_num}` : ''}`,
        `Project: ${s.project}`,
        `Tags: ${s.tags.map((t) => `@${t}`).join(' ') || '-'}`,
        `Result: ${s.status} after ${i.attempts.length} attempt(s), ${s.dur_ms} ms`,
        i.run ? `Run: ${i.run.run_id} · branch ${i.run.branch ?? '?'} · commit ${i.run.commit?.slice(0, 10) ?? '?'} · env ${i.run.environment ?? '?'} · ${i.run.category ?? ''}` : '',
        failing?.detail?.full_title ? `Full title: ${failing.detail.full_title}` : '',
      ].filter(Boolean).join('\n'),
    },
    {
      title: 'Error',
      priority: 0,
      min: 600,
      body: err
        ? [
            `Type: ${err.err_type}`,
            `Message:\n${strip(err.err_msg)}`,
            err.failed_step ? `Failed step: ${err.failed_step}` : '',
            err.locator ? `Locator: ${err.locator}` : '',
            err.err_file ? `At: ${mapPaths(err.err_file, i.pathMap)}:${err.err_line ?? '?'}` : '',
          ].filter(Boolean).join('\n')
        : 'No error was recorded.',
    },
    { title: 'Steps (>> marks the failed step)', priority: 1, min: 800, body: stepLines.join('\n') },
    { title: 'Code at the failure', priority: 1, min: 400, body: err?.snippet ? '```\n' + mapPaths(strip(err.snippet), i.pathMap) + '\n```' : '' },
    {
      title: `History (oldest → newest, P pass, f flaky, F fail, - skipped)`,
      priority: 2,
      min: 120,
      body: i.history.length ? `${historyLine}\nPassed ${ok} of ${ran.length} executed runs.` : '',
    },
    { title: 'Stack trace', priority: 3, min: 400, body: err?.stack ? '```\n' + mapPaths(strip(err.stack), i.pathMap) + '\n```' : '' },
    { title: 'Page snapshot at failure (error-context)', priority: 4, min: 600, body: i.errorContext ?? '' },
    { title: 'Network log (filtered, most recent last)', priority: 5, min: 400, keep: 'tail', body: i.networkLog ? '```\n' + i.networkLog + '\n```' : '' },
  ];
  return packSections(sections, i.capBytes);
}

export interface RunContextInput {
  run: RunRow;
  clusters: {
    sig: string;
    errType: string;
    message: string;
    failedStep: string | null;
    location: string | null;
    tests: { title: string; status: string; project: string }[];
  }[];
  flaky: { title: string; project: string }[];
  pathMap: PathMapping[];
  capBytes: number;
}

export function buildRunContext(i: RunContextInput): string {
  const r = i.run;
  const header = [
    `Run: ${r.run_id}`,
    `Branch ${r.branch ?? '?'} · commit ${r.commit?.slice(0, 10) ?? '?'} · env ${r.environment ?? '?'} · ${r.category ?? ''} · ${r.tag ?? ''}`,
    `Tests: ${r.total} total, ${r.passed} passed, ${r.failed} failed, ${r.flaky} flaky, ${r.skipped} skipped`,
  ].join('\n');
  const clusters = i.clusters
    .map((c, n) =>
      [
        `#${n + 1} issueSig=${c.sig} type=${c.errType} tests=${c.tests.length}`,
        `Message: ${clip(strip(c.message), 700)}`,
        c.failedStep ? `Failed step: ${c.failedStep}` : '',
        c.location ? `At: ${mapPaths(c.location, i.pathMap)}` : '',
        `Tests: ${c.tests.map((t) => `${t.title} [${t.status}, ${t.project}]`).join('; ')}`,
      ].filter(Boolean).join('\n'),
    )
    .join('\n\n');
  return packSections(
    [
      { title: 'Run', priority: 0, min: 300, body: header },
      { title: 'Failure groups (same normalized error and failed step)', priority: 1, min: 2000, body: clusters || 'No failures.' },
      { title: 'Tests that passed only on retry (flaky)', priority: 2, min: 200, body: i.flaky.map((f) => `- ${f.title} [${f.project}]`).join('\n') },
    ],
    i.capBytes,
  );
}

const CATEGORIES = AI_CATEGORIES.join(' | ');

const SHAPES: Record<AiKind, string> = {
  'test-analysis': `{
  "summary": "one or two sentences",
  "category": "${CATEGORIES}",
  "confidence": 0.0-1.0,
  "rootCause": "what went wrong and why",
  "evidence": ["facts from the context that support it"],
  "suggestedFix": "what to change, and where",
  "relatedFiles": [{ "path": "file in the repo", "line": 123 }]
}`,
  'test-fix': `{
  "summary": "what you changed and why",
  "filesChanged": [{ "path": "file", "description": "the change" }],
  "verification": "how to verify the fix (command or steps)",
  "risk": "what could break",
  "needsHumanReview": true
}`,
  'run-analysis': `{
  "summary": "a short overview for the team",
  "clusters": [{ "title": "...", "issueSigs": ["sig from the context"], "category": "${CATEGORIES}", "confidence": 0.0-1.0,
                 "rootCause": "...", "recommendation": "..." }],
  "flakySuspects": [{ "title": "test title", "reason": "..." }],
  "nextSteps": ["prioritized actions"]
}`,
};

const ANSWER_RULES = (kind: AiKind) =>
  `Reply with a short explanation in plain text, then exactly one \`\`\`json code block with this shape:\n\`\`\`json\n${SHAPES[kind]}\n\`\`\`\n` +
  'Use only facts from the context or files you read. If you are unsure, say so and lower the confidence.';

export function analyzeTestPrompt(context: string): string {
  return [
    'You are a senior QA engineer. Find the most likely root cause of this failed Playwright test.',
    'The working directory is the test repository: you may read files there to look at the test and page objects.',
    'Do not modify any files, and do not run commands that change anything.',
    ANSWER_RULES('test-analysis'),
    '## Context',
    context,
  ].join('\n\n');
}

export function fixTestPrompt(context: string): string {
  return [
    'You are a senior QA engineer. Fix this failing Playwright test in the working directory (the test repository).',
    'Make the smallest change that fixes the real cause. If the cause is a product bug or the environment, do not hide it ' +
      'by weakening assertions: change nothing and explain instead.',
    'Do not commit, push, or change files outside the working directory.',
    ANSWER_RULES('test-fix'),
    '## Context',
    context,
  ].join('\n\n');
}

export function analyzeRunPrompt(context: string): string {
  return [
    'You are a senior QA engineer. Analyse all failures of this Playwright run for the team.',
    'Group related failures (several groups may share one root cause), separate product bugs from test and environment',
    'problems, and point out likely flaky tests. Refer to groups by the issueSig values given in the context.',
    'You may read files in the working directory (the test repository). Do not modify anything.',
    ANSWER_RULES('run-analysis'),
    '## Context',
    context,
  ].join('\n\n');
}

export function retryPrompt(kind: AiKind, problem: string): string {
  return `Your answer could not be used: ${problem}\nReply with only the corrected \`\`\`json block with this shape:\n\`\`\`json\n${SHAPES[kind]}\n\`\`\``;
}
