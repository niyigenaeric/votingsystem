const test = require('node:test');
const assert = require('node:assert/strict');
const { voteRejection } = require('../db/votingRules');

const eligibleStudent = { campus: 'Huye', is_activated: 1 };
const openPosition = { status: 'open', campus: 'Huye' };
const candidate = { id: 4 };

test('accepts an eligible ballot for an open position', () => {
    assert.equal(voteRejection({
        student: eligibleStudent,
        position: openPosition,
        candidate,
        startReached: true,
        endNotReached: true
    }), null);
});

test('rejects a second ballot for the same position', () => {
    const rejection = voteRejection({
        student: eligibleStudent,
        position: openPosition,
        candidate,
        startReached: true,
        endNotReached: true,
        alreadyVoted: true
    });
    assert.equal(rejection.status, 409);
    assert.match(rejection.message, /already voted/);
});

test('rejects voting for a position assigned to another campus', () => {
    const rejection = voteRejection({
        student: eligibleStudent,
        position: { ...openPosition, campus: 'Remera' },
        candidate,
        startReached: true,
        endNotReached: true
    });
    assert.equal(rejection.status, 403);
    assert.match(rejection.message, /not eligible/);
});

test('rejects a closed position', () => {
    const rejection = voteRejection({
        student: eligibleStudent,
        position: { ...openPosition, status: 'closed' },
        candidate,
        startReached: true,
        endNotReached: true
    });
    assert.equal(rejection.status, 409);
    assert.match(rejection.message, /not open/);
});
