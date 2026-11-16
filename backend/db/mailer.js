// Without SMTP settings, development emails are printed in the server terminal.
let transporter = null;
if (process.env.SMTP_HOST) {
    transporter = require('nodemailer').createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 465),
        secure: Number(process.env.SMTP_PORT || 465) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

async function sendCode(to, code, purpose = 'activation', accountName = '') {
    const subject = purpose === 'admin_login'
        ? 'Your UR voting administrator sign-in code'
        : purpose === 'voter_login'
            ? 'Your UR student voting sign-in code'
            : 'Your UR student voting activation code';
    const message = purpose === 'admin_login'
        ? `Hello ${accountName || 'administrator'},\n\nYour administrator sign-in code is ${code}. It expires in 10 minutes.\n\nThis code only verifies sign-in to the account above. It does not create an administrator account or grant or change any role or privileges. The election administrator manages account roles and privileges.\n\nIf you cannot access this account's registered email, contact the election administrator for account support. Never share this code. If you did not request it, contact the election administrator.`
        : purpose === 'voter_login'
            ? 'Your voter sign-in code is ' + code + '. It expires in 10 minutes.\nIf you did not request it, ignore this email.'
            : 'Your activation code is ' + code + '. It expires in 10 minutes.\nIf you did not request it, ignore this email.';
    if (transporter) {
        const mail = {
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject,
            text: message
        };
        if (purpose === 'admin_login') {
            mail.html = `<p>Hello ${escapeHtml(accountName || 'administrator')},</p><p>Your administrator sign-in code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${escapeHtml(code)}</p><p>It expires in 10 minutes.</p><p>This code only verifies sign-in to the account above. It does not create an administrator account or grant or change any role or privileges. The election administrator manages account roles and privileges.</p><p>If you cannot access this account's registered email, contact the election administrator for account support. Never share this code. If you did not request it, contact the election administrator.</p>`;
        }
        return transporter.sendMail(mail);
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Mail is not configured');
    console.log(`[DEV MAIL ${new Date().toISOString()}] To ${to}: ${message}`);
}

async function sendRegistrationConfirmation(to, fullName, verificationUrl) {
    const message = `Hello ${fullName},\n\nConfirm your email address and activate your voter account by opening this link:\n${verificationUrl}\n\nThe link expires in 24 hours. Once confirmed, you can sign in. Email confirmation does not confirm eligibility to vote; your details must also match the official voter list, and official-email activation may be required.\n\nIf you did not create this account, ignore this email.`;
    const safeName = fullName.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    const safeUrl = verificationUrl.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    if (transporter) {
        return transporter.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject: 'Confirm your UR student voting account email',
            text: message,
            html: `<p>Hello ${safeName},</p><p>Confirm your email address and activate your voter account by clicking the link below. The link expires in 24 hours.</p><p><a href="${safeUrl}">Confirm email address</a></p><p>Email confirmation does not confirm eligibility to vote; your details must also match the official voter list, and official-email activation may be required.</p><p>If you did not create this account, ignore this email.</p>`
        });
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Mail is not configured');
    console.log(`[DEV MAIL ${new Date().toISOString()}] To ${to}: ${message}`);
}

async function sendPasswordReset(to, fullName, resetUrl) {
    const message = `Hello ${fullName},\n\nUse this link to reset the password for your UR student voting account:\n${resetUrl}\n\nThe link expires in 1 hour and can only be used once. If you did not request a password reset, ignore this email; your password will not change.`;
    const safeName = fullName.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    const safeUrl = resetUrl.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    if (transporter) {
        return transporter.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject: 'Reset your UR student voting account password',
            text: message,
            html: `<p>Hello ${safeName},</p><p>Use the link below to reset the password for your UR student voting account. The link expires in 1 hour and can only be used once.</p><p><a href="${safeUrl}">Reset your password</a></p><p>If you did not request a password reset, ignore this email; your password will not change.</p>`
        });
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Mail is not configured');
    console.log(`[DEV MAIL ${new Date().toISOString()}] To ${to}: ${message}`);
}

function registrationVerificationUrl(token) {
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    const url = new URL('/verify-email.html', baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
}

function passwordResetUrl(token) {
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    const url = new URL('/reset-password.html', baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
}

module.exports = { passwordResetUrl, registrationVerificationUrl, sendCode, sendPasswordReset, sendRegistrationConfirmation };