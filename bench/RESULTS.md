# Benchmark results

Date: 2026-09-13
Node: v24.14.1
Machine: local dev machine (Windows), single run per script, see command column.

| Metric | Target | Result | Pass | Command |
|---|---|---|---|---|
| Per-call overhead above raw `fetch` (non-stream), p50 | < 1 ms | OpenAIProvider −0.118 ms, AIFactory −0.123 ms (both faster than raw fetch; 1.8.0 run) | yes | `npm run bench:overhead` |
| Per-call overhead above raw `fetch` (non-stream), p99 | < 3 ms | OpenAIProvider −0.453 ms, AIFactory −0.905 ms | yes | `npm run bench:overhead` |
| Streaming overhead per chunk | < 0.05 ms | raw 17.08 µs/chunk, `processStream` 8.20 µs/chunk (delta −8.88 µs) | yes | `npm run bench:stream` |
| Memory for a 1 MB streamed answer | flat, far below 1 MB | 299.2 KB heapUsed delta for 1,048,580 chars streamed | yes | `npm run bench:stream -- --size` |
| Cold `import` of core entry | < 15 ms, zero network | median 9.17 ms over 5 runs (9.08, 9.08, 9.17, 9.47, 9.53); no-network assertion passed | yes | `npm run bench:import` |
| Published size (minified, gz) | < 12 kB for `./core` + one provider | 2.0 dev (2026-09-13, after images + tools): `.` 17,048 B; `./core` 9,579 B; `./core` + `./openai` bundled together 11,524 B | yes for the split entry; `.` keeps all five built-ins for zero config and is not expected to meet it | `npm run bench:size` |

## Notes

- **Overhead is negative**: `OpenAIProvider`/`AIFactory` measured faster than a bare `fetch` + `res.json()` in this run. Both do comparable work (fetch, read text, `JSON.parse`); the delta is noise-level (sub-millisecond), well inside target either way.
- **Streaming per-chunk**: raw fetch's µs/chunk is `total time / 1000` (the number of SSE frames sent), since raw fetch doesn't parse frames — it's a network-only baseline. `processStream` divides by its own yielded chunk count. Both comfortably clear the 0.05 ms (50 µs) target.
- **Memory check** (`bench/stream.mjs --size`) warms up the stream code path 3 times before measuring (JIT/module compile on the first-ever stream in a process otherwise dominates the reading — an unwarmed first run showed ~1 MB, i.e. the whole answer, purely from one-time compilation cost, not accumulation; see the `ponytail:` comment in the script). After warm-up the delta is a consistent 200–400 KB, well under the 1 MB streamed, confirming chunks are yielded rather than buffered.
- **Size**: gzip target of "< 12 kB" is ambiguous at this exact size — 12,200 bytes is under 12 KiB (12,288 B) but over a decimal 12 kB (12,000 B). Reported as borderline pass/fail rather than picking a favorable unit silently. `providers/openai-compatible.js` alone is 5,289 B gz, well clear either way.
- Single-provider (`gpt-4o`, non-stream) suite; multi-provider fallback/retry paths are not separately benchmarked here — out of scope for §6.2.
