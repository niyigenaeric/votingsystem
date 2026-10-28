// Sends the activation code. Without SMTP settings it prints the code in the
// server terminal (development only), so you can test with no email account.
let transporter = null;
if (process.env.SMTP_HOST) {
    transporter = require('nodemailer').createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 465),
        secure: Number(process.env.SMTP_PORT || 465) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}

async function sendCode(to, code, purpose = 'activation') {
    const subject = purpose === 'admin_login'
        ? 'Your UR voting administrator sign-in code'
        : 'Your UR student voting activation code';
    const message = purpose === 'admin_login'
        ? 'Your administrator sign-in code is ' + code + '. It expires in 10 minutes.\nIf you did not request it, contact the election administrator.'
        : 'Your activation code is ' + code + '. It expires in 10 minutes.\nIf you did not request it, ignore this email.';
    if (transporter) {
        return transporter.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject,
            text: message
        });
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Mail is not configured');
    console.log(`[DEV MAIL ${new Date().toISOString()}] To ${to}: ${message}`);
}

module.exports = { sendCode };