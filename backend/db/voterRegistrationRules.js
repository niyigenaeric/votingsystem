const REG_RE = /^22[2-5]0[0-9]{5}$/;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{10,72}$/;

function normalizeFullName(name) {
    return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function isValidEmail(email) {
    const localPart = email.split('@')[0];
    return email.length <= 150 && EMAIL_RE.test(email)
        && !localPart.startsWith('.') && !localPart.endsWith('.') && !localPart.includes('..');
}

function validateRegistration({ regNumber, fullName, email, password, confirmPassword }) {
    if (!REG_RE.test(regNumber)) return 'Enter a valid registration number, for example 223007576.';
    if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 100) {
        return 'Enter your full name as it appears on the official voter list.';
    }
    if (!isValidEmail(email)) return 'Enter a valid email address.';
    if (!PASSWORD_RE.test(password)) {
        return 'Password must be 10 to 72 characters and include a letter and a number.';
    }
    if (password !== confirmPassword) return 'The passwords do not match.';
    return null;
}

module.exports = { normalizeFullName, validateRegistration };
