const { CAMPUSES, canonical } = require('./campuses');

const REG_RE = /^22[2-5]0[0-9]{5}$/;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/;
const DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'gmail.com,hotmail.com,outlook.com,yahoo.com,live.com,icloud.com')
    .split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean);
const TYPOS = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'hotmial.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'yaho.com': 'yahoo.com' };

function splitCsvLine(line) {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') { value += '"'; index++; }
            else quoted = !quoted;
        } else if (character === ',' && !quoted) {
            values.push(value.trim());
            value = '';
        } else value += character;
    }
    values.push(value.trim());
    return values;
}

function parseStudentCsv(csv) {
    const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() !== '');
    if (!lines.length) return { error: 'The CSV is empty.' };

    const header = splitCsvLine(lines.shift()).map(value => value.toLowerCase()).join(',');
    if (header !== 'reg_number,full_name,contact_email,campus') {
        return { error: 'Header must be: reg_number,full_name,contact_email,campus' };
    }
    if (!lines.length) return { error: 'Add at least one student row below the header.' };

    const valid = [];
    const invalid = [];
    const seenReg = new Set();
    const seenEmail = new Set();
    lines.forEach((line, index) => {
        const lineNumber = index + 2;
        const columns = splitCsvLine(line);
        if (columns.length !== 4) return invalid.push(`Line ${lineNumber}: expected 4 columns`);
        const [reg, name] = columns;
        const email = columns[2].toLowerCase();
        const campus = canonical(columns[3]);
        if (!REG_RE.test(reg)) return invalid.push(`Line ${lineNumber}: reg number must look like 223007576`);
        if (!name || name.length > 100) return invalid.push(`Line ${lineNumber}: name missing or too long`);
        if (email.length > 150 || !EMAIL_RE.test(email)) return invalid.push(`Line ${lineNumber}: email format is wrong`);
        const domain = email.split('@')[1];
        if (TYPOS[domain]) return invalid.push(`Line ${lineNumber}: did you mean @${TYPOS[domain]}?`);
        if (!DOMAINS.includes(domain)) return invalid.push(`Line ${lineNumber}: email domain @${domain} is not allowed`);
        if (!campus) return invalid.push(`Line ${lineNumber}: campus must be one of ${CAMPUSES.join(', ')}`);
        if (seenReg.has(reg)) return invalid.push(`Line ${lineNumber}: reg number repeated in this file`);
        if (seenEmail.has(email)) return invalid.push(`Line ${lineNumber}: email repeated in this file`);
        seenReg.add(reg);
        seenEmail.add(email);
        valid.push([reg, name, email, campus]);
    });

    return { received: lines.length, valid, invalid };
}

module.exports = { parseStudentCsv };
