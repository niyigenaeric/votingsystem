function isVoterEmailConfirmationRequired(value = process.env.REQUIRE_VOTER_EMAIL_CONFIRMATION) {
    return String(value || '').toLowerCase() !== 'false';
}

module.exports = { isVoterEmailConfirmationRequired };
