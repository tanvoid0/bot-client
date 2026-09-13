// Minimal OpenAI-shaped mock: enough surface for the bench scripts, nothing else.
import { createServer } from 'node:http';

const MODELS_BODY = JSON.stringify({ data: [{ id: 'gpt-4o' }] });
const REPLY_TEXT = 'word '.repeat(40).trim(); // ~200 chars

function nonStreamBody() {
  return JSON.stringify({
    id: 'chatcmpl-bench',
    object: 'chat.completion',
    model: 'gpt-4o',
    choices: [{ index: 0, message: { role: 'assistant', content: REPLY_TEXT }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
  });
}

function writeSSE(res, n) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  for (let i = 0; i < n; i++) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'word ' } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: n, total_tokens: 10 + n } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

export function startMock() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(MODELS_BODY);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        if (body.stream) {
          writeSSE(res, body.max_tokens ?? 200);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(nonStreamBody());
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.keepAliveTimeout = 60_000;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
