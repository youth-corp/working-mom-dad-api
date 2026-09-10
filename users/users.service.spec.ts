import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsersService } from './users.service';

void describe('UsersService', () => {
  void it('removes push tokens and notifications immediately when an account is soft-deleted', async () => {
    const userUpdateCalls: unknown[] = [];
    const pushTokenDeleteCalls: unknown[] = [];
    const notificationDeleteCalls: unknown[] = [];
    const tx = {
      user: {
        update: (args: unknown) => {
          userUpdateCalls.push(args);
          return Promise.resolve(undefined);
        },
      },
      userPushToken: {
        deleteMany: (args: unknown) => {
          pushTokenDeleteCalls.push(args);
          return Promise.resolve(undefined);
        },
      },
      notification: {
        deleteMany: (args: unknown) => {
          notificationDeleteCalls.push(args);
          return Promise.resolve(undefined);
        },
      },
    };
    const prisma = {
      user: {
        findUnique: () => Promise.resolve({ id: 'user-1', deletedAt: null }),
      },
      $transaction: (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
    };
    const service = new UsersService(prisma as never, {} as never);

    await service.softDeleteAccount('user-1', { reason: '재가입 테스트' });

    assert.equal(userUpdateCalls.length, 1);
    assert.deepEqual(pushTokenDeleteCalls, [{ where: { userId: 'user-1' } }]);
    assert.deepEqual(notificationDeleteCalls, [
      { where: { userId: 'user-1' } },
    ]);
  });
});
