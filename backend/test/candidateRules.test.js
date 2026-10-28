const test = require('node:test');
const assert = require('node:assert/strict');
const {
    canVoteForPosition,
    getPositionVotingMessage,
    isValidManifesto,
    MAX_MANIFESTO_LENGTH
} = require('../db/candidateRules');

const openPosition = {
    eligible: true,
    voterCampus: 'Huye',
    positionCampus: 'Huye',
    status: 'open',
    hasVoted: false
};

test('requires a non-empty manifesto within the maximum length', () => {
    assert.equal(isValidManifesto('A clear plan'), true);
    assert.equal(isValidManifesto('   '), false);
    assert.equal(isValidManifesto('x'.repeat(MAX_MANIFESTO_LENGTH + 1)), false);
});

test('allows voting only for open positions the voter can access once', () => {
    assert.equal(canVoteForPosition(openPosition), true);
    assert.equal(canVoteForPosition({ ...openPosition, eligible: false }), false);
    assert.equal(canVoteForPosition({ ...openPosition, positionCampus: 'Kigali' }), false);
    assert.equal(canVoteForPosition({ ...openPosition, status: 'setup' }), false);
    assert.equal(canVoteForPosition({ ...openPosition, hasVoted: true }), false);
});

test('explains why a voter can or cannot vote for a position', () => {
    assert.match(getPositionVotingMessage(openPosition), /allowed to vote/);
    assert.match(getPositionVotingMessage({ ...openPosition, voterCampus: 'Kigali' }), /not eligible/);
    assert.match(getPositionVotingMessage({ ...openPosition, status: 'setup' }), /not opened/);
    assert.match(getPositionVotingMessage({ ...openPosition, status: 'closed' }), /closed/);
    assert.match(getPositionVotingMessage({ ...openPosition, hasVoted: true }), /already voted/);
});
