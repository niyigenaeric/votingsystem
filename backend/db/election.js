const pool = require('./connection');
const { addAuditLog } = require('./audit');

async function closeExpiredPositions() {
    const [positions] = await pool.query(
        `SELECT id, title FROM positions
         WHERE status = 'open' AND voting_ends_at IS NOT NULL AND voting_ends_at <= UTC_TIMESTAMP()
         ORDER BY id`
    );
    for (const position of positions) {
        const [result] = await pool.query(
            `UPDATE positions SET status = 'closed'
             WHERE id = ? AND status = 'open' AND voting_ends_at <= UTC_TIMESTAMP()`,
            [position.id]
        );
        if (result.affectedRows) {
            await addAuditLog('POSITION_AUTO_CLOSED', 'system', `position=${position.id}, title=${position.title}`);
        }
    }
}

module.exports = { closeExpiredPositions };
