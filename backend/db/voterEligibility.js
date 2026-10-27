const { normalizeFullName } = require('./voterRegistrationRules');

function matchesVoterAccount(account, submitted) {
    return normalizeFullName(account.full_name) === normalizeFullName(submitted.fullName)
        && account.email.trim().toLowerCase() === submitted.email.trim().toLowerCase();
}

function matchesOfficialVoterList(account, rosterEntry) {
    return !!rosterEntry
        && normalizeFullName(account.full_name) === normalizeFullName(rosterEntry.full_name)
        && account.email.trim().toLowerCase() === rosterEntry.contact_email.trim().toLowerCase();
}

module.exports = { matchesOfficialVoterList, matchesVoterAccount };
