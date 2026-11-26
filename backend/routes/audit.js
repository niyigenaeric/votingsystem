const express = require('express');
const crypto = require('crypto');
const pool = require('../db/connection');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/verify', verifyToken, requireRole('admin', 'auditor'), async (req, res) => {
    try {
        const [entries] = await pool.query(
            `SELECT id, event_type, actor, details, prev_hash, entry_hash
             FROM audit_log ORDER BY id ASC`
        );
        let previousHash = '0'.repeat(64);
        let checked = 0;
        for (const entry of entries) {
            const expectedHash = crypto.createHash('sha256')
                .update(`${previousHash}|${entry.event_type}|${entry.actor}|${entry.details}`)
                .digest('hex');
            if (entry.prev_hash !== previousHash || entry.entry_hash !== expectedHash) {
                return res.json({ verified: false, checked, failedEntryId: entry.id });
            }
            previousHash = entry.entry_hash;
            checked += 1;
        }
        return res.json({ verified: true, checked: entries.length });
    } catch (error) {
        console.error(error.message);
        return res.status(500).json({ message: 'Could not verify the audit chain.' });
    }
});

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
