const express = require('express');
const pool = require('../db/connection');
const { verifyToken, requireRole } = require('../middleware/auth');
const { featureSetupMessage } = require('../db/featureSetupError');

const router = express.Router();

router.get('/', verifyToken, requireRole('admin', 'auditor', 'voter'), async (req, res) => {
    try {
        const [positions] = await pool.query(
            `SELECT id, title, campus,
                    CONCAT(DATE_FORMAT(DATE_ADD(voting_starts_at, INTERVAL 2 HOUR), '%Y-%m-%dT%H:%i:%s'), '+02:00') AS startsAt,
                    TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), voting_starts_at) AS minutesUntil,
                    (notification_reads.position_id IS NOT NULL) AS isRead
             FROM positions
             LEFT JOIN election_notification_reads AS notification_reads
               ON notification_reads.user_role = ?
              AND notification_reads.user_id = ?
              AND notification_reads.position_id = positions.id
             WHERE archived_at IS NULL AND status <> 'closed'
               AND voting_starts_at > UTC_TIMESTAMP()
               AND voting_starts_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
             ORDER BY voting_starts_at, title, campus`,
            [req.user.role, req.user.id]
        );
        res.set('Cache-Control', 'no-store');
        res.json({
            notifications: positions.map(position => ({
                id: position.id,
                title: position.title,
                campus: position.campus || null,
                startsAt: position.startsAt,
                minutesUntil: Number(position.minutesUntil),
                isRead: Boolean(position.isRead)
            }))
        });
    } catch (error) {
        console.error('Election notifications could not be loaded:', error.message);
        const setupMessage = featureSetupMessage(error);
        res.status(setupMessage ? 503 : 500).json({
            message: setupMessage || 'Election notifications could not be loaded.'
        });
    }
});

router.patch('/:positionId/read', verifyToken, requireRole('admin', 'auditor', 'voter'), async (req, res) => {
    const positionId = Number(req.params.positionId);
    if (!/^[1-9]\d*$/.test(req.params.positionId) || !Number.isSafeInteger(positionId)) {
        return res.status(400).json({ message: 'A valid notification must be selected.' });
    }

    try {
        const [positions] = await pool.query(
            'SELECT id FROM positions WHERE id = ? AND archived_at IS NULL',
            [positionId]
        );
        if (!positions.length) {
            return res.status(404).json({ message: 'This election notification is no longer available.' });
        }
        await pool.query(
            `INSERT INTO election_notification_reads (user_role, user_id, position_id, read_at)
             VALUES (?, ?, ?, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE read_at = UTC_TIMESTAMP()`,
            [req.user.role, req.user.id, positionId]
        );
        res.json({ message: 'Notification marked as read.' });
    } catch (error) {
        console.error('Election notification could not be marked as read:', error.message);
        const setupMessage = featureSetupMessage(error);
        res.status(setupMessage ? 503 : 500).json({
            message: setupMessage || 'Election notification could not be marked as read.'
        });
    }
});

module.exports = router;
