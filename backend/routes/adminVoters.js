const express = require('express');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { verifyToken, requireRole } = require('../middleware/auth');
const { CAMPUSES } = require('../db/campuses');
const { parseStudentCsv } = require('../db/studentCsv');

const router = express.Router();
const serverError = res => res.status(500).json({ message: 'Server error' });

router.get('/campuses', verifyToken, requireRole('admin', 'auditor'), (req, res) => res.json(CAMPUSES));

router.post('/students/upload', verifyToken, requireRole('admin'),
    express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
    async (req, res) => {
        try {
            if (typeof req.body !== 'string' || !req.body.trim()) return res.status(400).json({ message: 'Send the CSV as text/csv' });
            const parsed = parseStudentCsv(req.body);
            if (parsed.error) return res.status(400).json({ message: parsed.error });
            if (parsed.received > 5000) return res.status(400).json({ message: 'Maximum 5000 rows per upload' });
            if (parsed.invalid.length) {
                return res.status(400).json({
                    message: 'CSV was not uploaded. Complete or correct every row and try again.',
                    invalidLines: parsed.invalid.slice(0, 20)
                });
            }

            let inserted = 0;
            if (parsed.valid.length) {
                const [result] = await pool.query(
                    'INSERT IGNORE INTO students (reg_number, full_name, contact_email, campus) VALUES ?',
                    [parsed.valid]
                );
                inserted = result.affectedRows;
                const byCampus = new Map();
                parsed.valid.forEach(value => byCampus.set(value[3], [...(byCampus.get(value[3]) || []), value[0]]));
                for (const [campus, registrations] of byCampus) {
                    await pool.query(
                        `UPDATE students SET campus = ? WHERE role = 'voter' AND campus IS NULL AND reg_number IN (?)`,
                        [campus, registrations]
                    );
                }
            }
            await addAuditLog('VOTER_LIST_UPLOADED', req.user.regNumber,
                `rows=${parsed.received}, added=${inserted}, duplicates=${parsed.valid.length - inserted}, invalid=0`);
            res.json({ received: parsed.received, added: inserted, duplicatesSkipped: parsed.valid.length - inserted, invalidLines: [] });
        } catch (error) {
            console.error(error.message);
            serverError(res);
        }
    });

router.get('/voters/summary', verifyToken, requireRole('admin', 'auditor'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT COALESCE(campus, 'Not set') AS campus, COUNT(*) AS total, SUM(is_activated) AS activated
             FROM students WHERE role = 'voter' GROUP BY campus ORDER BY campus`
        );
        res.json(rows.map(row => ({ campus: row.campus, total: Number(row.total), activated: Number(row.activated) })));
    } catch (error) { console.error(error.message); serverError(res); }
});

router.get('/voters/check', verifyToken, requireRole('admin', 'auditor'), async (req, res) => {
    try {
        const reg = String(req.query.reg || '').trim();
        if (!/^22[2-5]0[0-9]{5}$/.test(reg)) return res.status(400).json({ message: 'Registration number must look like 223007576' });
        const [[student]] = await pool.query(
            `SELECT full_name, campus, is_activated FROM students WHERE reg_number = ? AND role = 'voter'`,
            [reg]
        );
        if (!student) return res.json({ eligible: false });
        res.json({ eligible: true, name: student.full_name, campus: student.campus, activated: !!student.is_activated });
    } catch (error) { console.error(error.message); serverError(res); }
});

module.exports = router;
