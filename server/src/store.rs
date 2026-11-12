//! nuthatch's own store, one SQLite file: sessions, API tokens,
//! preferences and the audit log. Nothing about what is monitored is kept
//! here; that stays with the engines and their config files.
//!
//! Session and token secrets are kept as SHA-256 hashes, so a copy of the
//! file does not log anyone in.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

pub struct Store {
    db: Mutex<Connection>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// A new secret: 32 random bytes, in hex.
pub fn secret() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

fn hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// How long a session lasts without being used, and at most.
const IDLE: i64 = 8 * 3600;
const LONGEST: i64 = 7 * 24 * 3600;

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub user: String,
    pub csrf: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenInfo {
    pub id: i64,
    pub name: String,
    pub created: i64,
    pub last_used: Option<i64>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        let db = Connection::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        Store::prepare(db)
    }

    #[cfg(test)]
    pub fn memory() -> Store {
        Store::prepare(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn prepare(db: Connection) -> Result<Store, String> {
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS sessions (
                 hash TEXT PRIMARY KEY, user TEXT NOT NULL, csrf TEXT NOT NULL,
                 created INTEGER NOT NULL, last_seen INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS tokens (
                 id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user TEXT NOT NULL,
                 name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
             CREATE TABLE IF NOT EXISTS prefs (
                 user TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
                 PRIMARY KEY (user, key));
             CREATE TABLE IF NOT EXISTS audit (
                 id INTEGER PRIMARY KEY, time INTEGER NOT NULL, user TEXT NOT NULL,
                 backend TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS audit_time ON audit (time);",
        )
        .map_err(|e| format!("cannot prepare the store: {e}"))?;
        Ok(Store { db: Mutex::new(db) })
    }

    /// Starts a session. The answer is the cookie's secret and the session.
    pub fn new_session(&self, user: &str) -> Result<(String, Session), String> {
        let (cookie, csrf, now) = (secret(), secret(), now());
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM sessions WHERE last_seen < ?1 OR created < ?2", params![now - IDLE, now - LONGEST])
            .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT INTO sessions (hash, user, csrf, created, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![hash(&cookie), user, csrf, now],
        )
        .map_err(|e| e.to_string())?;
        Ok((cookie, Session { user: user.to_string(), csrf }))
    }

    pub fn session(&self, cookie: &str) -> Option<Session> {
        let now = now();
        let db = self.db.lock().unwrap();
        let hash = hash(cookie);
        let found = db
            .query_row(
                "SELECT user, csrf FROM sessions WHERE hash = ?1 AND last_seen >= ?2 AND created >= ?3",
                params![hash, now - IDLE, now - LONGEST],
                |row| Ok(Session { user: row.get(0)?, csrf: row.get(1)? }),
            )
            .optional()
            .ok()??;
        let _ = db.execute("UPDATE sessions SET last_seen = ?1 WHERE hash = ?2 AND last_seen < ?1 - 60", params![now, hash]);
        Some(found)
    }

    pub fn end_session(&self, cookie: &str) {
        let _ = self.db.lock().unwrap().execute("DELETE FROM sessions WHERE hash = ?1", params![hash(cookie)]);
    }

    /// Makes an API token for a user. The secret is given once, here.
    pub fn new_token(&self, user: &str, name: &str) -> Result<(i64, String), String> {
        let token = format!("nh_{}", secret());
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO tokens (hash, user, name, created) VALUES (?1, ?2, ?3, ?4)",
            params![hash(&token), user, name, now()],
        )
        .map_err(|e| e.to_string())?;
        Ok((db.last_insert_rowid(), token))
    }

    /// The user a token belongs to.
    pub fn token_user(&self, token: &str) -> Option<String> {
        let db = self.db.lock().unwrap();
        let hash = hash(token);
        let user: String = db.query_row("SELECT user FROM tokens WHERE hash = ?1", params![hash], |row| row.get(0)).optional().ok()??;
        let _ = db.execute("UPDATE tokens SET last_used = ?1 WHERE hash = ?2", params![now(), hash]);
        Some(user)
    }

    pub fn tokens(&self, user: &str) -> Vec<TokenInfo> {
        let db = self.db.lock().unwrap();
        let Ok(mut statement) = db.prepare("SELECT id, name, created, last_used FROM tokens WHERE user = ?1 ORDER BY id") else {
            return Vec::new();
        };
        statement
            .query_map(params![user], |row| {
                Ok(TokenInfo { id: row.get(0)?, name: row.get(1)?, created: row.get(2)?, last_used: row.get(3)? })
            })
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    pub fn delete_token(&self, user: &str, id: i64) -> bool {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM tokens WHERE id = ?1 AND user = ?2", params![id, user]).is_ok_and(|n| n > 0)
    }

    pub fn pref(&self, user: &str, key: &str) -> Option<String> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT value FROM prefs WHERE user = ?1 AND key = ?2", params![user, key], |row| row.get(0)).optional().ok()?
    }

    pub fn set_pref(&self, user: &str, key: &str, value: &str) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO prefs (user, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT (user, key) DO UPDATE SET value = excluded.value",
            params![user, key, value],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// Writes down what somebody did: logins, commands, refusals.
    pub fn audit(&self, user: &str, backend: &str, action: &str, detail: &str) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "INSERT INTO audit (time, user, backend, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now(), user, backend, action, detail],
        );
    }

    pub fn audit_tail(&self, limit: u32) -> Vec<(i64, String, String, String, String)> {
        let db = self.db.lock().unwrap();
        let Ok(mut statement) = db.prepare("SELECT time, user, backend, action, detail FROM audit ORDER BY id DESC LIMIT ?1") else {
            return Vec::new();
        };
        statement
            .query_map(params![limit], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_tokens_prefs() {
        let store = Store::memory();
        let (cookie, session) = store.new_session("ann").unwrap();
        assert_eq!(store.session(&cookie), Some(session));
        assert_eq!(store.session("not a cookie"), None);
        store.end_session(&cookie);
        assert_eq!(store.session(&cookie), None);

        let (id, token) = store.new_token("ann", "phone").unwrap();
        assert_eq!(store.token_user(&token).as_deref(), Some("ann"));
        assert_eq!(store.tokens("ann").len(), 1);
        assert!(!store.delete_token("bob", id));
        assert!(store.delete_token("ann", id));
        assert_eq!(store.token_user(&token), None);

        store.set_pref("ann", "theme", "\"dark\"").unwrap();
        store.set_pref("ann", "theme", "\"light\"").unwrap();
        assert_eq!(store.pref("ann", "theme").as_deref(), Some("\"light\""));
        assert_eq!(store.pref("bob", "theme"), None);

        store.audit("ann", "site", "command", "x");
        assert_eq!(store.audit_tail(5).len(), 1);
    }
}
