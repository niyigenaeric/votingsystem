require('dotenv').config();
const pool = require('../db/connection');

async function main() {
    const [rows] = await pool.query('SHOW GRANTS FOR CURRENT_USER()');
    const grants = rows.map(row => Object.values(row)[0]);
    grants.forEach(grant => console.log(grant));

    const database = String(process.env.DB_NAME || '').replace(/`/g, '``');
    if (!database) throw new Error('DB_NAME is required to evaluate the current grants.');
    const restrictedTables = ['votes', 'voter_receipts', 'audit_log'];
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
    if (broadGrant || tableWriteGrants.length) {
        console.error('FAIL: this database account can modify a protected vote/receipt/audit table.');
        process.exitCode = 1;
        return;
    }
    if (missingPermissions.length) {
        console.error('FAIL: required protected-table permissions are missing: ' + missingPermissions.join(', '));
        process.exitCode = 1;
        return;
    }
    console.log('No UPDATE, DELETE, ALTER, or DROP grant was found for the protected tables.');
    console.log('The protected tables have SELECT and INSERT privileges only.');
}

main()
    .catch(error => {
        console.error('Database grant check failed:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
