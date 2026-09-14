/** @module llmwire/routine */
/**
 * Routine: a named job on an interval (`'15m'`, `'2h'`, ms) or a 5-field cron
 * (`'0 8 * * *'`, local time), in this process, with `setTimeout`. A run that
 * overruns its slot skips the next tick; `stop()` aborts the running one.
 * A `Store` keeps `lastRunAt` / `lastResult` so a restart knows what it missed;
 * `catchUp: true` runs once immediately when the last run is older than a
 * period. Not a distributed scheduler: several instances need a lock in their
 * own `Store`.
 */
import type { Store } from './session.js';
import { AIError, toAIError } from '../core/errors.js';

export interface RoutineState<T = unknown> {
  lastRunAt?: number;
  lastResult?: T;
  lastError?: string;
}

export interface RoutineConfig<T = unknown> {
  name: string;
  /** `'30s'`, `'15m'`, `'2h'`, `'1d'`, a number of ms, or 5-field cron `min hour dom mon dow`. */
  every: string | number;
  run: (ctx: { signal: AbortSignal; lastRunAt?: number }) => T | Promise<T>;
  /** Persists `lastRunAt` and `lastResult` under `name`; `MemoryStore` from `./session` works. */
  store?: Store<RoutineState<T>>;
  onResult?: (result: T) => void | Promise<void>;
  onError?: (error: AIError) => void | Promise<void>;
  /** ms before a run is aborted (its `signal` fires) and reported as `TIMEOUT`. Default: none. */
  timeout?: number;
  /** On `start`, run at once when the stored last run is older than one period (or never happened). Default false. */
  catchUp?: boolean;
}

export class Routine<T = unknown> {
  readonly name: string;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: { abort: AbortController; done: Promise<void> };
  private started = false;

  constructor(private readonly cfg: RoutineConfig<T>) {
    this.name = cfg.name;
    nextRun(cfg.every, new Date()); // fail on a bad schedule now, not at first tick
  }

  /** When the next run is due, from `from` (default now). */
  next(from: Date = new Date()): Date {
    return nextRun(this.cfg.every, from);
  }

  async state(): Promise<RoutineState<T>> {
    return (await this.cfg.store?.get(this.name)) ?? {};
  }

  /** Schedules the ticks; with `catchUp`, runs first if a run was missed. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.cfg.catchUp) {
      const last = (await this.state()).lastRunAt;
      const missed = last === undefined || nextRun(this.cfg.every, new Date(last)).getTime() <= Date.now();
      if (missed) await this.runNow();
    }
    this.schedule();
  }

  /** Cancels the next tick and aborts a run in progress (its `signal` fires). Resolves once the run has ended. */
  async stop(): Promise<void> {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running?.abort.abort();
    await this.running?.done;
  }

  /** Runs once now, outside the schedule. If a run is already in progress, waits for it and returns its outcome instead. */
  async runNow(): Promise<T | undefined> {
    if (this.running) {
      await this.running.done;
      return (await this.state()).lastResult;
    }
    const abort = new AbortController();
    let result: T | undefined;
    const done = (async () => {
      const timer = this.cfg.timeout ? setTimeout(() => abort.abort(AIError.from({ message: `Routine "${this.name}" exceeded ${this.cfg.timeout} ms`, provider: 'routine', code: 'TIMEOUT' })), this.cfg.timeout) : undefined;
      const startedAt = Date.now();
      try {
        result = await this.cfg.run({ signal: abort.signal, lastRunAt: (await this.state()).lastRunAt });
        await this.cfg.store?.set(this.name, { lastRunAt: startedAt, lastResult: result });
        await this.cfg.onResult?.(result);
      } catch (err) {
        const error = abort.signal.reason instanceof AIError ? abort.signal.reason : toAIError(err, { provider: 'routine' });
        await this.cfg.store?.set(this.name, { ...(await this.state()), lastRunAt: startedAt, lastError: error.message });
        if (this.cfg.onError) await this.cfg.onError(error);
        else if (error.code !== 'ABORTED') throw error;
      } finally {
        clearTimeout(timer);
        this.running = undefined;
      }
    })();
    this.running = { abort, done };
    await done;
    return result;
  }

  private schedule(): void {
    if (!this.started) return;
    const delay = Math.max(0, this.next().getTime() - Date.now());
    this.timer = setTimeout(() => {
      // Overlap guard: a run still going from the last tick means this tick is skipped, not queued.
      const p = this.running ? Promise.resolve() : this.runNow().catch((e) => console.error(`[llmwire] routine "${this.name}" failed:`, e));
      void p.then(() => this.schedule());
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** ms for `'15m'`-style durations and numbers; `undefined` for a cron expression. */
export function parseDuration(every: string | number): number | undefined {
  if (typeof every === 'number') return every;
  const m = DURATION.exec(every.trim());
  return m ? Number(m[1]) * UNIT[m[2].toLowerCase()] : undefined;
}

/** The next time `every` fires strictly after `from`. */
export function nextRun(every: string | number, from: Date): Date {
  const ms = parseDuration(every);
  if (ms !== undefined) {
    if (!(ms > 0)) throw new Error(`Routine: interval must be positive, got ${JSON.stringify(every)}`);
    return new Date(from.getTime() + ms);
  }
  return nextCron(parseCron(every as string), from);
}

type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; anyDom: boolean; anyDow: boolean };

const RANGES: Array<[string, number, number]> = [['minute', 0, 59], ['hour', 0, 23], ['dom', 1, 31], ['month', 1, 12], ['dow', 0, 7]];

/** 5-field cron: `*`, lists, ranges and steps (`1-5`, `1,15`, star-slash-15); numbers only; Sunday is 0 or 7. */
export function parseCron(expr: string): Cron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Routine: expected 5 cron fields or a duration like '15m', got ${JSON.stringify(expr)}`);
  const out: Record<string, Set<number>> = {};
  fields.forEach((field, i) => {
    const [name, min, max] = RANGES[i];
    const set = new Set<number>();
    for (const part of field.split(',')) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
      if (!m) throw new Error(`Routine: bad cron field ${JSON.stringify(part)} in ${JSON.stringify(expr)}`);
      const lo = m[1] === '*' ? min : Number(m[1]);
      const hi = m[2] !== undefined ? Number(m[2]) : m[1] === '*' ? max : lo;
      const step = m[3] !== undefined ? Number(m[3]) : 1;
      if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`Routine: cron field ${JSON.stringify(part)} out of range ${min}-${max}`);
      for (let v = lo; v <= hi; v += step) set.add(name === 'dow' && v === 7 ? 0 : v);
    }
    out[name] = set;
  });
  return { ...(out as Omit<Cron, 'anyDom' | 'anyDow'>), anyDom: fields[2] === '*', anyDow: fields[4] === '*' };
}

function nextCron(c: Cron, from: Date): Date {
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  // As in cron: when both day fields are restricted, either matching is enough.
  const dayOk = (d: Date) => {
    const dom = c.dom.has(d.getDate());
    const dow = c.dow.has(d.getDay());
    return c.anyDom && c.anyDow ? true : c.anyDom ? dow : c.anyDow ? dom : dom || dow;
  };
  for (let guard = 0; guard < 366 * 24 * 60; guard++) {
    if (!c.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayOk(t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  throw new Error('Routine: cron expression never fires');
}
