import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_ALS_KEY = "__nineRouterRequestLogAls";

function getAls() {
  if (!globalThis[GLOBAL_ALS_KEY]) {
    globalThis[GLOBAL_ALS_KEY] = new AsyncLocalStorage();
  }
  return globalThis[GLOBAL_ALS_KEY];
}

/**
 * Run an async/sync function with the active 9Router disk requestLogId bound to
 * AsyncLocalStorage so in-process interceptors (e.g. proxyFetch.js) can attach
 * upstream captures 1-to-1 without threading requestLogId through every executor.
 */
export function runWithRequestLogId(requestLogId, fn) {
  if (!requestLogId) return fn();
  return getAls().run({ requestLogId }, fn);
}

export function getCurrentRequestLogId() {
  return getAls().getStore()?.requestLogId || null;
}
