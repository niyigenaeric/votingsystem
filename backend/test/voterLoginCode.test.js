const test = require('node:test');
const assert = require('node:assert/strict');
const { isVoterLoginCodeRequired } = require('../db/voterLoginCode');

test('voter sign-in email code is required by default', () => {
    assert.equal(isVoterLoginCodeRequired(undefined), true);
    assert.equal(isVoterLoginCodeRequired(''), true);
});

test('voter sign-in email code can be disabled explicitly', () => {
    assert.equal(isVoterLoginCodeRequired('false'), false);
    assert.equal(isVoterLoginCodeRequired('FALSE'), false);
    assert.equal(isVoterLoginCodeRequired('true'), true);
});
