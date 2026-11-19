const test = require('node:test');
const assert = require('node:assert/strict');
const { isVoterEmailConfirmationRequired } = require('../db/voterEmailConfirmation');

test('voter email confirmation is required by default', () => {
    assert.equal(isVoterEmailConfirmationRequired(undefined), true);
    assert.equal(isVoterEmailConfirmationRequired(''), true);
});

test('voter email confirmation can be disabled explicitly', () => {
    assert.equal(isVoterEmailConfirmationRequired('false'), false);
    assert.equal(isVoterEmailConfirmationRequired('FALSE'), false);
    assert.equal(isVoterEmailConfirmationRequired('true'), true);
});
