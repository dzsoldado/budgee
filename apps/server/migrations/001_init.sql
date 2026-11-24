-- Server tables. Times are milliseconds since the Unix epoch; booleans are 0/1.

-- Every synced row as an encrypted envelope. The server merges on these columns only.
-- blob = base64(IV + AES-GCM ciphertext); tombstones (deleted = 1) carry none.
CREATE TABLE envelopes (
  "table" TEXT NOT NULL,
  id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  device TEXT NOT NULL,
  seq INTEGER NOT NULL,
  blob TEXT,
  PRIMARY KEY ("table", id),
  CHECK ((deleted = 1) = (blob IS NULL))
);
CREATE UNIQUE INDEX envelopes_seq ON envelopes (seq);

-- The global sequence: a single row, bumped in the same batch as each envelope upsert.
-- Not MAX(seq) + 1: purging the tombstone that holds the max seq would let a seq be reused.
CREATE TABLE seq_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO seq_counter (id, value) VALUES (1, 0);

-- token_hash: hex SHA-256 of the device token; the token itself is never stored.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  last_ack_seq INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);

-- code_hash: hex SHA-256 of the one-time pairing code; the code itself is never stored.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
);

-- Server settings, e.g. the Google Drive connection.
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
