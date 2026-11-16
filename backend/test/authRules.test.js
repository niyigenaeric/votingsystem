const test = require('node:test');
const assert = require('node:assert/strict');
const { requiresSecondFactor } = require('../db/authRules');

test('requires a second factor for administrators and auditors', () => {
    assert.equal(requiresSecondFactor('admin'), true);
    assert.equal(requiresSecondFactor('auditor'), true);
    assert.equal(requiresSecondFactor('voter'), false);
});
