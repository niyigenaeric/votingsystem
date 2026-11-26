const MAX_MANIFESTO_LENGTH = 10000;

function isValidManifesto(manifesto) {
    return typeof manifesto === 'string'
        && manifesto.trim().length > 0
        && manifesto.length <= MAX_MANIFESTO_LENGTH;
}

function canRescheduleCandidateEntry({ status, votingStartReached }) {
    return status === 'setup' && !votingStartReached;
}

function canReschedulePosition({ status, archived, hasVotes }) {
    return status === 'setup' && !archived && !hasVotes;
}

function isEligibleForPosition({ eligible, voterCampus, positionCampus, positionListIncluded }) {
    return !!eligible && !!positionListIncluded && (!positionCampus || positionCampus === voterCampus);
}

function canVoteForPosition({ eligible, voterCampus, positionCampus, positionListIncluded, status, hasVoted }) {
    return isEligibleForPosition({ eligible, voterCampus, positionCampus, positionListIncluded })
        && status === 'open'
        && !hasVoted;
}

function getPositionVotingMessage({ eligible, voterCampus, positionCampus, positionListIncluded, status, hasVoted }) {
    if (!eligible) return 'You are not allowed to vote because your account is not eligible.';
    if (!positionListIncluded) return 'You are not on the approved voter list for this position.';
    if (!isEligibleForPosition({ eligible, voterCampus, positionCampus, positionListIncluded })) {
        return 'You are not eligible to vote for this campus position.';
    }
    if (status === 'setup') return 'Voting has not opened for this position yet.';
    if (status === 'closed') return 'Voting is closed for this position.';
    if (hasVoted) return 'You have already voted for this position.';
    return 'You are allowed to vote for this position.';
}

module.exports = {
    MAX_MANIFESTO_LENGTH,
    canVoteForPosition,
    canRescheduleCandidateEntry,
    canReschedulePosition,
    getPositionVotingMessage,
    isEligibleForPosition,
    isValidManifesto
};
