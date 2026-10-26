require('dotenv').config();
const crypto = require('crypto');
const pool = require('../db/connection');

async function main() {
    const [entries] = await pool.query(
        `SELECT id, event_type, actor, details, prev_hash, entry_hash
         FROM audit_log ORDER BY id ASC`
    );
    let expectedPreviousHash = '0'.repeat(64);
    for (const entry of entries) {
        const expectedHash = crypto.createHash('sha256')
            .update(`${expectedPreviousHash}|${entry.event_type}|${entry.actor}|${entry.details}`)
            .digest('hex');
        if (entry.prev_hash !== expectedPreviousHash || entry.entry_hash !== expectedHash) {
            console.error(`Audit chain verification failed at entry ${entry.id}.`);
            process.exitCode = 1;
            return;
        }
        expectedPreviousHash = entry.entry_hash;
    }
    console.log(`Audit chain verified: ${entries.length} entries.`);
}

main()
    .catch(error => {
        console.error('Audit chain verification could not complete:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
