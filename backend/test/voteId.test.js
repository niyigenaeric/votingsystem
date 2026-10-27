const test = require('node:test');
const assert = require('node:assert/strict');
const { newVoteId } = require('../db/voteId');

test('vote ids are random 32-character hex strings', () => {
    const ids = new Set();
    for (let i = 0; i < 2000; i++) {
        const id = newVoteId();
        assert.match(id, /^[0-9a-f]{32}$/);
        ids.add(id);
    }
    assert.equal(ids.size, 2000);
});

test('vote ids do not increase in order', () => {
    const ids = Array.from({ length: 50 }, () => newVoteId());
    assert.ok(ids.some((id, i) => i > 0 && id < ids[i - 1]));
});
