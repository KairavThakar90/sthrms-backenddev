const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { notifyHRNewLeaveRequest } = require('../services/emailService');

const startBridgeServer = (onRequest) => {
  return new Promise((resolve) => {
    const server = http.createServer(onRequest);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
};

const stopBridgeServer = async ({ server }) => {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};

test('notifyHRNewLeaveRequest removes configured CC recipients for the new leave email', async () => {
  process.env.EMAIL_CC_ADDRESSES = 'cc1@example.com, cc2@example.com';

  let payload = null;
  const { server, port } = await startBridgeServer((req, res) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      payload = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  process.env.WP_EMAIL_BRIDGE_URL = `http://127.0.0.1:${port}/wp-json/hrms/v1/send-email`;

  try {
    await notifyHRNewLeaveRequest('hr@example.com', 'Alice', 'Bob', {
      id: 101,
      leave_type: 'CL',
      leave_type_full: 'Casual Leave',
      start_date: '2026-07-13',
      end_date: '2026-07-14',
      reason: 'Family visit',
      days: 2
    });

    assert.ok(payload, 'expected the bridge request to be captured');
    assert.deepStrictEqual(payload.cc, [], 'new leave request email should not include configured CC recipients');
  } finally {
    await stopBridgeServer({ server });
  }
});
