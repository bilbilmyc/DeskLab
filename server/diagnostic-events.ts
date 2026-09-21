import type {DiagnosticEvent} from '../shared/diagnostics';

// Only fixed labels/codes leave this module. Never retain request bodies, raw
// errors, IDs, paths, URLs, guest output or credentials, even temporarily in a log.
export function diagnosticErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'ZodError') return 'INVALID_INPUT';
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EADDRINUSE', 'ETIMEDOUT'].includes(code ?? '')) return code!;
  const message = error instanceof Error ? error.message : '';
  if (/超时|timed? ?out/i.test(message)) return 'TIMEOUT';
  if (/WHPX|hypervisor|虚拟化/i.test(message)) return 'VIRTUALIZATION';
  if (/端口/.test(message)) return 'PORT';
  if (/磁盘|镜像|ISO/.test(message)) return 'STORAGE_OR_MEDIA';
  return 'OPERATION_FAILED';
}
export class DiagnosticEvents {
  private events: DiagnosticEvent[] = [];
  record(path: string, status: number, error?: unknown) {
    let operation: string | undefined;
    if (path === '/api/settings') operation = 'settings.save';
    if (path === '/api/machines') operation = 'machine.create';
    if (path === '/api/templates/import') operation = 'template.import';
    if (path === '/api/app/quit') operation = 'app.quit';
    const vm = path.match(/^\/api\/machines\/[^/]+\/(start|stop|force-stop|reset|delete|eject|template|network)$/);
    if (vm) operation = `machine.${vm[1]}`;
    const engine = path.match(/^\/api\/docker\/managed\/(enable|start|stop|force-stop|select|backup|restore|rebuild|configure)$/);
    if (engine) operation = `docker.${engine[1]}`;
    if (!operation) return;
    this.events.push({at: new Date().toISOString(), operation, outcome: status >= 400 ? 'failed' : status === 202 ? 'accepted' : 'completed', ...(status >= 400 ? {code: diagnosticErrorCode(error)} : {})});
    this.events = this.events.slice(-100);
  }
  snapshot() { return this.events.map(event => ({...event})); }
}
