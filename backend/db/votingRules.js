function voteRejection({ student, position, candidate, startReached, endNotReached, alreadyVoted = false }) {
    if (!student || !student.is_activated) {
        return { status: 403, message: 'An activated voter account is required.' };
    }
    if (!student.campus) {
        return { status: 403, message: 'Your campus is not set. Contact an election administrator before voting.' };
    }
    if (!position) return { status: 404, message: 'Position not found.' };
    if (position.status !== 'open' || !startReached || !endNotReached) {
        return { status: 409, message: 'Voting is not open for this position.' };
    }
    if (position.campus && position.campus !== student.campus) {
        return { status: 403, message: 'You are not eligible to vote for this campus position.' };
    }
    if (alreadyVoted) {
        return { status: 409, message: 'You have already voted for this position.' };
    }
    if (!candidate) {
        return { status: 400, message: 'The selected candidate does not belong to this position.' };
    }
    return null;
}

module.exports = { voteRejection };
