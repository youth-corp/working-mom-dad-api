import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { measureQueryable } from './measured-adapter';
import { requestTiming, type RequestTiming } from '../common/performance';

/** Exercise the real Prisma query engine with a fake wire adapter; never accesses a DB. */
void test('Prisma engine preserves request context through queries and interactive transactions', async () => {
  const queryable = {
    provider: 'postgres' as const,
    adapterName: 'test-adapter',
    queryRaw: () =>
      Promise.resolve({
        columnNames: ['value'],
        columnTypes: [0 as const],
        rows: [[1]],
      }),
    executeRaw: () => Promise.resolve(1),
  };
  const adapter = {
    provider: 'postgres' as const,
    adapterName: 'test-adapter',
    connect: () =>
      Promise.resolve(
        measureQueryable({
          ...queryable,
          dispose: () => Promise.resolve(),
          executeScript: () => Promise.resolve(),
          getConnectionInfo: () => ({ supportsRelationJoins: false }),
          startTransaction: () =>
            Promise.resolve(
              measureQueryable({
                ...queryable,
                options: { usePhantomQuery: true },
                commit: () => Promise.resolve(),
                rollback: () => Promise.resolve(),
              }),
            ),
        }),
      ),
  };
  const client = new PrismaClient({ adapter });
  const context: RequestTiming = { spans: [], db_count: 0, db_ms: 0 };
  try {
    await requestTiming.run(context, async () => {
      assert.deepEqual(await client.$queryRawUnsafe('SELECT 1 AS value'), [
        { value: 1 },
      ]);
      await client.$transaction(async (tx) => {
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT 1 AS value'), [
          { value: 1 },
        ]);
      });
    });
    assert.equal(context.db_count, 2);
    assert.ok(context.spans.every((span) => span.ok));
  } finally {
    await client.$disconnect();
  }
});
