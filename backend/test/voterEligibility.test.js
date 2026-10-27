const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesOfficialVoterList, matchesVoterAccount } = require('../db/voterEligibility');

const account = { full_name: 'Jane Doe', email: 'jane@example.com' };
const rosterEntry = {
    full_name: 'JANE   DOE',
    contact_email: 'JANE@example.com'
};

test('matches submitted sign-in identity with the created account', () => {
    assert.equal(matchesVoterAccount(account, { fullName: '  JANE Doe ', email: 'JANE@example.com' }), true);
    assert.equal(matchesVoterAccount(account, { fullName: 'Other Person', email: 'jane@example.com' }), false);
});

test('requires voter account name and email to match the official roster', () => {
    assert.equal(matchesOfficialVoterList(account, rosterEntry), true);
    assert.equal(matchesOfficialVoterList(account, { ...rosterEntry, contact_email: 'other@example.com' }), false);
    assert.equal(matchesOfficialVoterList(account, null), false);
});
