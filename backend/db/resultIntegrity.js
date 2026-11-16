const crypto = require('crypto');

function hashPublishedResults(positionId, title, candidates) {
    const canonical = candidates.map(candidate => [Number(candidate.id), Number(candidate.votes)]);
    return crypto.createHash('sha256')
        .update(JSON.stringify([Number(positionId), title, canonical]))
        .digest('hex');
}

function verifyPublishedResults(expectedHash, positionId, title, candidates) {
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
    const actualHash = hashPublishedResults(positionId, title, candidates);
    const expected = Buffer.from(expectedHash, 'hex');
    const actual = Buffer.from(actualHash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPublishedResults, verifyPublishedResults };
