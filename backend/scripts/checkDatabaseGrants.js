require('dotenv').config();
const pool = require('../db/connection');

async function main() {
    const [rows] = await pool.query('SHOW GRANTS FOR CURRENT_USER()');
    const grants = rows.map(row => Object.values(row)[0]);
    grants.forEach(grant => console.log(grant));

    const database = String(process.env.DB_NAME || '').replace(/`/g, '``');
    if (!database) throw new Error('DB_NAME is required to evaluate the current grants.');
    const restrictedTables = ['votes', 'voter_receipts', 'audit_log'];
    const voterAccountTables = ['voter_accounts', 'voter_login_codes', 'voter_email_verification_tokens', 'voter_password_reset_tokens', 'election_notification_reads'];
    const voterListTables = ['students'];
    const positionVoterListTables = ['position_voters'];
    const forbidden = /\b(?:ALL PRIVILEGES|UPDATE|DELETE|ALTER|DROP)\b/i;
    const normalizedGrants = grants.map(grant => {
        const normalized = grant.replace(/`/g, '').toLowerCase();
        const onIndex = normalized.indexOf(' on ');
        return {
            original: grant,
            privileges: onIndex < 0 ? '' : normalized.slice(0, onIndex),
            scope: onIndex < 0 ? '' : normalized.slice(onIndex + 4).split(' to ')[0].trim()
        };
    });
    const broadGrant = normalizedGrants.find(grant =>
        forbidden.test(grant.privileges)
        && (grant.scope === '*.*' || grant.scope === `${database.toLowerCase()}.*`)
    );
    const tableWriteGrants = normalizedGrants.filter(grant =>
        restrictedTables.some(table => grant.scope === `${database.toLowerCase()}.${table}`)
            && forbidden.test(grant.privileges)
    );
    const voterAccountUnsafeGrant = normalizedGrants.find(grant =>
        ((grant.scope === '*.*' || grant.scope === `${database.toLowerCase()}.*`)
            && forbidden.test(grant.privileges))
        || (voterAccountTables.some(table => grant.scope === `${database.toLowerCase()}.${table}`)
            && /\b(?:ALL PRIVILEGES|DELETE|ALTER|DROP)\b/i.test(grant.privileges))
    );
    const voterListUnsafeGrant = normalizedGrants.find(grant =>
        voterListTables.some(table => grant.scope === `${database.toLowerCase()}.${table}`)
            && /\b(?:ALL PRIVILEGES|ALTER|DROP)\b/i.test(grant.privileges)
    );
    const positionVoterListUnsafeGrant = normalizedGrants.find(grant =>
        ((grant.scope === '*.*' || grant.scope === `${database.toLowerCase()}.*`)
            && /\b(?:ALL PRIVILEGES|UPDATE|DELETE|ALTER|DROP)\b/i.test(grant.privileges))
        || (positionVoterListTables.some(table => grant.scope === `${database.toLowerCase()}.${table}`)
            && /\b(?:ALL PRIVILEGES|UPDATE|ALTER|DROP)\b/i.test(grant.privileges))
    );
    const missingPermissions = [];
    for (const table of restrictedTables) {
        const relevant = normalizedGrants.filter(grant =>
            grant.scope === '*.*'
            || grant.scope === `${database.toLowerCase()}.*`
            || grant.scope === `${database.toLowerCase()}.${table}`
        );
        for (const privilege of ['SELECT', 'INSERT']) {
            if (!relevant.some(grant => /\bALL PRIVILEGES\b/i.test(grant.privileges)
                || new RegExp(`\\b${privilege}\\b`, 'i').test(grant.privileges))) {
                missingPermissions.push(`${table}: ${privilege}`);
            }
        }
    }
    for (const table of voterAccountTables) {
        const tableGrants = normalizedGrants.filter(grant =>
            grant.scope === '*.*'
            || grant.scope === `${database.toLowerCase()}.*`
            || grant.scope === `${database.toLowerCase()}.${table}`
        );
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
            if (!tableGrants.some(grant => /\bALL PRIVILEGES\b/i.test(grant.privileges)
                || new RegExp(`\\b${privilege}\\b`, 'i').test(grant.privileges))) {
                missingPermissions.push(`${table}: ${privilege}`);
            }
        }
    }
    for (const table of voterListTables) {
        const tableGrants = normalizedGrants.filter(grant =>
            grant.scope === '*.*'
            || grant.scope === `${database.toLowerCase()}.*`
            || grant.scope === `${database.toLowerCase()}.${table}`
        );
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            if (!tableGrants.some(grant => /\bALL PRIVILEGES\b/i.test(grant.privileges)
                || new RegExp(`\\b${privilege}\\b`, 'i').test(grant.privileges))) {
                missingPermissions.push(`${table}: ${privilege}`);
            }
        }
    }
    for (const table of positionVoterListTables) {
        const tableGrants = normalizedGrants.filter(grant =>
            grant.scope === '*.*'
            || grant.scope === `${database.toLowerCase()}.*`
            || grant.scope === `${database.toLowerCase()}.${table}`
        );
        for (const privilege of ['SELECT', 'INSERT', 'DELETE']) {
            if (!tableGrants.some(grant => /\bALL PRIVILEGES\b/i.test(grant.privileges)
                || new RegExp(`\\b${privilege}\\b`, 'i').test(grant.privileges))) {
                missingPermissions.push(`${table}: ${privilege}`);
            }
        }
    }
    if (broadGrant || tableWriteGrants.length || voterAccountUnsafeGrant || voterListUnsafeGrant || positionVoterListUnsafeGrant) {
        console.error('FAIL: this database account has unsafe broad privileges on a protected or voter-list table.');
        process.exitCode = 1;
        return;
    }
    if (missingPermissions.length) {
        console.error('FAIL: required table permissions are missing: ' + missingPermissions.join(', '));
        process.exitCode = 1;
        return;
    }
    console.log('Protected vote, receipt, audit, and voter-account tables have no unsafe write grants.');
    console.log('The protected tables have SELECT and INSERT privileges only.');
    console.log('Voter account, token, and notification-read tables have the SELECT, INSERT, and UPDATE privileges required by voter access.');
    console.log('The students table has SELECT, INSERT, UPDATE, and DELETE privileges, with no table-level ALL, ALTER, or DROP grant.');
    console.log('The position_voters table has SELECT, INSERT, and DELETE privileges, with no UPDATE, ALTER, or DROP grant.');
}

main()
    .catch(error => {
        console.error('Database grant check failed:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
