import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type Span = { name: string; duration_ms: number; ok: boolean };
export type RequestTiming = { spans: Span[]; db_count: number; db_ms: number };
export const requestTiming = new AsyncLocalStorage<RequestTiming>();
const rounded = (value: number) => Math.round(value * 100) / 100;

/** Measures driver I/O including pool/network wait, never SQL or parameters. */
export async function measureDatabase<T>(
  name: 'db.query' | 'db.execute',
  run: () => Promise<T>,
): Promise<T> {
  const context = requestTiming.getStore();
  if (!context) return run();
  const started = performance.now();
  let ok = false;
  try {
    const result = await run();
    ok = true;
    return result;
  } finally {
    const duration = performance.now() - started;
    context.db_count += 1;
    context.db_ms += duration;
    if (context.spans.length < 64) {
      context.spans.push({ name, duration_ms: rounded(duration), ok });
    }
  }
}

export function performanceMiddleware(
  options: {
    enabled?: boolean;
    sampleRate?: number;
    write?: (event: Record<string, unknown>) => void;
  } = {},
) {
  const enabled = options.enabled ?? process.env.PERFORMANCE_ENABLED === 'true';
  const configuredRate =
    options.sampleRate ?? Number(process.env.PERFORMANCE_SAMPLE_RATE ?? 1);
  const rate = Number.isFinite(configuredRate)
    ? Math.max(0, Math.min(1, configuredRate))
    : 0;
  const write =
    options.write ?? ((event) => console.info(JSON.stringify(event)));
  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled || Math.random() >= rate) return next();
    const started = performance.now();
    const id = randomUUID();
    const context: RequestTiming = { spans: [], db_count: 0, db_ms: 0 };
    let headersMs: number | undefined;
    let logged = false;
    res.setHeader('X-Request-ID', id);
    res.setHeader(
      'X-API-Release',
      process.env.PERFORMANCE_RELEASE ||
        process.env.RENDER_GIT_COMMIT ||
        'unknown',
    );
    const original = res.writeHead.bind(res);
    res.writeHead = function (
      this: Response,
      ...args: Parameters<Response['writeHead']>
    ) {
      headersMs ??= rounded(performance.now() - started);
      if (!this.headersSent) {
        this.setHeader('Server-Timing', `app;dur=${headersMs}`);
      }
      return original(...args);
    } as Response['writeHead'];
    const finish = () => {
      if (logged) return;
      logged = true;
      // Express's route template contains parameter names, not user-supplied IDs.
      const route = (req.route as { path?: unknown } | undefined)?.path;
      try {
        write({
          event: 'api_request',
          schema_version: 1,
          request_id: id,
          api_release:
            process.env.PERFORMANCE_RELEASE ||
            process.env.RENDER_GIT_COMMIT ||
            'unknown',
          environment: process.env.NODE_ENV ?? 'unknown',
          route: typeof route === 'string' ? route : '__unmatched__',
          method: req.method,
          status: res.statusCode,
          completed: res.writableFinished,
          duration_ms: rounded(performance.now() - started),
          headers_ms: headersMs,
          db_count: context.db_count,
          db_ms: rounded(context.db_ms),
          spans: context.spans,
          spans_truncated: context.db_count > context.spans.length,
          sample_rate: rate,
        });
      } catch {
        /* Telemetry must not break requests. */
      }
    };
    res.once('finish', finish);
    res.once('close', finish);
    requestTiming.run(context, next);
  };
}
