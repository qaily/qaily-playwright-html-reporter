/**
 * Collects coverage labels from Playwright step annotations (TestStepInfo.annotations, Playwright 1.58+)
 * and writes them as <run>/step-coverage.jsonl, one row per labelled top-level step per attempt.
 * Labels on nested steps count for their top-level step, so the index matches test_details.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';

export const DEFAULT_COVERAGE_LEVELS = ['Component', 'Test Name', 'Feature', 'Area'];
/** Accepted alternative names per level position. */
const ALIASES: Record<number, string[]> = { 1: ['Scenario'] };

export interface CoverageOptions {
  /** Annotation types for the four levels, top first. Default: Component, Test Name (or Scenario), Feature, Area. */
  levels?: string[];
}

export interface StepCoverageRow {
  run_id: string;
  test_id: string;
  attempt: number;
  idx: number;
  title: string;
  status: string;
  component: string;
  scenario: string | null;
  feature: string | null;
  area: string | null;
}

type Annotation = { type: string; description?: string };

/** TestStep.annotations exists at runtime from 1.58; older type definitions don't declare it. */
function annotationsOf(step: TestStep): Annotation[] {
  const list = (step as unknown as { annotations?: Annotation[] }).annotations;
  return Array.isArray(list) ? list : [];
}

export class CoverageCollector {
  private levelOf = new Map<string, number>();
  private rows: Omit<StepCoverageRow, 'run_id'>[] = [];

  constructor(options: CoverageOptions = {}) {
    const levels = options.levels?.length === 4 ? options.levels : DEFAULT_COVERAGE_LEVELS;
    levels.forEach((name, i) => {
      this.levelOf.set(name.toLowerCase(), i);
      for (const alias of ALIASES[i] ?? []) this.levelOf.set(alias.toLowerCase(), i);
    });
  }

  /** Labels found on a step and its descendants, grouped into cells (one cell per distinct label set). */
  private cellsOf(step: TestStep): (string | null)[][] {
    const cells: (string | null)[][] = [];
    const visit = (s: TestStep) => {
      const cell: (string | null)[] = [null, null, null, null];
      for (const a of annotationsOf(s)) {
        const level = this.levelOf.get(a.type.toLowerCase());
        if (level !== undefined && a.description) cell[level] = a.description;
      }
      // A step is a hit when it has at least the first level.
      if (cell[0]) cells.push(cell);
      for (const child of s.steps ?? []) visit(child);
    };
    visit(step);
    const unique = new Map(cells.map((c) => [JSON.stringify(c), c]));
    return [...unique.values()];
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Only test.step() blocks; hooks and fixtures are not coverage.
    const top = result.steps;
    top.forEach((step, idx) => {
      for (const cell of this.cellsOf(step)) {
        this.rows.push({
          test_id: test.id,
          attempt: result.retry,
          idx,
          title: step.title,
          status: step.error ? 'failed' : 'passed',
          component: cell[0]!,
          scenario: cell[1],
          feature: cell[2],
          area: cell[3],
        });
      }
    });
  }

  get size(): number {
    return this.rows.length;
  }

  /** Writes <runDir>/step-coverage.jsonl (and .gz when archived). Writes nothing when no step was labelled. */
  write(runDir: string, runId: string, opts: { archived?: boolean; writePlainText?: boolean } = {}): string | null {
    if (!this.rows.length) return null;
    const text = this.rows.map((r) => JSON.stringify({ run_id: runId, ...r })).join('\n') + '\n';
    fs.mkdirSync(runDir, { recursive: true });
    const plain = path.join(runDir, 'step-coverage.jsonl');
    if (opts.writePlainText !== false) fs.writeFileSync(plain, text);
    if (opts.archived !== false) fs.writeFileSync(`${plain}.gz`, zlib.gzipSync(text));
    return plain;
  }
}
