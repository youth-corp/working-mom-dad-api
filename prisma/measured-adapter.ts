import { PrismaPg } from '@prisma/adapter-pg';
import { measureDatabase } from '../common/performance';

type Adapter = Awaited<ReturnType<PrismaPg['connect']>>;
type Transaction = Awaited<ReturnType<Adapter['startTransaction']>>;

export function measureQueryable<
  T extends Pick<Adapter, 'queryRaw' | 'executeRaw'>,
>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === 'queryRaw') {
        return (...args: Parameters<T['queryRaw']>) =>
          measureDatabase('db.query', () => object.queryRaw(args[0]));
      }
      if (property === 'executeRaw') {
        return (...args: Parameters<T['executeRaw']>) =>
          measureDatabase('db.execute', () => object.executeRaw(args[0]));
      }
      return Reflect.get(object, property, receiver) as unknown;
    },
  });
}

/** Includes queries inside interactive/batch transactions; leaves adapter ownership intact. */
export class MeasuredPrismaPg extends PrismaPg {
  async connect(): Promise<Adapter> {
    const adapter = measureQueryable(await super.connect());
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args): Promise<Transaction> =>
      measureQueryable(await startTransaction(...args));
    return adapter;
  }
}
