import assert from 'node:assert/strict';
import express from 'express';
import {
  COOLDOWN_WINDOW_MS,
  COOLDOWN_DURATION_MS,
  getCooldownThreshold,
} from '../shared/simosan.js';

let passed = 0;
let total = 0;

function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        passed++;
        console.log(`  PASS  ${name}`);
      }).catch((err) => {
        console.error(`  FAIL  ${name}:`, err);
        throw err;
      });
    }
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}:`, err);
    throw err;
  }
}

async function run() {
  console.log('--- Simosan SSE Streaming & Cooldown Policy Tests ---');

  test('Cooldown window is 2 hours and threshold is 25% of weekly budget', () => {
    assert.equal(COOLDOWN_WINDOW_MS, 2 * 60 * 60 * 1000);
    assert.equal(COOLDOWN_DURATION_MS, 2 * 60 * 60 * 1000);

    // 500,000 budget -> 125,000 threshold (25%)
    assert.equal(getCooldownThreshold(500_000), 125_000);

    // 800,000 budget -> 200,000 threshold (25%)
    assert.equal(getCooldownThreshold(800_000), 200_000);

    // Single message (~25,000 units) is only 5% of 500k -> far below 25%
    const singleMessageUnits = 25_000;
    assert.ok(singleMessageUnits < getCooldownThreshold(500_000));
    assert.ok(singleMessageUnits * 3 < getCooldownThreshold(500_000));
  });

  await test('Express SSE stream does not abort on POST body completion and delivers all deltas', async () => {
    const app = express();
    app.use(express.json());

    app.post('/api/test-ask', (req, res) => {
      let clientAborted = false;
      const onResponseClose = () => {
        if (!res.writableEnded) {
          clientAborted = true;
        }
      };
      res.on('close', onResponseClose);

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      res.write(`data: ${JSON.stringify({ type: 'meta', questionNumber: 1 })}\n\n`);

      const tokens = ['Hello', ' ', 'Doctor', '!', ' ', 'Welcome'];
      for (const tok of tokens) {
        if (clientAborted || res.writableEnded || res.destroyed) {
          throw new Error('client_disconnected');
        }
        res.write(`data: ${JSON.stringify({ type: 'delta', text: tok })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ type: 'done', threadId: 'test_thread' })}\n\n`);
      res.end();
    });

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const response = await fetch(`http://localhost:${port}/api/test-ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lectureId: 'test', question: 'hello' }),
      });

      assert.equal(response.status, 200);
      assert.ok(response.body);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events: any[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.split(/\r?\n/).find((l) => l.trimStart().startsWith('data: '));
          if (line) {
            events.push(JSON.parse(line.trimStart().slice(6)));
          }
        }
      }

      assert.equal(events[0].type, 'meta');
      const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
      assert.equal(deltas, 'Hello Doctor! Welcome');
      assert.equal(events[events.length - 1].type, 'done');
    } finally {
      server.close();
    }
  });

  console.log(`\nAll ${passed}/${total} SSE streaming tests passed!`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

