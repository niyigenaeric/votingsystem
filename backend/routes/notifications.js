const express = require('express');
const pool = require('../db/connection');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', verifyToken, requireRole('admin', 'auditor', 'voter'), async (req, res) => {
    try {
        const [positions] = await pool.query(
            `SELECT id, title, campus,
                    CONCAT(DATE_FORMAT(DATE_ADD(voting_starts_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS startsAt,
                    TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), voting_starts_at) AS minutesUntil
             FROM positions
             WHERE archived_at IS NULL AND status <> 'closed'
               AND voting_starts_at > UTC_TIMESTAMP()
               AND voting_starts_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
             ORDER BY voting_starts_at, title, campus`
        );
        res.set('Cache-Control', 'no-store');
        res.json({
            notifications: positions.map(position => ({
                id: position.id,
                title: position.title,
                campus: position.campus || null,
                startsAt: position.startsAt,
                minutesUntil: Number(position.minutesUntil)
            }))
        });
    } catch (error) {
        console.error('Election notifications could not be loaded:', error.message);
        res.status(500).json({ message: 'Election notifications could not be loaded.' });
    }
});

module.exports = router;
