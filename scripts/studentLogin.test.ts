import assert from 'node:assert/strict';
import test from 'node:test';
import { signInStudent, StudentLoginError } from '../src/services/studentLoginService';

const signInWithToken = async (token: string) => ({ token });

test('iOS Load failed is classified and retried once', async () => {
  let calls = 0;
  const result = await signInStudent({
    identifier: 'student-1',
    password: 'password',
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new TypeError('Load failed');
      return new Response(JSON.stringify({ token: 'custom-token', studentId: 'student-1' }), { status: 200 });
    },
    signInWithToken,
  });

  assert.equal(calls, 2);
  assert.equal(result.studentId, 'student-1');
});

test('invalid credentials are not retried', async () => {
  let calls = 0;
  await assert.rejects(
    signInStudent({
      identifier: 'student-1', password: 'wrong', retryDelayMs: 0, signInWithToken,
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
      },
    }),
    (error: unknown) => error instanceof StudentLoginError && error.code === 'auth/invalid-credential',
  );
  assert.equal(calls, 1);
});

test('password whitespace is preserved while the identifier is normalized', async () => {
  let request: any;
  await signInStudent({
    identifier: '  student-1  ',
    password: ' secret-with-spaces ',
    device: { name: 'Test phone', platform: 'android' },
    signInWithToken,
    fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ token: 'custom-token', studentId: 'student-1' }), { status: 200 });
    },
  });

  assert.equal(request.identifier, 'student-1');
  assert.equal(request.password, ' secret-with-spaces ');
  assert.deepEqual(request.device, { name: 'Test phone', platform: 'android' });
});

test('malformed server success response is distinguishable', async () => {
  await assert.rejects(
    signInStudent({
      identifier: 'student-1', password: 'password', signInWithToken,
      fetchImpl: async () => new Response('not json', { status: 200 }),
    }),
    (error: unknown) => error instanceof StudentLoginError && error.code === 'auth/server-response-invalid',
  );
});

test('Firebase token exchange failure retains its own code', async () => {
  await assert.rejects(
    signInStudent({
      identifier: 'student-1', password: 'password',
      fetchImpl: async () => new Response(JSON.stringify({ token: 'custom-token' }), { status: 200 }),
      signInWithToken: async () => { throw new Error('Firebase session unavailable'); },
    }),
    (error: unknown) => error instanceof StudentLoginError && error.code === 'auth/token-exchange-failed',
  );
});
