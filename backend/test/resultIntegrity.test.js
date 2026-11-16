const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPublishedResults, verifyPublishedResults } = require('../db/resultIntegrity');

const candidates = [{ id: 11, votes: 4 }, { id: 12, votes: 2 }];

test('verifies a published result hash against its canonical tally', () => {
    const hash = hashPublishedResults(7, 'Guild President', candidates);
    assert.equal(verifyPublishedResults(hash, 7, 'Guild President', candidates), true);
});

test('detects changed tallies and position metadata after publication', () => {
    const hash = hashPublishedResults(7, 'Guild President', candidates);
    assert.equal(verifyPublishedResults(hash, 7, 'Guild President', [{ id: 11, votes: 5 }, candidates[1]]), false);
    assert.equal(verifyPublishedResults(hash, 7, 'Guild President - Huye', candidates), false);
    assert.equal(verifyPublishedResults(hash, 8, 'Guild President', candidates), false);
});

test('rejects missing or malformed published hashes', () => {
    assert.equal(verifyPublishedResults(null, 7, 'Guild President', candidates), false);
    assert.equal(verifyPublishedResults('not-a-hash', 7, 'Guild President', candidates), false);
});
