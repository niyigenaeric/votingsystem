const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidPassword, normalizeFullName, validateRegistration } = require('../db/voterRegistrationRules');

const validRegistration = {
    regNumber: '223007576',
    fullName: 'Jane Doe',
    email: 'student@example.com',
    password: 'securepassword123',
    confirmPassword: 'securepassword123'
};

test('accepts valid voter registration details', () => {
    assert.equal(validateRegistration(validRegistration), null);
});

test('rejects malformed registration numbers and email addresses', () => {
    assert.match(validateRegistration({ ...validRegistration, regNumber: '123' }), /registration number/);
    assert.match(validateRegistration({ ...validRegistration, fullName: '' }), /full name/);
    assert.match(validateRegistration({ ...validRegistration, email: 'student..name@example.com' }), /email address/);
});

test('normalizes names for comparison with the official voter list', () => {
    assert.equal(normalizeFullName('  JANE   Doe '), normalizeFullName('Jane Doe'));
});

test('requires a strong password and matching confirmation', () => {
    assert.match(validateRegistration({ ...validRegistration, password: 'short' }), /10 to 72 characters/);
    assert.match(validateRegistration({ ...validRegistration, confirmPassword: 'differentpassword1' }), /do not match/);
});

test('applies the same password rules to password resets', () => {
    assert.equal(isValidPassword('securepassword123'), true);
    assert.equal(isValidPassword('short1'), false);
    assert.equal(isValidPassword('lettersOnlyPassword'), false);
    assert.equal(isValidPassword('1'.repeat(73) + 'a'), false);
});
