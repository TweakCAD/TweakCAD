/**
 * What a reader reports about a document.
 *
 * - `refuse`: an integrity rule is broken (chapter 20); the document is not
 *   opened.
 * - `pause`: content that could change geometry is not understood (chapter
 *   18); what depends on the object at `path` does not build.
 * - `ignore`: presentational content that is not understood; it is kept and
 *   has no effect.
 */
export type Severity = 'refuse' | 'pause' | 'ignore';

export type DiagnosticCode =
  | 'wrong-type'
  | 'null'
  | 'missing-field'
  | 'unknown-key'
  | 'unknown-variant'
  | 'unknown-version'
  | 'bad-value'
  | 'bad-id'
  | 'duplicate-id'
  | 'dangling'
  | 'bad-set'
  | 'bad-hash'
  | 'missing-name'
  | 'bad-name'
  | 'duplicate-name'
  | 'reserved-name'
  | 'cycle'
  | 'bad-extensions'
  | 'bad-override'
  | 'bad-configuration'
  | 'bad-expression'
  | 'bad-rotation';

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  /** RFC 6901 pointer into the document. */
  path: string;
  message: string;
}

export class Diagnostics {
  readonly list: Diagnostic[] = [];

  add(severity: Severity, code: DiagnosticCode, path: string, message: string): void {
    this.list.push({ severity, code, path, message });
  }

  refuse(code: DiagnosticCode, path: string, message: string): void {
    this.add('refuse', code, path, message);
  }

  pause(code: DiagnosticCode, path: string, message: string): void {
    this.add('pause', code, path, message);
  }

  ignore(code: DiagnosticCode, path: string, message: string): void {
    this.add('ignore', code, path, message);
  }

  get refused(): boolean {
    return this.list.some((d) => d.severity === 'refuse');
  }
}

/** Appends one reference token to an RFC 6901 pointer. */
export function child(path: string, token: string | number): string {
  const text = String(token).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${path}/${text}`;
}
