const MAX_MANIFESTO_LENGTH = 10000;

function isValidManifesto(manifesto) {
    return typeof manifesto === 'string'
        && manifesto.trim().length > 0
        && manifesto.length <= MAX_MANIFESTO_LENGTH;
}

function canVoteForPosition({ eligible, voterCampus, positionCampus, status, hasVoted }) {
    return !!eligible
        && (!positionCampus || positionCampus === voterCampus)
        && status === 'open'
        && !hasVoted;
}

function getPositionVotingMessage({ eligible, voterCampus, positionCampus, status, hasVoted }) {
    if (!eligible) return 'You are not allowed to vote because your account is not eligible.';
    if (positionCampus && positionCampus !== voterCampus) {
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
    getPositionVotingMessage,
    isValidManifesto
};
