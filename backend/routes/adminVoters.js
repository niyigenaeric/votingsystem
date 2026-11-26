const express = require('express');
const pool = require('../db/connection');
const { addAuditLog, lockAuditLog, appendAuditLog, releaseAuditLogLock } = require('../db/audit');
const { verifyToken, requireRole } = require('../middleware/auth');
const { CAMPUSES, canonical } = require('../db/campuses');
const { parseStudentCsv } = require('../db/studentCsv');

const router = express.Router();
const serverError = res => res.status(500).json({ message: 'Server error' });
const REG_RE = /^22[2-5]0[0-9]{5}$/;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/;
const EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'gmail.com,hotmail.com,outlook.com,yahoo.com,live.com,icloud.com')
    .split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean);
const MAX_PAGE_SIZE = 50;

function validateVoter(body, includeRegNumber) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Enter voter details.' };
    const regNumber = String(body.regNumber || '').trim();
    const fullName = String(body.fullName || '').trim().replace(/\s+/g, ' ');
    const email = String(body.email || '').trim().toLowerCase();
    const campus = canonical(body.campus);
    if (includeRegNumber && !REG_RE.test(regNumber)) return { error: 'Registration number must look like 223007576.' };
    if (fullName.length < 2 || fullName.length > 100) return { error: 'Enter a full name between 2 and 100 characters.' };
    if (email.length > 150 || !EMAIL_RE.test(email)) return { error: 'Enter a valid voter email address.' };
    const domain = email.split('@')[1];
    if (!EMAIL_DOMAINS.includes(domain)) return { error: `Email domain @${domain} is not allowed.` };
    if (!campus) return { error: `Choose a campus: ${CAMPUSES.join(', ')}.` };
    return { value: { regNumber, fullName, email, campus } };
}

function safeCsvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function rollbackQuietly(connection) {
    try { await connection.rollback(); } catch { /* transaction may already be closed */ }
}

router.get('/campuses', verifyToken, requireRole('admin', 'auditor'), (req, res) => res.json(CAMPUSES));

router.get('/students', verifyToken, requireRole('admin'), async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const search = String(req.query.search || '').trim();
    if (!Number.isSafeInteger(page) || page < 1) return res.status(400).json({ message: 'Page must be a positive integer.' });
    if (search.length > 100) return res.status(400).json({ message: 'Search must be 100 characters or fewer.' });
    const offset = (page - 1) * MAX_PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) return res.status(400).json({ message: 'Page is too large.' });
    const where = search
        ? `AND (s.reg_number LIKE ? OR s.full_name LIKE ? OR s.contact_email LIKE ? OR s.campus LIKE ?)`
        : '';
    const searchTerm = `%${search}%`;
    const params = search ? [searchTerm, searchTerm, searchTerm, searchTerm] : [];
    try {
        const [[count]] = await pool.query(
            `SELECT COUNT(*) AS total FROM students s WHERE s.role = 'voter' ${where}`,
            params
        );
        const [voters] = await pool.query(
            `SELECT s.id, s.reg_number AS regNumber, s.full_name AS fullName,
                    s.contact_email AS email, s.campus, s.is_activated AS isActivated,
                    (va.id IS NOT NULL) AS accountCreated,
                    va.full_name AS accountFullName, va.email AS accountEmail
             FROM students s
             LEFT JOIN voter_accounts va ON va.reg_number = s.reg_number
             WHERE s.role = 'voter' ${where}
             ORDER BY s.reg_number ASC LIMIT ? OFFSET ?`,
            [...params, MAX_PAGE_SIZE, offset]
        );
        res.set('Cache-Control', 'no-store, private');
        res.json({ voters, page, pageSize: MAX_PAGE_SIZE, total: Number(count.total) });
    } catch (error) {
        console.error(error.message);
        serverError(res);
    }
});

router.get('/students/export', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const [voters] = await pool.query(
            `SELECT reg_number AS regNumber, full_name AS fullName,
                    contact_email AS email, campus
             FROM students WHERE role = 'voter' ORDER BY reg_number ASC`
        );
        const lines = [
            ['reg_number', 'full_name', 'contact_email', 'campus'].map(safeCsvCell).join(','),
            ...voters.map(voter => [voter.regNumber, voter.fullName, voter.email, voter.campus].map(safeCsvCell).join(','))
        ];
        await addAuditLog('VOTER_LIST_EXPORTED', req.user.regNumber, `rows=${voters.length}`);
        res.set({
            'Cache-Control': 'no-store, private',
            'Content-Disposition': `attachment; filename="eligible-voters-${new Date().toISOString().slice(0, 10)}.csv"`
        });
        res.type('text/csv').send(`\uFEFF${lines.join('\r\n')}\r\n`);
    } catch (error) {
        console.error(error.message);
        serverError(res);
    }
});

router.post('/students', verifyToken, requireRole('admin'), async (req, res) => {
    const parsed = validateVoter(req.body, true);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const voter = parsed.value;
    const connection = await pool.getConnection();
    let auditLocked = false;
    try {
        await connection.beginTransaction();
        await lockAuditLog(connection);
        auditLocked = true;
        const [[account]] = await connection.query(
            'SELECT full_name, email FROM voter_accounts WHERE reg_number = ? FOR UPDATE',
            [voter.regNumber]
        );
        if (account && (
            account.email.trim().toLowerCase() !== voter.email
            || account.full_name.trim().replace(/\s+/g, ' ').toLowerCase() !== voter.fullName.toLowerCase()
        )) {
            await rollbackQuietly(connection);
            return res.status(409).json({
                message: 'This registration number already has a voter account. Enter the same name and email as that account to preserve eligibility.'
            });
        }
        const [result] = await connection.query(
            `INSERT INTO students (reg_number, full_name, contact_email, campus, role)
             VALUES (?, ?, ?, ?, 'voter')`,
            [voter.regNumber, voter.fullName, voter.email, voter.campus]
        );
        await appendAuditLog(connection, 'ELIGIBLE_VOTER_ADDED', req.user.regNumber,
            `studentId=${result.insertId}; campus=${voter.campus}`);
        await connection.commit();
        res.status(201).json({ message: 'Voter added to the eligible list.', id: result.insertId });
    } catch (error) {
        await rollbackQuietly(connection);
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That registration number or email is already on file.' });
        console.error(error.message);
        serverError(res);
    } finally {
        if (auditLocked) await releaseAuditLogLock(connection);
        connection.release();
    }
});

router.patch('/students/:id', verifyToken, requireRole('admin'), async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Voter ID is invalid.' });
    const parsed = validateVoter(req.body, false);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const voter = parsed.value;
    const connection = await pool.getConnection();
    let auditLocked = false;
    try {
        await connection.beginTransaction();
        await lockAuditLog(connection);
        auditLocked = true;
        const [[existing]] = await connection.query(
            `SELECT s.reg_number, va.full_name AS accountFullName, va.email AS accountEmail
             FROM students s LEFT JOIN voter_accounts va ON va.reg_number = s.reg_number
             WHERE s.id = ? AND s.role = 'voter' FOR UPDATE`,
            [id]
        );
        if (!existing) {
            await rollbackQuietly(connection);
            return res.status(404).json({ message: 'Eligible voter was not found.' });
        }
        if (existing.accountEmail && (
            existing.accountEmail.trim().toLowerCase() !== voter.email
            || existing.accountFullName.trim().replace(/\s+/g, ' ').toLowerCase() !== voter.fullName.toLowerCase()
        )) {
            await rollbackQuietly(connection);
            return res.status(409).json({
                message: 'This voter already has an account. Keep the name and email matched to that account so eligibility remains active.'
            });
        }
        await connection.query(
            `UPDATE students SET full_name = ?, contact_email = ?, campus = ?
             WHERE id = ? AND role = 'voter'`,
            [voter.fullName, voter.email, voter.campus, id]
        );
        await appendAuditLog(connection, 'ELIGIBLE_VOTER_UPDATED', req.user.regNumber,
            `studentId=${id}; campus=${voter.campus}`);
        await connection.commit();
        res.json({ message: 'Eligible voter details updated.' });
    } catch (error) {
        await rollbackQuietly(connection);
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That email is already assigned to another student.' });
        console.error(error.message);
        serverError(res);
    } finally {
        if (auditLocked) await releaseAuditLogLock(connection);
        connection.release();
    }
});

router.delete('/students/:id', verifyToken, requireRole('admin'), async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Voter ID is invalid.' });
    const connection = await pool.getConnection();
    let auditLocked = false;
    try {
        await connection.beginTransaction();
        await lockAuditLog(connection);
        auditLocked = true;
        const [[student]] = await connection.query(
            `SELECT id, reg_number FROM students WHERE id = ? AND role = 'voter' FOR UPDATE`, [id]
        );
        if (!student) {
            await rollbackQuietly(connection);
            return res.status(404).json({ message: 'Eligible voter was not found.' });
        }
        const [[receiptCount]] = await connection.query(
            'SELECT COUNT(*) AS total FROM voter_receipts WHERE student_id = ?', [id]
        );
        if (Number(receiptCount.total) > 0) {
            await rollbackQuietly(connection);
            return res.status(409).json({ message: 'This voter has a protected election receipt and cannot be removed from the eligible list.' });
        }
        await connection.query('DELETE FROM students WHERE id = ? AND role = \'voter\'', [id]);
        await appendAuditLog(connection, 'ELIGIBLE_VOTER_REMOVED', req.user.regNumber,
            `studentId=${id}; registration=${student.reg_number}`);
        await connection.commit();
        res.json({ message: 'Voter removed from the eligible list. Their separate voter account has been retained.' });
    } catch (error) {
        await rollbackQuietly(connection);
        if (error.code === 'ER_TABLEACCESS_DENIED_ERROR') {
            return res.status(503).json({ message: 'The database account needs the documented table-level students DELETE grant before this voter can be removed.' });
        }
        console.error(error.message);
        serverError(res);
    } finally {
        if (auditLocked) await releaseAuditLogLock(connection);
        connection.release();
    }
});

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
