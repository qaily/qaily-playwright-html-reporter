/**
 * The Playwright reporter: writes each run as JSONL files (from @qaily/playwright-jsonl-reporter), plus the step
 * coverage labels for the heat map. `qaily-report build` turns the run folders into the report's data.
 *
 * @example
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [['@qaily/playwright-html-reporter', { outputDir: 'reports/data' }]],
 * });
 */

import * as path from 'node:path';
import { PlaywrightJsonlReporterCore, type PlaywrightJsonlReporterCoreOptions } from '@qaily/playwright-jsonl-reporter';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import { CoverageCollector, type CoverageOptions } from './coverage-collector.ts';

export interface QailyReporterOptions extends PlaywrightJsonlReporterCoreOptions {
  /** Step coverage for the heat map: which step annotation types are the four levels. */
  coverage?: CoverageOptions;
}

export default class QailyReporter extends PlaywrightJsonlReporterCore {
  private coverageCollector: CoverageCollector;

  constructor(options: QailyReporterOptions = {}) {
    const { afterJsonl: userAfterJsonl, coverage, ...rest } = options;
    const collector = new CoverageCollector(coverage);
    super({
      ...rest,
      afterJsonl: async () => {
        // The core writes the run to <outputDir>/<runId>; step coverage goes next to it.
        const runId = (this as unknown as { runId: string }).runId;
        const outputDir = rest.outputDir || './reports/data';
        const written = collector.write(path.join(outputDir, runId), runId, { archived: rest.archived, writePlainText: rest.writePlainText });
        if (written) console.log(`[Qaily reporter] Step coverage: ${collector.size} labelled step(s) → ${written}`);
        await userAfterJsonl?.();
      },
    });
    this.coverageCollector = collector;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    super.onTestEnd(test, result);
    this.coverageCollector.onTestEnd(test, result);
  }
}
