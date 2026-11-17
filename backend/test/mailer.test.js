const test = require('node:test');
const assert = require('node:assert/strict');

const { getEmailProvider, buildMailPayload, resolveSenderAddress } = require('../db/mailer');

test('uses Brevo when BREVO_API_KEY is configured', () => {
  const previous = { ...process.env };
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_EMAIL = 'no-reply@example.com';
  delete process.env.SMTP_HOST;

  try {
    assert.equal(getEmailProvider(), 'brevo');
    assert.equal(resolveSenderAddress(), 'no-reply@example.com');
    const payload = buildMailPayload({
      to: 'student@example.com',
      subject: 'Your code',
      text: 'Your code is 123456',
      html: '<p>Your code is 123456</p>'
    });
    assert.equal(payload.sender.email, 'no-reply@example.com');
    assert.equal(payload.to[0].email, 'student@example.com');
  } finally {
    process.env = previous;
  }
});

test('falls back to SMTP when no Brevo config is present', () => {
  const previous = { ...process.env };
  delete process.env.BREVO_API_KEY;
  process.env.SMTP_HOST = 'smtp.mailtrap.io';
  process.env.SMTP_USER = 'user';
  process.env.SMTP_PASS = 'pass';

  try {
    assert.equal(getEmailProvider(), 'smtp');
    assert.equal(resolveSenderAddress(), 'user');
  } finally {
    process.env = previous;
  }
});
