const express = require('express');
const pool = require('../db/connection');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/stats', verifyToken, requireRole('admin', 'auditor'), async (req, res) => {
    try {
        const [[students]] = await pool.query(
            `SELECT COUNT(*) AS total, COALESCE(SUM(is_activated), 0) AS activated
             FROM students WHERE role = 'voter'`
        );
        const [[ballots]] = await pool.query('SELECT COUNT(*) AS voted FROM votes');
        res.json({
            total: Number(students.total),
            activated: Number(students.activated),
            voted: Number(ballots.voted)
        });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ message: 'Could not load election statistics' });
    }
});

module.exports = router;
