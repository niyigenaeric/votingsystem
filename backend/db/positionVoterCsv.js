const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/;

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

function parsePositionVoterCsv(csv) {
    const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() !== '');
    if (!lines.length) return { error: 'The position voter CSV is empty.' };
    const header = splitCsvLine(lines.shift());
    if (header.length !== 1 || header[0].toLowerCase() !== 'email' || lines.length === 0) {
        return { error: 'CSV must have an email header and at least one voter email.' };
    }

    const emails = [];
    const seen = new Set();
    const invalid = [];
    lines.forEach((line, index) => {
        const lineNumber = index + 2;
        const columns = splitCsvLine(line);
        const email = (columns[0] || '').toLowerCase();
        if (columns.length !== 1) return invalid.push(`Line ${lineNumber}: expected one email column`);
        if (!email || email.length > 150 || !EMAIL_RE.test(email)) {
            return invalid.push(`Line ${lineNumber}: enter a valid email address`);
        }
        if (seen.has(email)) return invalid.push(`Line ${lineNumber}: email is repeated in this file`);
        seen.add(email);
        emails.push(email);
    });

    return { received: lines.length, emails, invalid };
}

module.exports = { parsePositionVoterCsv };
