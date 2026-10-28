# University of Rwanda Student Voting System

## Local setup

1. Install Node.js and MySQL. Create a local environment file from `backend/.env.example` and set the database connection values.
2. Generate a unique session signing key with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Put the output in `JWT_SECRET`. Do not reuse the example placeholder or commit `.env`.
3. For a new database, execute `backend/schema.sql` as a database administrator. Set `DB_NAME` to `voting_system`, or change the database name in the schema to match the environment.
4. For an existing database, make a verified backup first, then run `npm run db:migrate` from `backend`. The upgrade converts existing Kigali-local candidate/start schedule values to UTC once, adds the candidate manifesto column, administrator username/university-position fields, and position archive field, and copies existing administrator registration numbers into the username field; newly created schedules use UTC storage.
5. Run `npm install`, then `npm run dev` from `backend`.

Student and administrator one-time codes require SMTP in production. In development, when SMTP is not configured, codes are written to the server console for local testing only.

Create a new administrator from `backend` after configuring the database:

```powershell
node .\scripts\createAdmin.js "username" "Full Name" "admin@example.com" "University position" "AtLeast10Characters"
```

Administrators sign in with that username. The university position is stored on the account for future use and is not currently displayed in the panel. For an existing database, run `npm run db:migrate` before creating an administrator.

Administrators can archive closed positions from **Manage each position**. Archiving hides a position from active administration lists and voter ballots, but preserves candidates, votes, results, and audit history. Archived positions can be restored; permanently deleting election records is not supported.

## Voting and schedules

- Schedule form values are Rwanda local time (`Africa/Kigali`, UTC+02:00); the server stores and compares schedule dates in UTC.
- An administrator must open a position after its scheduled start. An open position is automatically closed at its scheduled end; administrators may close it sooner.
- Anyone may create a voter account using a unique registration number, full name, email, and password. At sign-in, submitted identity details must match the account. Voters can sign in even when their account does not match the official roster, but the ballot page reports their eligibility and the server prevents ineligible voting. Existing activated voter accounts are copied into the voter-account table during `npm run db:migrate`.
- Administrators provide each candidate's manifesto, name, and photo. Voters can browse candidate profiles across election positions even before voting opens or when their account is not eligible; vote controls are enabled only for eligible voters in open positions.
- Roster matching checks that submitted details correspond to an eligible record; it does not prove that the person entering them is the real student. Email ownership verification is not configured and no registration email is sent. A person who knows another voter's roster details could impersonate them, so use university SSO or a one-time code sent to the official email before relying on this for a real election.
- Students need an assigned campus and may cast one ballot for each eligible position. The candidate choice is stored in `votes`; the separate `voter_receipts` row prevents repeat voting without a direct database link to the choice. Votes carry a random identifier and no timestamp, and receipts store no date, so a choice cannot be matched to a voter by time or order.
- A receipt code is displayed once after a successful vote. The database stores only its SHA-256 hash.
- This is not cryptographic ballot secrecy: a privileged operator with access to application/server logs or other timing information may still correlate voting activity. The receipt proves only that a vote was recorded for a position; it does not prove which candidate was selected.
- Candidate images are stored under `UPLOAD_DIR` (the development default is `backend/uploads/candidates`). EXIF/IPTC, PNG text/time, and WebP EXIF/XMP metadata are removed before storage.

## Database privileges and audit checks

Use a database administrator account for schema changes. The application account must not have update/delete privileges on votes, receipts, or audit entries. For MySQL account host `localhost`, an administrator can grant the required restricted permissions with:

```sql
GRANT SELECT, INSERT ON voting_system.votes TO 'voting_app'@'localhost';
GRANT SELECT, INSERT ON voting_system.voter_receipts TO 'voting_app'@'localhost';
GRANT SELECT, INSERT ON voting_system.audit_log TO 'voting_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON voting_system.voter_accounts TO 'voting_app'@'localhost';
SHOW GRANTS FOR 'voting_app'@'localhost';
```

If broader privileges were granted previously, revoke them before applying these table grants. Run `npm run db:check-grants` from `backend` using the application's database account; it verifies read/insert access for votes, receipts, and audit entries, the read/insert/update access voter sign-in needs on `voter_accounts`, and fails for unsafe broad or protected-table grants.

Run `npm run db:verify-audit` from `backend` to recompute the entire audit hash chain. The auditor/admin interface also provides read-only, paginated audit entries.

For an existing database, take and verify a backup before applying the vote-anonymity migration. From `backend`, run `npm run db:migrate-anonymity -- --confirm-backup`. The migration checks for triggers on the vote tables and stops if any are present; review and resolve those triggers before rerunning it.

## Production deployment

- Set `NODE_ENV=production`, use a unique random `JWT_SECRET`, configure SMTP, and set `TRUST_PROXY_HOPS` to the actual trusted TLS proxy count. The server redirects HTTP to HTTPS and sets HSTS; TLS termination must be configured at the trusted proxy.
- Set `UPLOAD_DIR` to a persistent mounted volume. The process intentionally refuses production startup without this setting so candidate photos are not silently written to an ephemeral container disk. Back up this volume together with the database.
- Use a managed MySQL service with automated point-in-time/database backups. Before schema or release changes, take an encrypted off-host backup and periodically test restoring it. A logical backup can be created with `mysqldump --single-transaction --routines --triggers`; provide credentials through a protected MySQL option file rather than command-line arguments, and keep backup files out of the repository.
- Keep `.env`, database backups, and candidate uploads out of source control. Do not expose the database directly to the public internet.
- The Content Security Policy allows same-origin assets and per-response nonces for the current inline page scripts; inline JavaScript is not permitted without the nonce.

## Tests

From `backend`, run:

```powershell
npm test
```

The test suite covers duplicate-vote rejection, campus eligibility, closed positions, schedule timezone conversion, and photo metadata stripping.
