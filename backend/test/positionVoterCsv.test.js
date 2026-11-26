const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePositionVoterCsv } = require('../db/positionVoterCsv');

test('parses a separate email-only position voter CSV', () => {
    const result = parsePositionVoterCsv('\uFEFFemail\r\nJane.Doe@gmail.com\r\nstudent@example.com');
    assert.deepEqual(result, {
        received: 2,
        emails: ['jane.doe@gmail.com', 'student@example.com'],
        invalid: []
    });
});

test('rejects repeated addresses and rows with extra columns', () => {
    const result = parsePositionVoterCsv('email\nvoter@gmail.com\nvoter@gmail.com\nother@gmail.com,extra');
    assert.deepEqual(result.invalid, [
        'Line 3: email is repeated in this file',
        'Line 4: expected one email column'
    ]);
});

test('requires a header and at least one valid voter address', () => {
    assert.match(parsePositionVoterCsv('').error, /empty/);
    assert.match(parsePositionVoterCsv('email').error, /at least one/);
    assert.match(parsePositionVoterCsv('email,other\nvoter@gmail.com').error, /email header/);
    assert.deepEqual(parsePositionVoterCsv('email\nnot-an-email').invalid, [
        'Line 2: enter a valid email address'
    ]);
});
