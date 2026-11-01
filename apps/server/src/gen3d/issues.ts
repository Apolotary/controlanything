/** Check findings shared by every gen3d stage: where, what, how bad. */
export type Severity = 'error' | 'warn';
export type Stage = 'schema' | 'bindings' | 'presentation' | 'geometry' | 'safety' | 'composition' | 'request';

export interface Issue {
  stage: Stage;
  severity: Severity;
  code: string;
  /** where in the output, e.g. "hacks[2].commands[0].action" */
  path: string;
  message: string;
}

export function issue(stage: Stage, code: string, path: string, message: string, severity: Severity = 'error'): Issue {
  return { stage, severity, code, path, message };
}
