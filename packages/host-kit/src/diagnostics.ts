export {
  countDiagnosticEventsByPhase,
  createRequestId,
  type DiagnosticEventInput,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  redactRegisteredSensitiveValues,
  registerDiagnosticSensitiveValue,
  type ResourceDiagnostic,
  updateDiagnosticsScope,
  withDiagnosticsScope,
  withDiagnosticTimer,
} from './internal/diagnostics.ts';
