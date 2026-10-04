import { AsyncLocalStorage } from 'node:async_hooks';

/** Attach the right article to interleaved AI logs without shared mutable labels. */
export const cardContext = new AsyncLocalStorage<string>();
