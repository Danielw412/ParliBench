-- Administrator permission moves from a shared backend secret onto user accounts.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1));
-- One-time bootstrap: the founding operator account becomes the first administrator, and only
-- while no administrator exists. Every later grant goes through an existing admin in the app,
-- or through `npm run admin:grant -- <username> --remote` for recovery.
UPDATE users SET is_admin=1 WHERE username='dannywang' COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin=1);
