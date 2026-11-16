const test = require('node:test');
const assert = require('node:assert/strict');
const { featureSetupMessage } = require('../db/featureSetupError');

test('explains how to apply missing database tables', () => {
    assert.match(featureSetupMessage({ code: 'ER_NO_SUCH_TABLE' }), /npm run db:migrate/);
});

test('directs missing database permissions to the README grants', () => {
    for (const code of ['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR']) {
        assert.match(featureSetupMessage({ code }), /required grants from the README/);
    }
});

test('does not mask unrelated database failures as setup errors', () => {
    assert.equal(featureSetupMessage({ code: 'ECONNREFUSED' }), null);
});
