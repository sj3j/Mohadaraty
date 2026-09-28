import assert from 'node:assert';
import { createSupportHandlers, SUPPORT_CATEGORIES } from '../shared/supportApi.js';

async function runTests() {
  console.log('🧪 Starting Support API Unit Tests...');

  let storedTicket: any = null;
  let storedAlert: any = null;

  const mockDb = {
    collection: (collName: string) => {
      if (collName === 'support_tickets') {
        return {
          doc: (id: string) => ({
            set: async (data: any) => {
              storedTicket = { id, ...data };
            }
          })
        };
      }
      if (collName === 'adminAlerts') {
        return {
          add: async (data: any) => {
            storedAlert = data;
            return { id: 'alert-123' };
          }
        };
      }
      throw new Error(`Unexpected collection: ${collName}`);
    }
  };

  const mockAdmin = {
    firestore: Object.assign(() => mockDb, {
      FieldValue: {
        serverTimestamp: () => 'MOCK_TIMESTAMP'
      }
    })
  };

  const handlers = createSupportHandlers({ admin: mockAdmin });

  function createMockReqRes(body: any) {
    const req = {
      body,
      ip: '127.0.0.1',
      headers: {}
    } as any;

    const resState: { statusCode: number; jsonPayload: any } = {
      statusCode: 200,
      jsonPayload: null
    };

    const res = {
      status: (code: number) => {
        resState.statusCode = code;
        return res;
      },
      json: (payload: any) => {
        resState.jsonPayload = payload;
        return res;
      }
    } as any;

    return { req, res, resState };
  }

  // Test 1: Validation - name too short
  {
    const { req, res, resState } = createMockReqRes({
      name: 'A',
      email: 'user@example.com',
      category: 'general',
      message: 'Valid message content goes here'
    });
    await handlers.submitTicket(req, res);
    assert.strictEqual(resState.statusCode, 400, 'Expected 400 for short name');
    assert.ok(resState.jsonPayload.error.includes('الاسم'), 'Expected name error');
    console.log('  ✓ Test 1 Passed: Short name rejected (400)');
  }

  // Test 2: Validation - invalid email
  {
    const { req, res, resState } = createMockReqRes({
      name: 'علي حسن',
      email: 'not-an-email',
      category: 'general',
      message: 'Valid message content goes here'
    });
    await handlers.submitTicket(req, res);
    assert.strictEqual(resState.statusCode, 400, 'Expected 400 for invalid email');
    assert.ok(resState.jsonPayload.error.includes('البريد'), 'Expected email error');
    console.log('  ✓ Test 2 Passed: Invalid email rejected (400)');
  }

  // Test 3: Validation - message too short (<10 chars)
  {
    const { req, res, resState } = createMockReqRes({
      name: 'علي حسن',
      email: 'ali@example.com',
      category: 'subscription',
      message: 'مرحبا'
    });
    await handlers.submitTicket(req, res);
    assert.strictEqual(resState.statusCode, 400, 'Expected 400 for short message');
    assert.ok(resState.jsonPayload.error.includes('تفاصيل'), 'Expected message error');
    console.log('  ✓ Test 3 Passed: Short message rejected (400)');
  }

  // Test 4: Validation - valid submission with subscription category
  {
    storedTicket = null;
    storedAlert = null;
    const { req, res, resState } = createMockReqRes({
      name: 'علي حسن',
      email: 'ali@example.com',
      category: 'subscription',
      message: 'أريد استعادة اشتراكي بعد شراء جهاز آيفون جديد'
    });
    await handlers.submitTicket(req, res);
    assert.strictEqual(resState.statusCode, 200, 'Expected 200 for valid ticket');
    assert.strictEqual(resState.jsonPayload.success, true);
    assert.ok(/^MHD-\d{6}$/.test(resState.jsonPayload.ticketId), 'Ticket ID format should be MHD-XXXXXX');
    
    // Check support_tickets document
    assert.ok(storedTicket, 'Ticket should be saved to support_tickets');
    assert.strictEqual(storedTicket.ticketId, resState.jsonPayload.ticketId);
    assert.strictEqual(storedTicket.name, 'علي حسن');
    assert.strictEqual(storedTicket.email, 'ali@example.com');
    assert.strictEqual(storedTicket.category, 'subscription');
    assert.strictEqual(storedTicket.status, 'open');
    assert.strictEqual(storedTicket.createdAt, 'MOCK_TIMESTAMP');

    // Check adminAlerts document
    assert.ok(storedAlert, 'Alert should be dispatched to adminAlerts');
    assert.strictEqual(storedAlert.type, 'support_ticket');
    assert.strictEqual(storedAlert.ticketId, resState.jsonPayload.ticketId);
    assert.strictEqual(storedAlert.email, 'ali@example.com');
    assert.strictEqual(storedAlert.reportedByName, 'علي حسن');
    assert.strictEqual(storedAlert.category, 'subscription');
    assert.strictEqual(storedAlert.replied, false);
    console.log('  ✓ Test 4 Passed: Valid ticket created in support_tickets & adminAlerts with format ' + resState.jsonPayload.ticketId);
  }

  // Test 5: Fallback on unknown category
  {
    storedTicket = null;
    storedAlert = null;
    const { req, res, resState } = createMockReqRes({
      name: 'زينب أحمد',
      email: 'zainab@example.com',
      category: 'unknown_category_xyz',
      message: 'سؤال عام بخصوص التطبيق والمحاضرات'
    });
    await handlers.submitTicket(req, res);
    assert.strictEqual(resState.statusCode, 200);
    assert.strictEqual(storedTicket.category, 'general', 'Unknown category should fallback to general');
    console.log('  ✓ Test 5 Passed: Unknown category defaults to general');
  }

  console.log('\n🎉 ALL SUPPORT API TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
