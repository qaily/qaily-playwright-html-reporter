// Public entry of the npm package `@qaily/playwright-html-reporter`.

export { default, default as QailyReporter, type QailyReporterOptions } from './reporter.ts';
export { coverage, type CoverageLabels } from './coverage.ts';
export { CoverageCollector, type CoverageOptions } from './coverage-collector.ts';

// The JSONL layer, for extending the reporter.
export { PlaywrightJsonlReporterCore, JsonlGenerator, DEFAULT_GENERATOR_OPTIONS } from '@qaily/playwright-jsonl-reporter';
export type { GeneratorOptions, PlaywrightJsonlReporterCoreOptions } from '@qaily/playwright-jsonl-reporter';
