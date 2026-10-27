const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db/connection');
const { addAuditLog } = require('../db/audit');
const { validateRegistration } = require('../db/voterRegistrationRules');

const router = express.Router();
const registrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: { message: 'Too many account creation attempts. Try again later.' }
});
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
        await connection.query(
            `INSERT INTO voter_accounts (reg_number, full_name, email, password_hash)
             VALUES (?, ?, ?, ?)`,
            [regNumber, fullName, email, passwordHash]
        );
        await connection.commit();
        try {
            await addAuditLog('VOTER_ACCOUNT_CREATED', regNumber, 'Self-registration; voter eligibility is checked at sign-in');
        } catch (auditError) {
            console.error('Voter account was created but its audit entry could not be written:', auditError.message);
            return res.status(201).json({
                message: 'Account created, but its audit entry could not be recorded. Contact an administrator before signing in.'
            });
        }
        res.status(201).json({ message: 'Account created. Sign in to check voter eligibility against the official list.' });
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
        res.status(500).json({ message: 'Could not create the account.' });
    } finally {
        connection.release();
    }
});

module.exports = router;
