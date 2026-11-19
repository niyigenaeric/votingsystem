function isVoterLoginCodeRequired(value = process.env.REQUIRE_VOTER_LOGIN_CODE) {
    return String(value || '').toLowerCase() !== 'false';
}

module.exports = { isVoterLoginCodeRequired };
