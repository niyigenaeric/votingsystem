const crypto = require('crypto');
const pool = require('./connection');

// Each entry stores a hash of the previous entry, so editing or
// deleting an old record breaks the chain and can be detected.
// A named lock keeps two requests from reading the same "last hash",
// and it needs no UPDATE permission on the table.
async function addAuditLog(eventType, actor, details = '') {
    const conn = await pool.getConnection();
    let locked = false;
    try {
        const [[l]] = await conn.query("SELECT GET_LOCK('audit_chain', 10) AS ok");
        if (Number(l.ok) !== 1) throw new Error('Could not lock the audit log');
        locked = true;
        const [rows] = await conn.query('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1');
        const prevHash = rows.length ? rows[0].entry_hash : '0'.repeat(64);
        const entryHash = crypto
            .createHash('sha256')
            .update(prevHash + '|' + eventType + '|' + actor + '|' + details)
            .digest('hex');
        await conn.query(
            'INSERT INTO audit_log (event_type, actor, details, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?)',
            [eventType, actor, details, prevHash, entryHash]
        );
    } finally {
        if (locked) {
            try {
                await conn.query("SELECT RELEASE_LOCK('audit_chain')");
            } catch (error) {
                console.error('Could not release audit log lock:', error.message);
            }
        }
        conn.release();
    }
}

module.exports = { addAuditLog };