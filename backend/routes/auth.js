const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { sendCode } = require('../db/mailer');
const { verifyToken } = require('../middleware/auth');
const { getVoterEligibility, matchesVoterAccount } = require('../db/voterEligibility');
const { requiresSecondFactor } = require('../db/authRules');
const { isVoterEmailConfirmationRequired } = require('../db/voterEmailConfirmation');

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
const MAX_VOTER_LOGIN_CODES = 3;
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

async function findStaffAccount(connection, usernameOrReg, usernameLogin) {
    const queryParts = [
        {
            table: 'staff_accounts',
            sql: `SELECT id, reg_number, username, full_name, email, university_position, role, is_active, password_hash,
                    (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS is_locked
                  FROM staff_accounts WHERE ${usernameLogin ? 'username = ?' : 'reg_number = ?'} AND role IN ('admin', 'auditor')`,
            params: [usernameOrReg]
        },
        {
            table: 'students',
            sql: `SELECT id, reg_number, username, full_name, contact_email AS email, university_position, role, is_activated AS is_active,
                    password_hash, (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS is_locked
                  FROM students WHERE ${usernameLogin ? 'username = ?' : 'reg_number = ?'} AND role IN ('admin', 'auditor')`,
            params: [usernameOrReg]
        }
    ];

    for (const query of queryParts) {
        try {
            const [rows] = await connection.query(query.sql, query.params);
            if (rows[0]) {
                return { ...rows[0], source_table: query.table };
            }
        } catch (error) {
            const message = String(error.message || '');
            if (!/doesn't exist|unknown table|ER_NO_SUCH_TABLE/i.test(message)) {
                throw error;
            }
        }
    }
    return null;
}

router.post('/login', loginLimiter, async (req, res) => {
    try {
        const body = req.body || {};
        const { password } = body;
        const usernameLogin = typeof body.username === 'string';
        const loginName = usernameLogin ? body.username : body.regNumber;
        if (typeof loginName !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ message: 'Username or registration number and password are required' });
        }

        const registrationNumber = loginName.trim();
        let voterAccounts = [];
        if (!usernameLogin) {
            [voterAccounts] = await pool.query(
                `SELECT *, (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS is_locked
                 FROM voter_accounts WHERE reg_number = ?`,
                [registrationNumber]
            );
        }
        const voterAccount = voterAccounts[0];
        if (voterAccount) {
            const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
            if (!email) {
                return res.status(400).json({ message: 'Registration number, email, and password are required.' });
            }
            const passwordOk = await bcrypt.compare(password, voterAccount.password_hash);
            if (voterAccount.is_locked) {
                await addAuditLog('LOGIN_BLOCKED', registrationNumber, 'Voter account locked');
                return res.status(423).json({ message: 'Account temporarily locked. Try again later.' });
            }
            if (!passwordOk) {
                await pool.query(
                    `UPDATE voter_accounts
                     SET failed_attempts = failed_attempts + 1,
                         locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), locked_until)
                     WHERE id = ?`,
                    [MAX_ATTEMPTS, LOCK_MINUTES, voterAccount.id]
                );
                await addAuditLog('LOGIN_FAILED', registrationNumber, 'Wrong voter-account password');
                return res.status(401).json({ message: 'Invalid credentials' });
            }
            if (!matchesVoterAccount(voterAccount, { email })) {
                await addAuditLog('LOGIN_FAILED', registrationNumber, 'Voter account email did not match');
                return res.status(401).json({ message: 'Invalid credentials' });
            }
            if (isVoterEmailConfirmationRequired()) {
                const [[emailConfirmation]] = await pool.query(
                    `SELECT EXISTS(
                        SELECT 1 FROM voter_email_verification_tokens
                        WHERE voter_account_id = ? AND used = 1
                    ) AS email_verified`,
                    [voterAccount.id]
                );
                if (!emailConfirmation.email_verified) {
                    await addAuditLog('VOTER_EMAIL_VERIFICATION_REQUIRED', registrationNumber,
                        'Registration email has not been confirmed');
                    return res.status(403).json({
                        code: 'EMAIL_NOT_VERIFIED',
                        message: 'Confirm your account email using the link we sent before signing in.'
                    });
                }
            }

            const [eligibleRows] = await pool.query(
                `SELECT id, reg_number, full_name, contact_email, campus, role, is_activated
                 FROM students WHERE reg_number = ? AND role = 'voter'`,
                [registrationNumber]
            );
            const eligibleVoter = eligibleRows[0];
            const eligibility = getVoterEligibility(voterAccount, eligibleVoter);

            await pool.query(
                `UPDATE voter_accounts SET failed_attempts = 0, locked_until = NULL WHERE id = ?`,
                [voterAccount.id]
            );
            if (eligibility.eligible && !eligibleVoter.is_activated) {
                await addAuditLog('VOTER_VERIFICATION_REQUIRED', registrationNumber,
                    'Official-email activation is required before voting');
            } else if (!eligibility.eligible) {
                await addAuditLog('VOTER_ELIGIBILITY_DENIED', registrationNumber, eligibility.message);
            }
            const [[activeCodes]] = await pool.query(
                'SELECT COUNT(*) AS count FROM voter_login_codes WHERE voter_account_id = ? AND used = 0 AND expires_at > UTC_TIMESTAMP()',
                [voterAccount.id]
            );
            if (Number(activeCodes.count) >= MAX_VOTER_LOGIN_CODES) {
                return res.status(429).json({ message: 'Too many sign-in codes were requested. Try again later.' });
            }
            const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
            await pool.query('UPDATE voter_login_codes SET used = 1 WHERE voter_account_id = ? AND used = 0', [voterAccount.id]);
            await pool.query(
                `INSERT INTO voter_login_codes (voter_account_id, code_hash, expires_at)
                 VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
                [voterAccount.id, await bcrypt.hash(code, 10), LOGIN_CODE_MINUTES]
            );
            try {
                await sendCode(voterAccount.email, code, 'voter_login');
            } catch (error) {
                console.error('Voter sign-in email failed:', error.message);
                await pool.query('UPDATE voter_login_codes SET used = 1 WHERE voter_account_id = ? AND used = 0', [voterAccount.id]);
                await addAuditLog('VOTER_LOGIN_CODE_FAILED', registrationNumber, 'Email delivery failed');
                return res.status(503).json({ message: 'The sign-in code could not be sent. Please try again later.' });
            }
            await addAuditLog('VOTER_LOGIN_CODE_SENT', registrationNumber, 'Code issued');
            return res.json({ requiresCode: true, role: 'voter' });
        }

        const student = await findStaffAccount(pool, registrationNumber, usernameLogin);
        const passwordOk = await bcrypt.compare(
            password,
            student && student.password_hash ? student.password_hash : DUMMY_HASH
        );
        if (!student || !student.is_active || !student.password_hash) {
            await addAuditLog('LOGIN_FAILED', registrationNumber, 'Unknown or inactive staff account');
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        if (student.is_locked) {
            await addAuditLog('LOGIN_BLOCKED', student.reg_number, 'Staff account locked');
            return res.status(423).json({ message: 'Account temporarily locked. Try again later.' });
        }
        if (!passwordOk) {
            const accountTable = student.source_table === 'staff_accounts' ? 'staff_accounts' : 'students';
            await pool.query(
                `UPDATE ${accountTable}
                 SET failed_attempts = failed_attempts + 1,
                     locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), locked_until)
                 WHERE id = ?`,
                [MAX_ATTEMPTS, LOCK_MINUTES, student.id]
            );
            await addAuditLog('LOGIN_FAILED', student.reg_number, 'Wrong password');
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const accountTable = student.source_table === 'staff_accounts' ? 'staff_accounts' : 'students';
        await pool.query(`UPDATE ${accountTable} SET failed_attempts = 0, locked_until = NULL WHERE id = ?`, [student.id]);
        if (!requiresSecondFactor(student.role)) {
            await addAuditLog('LOGIN_SUCCESS', student.reg_number, `Role ${student.role}`);
            return issueSession(student, res);
        }

        const useStaffOtp = student.source_table === 'staff_accounts';
        const [[activeCodes]] = await pool.query(
            useStaffOtp
                ? "SELECT COUNT(*) AS count FROM otp_codes WHERE staff_id = ? AND purpose = 'admin_login' AND expires_at > UTC_TIMESTAMP()"
                : "SELECT COUNT(*) AS count FROM otp_codes WHERE student_id = ? AND purpose = 'admin_login' AND expires_at > UTC_TIMESTAMP()",
            [student.id]
        );
        if (Number(activeCodes.count) >= 3) {
            return res.status(429).json({ message: 'Too many privileged sign-in codes were requested. Try again later.' });
        }
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        await pool.query(
            useStaffOtp
                ? "UPDATE otp_codes SET used = 1 WHERE staff_id = ? AND purpose = 'admin_login' AND used = 0"
                : "UPDATE otp_codes SET used = 1 WHERE student_id = ? AND purpose = 'admin_login' AND used = 0",
            [student.id]
        );
        await pool.query(
            useStaffOtp
                ? "INSERT INTO otp_codes (staff_id, purpose, code_hash, expires_at) VALUES (?, 'admin_login', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))"
                : "INSERT INTO otp_codes (student_id, purpose, code_hash, expires_at) VALUES (?, 'admin_login', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))",
            [student.id, await bcrypt.hash(code, 10), LOGIN_CODE_MINUTES]
        );
        try {
            await sendCode(student.email, code, 'admin_login', student.username || registrationNumber);
        } catch (error) {
            console.error(
                `Administrator sign-in email failed for ${student.full_name} (${student.username || registrationNumber}):`,
                error.message
            );
            await pool.query(
                useStaffOtp
                    ? "UPDATE otp_codes SET used = 1 WHERE staff_id = ? AND purpose = 'admin_login' AND used = 0"
                    : "UPDATE otp_codes SET used = 1 WHERE student_id = ? AND purpose = 'admin_login' AND used = 0",
                [student.id]
            );
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
    const body = req.body || {};
    const usernameLogin = typeof body.username === 'string';
    const registrationNumber = String((usernameLogin ? body.username : body.regNumber) || '').trim();
    const code = String((req.body && req.body.code) || '').trim();
    if (!registrationNumber || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: 'Registration number or username and a 6-digit code are required.' });
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        if (!usernameLogin) {
            const [[account]] = await connection.query(
                'SELECT id, reg_number FROM voter_accounts WHERE reg_number = ? FOR UPDATE',
                [registrationNumber]
            );
            if (!account) {
                await connection.rollback();
                return res.status(401).json({ message: 'Invalid or expired sign-in code.' });
            }
            const [[otp]] = await connection.query(
                `SELECT id, code_hash, attempts FROM voter_login_codes
                 WHERE voter_account_id = ? AND used = 0 AND expires_at > UTC_TIMESTAMP()
                 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
                [account.id]
            );
            if (!otp || Number(otp.attempts) >= MAX_CODE_TRIES) {
                await connection.rollback();
                return res.status(401).json({ message: 'Invalid or expired sign-in code.' });
            }
            if (!(await bcrypt.compare(code, otp.code_hash))) {
                await connection.query(
                    'UPDATE voter_login_codes SET attempts = attempts + 1, used = IF(attempts + 1 >= ?, 1, 0) WHERE id = ?',
                    [MAX_CODE_TRIES, otp.id]
                );
                await connection.commit();
                await addAuditLog('VOTER_LOGIN_FAILED', account.reg_number, 'Wrong sign-in code');
                return res.status(401).json({ message: 'Invalid or expired sign-in code.' });
            }
            await connection.query('UPDATE voter_login_codes SET used = 1 WHERE id = ? AND used = 0', [otp.id]);
            await connection.commit();
            await addAuditLog('LOGIN_SUCCESS', account.reg_number, 'Role voter; sign-in code verified');
            return issueSession({ id: account.id, reg_number: account.reg_number, role: 'voter' }, res);
        }
        const [[student]] = await connection.query(
            `SELECT id, reg_number, username, full_name, email, role, is_active, university_position, 'staff_accounts' AS source_table
             FROM staff_accounts WHERE ${usernameLogin ? 'username = ?' : 'reg_number = ?'} AND role IN ('admin', 'auditor') AND is_active = 1 FOR UPDATE`,
            [registrationNumber]
        );
        let adminAccount = student;
        if (!adminAccount) {
            const [[legacyStudent]] = await connection.query(
                `SELECT id, reg_number, username, full_name, contact_email AS email, role, is_activated AS is_active, 'students' AS source_table
                 FROM students WHERE ${usernameLogin ? 'username = ?' : 'reg_number = ?'} AND role IN ('admin', 'auditor') AND is_activated = 1 FOR UPDATE`,
                [registrationNumber]
            );
            if (!legacyStudent) {
                await connection.rollback();
                return res.status(401).json({ message: 'Invalid or expired sign-in code.' });
            }
            adminAccount = legacyStudent;
        }
        const [[otp]] = await connection.query(
            adminAccount.source_table === 'staff_accounts'
                ? `SELECT id, code_hash, attempts FROM otp_codes
                   WHERE staff_id = ? AND purpose = 'admin_login' AND used = 0
                     AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1 FOR UPDATE`
                : `SELECT id, code_hash, attempts FROM otp_codes
                   WHERE student_id = ? AND purpose = 'admin_login' AND used = 0
                     AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            [adminAccount.id]
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
        await addAuditLog('LOGIN_SUCCESS', adminAccount.reg_number, `Role ${adminAccount.role}; second factor verified`);
        issueSession(adminAccount, res);
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
