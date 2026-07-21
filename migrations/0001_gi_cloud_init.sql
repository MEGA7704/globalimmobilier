PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gi_app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE IF NOT EXISTS gi_companies (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  public_count INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','business')),
  subscription_start TEXT NOT NULL,
  subscription_end TEXT NOT NULL,
  subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active','suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS gi_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Gestionnaire',
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES gi_companies(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_gi_accounts_company ON gi_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_gi_accounts_username ON gi_accounts(username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS gi_company_state_meta (
  company_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES gi_companies(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS gi_company_state_chunks (
  company_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (company_id, version, chunk_index),
  FOREIGN KEY (company_id) REFERENCES gi_companies(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_gi_state_chunks_lookup
  ON gi_company_state_chunks(company_id, version, chunk_index);
