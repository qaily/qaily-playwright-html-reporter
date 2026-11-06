import type { AiCategory, AiRecord, Settings } from '@qaily/contracts';

export const AI_CATEGORY_LABEL: Record<AiCategory, string> = {
  'product-bug': 'Product bug',
  'test-bug': 'Test bug',
  environment: 'Environment',
  'test-data': 'Test data',
  flaky: 'Flaky',
  unknown: 'Unclear',
};

export const AI_CATEGORY_COLOR: Record<AiCategory, string> = {
  'product-bug': 'var(--q-fail)',
  'test-bug': 'var(--q-flaky)',
  environment: 'var(--q-accent)',
  'test-data': 'var(--q-accent)',
  flaky: 'var(--q-flaky)',
  unknown: 'var(--q-skip)',
};

/** "claude-sonnet · 22 Oct 14:05 · by alice" */
export function aiProvenance(r: AiRecord, settings: Settings): string {
  const when = new Date(r.createdAt).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: settings.display.timeZone === 'UTC' ? 'UTC' : undefined,
  });
  return [r.model ?? r.provider, when, r.author ? `by ${r.author}` : ''].filter(Boolean).join(' · ');
}
