const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db/connection');
const { lockAuditLog, appendAuditLog, releaseAuditLogLock } = require('../db/audit');
const { isValidEmail, isValidPassword, validateRegistration } = require('../db/voterRegistrationRules');
const { passwordResetUrl, registrationVerificationUrl, sendPasswordReset, sendRegistrationConfirmation } = require('../db/mailer');
const { featureSetupMessage } = require('../db/featureSetupError');

const router = express.Router();
const registrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: { message: 'Too many account creation attempts. Try again later.' }
});
const verificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: { message: 'Too many verification attempts. Try again later.' }
});
const resendLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    message: { message: 'Too many verification email requests. Try again later.' }
});
const passwordResetRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    message: { message: 'Too many password reset requests. Try again later.' }
});
const passwordResetConfirmLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: { message: 'Too many password reset attempts. Try again later.' }
});
const VERIFICATION_TOKEN_HOURS = 24;
const PASSWORD_RESET_TOKEN_MINUTES = 60;
function createOneTimeToken() {
    const token = crypto.randomBytes(32).toString('hex');
    return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

router.post('/register', registrationLimiter, async (req, res) => {
    const body = req.body || {};
    const regNumber = typeof body.regNumber === 'string' ? body.regNumber.trim() : '';
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim().replace(/\s+/g, ' ') : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

    const validationError = validateRegistration({ regNumber, fullName, email, password, confirmPassword });
    if (validationError) return res.status(400).json({ message: validationError });

    const connection = await pool.getConnection();
    let auditLockAcquired = false;
    let accountCreated = false;
    let verificationToken;
    try {
        const passwordHash = await bcrypt.hash(password, 12);
        await connection.beginTransaction();
        const [[reservedAccount]] = await connection.query(
            `SELECT id FROM students
             WHERE reg_number = ? AND role IN ('admin', 'auditor') FOR UPDATE`,
            [regNumber]
        );
        if (reservedAccount) {
            await connection.rollback();
            return res.status(409).json({ message: 'That registration number is reserved for a staff account.' });
        }
        const [account] = await connection.query(
            `INSERT INTO voter_accounts (reg_number, full_name, email, password_hash)
             VALUES (?, ?, ?, ?)`,
            [regNumber, fullName, email, passwordHash]
        );
        verificationToken = createOneTimeToken();
        await connection.query(
            `INSERT INTO voter_email_verification_tokens (voter_account_id, token_hash, expires_at)
             VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`,
            [account.insertId, verificationToken.hash, VERIFICATION_TOKEN_HOURS]
        );
        await lockAuditLog(connection);
        auditLockAcquired = true;
        await appendAuditLog(
            connection,
            'VOTER_ACCOUNT_CREATED',
            regNumber,
            'Self-registration; email confirmation is required before sign-in'
        );
        await connection.commit();
        accountCreated = true;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('Account creation rollback failed:', rollbackError.message);
        }
        if (error.code === 'ER_DUP_ENTRY') {
            const duplicateEmail = String(error.message).includes('uq_voter_accounts_email');
            return res.status(409).json({
                message: duplicateEmail
                    ? 'That email address is already associated with an account.'
                    : 'An account already exists for that registration number.'
            });
        }
        console.error(error.message);
        return res.status(500).json({ message: 'Could not create the account.' });
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
    }
    if (!accountCreated) return;
    let message = 'Account created successfully! Go to your email and click the verification link before signing in.';
    let emailSent = true;
    try {
        await sendRegistrationConfirmation(email, fullName, registrationVerificationUrl(verificationToken.token));
    } catch (mailError) {
        emailSent = false;
        console.error('Voter registration confirmation email failed:', mailError.message);
        message = 'Account created, but the confirmation email could not be sent. Use the resend form below to request another link.';
        try {
            await pool.query(
                'UPDATE voter_email_verification_tokens SET used = 2 WHERE token_hash = ? AND used = 0',
                [verificationToken.hash]
            );
        } catch (cleanupError) {
            console.error('Could not invalidate unsent voter confirmation link:', cleanupError.message);
        }
    }
    res.status(201).json({ message, emailSent });
});

router.post('/email/verify', verificationLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!/^[a-f0-9]{64}$/.test(token)) {
        return res.status(400).json({ message: 'This confirmation link is invalid or expired. Request a new one.' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const connection = await pool.getConnection();
    let auditLockAcquired = false;
    try {
        await connection.beginTransaction();
        const [[verification]] = await connection.query(
            `SELECT tokens.id, tokens.voter_account_id, accounts.reg_number
             FROM voter_email_verification_tokens tokens
             JOIN voter_accounts accounts ON accounts.id = tokens.voter_account_id
             WHERE tokens.token_hash = ? AND tokens.used = 0 AND tokens.expires_at > UTC_TIMESTAMP()
             FOR UPDATE`,
            [tokenHash]
        );
        if (!verification) {
            await connection.rollback();
            return res.status(400).json({ message: 'This confirmation link is invalid or expired. Request a new one.' });
        }
        await connection.query(
            'UPDATE voter_email_verification_tokens SET used = 1 WHERE id = ?',
            [verification.id]
        );
        await lockAuditLog(connection);
        auditLockAcquired = true;
        await appendAuditLog(connection, 'VOTER_EMAIL_VERIFIED', verification.reg_number,
            'Registration email confirmation link used');
        await connection.commit();
        res.json({ message: 'Email confirmed. Your account is active; you can now sign in.' });
    } catch (error) {
        await connection.rollback();
        console.error('Voter email verification failed:', error.message);
        res.status(500).json({ message: 'Could not verify the email. Please try again.' });
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
    }
});

router.post('/email/resend', resendLimiter, async (req, res) => {
    const regNumber = typeof req.body?.regNumber === 'string' ? req.body.regNumber.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const genericMessage = 'If an unverified account matches those details, a new confirmation link has been sent.';
    if (!regNumber || !email || regNumber.length > 20 || email.length > 150) {
        return res.status(400).json({ message: 'Enter the registration number and email used to create the account.' });
    }
    const connection = await pool.getConnection();
    let account;
    let verificationToken;
    try {
        await connection.beginTransaction();
        const [[currentAccount]] = await connection.query(
            `SELECT id, reg_number, full_name, email,
                    EXISTS(
                        SELECT 1 FROM voter_email_verification_tokens
                        WHERE voter_account_id = voter_accounts.id AND used = 1
                    ) AS email_verified
             FROM voter_accounts WHERE reg_number = ? AND email = ? FOR UPDATE`,
            [regNumber, email]
        );
        if (!currentAccount || currentAccount.email_verified) {
            await connection.rollback();
            return res.json({ message: genericMessage });
        }
        account = currentAccount;
        verificationToken = createOneTimeToken();
        await connection.query(
            'UPDATE voter_email_verification_tokens SET used = 2 WHERE voter_account_id = ? AND used = 0',
            [account.id]
        );
        await connection.query(
            `INSERT INTO voter_email_verification_tokens (voter_account_id, token_hash, expires_at)
             VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`,
            [account.id, verificationToken.hash, VERIFICATION_TOKEN_HOURS]
        );
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        console.error('Could not prepare voter email confirmation:', error.message);
        return res.status(500).json({ message: 'Could not prepare a confirmation email. Please try again.' });
    } finally {
        connection.release();
    }
    try {
        await sendRegistrationConfirmation(
            account.email,
            account.full_name,
            registrationVerificationUrl(verificationToken.token)
        );
        await addAuditLog('VOTER_EMAIL_VERIFICATION_RESENT', account.reg_number, 'Confirmation link sent');
        res.json({ message: genericMessage });
    } catch (error) {
        console.error('Voter confirmation email resend failed:', error.message);
        try {
            await pool.query(
                'UPDATE voter_email_verification_tokens SET used = 2 WHERE token_hash = ? AND used = 0',
                [verificationToken.hash]
            );
        } catch (cleanupError) {
            console.error('Could not invalidate unsent voter confirmation link:', cleanupError.message);
        }
        res.status(503).json({ message: 'The confirmation email could not be sent. Please try again later.' });
    }
});

router.post('/password-reset/request', passwordResetRequestLimiter, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!isValidEmail(email)) {
        return res.status(400).json({ message: 'Enter the email address used for your voter account.' });
    }

    const genericMessage = 'If a voter account matches that email address, a password reset link will be sent there. Check your inbox and spam folder.';
    const connection = await pool.getConnection();
    let account;
    let resetToken;
    try {
        await connection.beginTransaction();
        const [[currentAccount]] = await connection.query(
            'SELECT id, reg_number, full_name, email FROM voter_accounts WHERE email = ? FOR UPDATE',
            [email]
        );
        if (!currentAccount) {
            await connection.rollback();
            return res.json({ message: genericMessage });
        }
        account = currentAccount;
        resetToken = createOneTimeToken();
        await connection.query(
            'UPDATE voter_password_reset_tokens SET used = 1 WHERE voter_account_id = ? AND used = 0',
            [account.id]
        );
        await connection.query(
            `INSERT INTO voter_password_reset_tokens (voter_account_id, token_hash, expires_at)
             VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
            [account.id, resetToken.hash, PASSWORD_RESET_TOKEN_MINUTES]
        );
        await connection.commit();
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('Password reset request rollback failed:', rollbackError.message);
        }
        console.error('Could not prepare voter password reset:', error.message);
        const setupMessage = featureSetupMessage(error);
        return res.status(setupMessage ? 503 : 500).json({
            message: setupMessage || 'Could not process the password reset request. Please try again.'
        });
    } finally {
        connection.release();
    }

    try {
        await sendPasswordReset(account.email, account.full_name, passwordResetUrl(resetToken.token));
    } catch (error) {
        console.error('Voter password reset email failed:', error.message);
        try {
            await pool.query(
                'UPDATE voter_password_reset_tokens SET used = 1 WHERE token_hash = ? AND used = 0',
                [resetToken.hash]
            );
        } catch (cleanupError) {
            console.error('Could not invalidate unsent password reset link:', cleanupError.message);
        }
    }
    try {
        await addAuditLog('VOTER_PASSWORD_RESET_REQUESTED', account.reg_number, 'Password reset link requested');
    } catch (error) {
        console.error('Could not audit voter password reset request:', error.message);
    }
    res.json({ message: genericMessage });
});

router.post('/password-reset/confirm', passwordResetConfirmLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirmPassword = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : '';
    if (!/^[a-f0-9]{64}$/.test(token)) {
        return res.status(400).json({ message: 'This password reset link is invalid or expired. Request a new one.' });
    }
    if (!isValidPassword(password)) {
        return res.status(400).json({ message: 'Password must be 10 to 72 characters and include a letter and a number.' });
    }
    if (password !== confirmPassword) {
        return res.status(400).json({ message: 'The passwords do not match.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const passwordHash = await bcrypt.hash(password, 12);
    const connection = await pool.getConnection();
    let auditLockAcquired = false;
    try {
        await connection.beginTransaction();
        const [[reset]] = await connection.query(
            `SELECT tokens.id, tokens.voter_account_id, accounts.reg_number
             FROM voter_password_reset_tokens tokens
             JOIN voter_accounts accounts ON accounts.id = tokens.voter_account_id
             WHERE tokens.token_hash = ? AND tokens.used = 0 AND tokens.expires_at > UTC_TIMESTAMP()
             FOR UPDATE`,
            [tokenHash]
        );
        if (!reset) {
            await connection.rollback();
            return res.status(410).json({ message: 'This password reset link is invalid or expired. Request a new one.' });
        }
        await connection.query(
            `UPDATE voter_accounts
             SET password_hash = ?, failed_attempts = 0, locked_until = NULL
             WHERE id = ?`,
            [passwordHash, reset.voter_account_id]
        );
        await connection.query(
            'UPDATE voter_password_reset_tokens SET used = 1 WHERE voter_account_id = ? AND used = 0',
            [reset.voter_account_id]
        );
        await connection.query(
            'UPDATE voter_login_codes SET used = 1 WHERE voter_account_id = ? AND used = 0',
            [reset.voter_account_id]
        );
        await lockAuditLog(connection);
        auditLockAcquired = true;
        await appendAuditLog(connection, 'VOTER_PASSWORD_RESET_COMPLETED', reset.reg_number,
            'Password reset link used; failed sign-in attempts cleared');
        await connection.commit();
        return res.json({ message: 'Your password has been reset. You can now sign in with your new password.' });
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('Password reset confirmation rollback failed:', rollbackError.message);
        }
        console.error('Voter password reset confirmation failed:', error.message);
        return res.status(500).json({ message: 'Could not reset the password. Please try again.' });
    } finally {
        if (auditLockAcquired) await releaseAuditLogLock(connection);
        connection.release();
    }
});

module.exports = router;
