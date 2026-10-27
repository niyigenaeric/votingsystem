const { normalizeFullName } = require('./voterRegistrationRules');

function matchesVoterAccount(account, submitted) {
    return normalizeFullName(account.full_name) === normalizeFullName(submitted.fullName)
        && account.email.trim().toLowerCase() === submitted.email.trim().toLowerCase();
}

function matchesOfficialVoterList(account, rosterEntry) {
    return !!account && !!rosterEntry
        && normalizeFullName(account.full_name) === normalizeFullName(rosterEntry.full_name)
        && account.email.trim().toLowerCase() === rosterEntry.contact_email.trim().toLowerCase();
}

function getVoterEligibility(account, rosterEntry) {
    if (!matchesOfficialVoterList(account, rosterEntry)) {
        return {
            eligible: false,
            message: 'You are not allowed to vote because your account details do not match an eligible voter-list entry. Contact an election administrator if you believe this is an error.'
        };
    }
    if (!rosterEntry.campus) {
        return {
            eligible: false,
            message: 'You are not allowed to vote because your voter-list record has no campus assigned. Contact an election administrator.'
        };
    }
    return { eligible: true, message: 'You are allowed to vote.' };
}

module.exports = { getVoterEligibility, matchesOfficialVoterList, matchesVoterAccount };
