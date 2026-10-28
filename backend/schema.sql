CREATE DATABASE IF NOT EXISTS voting_system
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE voting_system;

CREATE TABLE IF NOT EXISTS students (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reg_number VARCHAR(20) NOT NULL,
  username VARCHAR(50) NULL,
  full_name VARCHAR(100) NOT NULL,
  contact_email VARCHAR(150) NOT NULL,
  university_position VARCHAR(100) NULL,
  campus VARCHAR(50) NULL,
  password_hash VARCHAR(255) NULL,
  role ENUM('voter', 'admin', 'auditor') NOT NULL DEFAULT 'voter',
  is_activated TINYINT(1) NOT NULL DEFAULT 0,
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_students_reg_number (reg_number),
  UNIQUE KEY uq_students_username (username),
  UNIQUE KEY uq_students_email (contact_email),
  KEY idx_students_campus_role (campus, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS voter_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reg_number VARCHAR(20) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_voter_accounts_reg_number (reg_number),
  UNIQUE KEY uq_voter_accounts_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS positions (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(100) NOT NULL,
  campus VARCHAR(50) NOT NULL DEFAULT '',
  status ENUM('setup', 'open', 'closed') NOT NULL DEFAULT 'setup',
  candidate_entry_deadline DATETIME NULL,
  candidate_entry_closed TINYINT(1) NOT NULL DEFAULT 0,
  voting_starts_at DATETIME NULL,
  voting_ends_at DATETIME NULL,
  results_published TINYINT(1) NOT NULL DEFAULT 0,
  published_at DATETIME NULL,
  results_hash CHAR(64) NULL,
  archived_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_positions_title_campus (title, campus),
  KEY idx_positions_status_end (status, voting_ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS candidates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(100) NOT NULL,
  reg_number VARCHAR(20) NULL,
  position_id INT NOT NULL,
  image_path VARCHAR(255) NOT NULL,
  manifesto TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_candidates_position_reg (position_id, reg_number),
  UNIQUE KEY uq_candidates_id_position (id, position_id),
  KEY idx_candidates_position_name (position_id, full_name),
  CONSTRAINT fk_candidates_position FOREIGN KEY (position_id) REFERENCES positions(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS votes (
  id CHAR(32) NOT NULL,
  position_id INT NOT NULL,
  candidate_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY idx_votes_position_candidate (position_id, candidate_id),
  CONSTRAINT fk_votes_position FOREIGN KEY (position_id) REFERENCES positions(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_votes_candidate_position FOREIGN KEY (candidate_id, position_id)
    REFERENCES candidates(id, position_id) ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS voter_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id INT UNSIGNED NOT NULL,
  position_id INT NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_voter_receipt_student_position (student_id, position_id),
  UNIQUE KEY uq_voter_receipt_hash (receipt_hash),
  KEY idx_voter_receipts_position (position_id),
  CONSTRAINT fk_voter_receipts_student FOREIGN KEY (student_id) REFERENCES students(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_voter_receipts_position FOREIGN KEY (position_id) REFERENCES positions(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id INT UNSIGNED NOT NULL,
  purpose ENUM('activation', 'admin_login') NOT NULL DEFAULT 'activation',
  code_hash VARCHAR(255) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_otp_student_purpose_expiry (student_id, purpose, expires_at, used),
  CONSTRAINT fk_otp_codes_student FOREIGN KEY (student_id) REFERENCES students(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(64) NOT NULL,
  actor VARCHAR(100) NOT NULL,
  details TEXT NOT NULL,
  prev_hash CHAR(64) NOT NULL,
  entry_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_migrations (
  version VARCHAR(100) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO app_migrations (version) VALUES ('20261026_kigali_utc_schedule');

-- Execute these grants as the database administrator after confirming the account host:
-- GRANT SELECT, INSERT ON voting_system.votes TO 'voting_app'@'localhost';
-- GRANT SELECT, INSERT ON voting_system.voter_receipts TO 'voting_app'@'localhost';
-- GRANT SELECT, INSERT ON voting_system.audit_log TO 'voting_app'@'localhost';
