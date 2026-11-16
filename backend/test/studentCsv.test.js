const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStudentCsv } = require('../db/studentCsv');

const header = 'reg_number,full_name,contact_email,campus';
const validRow = '223007576,Jane Doe,jane.doe@gmail.com,Huye';

test('parses complete student CSV rows', () => {
    const result = parseStudentCsv(`${header}\n${validRow}`);
    assert.equal(result.received, 1);
    assert.deepEqual(result.valid, [['223007576', 'Jane Doe', 'jane.doe@gmail.com', 'Huye']]);
    assert.deepEqual(result.invalid, []);
});

test('reports incomplete rows so the upload can be rejected as a whole', () => {
    const result = parseStudentCsv(`${header}\n${validRow}\n0000`);
    assert.equal(result.received, 2);
    assert.equal(result.valid.length, 1);
    assert.deepEqual(result.invalid, ['Line 3: expected 4 columns']);
});

test('rejects a CSV without student rows', () => {
    assert.equal(parseStudentCsv(header).error, 'Add at least one student row below the header.');
});
