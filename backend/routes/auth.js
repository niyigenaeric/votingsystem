const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { sendCode } = require('../db/mailer');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
const SESSION_COOKIE = 'voting_session';
const SESSION_MAX_AGE = 30 * 60 * 1000;
const sessionCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE
};
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12);
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const LOGIN_CODE_MINUTES = 10;
const MAX_CODE_TRIES = 5;
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    message: { message: 'Too many attempts. Try again later.' }
});

function issueSession(student, res) {
    const token = jwt.sign(
        { id: student.id, regNumber: student.reg_number, role: student.role },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
    );
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions);
    res.json({ role: student.role });
}

router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { regNumber, password } = req.body || {};
        if (typeof regNumber !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ message: 'Registration number and password are required' });
        }

        const registrationNumber = regNumber.trim();
        const [rows] = await pool.query(
            `SELECT *, (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS is_locked
             FROM students WHERE reg_number = ?`,
            [registrationNumber]
        );
        const student = rows[0];
        const passwordOk = await bcrypt.compare(
            password,
            student && student.password_hash ? student.password_hash : DUMMY_HASH
        );
        if (!student || !student.is_activated || !student.password_hash) {
            await addAuditLog('LOGIN_FAILED', registrationNumber, 'Unknown or inactive account');
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        if (student.is_locked) {
            await addAuditLog('LOGIN_BLOCKED', student.reg_number, 'Account locked');
            return res.status(423).json({ message: 'Account temporarily locked. Try again later.' });
        }
        if (!passwordOk) {
            await pool.query(
                `UPDATE students
                 SET failed_attempts = failed_attempts + 1,
                     locked_until = IF(failed_attempts >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), locked_until)
                 WHERE id = ?`,
                [MAX_ATTEMPTS, LOCK_MINUTES, student.id]
            );
            await addAuditLog('LOGIN_FAILED', student.reg_number, 'Wrong password');
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        await pool.query('UPDATE students SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [student.id]);
        if (student.role !== 'admin') {
            await addAuditLog('LOGIN_SUCCESS', student.reg_number, `Role ${student.role}`);
            return issueSession(student, res);
        }

        const [[activeCodes]] = await pool.query(
            "SELECT COUNT(*) AS count FROM otp_codes WHERE student_id = ? AND purpose = 'admin_login' AND expires_at > UTC_TIMESTAMP()",
            [student.id]
        );
        if (Number(activeCodes.count) >= 3) {
            return res.status(429).json({ message: 'Too many administrator sign-in codes were requested. Try again later.' });
        }
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        await pool.query("UPDATE otp_codes SET used = 1 WHERE student_id = ? AND purpose = 'admin_login' AND used = 0", [student.id]);
        await pool.query(
            "INSERT INTO otp_codes (student_id, purpose, code_hash, expires_at) VALUES (?, 'admin_login', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))",
            [student.id, await bcrypt.hash(code, 10), LOGIN_CODE_MINUTES]
        );
        try {
            await sendCode(student.contact_email, code, 'admin_login');
        } catch (error) {
            console.error('Administrator sign-in email failed:', error.message);
            await pool.query("UPDATE otp_codes SET used = 1 WHERE student_id = ? AND purpose = 'admin_login' AND used = 0", [student.id]);
            await addAuditLog('ADMIN_LOGIN_CODE_FAILED', student.reg_number, 'Email delivery failed');
            return res.status(503).json({ message: 'The sign-in code could not be sent. Please try again later.' });
        }
        await addAuditLog('ADMIN_LOGIN_CODE_SENT', student.reg_number, 'Code issued');
        res.json({ requiresCode: true });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/login/verify', loginLimiter, async (req, res) => {
    const registrationNumber = String((req.body && req.body.regNumber) || '').trim();
    const code = String((req.body && req.body.code) || '').trim();
    if (!registrationNumber || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: 'Registration number and a 6-digit code are required.' });
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [[student]] = await connection.query(
            `SELECT id, reg_number, role, is_activated, contact_email
             FROM students WHERE reg_number = ? AND role = 'admin' AND is_activated = 1 FOR UPDATE`,
            [registrationNumber]
        );
        if (!student) {
            await connection.rollback();
            return res.status(401).json({ message: 'Invalid or expired sign-in code.' });
        }
        const [[otp]] = await connection.query(
            `SELECT id, code_hash, attempts FROM otp_codes
             WHERE student_id = ? AND purpose = 'admin_login' AND used = 0
               AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            [student.id]
        );
        if (!otp || Number(otp.attempts) >= MAX_CODE_TRIES) {
            await connection.rollback();
            return res.status(401).json({ message: 'Invalid or expired sign-in code.' });
        }
        if (!(await bcrypt.compare(code, otp.code_hash))) {
            await connection.query(
                'UPDATE otp_codes SET attempts = attempts + 1, used = IF(attempts + 1 >= ?, 1, 0) WHERE id = ?',
                [MAX_CODE_TRIES, otp.id]
            );
            await connection.commit();
            await addAuditLog('ADMIN_LOGIN_FAILED', student.reg_number, 'Wrong sign-in code');
            return res.status(401).json({ message: 'Invalid or expired sign-in code.' });
        }
        await connection.query('UPDATE otp_codes SET used = 1 WHERE id = ? AND used = 0', [otp.id]);
        await connection.commit();
        await addAuditLog('LOGIN_SUCCESS', student.reg_number, 'Role admin; second factor verified');
        issueSession(student, res);
    } catch (error) {
        await connection.rollback();
        console.error(error.message);
        res.status(500).json({ message: 'Could not verify the sign-in code.' });
    } finally {
        connection.release();
    }
});

router.get('/me', verifyToken, (req, res) => {
    res.json({ id: req.user.id, regNumber: req.user.regNumber, role: req.user.role });
});

router.post('/logout', (req, res) => {
    const { maxAge, ...clearOptions } = sessionCookieOptions;
    res.clearCookie(SESSION_COOKIE, clearOptions);
    res.status(204).end();
});

module.exports = router;
