-- When the server last stored each envelope, in milliseconds since the Unix epoch, from the
-- server's clock. The daily cleanup purges tombstones by it; client hlc wall times are not
-- trusted for that. NULL is never purged.
ALTER TABLE envelopes ADD COLUMN updated_at INTEGER;

-- Rows stored before this column existed count as stored now, so none is purged early.
UPDATE envelopes SET updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;

-- The cleanup looks only at tombstones.
CREATE INDEX envelopes_tombstones ON envelopes (updated_at) WHERE deleted = 1;
