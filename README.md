# University of Rwanda Student Voting System

## Local setup

1. Install Node.js and MySQL. Create a local environment file from `backend/.env.example` and set the database connection values.
2. Generate a unique session signing key with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Put the output in `JWT_SECRET`. Do not reuse the example placeholder or commit `.env`.
3. For a new database, execute `backend/schema.sql` as a database administrator. Set `DB_NAME` to `voting_system`, or change the database name in the schema to match the environment.
4. For an existing database, make a verified backup first, then run `npm run db:migrate` from `backend`. The upgrade converts existing Kigali-local candidate/start schedule values to UTC once, adds the candidate manifesto column, administrator username/university-position fields, position archive, voter sign-in, email-verification, password-reset, and per-user election-notification read-state tables, and copies existing administrator registration numbers into the username field; newly created schedules use UTC storage.
5. Run `npm install`, then `npm run dev` from `backend`.

Voter account email confirmation, password reset, and voter/administrator one-time codes require SMTP in production. New voters must click the link sent after registration before they can sign in; the link expires after 24 hours. The **Forgot your password?** link on voter sign-in sends a one-time reset link to the email address already saved on the matching voter account. Reset links expire after 1 hour; after setting a new password, the voter can sign in with it as usual. Voters receive a separate one-time code on each sign-in, and administrators also receive a one-time sign-in code. In development, when SMTP is not configured, emails are written to the server console for local testing only. Set `APP_BASE_URL` to the app's public origin in production so email links point to the deployed site; local development defaults to `http://localhost:5000`.

The notification bell shows upcoming positions starting within 24 hours. Each signed-in account can mark a notification as read; its unread badge count is then updated and the read state is saved for that account.

Create a new administrator from `backend` after configuring the database:

```powershell
node .\scripts\createAdmin.js "username" "Full Name" "admin@example.com" "University position" "AtLeast10Characters"
```

Administrators sign in with that username. The university position is stored on the account for future use and is not currently displayed in the panel. For an existing database, run `npm run db:migrate` before creating an administrator.

Administrators can edit a position's name, campus, candidate-entry deadline, and voting schedule from **Manage each position** before voting starts. If its scheduled start passes before voting is opened, administrators can reschedule the unopened election as long as no votes have been recorded; this changes the dates only and preserves its existing candidates. Candidate details remain locked until the new scheduled start. Edits update the existing position, so its candidates remain linked. Administrators can also archive closed positions from **Manage each position**. Archiving hides a position from active administration lists and voter ballots, but preserves candidates, votes, results, and audit history. Archived positions can be restored; permanently deleting election records is not supported.

## Voting and schedules

- Schedule form values are Rwanda local time (`Africa/Kigali`, UTC+02:00); the server stores and compares schedule dates in UTC.
- An administrator must open a position after its scheduled start. An open position is automatically closed at its scheduled end; administrators may close it sooner.
- Anyone may create a voter account using a unique registration number, full name, email, and password. The account remains unable to sign in until the user clicks the confirmation link sent to that email. Voter sign-in asks for the registration number, the account email, and password; the submitted email must match the account. Voters can sign in even when their account does not match the official roster, but the ballot page reports their eligibility and the server prevents ineligible voting. Existing activated voter accounts are copied into the voter-account table during `npm run db:migrate` and must confirm their email before signing in.
- Administrators provide each candidate's manifesto, name, and photo. Voters can browse candidate profiles across election positions even before voting opens or when their account is not eligible; vote controls are enabled only for eligible voters in open positions.
- After email confirmation, voter sign-in requires a one-time code sent to the email on the voter's account. Voter eligibility is separate: eligible voters must also enter a one-time code sent to the email stored on their official voter-list record using **Verify your account**. The registration email supplied by the voter is never used for official-list activation. These checks demonstrate access to their respective mailboxes, but do not replace university SSO or prove who controls a compromised mailbox.
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
GRANT SELECT, INSERT, UPDATE ON voting_system.voter_login_codes TO 'voting_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON voting_system.voter_email_verification_tokens TO 'voting_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON voting_system.voter_password_reset_tokens TO 'voting_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON voting_system.election_notification_reads TO 'voting_app'@'localhost';
SHOW GRANTS FOR 'voting_app'@'localhost';
```

For an existing database updated manually in MySQL Workbench, after taking a backup, create the token and notification-read tables and grant access. No new account column is required:

```sql
CREATE TABLE IF NOT EXISTS voting_system.voter_email_verification_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  voter_account_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_voter_email_verification_token_hash (token_hash),
  KEY idx_voter_email_verification_account (voter_account_id, expires_at, used),
  CONSTRAINT fk_voter_email_verification_account
    FOREIGN KEY (voter_account_id) REFERENCES voting_system.voter_accounts(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE ON voting_system.voter_email_verification_tokens
  TO 'voting_app'@'localhost';

CREATE TABLE IF NOT EXISTS voting_system.voter_password_reset_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  voter_account_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_voter_password_reset_token_hash (token_hash),
  KEY idx_voter_password_reset_account (voter_account_id, expires_at, used),
  CONSTRAINT fk_voter_password_reset_account
    FOREIGN KEY (voter_account_id) REFERENCES voting_system.voter_accounts(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE ON voting_system.voter_password_reset_tokens
  TO 'voting_app'@'localhost';

CREATE TABLE IF NOT EXISTS voting_system.election_notification_reads (
  user_role ENUM('voter', 'admin', 'auditor') NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  position_id INT NOT NULL,
  read_at DATETIME NOT NULL,
  PRIMARY KEY (user_role, user_id, position_id),
  KEY idx_election_notification_reads_position (position_id),
  CONSTRAINT fk_election_notification_reads_position
    FOREIGN KEY (position_id) REFERENCES voting_system.positions(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE ON voting_system.election_notification_reads
  TO 'voting_app'@'localhost';
```

The verification and password-reset tables store only token hashes, expiry, and one-time status; the links themselves are never stored in plain text in MySQL. `used = 1` marks a spent or invalidated token. Notification read state is stored per user and position. Replace the database/user/host names in the statements if your setup differs. If broader privileges were granted previously, revoke them before applying these table grants. Run `npm run db:check-grants` from `backend` using the application's database account; it verifies read/insert access for votes, receipts, and audit entries, and read/insert/update access on voter account, token, and notification-read tables.

Run `npm run db:verify-audit` from `backend` to recompute the entire audit hash chain. The auditor/admin interface also provides read-only, paginated audit entries.

For an existing database, take and verify a backup before applying the vote-anonymity migration. From `backend`, run `npm run db:migrate-anonymity -- --confirm-backup`. The migration checks for triggers on the vote tables and stops if any are present; review and resolve those triggers before rerunning it.

## Production deployment

- Set `NODE_ENV=production`, use a unique random `JWT_SECRET`, configure SMTP and `APP_BASE_URL` to the public HTTPS origin, and set `TRUST_PROXY_HOPS` to the actual trusted TLS proxy count. The server redirects HTTP to HTTPS and sets HSTS; TLS termination must be configured at the trusted proxy.
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
