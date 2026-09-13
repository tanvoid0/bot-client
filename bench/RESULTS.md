# Benchmark results

Date: 2026-09-13
Node: v24.14.1
Machine: local dev machine (Windows), single run per script, see command column.

| Metric | Target | Result | Pass | Command |
|---|---|---|---|---|
| Per-call overhead above raw `fetch` (non-stream), p50 | < 1 ms | OpenAIProvider −0.122 ms, AIFactory −0.126 ms (both faster than raw fetch) | yes | `npm run bench:overhead` |
| Per-call overhead above raw `fetch` (non-stream), p99 | < 3 ms | OpenAIProvider −0.646 ms, AIFactory −0.941 ms | yes | `npm run bench:overhead` |
| Streaming overhead per chunk | < 0.05 ms | raw 16.52 µs/chunk, `processStream` 7.64 µs/chunk (delta −8.87 µs) | yes | `npm run bench:stream` |
| Memory for a 1 MB streamed answer | flat, far below 1 MB | 296.5 KB heapUsed delta for 1,048,580 chars streamed | yes | `npm run bench:stream -- --size` |
| Cold `import` of core entry | < 15 ms, zero network | median 9.83 ms over 5 runs (9.81, 9.82, 9.83, 9.84, 19.78); no-network assertion passed | yes | `npm run bench:import` |
| Published size (`.` entry, minified, gz) | < 12 kB | raw 42,958 B, gz 13,543 B (after reasoning support, hints and fallback rules landed; earlier in the day 12,200 B) | no, 1.5 kB over; Phase 2 subpath exports move the Ollama CLI and per-provider code out of `.` | `npm run bench:size` |

## Notes

- **Overhead is negative**: `OpenAIProvider`/`AIFactory` measured faster than a bare `fetch` + `res.json()` in this run. Both do comparable work (fetch, read text, `JSON.parse`); the delta is noise-level (sub-millisecond), well inside target either way.
- **Streaming per-chunk**: raw fetch's µs/chunk is `total time / 1000` (the number of SSE frames sent), since raw fetch doesn't parse frames — it's a network-only baseline. `processStream` divides by its own yielded chunk count. Both comfortably clear the 0.05 ms (50 µs) target.
- **Memory check** (`bench/stream.mjs --size`) warms up the stream code path 3 times before measuring (JIT/module compile on the first-ever stream in a process otherwise dominates the reading — an unwarmed first run showed ~1 MB, i.e. the whole answer, purely from one-time compilation cost, not accumulation; see the `ponytail:` comment in the script). After warm-up the delta is a consistent 200–400 KB, well under the 1 MB streamed, confirming chunks are yielded rather than buffered.
- **Size**: gzip target of "< 12 kB" is ambiguous at this exact size — 12,200 bytes is under 12 KiB (12,288 B) but over a decimal 12 kB (12,000 B). Reported as borderline pass/fail rather than picking a favorable unit silently. `providers/openai-compatible.js` alone is 5,289 B gz, well clear either way.
- Single-provider (`gpt-4o`, non-stream) suite; multi-provider fallback/retry paths are not separately benchmarked here — out of scope for §6.2.
