const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLeaveDayBreakdown } = require('../controllers/leaveController');

test('SL leave ignores sandwich-rule behavior and counts only working days', () => {
  const result = calculateLeaveDayBreakdown('2026-07-03', '2026-07-06', 'SL');

  assert.deepStrictEqual(result, {
    totalDays: 2,
    paidDays: 2,
    lwpDays: 0,
  });
});

test('non-SL leave keeps the existing sandwich-rule breakdown', () => {
  const result = calculateLeaveDayBreakdown('2026-07-03', '2026-07-06', 'CL');

  assert.deepStrictEqual(result, {
    totalDays: 4,
    paidDays: 2,
    lwpDays: 2,
  });
});
