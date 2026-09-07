import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express } from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import {
  measureDatabase,
  performanceMiddleware,
  requestTiming,
  type RequestTiming,
} from './performance';
import { measureQueryable } from '../prisma/measured-adapter';

void test('concurrent DB spans are isolated, count failures, and cap details', async () => {
  const a: RequestTiming = { spans: [], db_count: 0, db_ms: 0 };
  const b: RequestTiming = { spans: [], db_count: 0, db_ms: 0 };
  await Promise.all([
    requestTiming.run(a, () =>
      measureDatabase('db.query', async () => {
        await delay(5);
        return 1;
      }),
    ),
    requestTiming.run(b, async () => {
      for (let index = 0; index < 65; index++) {
        await assert.rejects(
          measureDatabase('db.execute', () =>
            Promise.reject(new Error('private SQL data')),
          ),
        );
      }
    }),
  ]);
  assert.equal(a.db_count, 1);
  assert.equal(b.db_count, 65);
  assert.equal(b.spans.length, 64);
  assert.equal(b.spans[0].ok, false);
  assert.ok(!JSON.stringify(b).includes('private'));
});

void test('driver wrapper preserves query results and receiver without serializing SQL', async () => {
  const context: RequestTiming = { spans: [], db_count: 0, db_ms: 0 };
  const target = {
    marker: 42,
    queryRaw(this: { marker: number }) {
      return Promise.resolve({
        columnNames: [],
        columnTypes: [],
        rows: [[this.marker]],
      });
    },
    executeRaw(this: { marker: number }) {
      return Promise.resolve(this.marker);
    },
  };
  const adapter = measureQueryable(target);
  await requestTiming.run(context, async () => {
    assert.equal(await adapter.executeRaw(), 42);
    assert.deepEqual((await adapter.queryRaw()).rows, [[42]]);
  });
  assert.equal(context.db_count, 2);
});

void test('HTTP logging includes rejected requests and only route templates; no duplicate finish/close', async () => {
  const logs: Record<string, unknown>[] = [];
  const app = new ExpressAdapter().getInstance<Express>();
  app.use(
    performanceMiddleware({
      enabled: true,
      sampleRate: 1,
      write: (entry) => {
        logs.push(entry);
      },
    }),
  );
  app.get('/children/:id', async (_req, res) => {
    await measureDatabase('db.query', () => delay(2));
    res.status(401).json({ error: 'denied' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/children/secret-child?token=secret`,
    );
    await response.text();
    assert.ok(response.headers.get('x-request-id'));
    assert.match(response.headers.get('server-timing') ?? '', /^app;dur=/);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].route, '/children/:id');
    assert.equal(logs[0].status, 401);
    assert.equal(logs[0].db_count, 1);
    assert.equal(logs[0].completed, true);
    assert.ok(!JSON.stringify(logs).includes('secret'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

void test('disabled middleware passes through without touching response', () => {
  let called = false;
  performanceMiddleware({ enabled: false })(
    null as never,
    null as never,
    () => {
      called = true;
    },
  );
  assert.equal(called, true);
});
