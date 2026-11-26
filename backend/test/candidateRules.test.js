const test = require('node:test');
const assert = require('node:assert/strict');
const {
    canRescheduleCandidateEntry,
    canReschedulePosition,
    canVoteForPosition,
    getPositionVotingMessage,
    isEligibleForPosition,
    isValidManifesto,
    MAX_MANIFESTO_LENGTH
} = require('../db/candidateRules');

const openPosition = {
    eligible: true,
    voterCampus: 'Huye',
    positionCampus: 'Huye',
    positionListIncluded: true,
    status: 'open',
    hasVoted: false
};

test('allows candidate-entry rescheduling only before voting opens', () => {
    assert.equal(canRescheduleCandidateEntry({ status: 'setup', votingStartReached: false }), true);
    assert.equal(canRescheduleCandidateEntry({ status: 'setup', votingStartReached: true }), false);
    assert.equal(canRescheduleCandidateEntry({ status: 'open', votingStartReached: false }), false);
    assert.equal(canRescheduleCandidateEntry({ status: 'closed', votingStartReached: false }), false);
});

test('allows an unopened, unvoted election schedule to be moved after its start time', () => {
    assert.equal(canReschedulePosition({ status: 'setup', archived: false, hasVotes: false }), true);
    assert.equal(canReschedulePosition({ status: 'setup', archived: false, hasVotes: true }), false);
    assert.equal(canReschedulePosition({ status: 'setup', archived: true, hasVotes: false }), false);
    assert.equal(canReschedulePosition({ status: 'open', archived: false, hasVotes: false }), false);
    assert.equal(canReschedulePosition({ status: 'closed', archived: false, hasVotes: false }), false);
});

test('requires a non-empty manifesto within the maximum length', () => {
    assert.equal(isValidManifesto('A clear plan'), true);
    assert.equal(isValidManifesto('   '), false);
    assert.equal(isValidManifesto('x'.repeat(MAX_MANIFESTO_LENGTH + 1)), false);
});

test('allows voting only for open positions the voter can access once', () => {
    assert.equal(canVoteForPosition(openPosition), true);
    assert.equal(canVoteForPosition({ ...openPosition, eligible: false }), false);
    assert.equal(canVoteForPosition({ ...openPosition, positionListIncluded: false }), false);
    assert.equal(canVoteForPosition({ ...openPosition, positionCampus: 'Kigali' }), false);
    assert.equal(canVoteForPosition({ ...openPosition, status: 'setup' }), false);
    assert.equal(canVoteForPosition({ ...openPosition, hasVoted: true }), false);
});

test('determines eligibility for each position independently of its voting status', () => {
    assert.equal(isEligibleForPosition(openPosition), true);
    assert.equal(isEligibleForPosition({ ...openPosition, status: 'setup' }), true);
    assert.equal(isEligibleForPosition({ ...openPosition, positionCampus: null }), true);
    assert.equal(isEligibleForPosition({ ...openPosition, positionCampus: 'Kigali' }), false);
    assert.equal(isEligibleForPosition({ ...openPosition, eligible: false }), false);
    assert.equal(isEligibleForPosition({ ...openPosition, positionListIncluded: false }), false);
});

test('explains why a voter can or cannot vote for a position', () => {
    assert.match(getPositionVotingMessage(openPosition), /allowed to vote/);
    assert.match(getPositionVotingMessage({ ...openPosition, positionListIncluded: false }), /not on the approved voter list/);
    assert.match(getPositionVotingMessage({ ...openPosition, voterCampus: 'Kigali' }), /not eligible/);
    assert.match(getPositionVotingMessage({ ...openPosition, status: 'setup' }), /not opened/);
    assert.match(getPositionVotingMessage({ ...openPosition, status: 'closed' }), /closed/);
    assert.match(getPositionVotingMessage({ ...openPosition, hasVoted: true }), /already voted/);
});
