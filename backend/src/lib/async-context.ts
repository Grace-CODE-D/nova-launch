import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  correlationId: string;
}

export const asyncContext = new AsyncLocalStorage<RequestContext>();

export function getCorrelationId(): string | undefined {
  return asyncContext.getStore()?.correlationId;
}

export function runWithContext<T>(correlationId: string, fn: () => T): T {
  return asyncContext.run({ correlationId }, fn);
}
