//! A backend: one engine, as nuthatch reaches it. Today that is a
//! Livestatus socket; a nuthatch at another site, over HTTPS, comes later
//! and fits the same trait.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::Value;

use crate::livestatus::{self, Address};

#[async_trait]
pub trait Backend: Send + Sync {
    fn name(&self) -> &str;
    /// A Livestatus request, without the lines that end it. Rows come back.
    async fn query(&self, request: &str) -> Result<Vec<Value>, String>;
    /// An external command line, `[time] NAME;arguments`.
    async fn command(&self, line: &str) -> Result<(), String>;
    /// Whether the engine limits what a query's `AuthUser` sees. Asked of
    /// the engine itself and remembered for a minute; an engine that
    /// cannot be asked counts as one that does not.
    async fn enforces_auth(&self) -> bool;
}

pub struct LivestatusBackend {
    name: String,
    address: Address,
    probed: Mutex<Option<(bool, Instant)>>,
}

const PROBE_EVERY: Duration = Duration::from_secs(60);

impl LivestatusBackend {
    pub fn new(name: &str, address: Address) -> LivestatusBackend {
        LivestatusBackend { name: name.to_string(), address, probed: Mutex::new(None) }
    }

    /// Asks for the hosts as a user that cannot exist. An engine that
    /// shows such a user any host does not enforce `AuthUser`. One with no
    /// hosts at all cannot be told apart, and counts as not enforcing.
    async fn probe(&self) -> bool {
        let nobody = format!("nuthatch-probe-{}", crate::store::secret());
        let count = |rows: Vec<Value>| rows.first().and_then(|r| r.get(0)).and_then(Value::as_f64).unwrap_or(-1.0);
        let all = livestatus::query(&self.address, "GET hosts\nStats: state >= 0").await.map(count);
        let limited = livestatus::query(&self.address, &format!("GET hosts\nAuthUser: {nobody}\nStats: state >= 0")).await.map(count);
        matches!((all, limited), (Ok(all), Ok(limited)) if all > 0.0 && limited == 0.0)
    }
}

#[async_trait]
impl Backend for LivestatusBackend {
    fn name(&self) -> &str {
        &self.name
    }

    async fn query(&self, request: &str) -> Result<Vec<Value>, String> {
        livestatus::query(&self.address, request).await
    }

    async fn command(&self, line: &str) -> Result<(), String> {
        livestatus::command(&self.address, line).await
    }

    async fn enforces_auth(&self) -> bool {
        if let Some((answer, at)) = *self.probed.lock().unwrap() {
            if at.elapsed() < PROBE_EVERY {
                return answer;
            }
        }
        let answer = self.probe().await;
        *self.probed.lock().unwrap() = Some((answer, Instant::now()));
        answer
    }
}
