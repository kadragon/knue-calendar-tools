import type { ProcessedRecord } from "../types.js";

export interface PendingPlanEntry {
  nttNo: string;
  plan: unknown;
}

export interface StateStore {
  getProcessedRecord(feedId: string, nttNo: string): Promise<ProcessedRecord | null>;
  getMaxProcessedId(feedId: string): Promise<number>;
  updateMaxProcessedId(feedId: string, id: number): Promise<void>;
  getItemFailureCount(feedId: string, nttNo: string): Promise<number>;
  recordItemFailure(feedId: string, nttNo: string): Promise<number>;
  clearItemFailureCount(feedId: string, nttNo: string): Promise<void>;
  getPendingPlan(feedId: string, nttNo: string): Promise<unknown>;
  listPendingPlans(feedId: string): Promise<PendingPlanEntry[]>;
  putPendingPlan(feedId: string, nttNo: string, plan: unknown): Promise<void>;
  completeItem(feedId: string, nttNo: string, record: ProcessedRecord): Promise<void>;
}

export interface StateEnv {
  state: StateStore;
}

export const LEGACY_FEED_ID = "bbs28";

export function getProcessedRecord(env: StateEnv, feedId: string, nttNo: string) {
  return env.state.getProcessedRecord(feedId, nttNo);
}

export function getMaxProcessedId(env: StateEnv, feedId: string) {
  return env.state.getMaxProcessedId(feedId);
}

export async function updateMaxProcessedId(env: StateEnv, feedId: string, id: string) {
  const numericId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(numericId) || numericId < 0) {
    console.warn(`updateMaxProcessedId called with invalid id: "${id}"`);
    return;
  }
  await env.state.updateMaxProcessedId(feedId, numericId);
}

export function getItemFailureCount(env: StateEnv, feedId: string, nttNo: string) {
  return env.state.getItemFailureCount(feedId, nttNo);
}

export function recordItemFailure(env: StateEnv, feedId: string, nttNo: string) {
  return env.state.recordItemFailure(feedId, nttNo);
}

export function clearItemFailureCount(env: StateEnv, feedId: string, nttNo: string) {
  return env.state.clearItemFailureCount(feedId, nttNo);
}

export async function getPendingPlan<T>(env: StateEnv, feedId: string, nttNo: string) {
  return (await env.state.getPendingPlan(feedId, nttNo)) as T | null;
}

export async function listPendingPlans<T>(env: StateEnv, feedId: string) {
  return (await env.state.listPendingPlans(feedId)) as { nttNo: string; plan: T }[];
}

export function putPendingPlan(env: StateEnv, feedId: string, nttNo: string, plan: unknown) {
  return env.state.putPendingPlan(feedId, nttNo, plan);
}

export function completeItem(env: StateEnv, feedId: string, nttNo: string, record: ProcessedRecord) {
  return env.state.completeItem(feedId, nttNo, record);
}
