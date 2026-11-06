// Issue grouping: the same failure in different tests or runs gets the same key.
// Must match the SQL in packages/reporter/src/build.ts (covered by a test).

export function normalizeMessage(msg: string): string {
  return msg.replace(/\d+/g, 'N');
}

export function normalizeStep(step: string | null | undefined): string | null {
  if (step == null) return null;
  return step.replace(/"[^"]*"/g, '"S"').replace(/\d+/g, 'N');
}

/** Unhashed issue key; the build stores left(md5(key), 12) as issue_sig. */
export function issueKey(msg: string, step: string | null | undefined): string {
  return `${normalizeMessage(msg)}|${normalizeStep(step) ?? ''}`;
}
