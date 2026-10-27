const crypto = require('crypto');

function newVoteId() {
    return crypto.randomBytes(16).toString('hex');
}

module.exports = { newVoteId };
