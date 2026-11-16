const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthHandler } = require('../db/health');

test('public health check returns only a minimal status when the database is available', async () => {
    let responseBody;
    const handler = createHealthHandler({ query: async () => [[{ ok: 1 }]] });
    await handler({}, { json: body => { responseBody = body; } });
    assert.deepEqual(responseBody, { status: 'ok' });
});

test('public health check hides database errors and returns unavailable', async () => {
    let statusCode;
    let responseBody;
    const handler = createHealthHandler({ query: async () => { throw new Error('private database details'); } });
    const originalError = console.error;
    console.error = () => {};
    try {
        await handler({}, {
            status: code => { statusCode = code; return { json: body => { responseBody = body; } }; }
        });
    } finally {
        console.error = originalError;
    }
    assert.equal(statusCode, 503);
    assert.deepEqual(responseBody, { status: 'unavailable' });
});
