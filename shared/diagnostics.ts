export type CheckStatus = 'pass' | 'warning' | 'fail' | 'unknown';
export interface DiagnosticCheck {
  id: string; title: string; status: CheckStatus; detail: string; remedy?: string;
}
export interface DiagnosticReport {
  schemaVersion: 1; checkedAt: string; checks: DiagnosticCheck[];
  summary: Record<CheckStatus, number>;
}
export interface DiagnosticEvent {
  at: string; operation: string; outcome: 'completed' | 'accepted' | 'failed'; code?: string;
}
export interface DiagnosticExport {
  schemaVersion: 1; appVersion: string; exportedAt: string; report: DiagnosticReport;
  events: DiagnosticEvent[]; scope: string;
}
