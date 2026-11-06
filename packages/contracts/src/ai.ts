// AI results: what the agent must return (validated with zod) and how results are stored.
//
//   data/ai/index.json                          which runs/tests have results
//   data/ai/runs/<run_id>/summary.json          "Analyze all failures" for a run
//   data/ai/runs/<run_id>/tests/<test_id>.json      "Analyze test"
//   data/ai/runs/<run_id>/tests/<test_id>.fix.json  "Fix with AI"

import { z } from 'zod';

export const AI_SCHEMA_VERSION = 1;
export const AI_PROMPT_VERSION = 'qaily-ai/1';

export const AI_CATEGORIES = ['product-bug', 'test-bug', 'environment', 'test-data', 'flaky', 'unknown'] as const;
const category = z.enum(AI_CATEGORIES);
const confidence = z.number().min(0).max(1);
const text = z.string().max(4000);

export const aiTestAnalysisSchema = z.object({
  summary: z.string().min(1).max(600),
  category,
  confidence,
  rootCause: text,
  evidence: z.array(z.string().max(1000)).max(12).default([]),
  suggestedFix: text,
  relatedFiles: z.array(z.object({ path: z.string().max(500), line: z.number().int().optional() })).max(20).default([]),
});

export const aiFixResultSchema = z.object({
  summary: z.string().min(1).max(600),
  filesChanged: z.array(z.object({ path: z.string().max(500), description: z.string().max(1000) })).max(50).default([]),
  verification: text,
  risk: text.default(''),
  needsHumanReview: z.boolean().default(true),
});

export const aiRunAnalysisSchema = z.object({
  summary: z.string().min(1).max(2000),
  clusters: z
    .array(
      z.object({
        title: z.string().max(300),
        issueSigs: z.array(z.string().max(40)).max(50).default([]),
        category,
        confidence,
        rootCause: text,
        recommendation: text,
      }),
    )
    .max(50)
    .default([]),
  flakySuspects: z.array(z.object({ title: z.string().max(500), reason: z.string().max(1000) })).max(30).default([]),
  nextSteps: z.array(z.string().max(1000)).max(15).default([]),
});

export type AiCategory = (typeof AI_CATEGORIES)[number];
export type AiTestAnalysis = z.infer<typeof aiTestAnalysisSchema>;
export type AiFixResult = z.infer<typeof aiFixResultSchema>;
export type AiRunAnalysis = z.infer<typeof aiRunAnalysisSchema>;

export type AiKind = 'test-analysis' | 'test-fix' | 'run-analysis';

export interface AiResultByKind {
  'test-analysis': AiTestAnalysis;
  'test-fix': AiFixResult;
  'run-analysis': AiRunAnalysis;
}

export const AI_RESULT_SCHEMAS: { [K in AiKind]: z.ZodType<AiResultByKind[K], z.ZodTypeDef, unknown> } = {
  'test-analysis': aiTestAnalysisSchema,
  'test-fix': aiFixResultSchema,
  'run-analysis': aiRunAnalysisSchema,
};

/** A stored result with provenance, so readers can judge how much to trust it. */
export interface AiRecord<K extends AiKind = AiKind> {
  schemaVersion: number;
  kind: K;
  runId: string;
  testId?: string;
  createdAt: string;
  /** GitHub login when known. */
  author?: string;
  provider: string;
  model?: string;
  promptVersion: string;
  /** Short hash of the context sent, to spot results made from different data. */
  inputHash: string;
  result: AiResultByKind[K];
  /** The agent's free-text answer, capped. */
  transcript?: string;
}

const recordSchema = z.object({
  schemaVersion: z.number().int(),
  kind: z.enum(['test-analysis', 'test-fix', 'run-analysis']),
  runId: z.string().min(1),
  testId: z.string().optional(),
  createdAt: z.string(),
  author: z.string().optional(),
  provider: z.string(),
  model: z.string().optional(),
  promptVersion: z.string(),
  inputHash: z.string(),
  result: z.unknown(),
  transcript: z.string().optional(),
});

/** Validates a stored record (it may come from another viewer's commit). Returns null when unusable. */
export function parseAiRecord(json: unknown): AiRecord | null {
  const env = recordSchema.safeParse(json);
  if (!env.success) return null;
  const result = AI_RESULT_SCHEMAS[env.data.kind].safeParse(env.data.result);
  return result.success ? ({ ...env.data, result: result.data } as AiRecord) : null;
}

export interface AiIndex {
  schemaVersion: number;
  runs: Record<string, { summary?: string; tests?: string[]; fixes?: string[] }>;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** Storage path (relative to data/ai/) for a record. Ids are checked so a path can never escape the folder. */
export function aiRecordPath(kind: AiKind, runId: string, testId?: string): string {
  if (!SAFE_ID.test(runId) || runId.includes('..')) throw new Error(`Unsafe run id: ${runId}`);
  if (kind === 'run-analysis') return `runs/${runId}/summary.json`;
  if (!testId || !SAFE_ID.test(testId) || testId.includes('..')) throw new Error(`Unsafe test id: ${testId}`);
  return `runs/${runId}/tests/${testId}${kind === 'test-fix' ? '.fix' : ''}.json`;
}

/** Parses a record path back into its parts; null when it is not a valid record path. */
export function parseAiRecordPath(path: string): { kind: AiKind; runId: string; testId?: string } | null {
  const m = /^runs\/([A-Za-z0-9._-]+)\/(?:(summary)\.json|tests\/([A-Za-z0-9._-]+?)(\.fix)?\.json)$/.exec(path);
  if (!m || m[1].includes('..') || (m[3] ?? '').includes('..')) return null;
  if (m[2]) return { kind: 'run-analysis', runId: m[1] };
  return { kind: m[4] ? 'test-fix' : 'test-analysis', runId: m[1], testId: m[3] };
}

/** Adds a record to the index (pure; used by the local server and the GitHub writer alike). */
export function addToAiIndex(index: AiIndex | null, record: Pick<AiRecord, 'kind' | 'runId' | 'testId' | 'createdAt'>): AiIndex {
  const next: AiIndex = { schemaVersion: AI_SCHEMA_VERSION, runs: { ...(index?.runs ?? {}) } };
  const run = { ...(next.runs[record.runId] ?? {}) };
  if (record.kind === 'run-analysis') run.summary = record.createdAt;
  else {
    const key = record.kind === 'test-fix' ? 'fixes' : 'tests';
    run[key] = [...new Set([...(run[key] ?? []), record.testId!])].sort();
  }
  next.runs[record.runId] = run;
  return next;
}
