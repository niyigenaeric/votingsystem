const express = require('express');
const pool = require('../db/connection');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', verifyToken, requireRole('admin', 'auditor'), async (req, res) => {
    const afterId = req.query.afterId === undefined ? 0 : Number(req.query.afterId);
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
        return res.status(400).json({ message: 'afterId must be a non-negative integer.' });
    }
    try {
        const [entries] = await pool.query(
            `SELECT id, event_type AS eventType, actor, details, prev_hash AS previousHash,
                    entry_hash AS entryHash, created_at AS createdAt
             FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT 200`,
            [afterId]
        );
        res.json({ entries });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ message: 'Could not load the audit log.' });
    }
});

module.exports = router;
