function getTransporter() {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
    return require('nodemailer').createTransport({
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

function getEmailProvider() {
    if (process.env.BREVO_API_KEY && (process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM)) return 'brevo';
    if (getTransporter()) return 'smtp';
    return 'dev-log';
}

function resolveSenderAddress() {
    if (process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM) {
        return process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM;
    }
    if (process.env.SMTP_USER) return process.env.SMTP_USER;
    return 'noreply@localhost';
}

function buildMailPayload({ to, subject, text, html, senderName = process.env.BREVO_SENDER_NAME || 'UR Voting System' }) {
    return {
        sender: {
            name: senderName,
            email: resolveSenderAddress()
        },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html || text
    };
}

async function sendWithBrevo(payload) {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'api-key': process.env.BREVO_API_KEY,
            'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Brevo mail failed (${response.status}): ${body}`);
    }
    return response.json();
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
    const html = purpose === 'admin_login'
        ? `<p>Hello ${escapeHtml(accountName || 'administrator')},</p><p>Your administrator sign-in code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${escapeHtml(code)}</p><p>It expires in 10 minutes.</p><p>This code only verifies sign-in to the account above. It does not create an administrator account or grant or change any role or privileges. The election administrator manages account roles and privileges.</p><p>If you cannot access this account's registered email, contact the election administrator for account support. Never share this code. If you did not request it, contact the election administrator.</p>`
        : null;
    if (getEmailProvider() === 'brevo') {
        return sendWithBrevo(buildMailPayload({
            to,
            subject,
            text: message,
            html: html || undefined
        }));
    }
    const activeTransporter = getTransporter();
    if (activeTransporter) {
        const mail = {
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject,
            text: message
        };
        if (html) mail.html = html;
        return activeTransporter.sendMail(mail);
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Mail is not configured');
    console.log(`[DEV MAIL ${new Date().toISOString()}] To ${to}: ${message}`);
}

async function sendRegistrationConfirmation(to, fullName, verificationUrl) {
    const message = `Hello ${fullName},\n\nConfirm your email address and activate your voter account by opening this link:\n${verificationUrl}\n\nThe link expires in 24 hours. Once confirmed, you can sign in. Email confirmation does not confirm eligibility to vote; your details must also match the official voter list, and official-email activation may be required.\n\nIf you did not create this account, ignore this email.`;
    const safeName = escapeHtml(fullName);
    const safeUrl = escapeHtml(verificationUrl);
    const html = `<p>Hello ${safeName},</p><p>Confirm your email address and activate your voter account by clicking the link below. The link expires in 24 hours.</p><p><a href="${safeUrl}">Confirm email address</a></p><p>Email confirmation does not confirm eligibility to vote; your details must also match the official voter list, and official-email activation may be required.</p><p>If you did not create this account, ignore this email.</p>`;
    if (getEmailProvider() === 'brevo') {
        return sendWithBrevo(buildMailPayload({
            to,
            subject: 'Confirm your UR student voting account email',
            text: message,
            html
        }));
    }
    const activeTransporter = getTransporter();
    if (activeTransporter) {
        return activeTransporter.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject: 'Confirm your UR student voting account email',
            text: message,
            html
        });
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Mail is not configured');
    console.log(`[DEV MAIL ${new Date().toISOString()}] To ${to}: ${message}`);
}

async function sendPasswordReset(to, fullName, resetUrl) {
    const message = `Hello ${fullName},\n\nUse this link to reset the password for your UR student voting account:\n${resetUrl}\n\nThe link expires in 1 hour and can only be used once. If you did not request a password reset, ignore this email; your password will not change.`;
    const safeName = escapeHtml(fullName);
    const safeUrl = escapeHtml(resetUrl);
    const html = `<p>Hello ${safeName},</p><p>Use the link below to reset the password for your UR student voting account. The link expires in 1 hour and can only be used once.</p><p><a href="${safeUrl}">Reset your password</a></p><p>If you did not request a password reset, ignore this email; your password will not change.</p>`;
    if (getEmailProvider() === 'brevo') {
        return sendWithBrevo(buildMailPayload({
            to,
            subject: 'Reset your UR student voting account password',
            text: message,
            html
        }));
    }
    const activeTransporter = getTransporter();
    if (activeTransporter) {
        return activeTransporter.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject: 'Reset your UR student voting account password',
            text: message,
            html
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

module.exports = {
    buildMailPayload,
    getEmailProvider,
    passwordResetUrl,
    registrationVerificationUrl,
    resolveSenderAddress,
    sendCode,
    sendPasswordReset,
    sendRegistrationConfirmation
};