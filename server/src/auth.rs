//! Who is asking: passwords from an htpasswd file, as Thruk sites usually
//! have one, and a limit on failed logins.
//!
//! Hashes read: bcrypt (`htpasswd -B`), SHA-crypt (`$5$`, `$6$`) and
//! Apache's MD5 form (`$apr1$`, htpasswd's default). Plain crypt(3) and
//! `{SHA}` lines are not: such a user cannot log in, and is named in a
//! warning at start.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use md5::{Digest, Md5};

pub struct Htpasswd {
    path: PathBuf,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    users: HashMap<String, String>,
    read_at: Option<SystemTime>,
}

fn readable(hash: &str) -> bool {
    ["$2a$", "$2b$", "$2y$", "$5$", "$6$", "$apr1$"].iter().any(|p| hash.starts_with(p))
}

fn read(path: &Path) -> Result<(HashMap<String, String>, Vec<String>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut users = HashMap::new();
    let mut warnings = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((user, hash)) = line.split_once(':') else { continue };
        if !readable(hash) {
            warnings.push(format!(
                "{}: the password of '{user}' is in a form nuthatch does not read; set it again with htpasswd -B",
                path.display()
            ));
        }
        users.insert(user.to_string(), hash.to_string());
    }
    Ok((users, warnings))
}

/// Apache's MD5 password hash, `$apr1$<salt>$<hash>`: the MD5-crypt
/// scheme with its own marker, as its documentation describes it.
fn apr1(password: &[u8], salt: &[u8]) -> String {
    const MAGIC: &[u8] = b"$apr1$";
    let salt = &salt[..salt.len().min(8)];
    let mut alternate = Md5::new();
    alternate.update(password);
    alternate.update(salt);
    alternate.update(password);
    let alternate = alternate.finalize();
    let mut ctx = Md5::new();
    ctx.update(password);
    ctx.update(MAGIC);
    ctx.update(salt);
    let mut left = password.len();
    while left > 0 {
        ctx.update(&alternate[..left.min(16)]);
        left = left.saturating_sub(16);
    }
    let mut bits = password.len();
    while bits != 0 {
        if bits & 1 == 1 {
            ctx.update([0u8]);
        } else {
            ctx.update(&password[..1]);
        }
        bits >>= 1;
    }
    let mut last = ctx.finalize();
    for round in 0..1000 {
        let mut ctx = Md5::new();
        if round & 1 == 1 {
            ctx.update(password);
        } else {
            ctx.update(last);
        }
        if round % 3 != 0 {
            ctx.update(salt);
        }
        if round % 7 != 0 {
            ctx.update(password);
        }
        if round & 1 == 1 {
            ctx.update(last);
        } else {
            ctx.update(password);
        }
        last = ctx.finalize();
    }
    const ALPHABET: &[u8] = b"./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = String::new();
    let mut put = |mut value: u32, count: usize| {
        for _ in 0..count {
            out.push(ALPHABET[(value & 0x3f) as usize] as char);
            value >>= 6;
        }
    };
    let f = |i: usize| last[i] as u32;
    put(f(0) << 16 | f(6) << 8 | f(12), 4);
    put(f(1) << 16 | f(7) << 8 | f(13), 4);
    put(f(2) << 16 | f(8) << 8 | f(14), 4);
    put(f(3) << 16 | f(9) << 8 | f(15), 4);
    put(f(4) << 16 | f(10) << 8 | f(5), 4);
    put(f(11), 2);
    out
}

/// Compares without telling how much matched.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn verify(password: &str, hash: &str) -> bool {
    if let Some(rest) = hash.strip_prefix("$apr1$") {
        let Some((salt, wanted)) = rest.split_once('$') else { return false };
        return same(apr1(password.as_bytes(), salt.as_bytes()).as_bytes(), wanted.as_bytes());
    }
    readable(hash) && pwhash::unix::verify(password, hash)
}

/// A hash nobody's password gives, checked for a user that does not
/// exist, so that an unknown name takes as long as a wrong password.
const NOBODY: &str = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8rQyqHq6Tz9lFz8rXkQGZsVv9ZQ7mG";

impl Htpasswd {
    pub fn open(path: &Path) -> Result<(Htpasswd, Vec<String>), String> {
        let (users, warnings) = read(path)?;
        let read_at = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        Ok((Htpasswd { path: path.to_path_buf(), state: Mutex::new(State { users, read_at }) }, warnings))
    }

    fn hash_of(&self, user: &str) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        // The file is read again when it changed.
        let modified = std::fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        if modified != state.read_at {
            if let Ok((users, _)) = read(&self.path) {
                state.users = users;
                state.read_at = modified;
            }
        }
        state.users.get(user).cloned()
    }

    /// Whether the password is the user's. The hashing runs off the
    /// threads that serve requests.
    pub async fn check(&self, user: &str, password: &str) -> bool {
        let hash = self.hash_of(user);
        let password = password.to_string();
        tokio::task::spawn_blocking(move || match hash {
            Some(hash) => verify(&password, &hash),
            None => {
                let _ = verify(&password, NOBODY);
                false
            }
        })
        .await
        .unwrap_or(false)
    }
}

/// Failed logins, per user name and per address: five in five minutes,
/// then that name or address waits.
#[derive(Default)]
pub struct Limiter {
    failures: Mutex<HashMap<String, Vec<Instant>>>,
}

const WINDOW: Duration = Duration::from_secs(300);
const ALLOWED: usize = 5;

impl Limiter {
    pub fn blocked(&self, keys: &[String]) -> bool {
        let mut failures = self.failures.lock().unwrap();
        failures.retain(|_, times| {
            times.retain(|t| t.elapsed() < WINDOW);
            !times.is_empty()
        });
        keys.iter().any(|k| failures.get(k).is_some_and(|times| times.len() >= ALLOWED))
    }

    pub fn failed(&self, keys: &[String]) {
        let mut failures = self.failures.lock().unwrap();
        for key in keys {
            failures.entry(key.clone()).or_default().push(Instant::now());
        }
    }

    pub fn succeeded(&self, user_key: &str) {
        self.failures.lock().unwrap().remove(user_key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apr1_agrees_with_openssl() {
        // openssl passwd -apr1 -salt <salt> <password>
        assert!(verify("s3cret", "$apr1$Xy12AbCd$J016AtqHNNVnJHmaiyxUC1"));
        assert!(verify("a much longer password than sixteen bytes", "$apr1$ab$ZgbyBttfAvWjwKDroS41O1"));
        assert!(!verify("s3cred", "$apr1$Xy12AbCd$J016AtqHNNVnJHmaiyxUC1"));
    }

    #[tokio::test]
    async fn checks_each_form() {
        let dir = std::env::temp_dir().join(format!("nuthatch-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("htpasswd");
        let bcrypt = pwhash::bcrypt::hash("s3cret").unwrap();
        let sha = pwhash::sha512_crypt::hash("other").unwrap();
        std::fs::write(&file, format!("ann:{bcrypt}\nbob:{sha}\ncat:$apr1$Xy12AbCd$J016AtqHNNVnJHmaiyxUC1\nold:abJnggxhB/yWI\n")).unwrap();
        let (auth, warnings) = Htpasswd::open(&file).unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(auth.check("ann", "s3cret").await);
        assert!(!auth.check("ann", "wrong").await);
        assert!(auth.check("bob", "other").await);
        assert!(auth.check("cat", "s3cret").await);
        assert!(!auth.check("old", "anything").await);
        assert!(!auth.check("ghost", "s3cret").await);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn limits_failures() {
        let limiter = Limiter::default();
        let keys = vec!["user:ann".to_string(), "addr:192.0.2.9".to_string()];
        for _ in 0..ALLOWED {
            assert!(!limiter.blocked(&keys));
            limiter.failed(&keys);
        }
        assert!(limiter.blocked(&keys));
        assert!(limiter.blocked(&["user:ann".to_string()]));
        assert!(!limiter.blocked(&["user:bob".to_string()]));
        limiter.succeeded("user:ann");
        assert!(!limiter.blocked(&["user:ann".to_string()]));
    }
}
