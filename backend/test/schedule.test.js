const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKigaliDateTime } = require('../db/schedule');

test('converts Rwanda local schedule time to UTC for database storage', () => {
    assert.equal(parseKigaliDateTime('2026-10-26T15:30'), '2026-10-26 13:30:00');
});

test('handles Kigali midnight when conversion crosses to the previous UTC date', () => {
    assert.equal(parseKigaliDateTime('2026-10-26T00:30'), '2026-10-25 22:30:00');
});

test('rejects invalid and ambiguous local date-time values', () => {
    assert.equal(parseKigaliDateTime('2026-02-30T12:00'), null);
    assert.equal(parseKigaliDateTime('2026-10-26 12:00'), null);
    assert.equal(parseKigaliDateTime(123), null);
});
