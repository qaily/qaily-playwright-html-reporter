// Lanes group runs for dashboards (e.g. "Web · Dev"). Matching is config, never parsed from folder names.

export interface LaneMatch {
  /** Regular expression source matched against the manifest category, e.g. "^ui:web". */
  category?: string;
  /** Exact environment, e.g. "sys". */
  environment?: string;
  /** Regular expression source matched against the git branch. */
  branch?: string;
}

export interface Lane {
  id: string;
  label: string;
  match: LaneMatch;
}

interface LaneSubject {
  category: string | null;
  environment: string | null;
  branch: string | null;
}

function regexMatches(source: string | undefined, value: string | null): boolean {
  if (source === undefined || source === '') return true;
  if (value == null) return false;
  try {
    return new RegExp(source).test(value);
  } catch {
    return false;
  }
}

export function laneMatches(lane: Lane, run: LaneSubject): boolean {
  const m = lane.match;
  return (
    regexMatches(m.category, run.category) &&
    (m.environment === undefined || m.environment === '' || m.environment === run.environment) &&
    regexMatches(m.branch, run.branch)
  );
}

/** First matching lane wins, so order lanes from specific to general. */
export function laneOf(lanes: readonly Lane[], run: LaneSubject): Lane | null {
  return lanes.find((lane) => laneMatches(lane, run)) ?? null;
}
