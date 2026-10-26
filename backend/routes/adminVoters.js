const express = require('express');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { verifyToken, requireRole } = require('../middleware/auth');
const { CAMPUSES, canonical } = require('../db/campuses');

const router = express.Router();
const REG_RE = /^22[2-5]0[0-9]{5}$/;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/;
const DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'gmail.com,hotmail.com,outlook.com,yahoo.com,live.com,icloud.com')
    .split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean);
const TYPOS = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'hotmial.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'yaho.com': 'yahoo.com' };
const serverError = res => res.status(500).json({ message: 'Server error' });

function splitCsvLine(line) {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') { value += '"'; index++; }
            else quoted = !quoted;
        } else if (character === ',' && !quoted) {
            values.push(value.trim());
            value = '';
        } else value += character;
    }
    values.push(value.trim());
    return values;
}

router.get('/campuses', verifyToken, requireRole('admin', 'auditor'), (req, res) => res.json(CAMPUSES));

router.post('/students/upload', verifyToken, requireRole('admin'),
    express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
    async (req, res) => {
        try {
            if (typeof req.body !== 'string' || !req.body.trim()) return res.status(400).json({ message: 'Send the CSV as text/csv' });
            const lines = req.body.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() !== '');
            const header = splitCsvLine(lines.shift()).map(value => value.toLowerCase()).join(',');
            if (header !== 'reg_number,full_name,contact_email,campus') {
                return res.status(400).json({ message: 'Header must be: reg_number,full_name,contact_email,campus' });
            }
            if (lines.length > 5000) return res.status(400).json({ message: 'Maximum 5000 rows per upload' });

            const valid = [];
            const invalid = [];
            const seenReg = new Set();
            const seenEmail = new Set();
            lines.forEach((line, index) => {
                const lineNumber = index + 2;
                const columns = splitCsvLine(line);
                if (columns.length !== 4) return invalid.push(`Line ${lineNumber}: expected 4 columns`);
                const [reg, name] = columns;
                const email = columns[2].toLowerCase();
                const campus = canonical(columns[3]);
                if (!REG_RE.test(reg)) return invalid.push(`Line ${lineNumber}: reg number must look like 223007576`);
                if (!name || name.length > 100) return invalid.push(`Line ${lineNumber}: name missing or too long`);
                if (email.length > 150 || !EMAIL_RE.test(email)) return invalid.push(`Line ${lineNumber}: email format is wrong`);
                const domain = email.split('@')[1];
                if (TYPOS[domain]) return invalid.push(`Line ${lineNumber}: did you mean @${TYPOS[domain]}?`);
                if (!DOMAINS.includes(domain)) return invalid.push(`Line ${lineNumber}: email domain @${domain} is not allowed`);
                if (!campus) return invalid.push(`Line ${lineNumber}: campus must be one of ${CAMPUSES.join(', ')}`);
                if (seenReg.has(reg)) return invalid.push(`Line ${lineNumber}: reg number repeated in this file`);
                if (seenEmail.has(email)) return invalid.push(`Line ${lineNumber}: email repeated in this file`);
                seenReg.add(reg);
                seenEmail.add(email);
                valid.push([reg, name, email, campus]);
            });

            let inserted = 0;
            if (valid.length) {
                const [result] = await pool.query(
                    'INSERT IGNORE INTO students (reg_number, full_name, contact_email, campus) VALUES ?',
                    [valid]
                );
                inserted = result.affectedRows;
                const byCampus = new Map();
                valid.forEach(value => byCampus.set(value[3], [...(byCampus.get(value[3]) || []), value[0]]));
                for (const [campus, registrations] of byCampus) {
                    await pool.query(
                        `UPDATE students SET campus = ? WHERE role = 'voter' AND campus IS NULL AND reg_number IN (?)`,
                        [campus, registrations]
                    );
                }
            }
            await addAuditLog('VOTER_LIST_UPLOADED', req.user.regNumber,
                `rows=${lines.length}, added=${inserted}, duplicates=${valid.length - inserted}, invalid=${invalid.length}`);
            res.json({ received: lines.length, added: inserted, duplicatesSkipped: valid.length - inserted, invalidLines: invalid.slice(0, 20) });
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
        if (!REG_RE.test(reg)) return res.status(400).json({ message: 'Registration number must look like 223007576' });
        const [[student]] = await pool.query(
            `SELECT full_name, campus, is_activated FROM students WHERE reg_number = ? AND role = 'voter'`,
            [reg]
        );
        if (!student) return res.json({ eligible: false });
        res.json({ eligible: true, name: student.full_name, campus: student.campus, activated: !!student.is_activated });
    } catch (error) { console.error(error.message); serverError(res); }
});

module.exports = router;
