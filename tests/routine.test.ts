/** Phase 6: cron next-run, durations, overlap skip, catch-up, timeout, stop. Fake timers throughout. */
import { Routine, nextRun, parseCron, parseDuration } from '../src/agent/routine.js';
import { MemoryStore } from '../src/agent/session.js';
import type { RoutineState } from '../src/agent/routine.js';

const at = (s: string) => new Date(s); // local time

describe('schedule parsing', () => {
  test('durations', () => {
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1.5d')).toBe(129_600_000);
    expect(parseDuration(500)).toBe(500);
    expect(parseDuration('0 8 * * *')).toBeUndefined();
    expect(() => nextRun('0m', new Date())).toThrow(/positive/);
  });

  test('cron next run: minute, hour, list, step, range, day-of-week, day-of-month, month rollover', () => {
    expect(nextRun('0 8 * * *', at('2026-09-14T09:00:00'))).toEqual(at('2026-09-15T08:00:00'));
    expect(nextRun('0 8 * * *', at('2026-09-14T07:59:00'))).toEqual(at('2026-09-14T08:00:00'));
    expect(nextRun('*/15 * * * *', at('2026-09-14T09:07:00'))).toEqual(at('2026-09-14T09:15:00'));
    expect(nextRun('*/15 * * * *', at('2026-09-14T09:15:00'))).toEqual(at('2026-09-14T09:30:00')); // strictly after
    expect(nextRun('30 9-17 * * 1-5', at('2026-09-12T10:00:00'))).toEqual(at('2026-09-14T09:30:00')); // Saturday → Monday
    expect(nextRun('0 0 1 * *', at('2026-09-14T00:00:00'))).toEqual(at('2026-10-01T00:00:00'));
    expect(nextRun('0 12 * 12 *', at('2026-09-14T00:00:00'))).toEqual(at('2026-12-01T12:00:00'));
    expect(nextRun('0 0 * * 7', at('2026-09-14T00:00:00'))).toEqual(at('2026-09-20T00:00:00')); // 7 is Sunday
    // both day fields set: either matches (cron semantics)
    expect(nextRun('0 0 15 * 1', at('2026-09-14T01:00:00'))).toEqual(at('2026-09-15T00:00:00'));
  });

  test('bad cron', () => {
    expect(() => parseCron('* * *')).toThrow(/5 cron fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('a * * * *')).toThrow(/bad cron field/);
    expect(() => new Routine({ name: 'x', every: 'never', run: () => 0 })).toThrow();
  });
});

describe('Routine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async (ms: number) => {
    await jest.advanceTimersByTimeAsync(ms);
  };

  test('ticks on the interval, persists state, calls onResult', async () => {
    const store = new MemoryStore<RoutineState<number>>();
    const results: number[] = [];
    let n = 0;
    const r = new Routine({ name: 'tick', every: '1s', run: () => ++n, store, onResult: (v) => void results.push(v) });
    await r.start();
    await flush(3_050);
    expect(results).toEqual([1, 2, 3]);
    expect((await store.get('tick'))?.lastResult).toBe(3);
    await r.stop();
    await flush(5_000);
    expect(n).toBe(3);
  });

  test('overlap guard: a run longer than the interval skips ticks instead of queueing them', async () => {
    let started = 0;
    const r = new Routine({
      name: 'slow',
      every: '1s',
      run: ({ signal }) => new Promise<void>((res) => { started++; const t = setTimeout(res, 2_500); signal.addEventListener('abort', () => { clearTimeout(t); res(); }); }),
    });
    await r.start();
    await flush(6_100); // ticks at 1s (run 1s→3.5s), 2s skipped, 3s skipped, next scheduled 4.5s (run 4.5→7s), 5.5 skipped
    expect(started).toBe(2);
    await r.stop();
  });

  test('catchUp: runs at start when the stored run is stale or absent, not when fresh', async () => {
    const store = new MemoryStore<RoutineState<string>>();
    let runs = 0;
    const make = () => new Routine({ name: 'c', every: '1h', run: () => `run${++runs}`, store, catchUp: true });
    const a = make();
    await a.start(); // nothing stored → run now
    expect(runs).toBe(1);
    await a.stop();
    const b = make();
    await b.start(); // fresh → no run
    expect(runs).toBe(1);
    await b.stop();
    await store.set('c', { lastRunAt: Date.now() - 2 * 3_600_000, lastResult: 'old' });
    const c = make();
    await c.start(); // stale → run
    expect(runs).toBe(2);
    await c.stop();
  });

  test('timeout aborts the run with TIMEOUT via onError; a throwing run without onError rejects runNow', async () => {
    const errors: string[] = [];
    const r = new Routine({
      name: 't',
      every: '1h',
      timeout: 100,
      run: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      onError: (e) => void errors.push(e.code),
      store: new MemoryStore<RoutineState<never>>(),
    });
    const p = r.runNow();
    await flush(150);
    await p;
    expect(errors).toEqual(['TIMEOUT']);
    expect((await r.state()).lastError).toMatch(/exceeded 100 ms/);

    const bad = new Routine({ name: 'b', every: '1h', run: () => { throw new Error('boom'); } });
    await expect(bad.runNow()).rejects.toMatchObject({ message: 'boom' });
  });

  test('stop aborts a run in progress and resolves once it ended; runNow during a run waits for it', async () => {
    let aborted = false;
    const r = new Routine({
      name: 's',
      every: '1h',
      run: ({ signal }) => new Promise<string>((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve('aborted'); }); }),
      store: new MemoryStore<RoutineState<string>>(),
    });
    const first = r.runNow();
    const second = r.runNow(); // joins the first
    await flush(10);
    await r.stop();
    expect(aborted).toBe(true);
    expect(await first).toBe('aborted');
    expect(await second).toBe('aborted');
  });
});
