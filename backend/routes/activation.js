const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { sendCode } = require('../db/mailer');

const router = express.Router();
const REG_RE = /^22[2-5]0[0-9]{5}$/;
const CODE_MINUTES = 10;   // a code lives for 10 minutes
const MAX_CODES = 3;       // at most 3 codes per 10 minutes per student
const MAX_TRIES = 5;       // 5 wrong guesses cancel the code
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, message: { message: 'Too many attempts. Try again later.' } });

// Same answer whether or not the registration number exists, so nobody can probe the list
const GENERIC = { message: 'If this registration number is on the eligible list and not yet activated, a code has been sent to its registered email.' };
const passwordOk = p => typeof p === 'string' && p.length >= 10 && p.length <= 72 && /[A-Za-z]/.test(p) && /\d/.test(p);

router.post('/activate/request', limiter, async (req, res) => {
    try {
        const reg = String((req.body && req.body.regNumber) || '').trim();
        if (!REG_RE.test(reg)) return res.json(GENERIC);
        const [rows] = await pool.query("SELECT id, contact_email, is_activated FROM students WHERE reg_number = ? AND role = 'voter'", [reg]);
        const s = rows[0];
        if (s && !s.is_activated) {
            const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM otp_codes WHERE student_id = ? AND purpose = 'activation' AND expires_at > UTC_TIMESTAMP()", [s.id]);
            if (c.n < MAX_CODES) {
                const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
                await pool.query("UPDATE otp_codes SET used = 1 WHERE student_id = ? AND purpose = 'activation' AND used = 0", [s.id]);
                await pool.query("INSERT INTO otp_codes (student_id, purpose, code_hash, expires_at) VALUES (?, 'activation', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))",
                    [s.id, await bcrypt.hash(code, 10), CODE_MINUTES]);
                try { await sendCode(s.contact_email, code); } catch (err) {
                    console.error('Activation email failed:', err.message);
                    return res.status(503).json({ message: 'The activation email could not be sent. Please try again later.' });
                }
                await addAuditLog('ACTIVATION_CODE_SENT', reg, 'Code issued');
            }
        }
        res.json(GENERIC);
    } catch (e) {
        console.error(e.message);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/activate/confirm', limiter, async (req, res) => {
    const fail = () => res.status(400).json({ message: 'Invalid or expired code.' });
    try {
        const b = req.body || {};
        const reg = String(b.regNumber || '').trim();
        const code = String(b.code || '').trim();
        if (!REG_RE.test(reg) || !/^\d{6}$/.test(code)) return fail();
        if (!passwordOk(b.password)) {
            return res.status(400).json({ message: 'Password must be 10 to 72 characters and include a letter and a number.' });
        }
        const [rows] = await pool.query("SELECT id FROM students WHERE reg_number = ? AND role = 'voter' AND is_activated = 0", [reg]);
        if (!rows.length) return fail();
        const sid = rows[0].id;

        const [otps] = await pool.query("SELECT id, code_hash FROM otp_codes WHERE student_id = ? AND purpose = 'activation' AND used = 0 AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1", [sid]);
        if (!otps.length) return fail();
        if (!(await bcrypt.compare(code, otps[0].code_hash))) {
            await pool.query('UPDATE otp_codes SET attempts = attempts + 1, used = IF(attempts >= ?, 1, 0) WHERE id = ?', [MAX_TRIES, otps[0].id]);
            await addAuditLog('ACTIVATION_FAILED', reg, 'Wrong code');
            return fail();
        }

        const hash = await bcrypt.hash(b.password, 12);
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [u] = await conn.query('UPDATE students SET password_hash = ?, is_activated = 1, failed_attempts = 0 WHERE id = ? AND is_activated = 0', [hash, sid]);
            if (!u.affectedRows) { await conn.rollback(); return fail(); }
            await conn.query("UPDATE otp_codes SET used = 1 WHERE student_id = ? AND purpose = 'activation'", [sid]);
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
        await addAuditLog('ACCOUNT_ACTIVATED', reg, 'Account activated');
        res.json({ message: 'Account activated. You can now sign in.' });
    } catch (e) {
        console.error(e.message);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;