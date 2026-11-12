//! Telling the browser that something changed.
//!
//! Neither Naemon nor checkd pushes anything over Livestatus, so while at
//! least one browser listens, each backend is asked every two seconds for
//! a few sums that move when states, acknowledgements, downtimes or
//! comments do. When they moved, every listener gets
//! `event: changed` with `{"backend": name}`, and `event: backend` with
//! `{"name", "ok"}` when a backend stops or starts answering.
//!
//! The events carry nothing of what changed: the browser asks again
//! through the queries, which decide what this user may see. Results that
//! change no state (a new output, a new last check) send nothing; the
//! browser reads those on a timer of its own.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use serde_json::json;
use tokio::sync::broadcast;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::App;
use crate::backend::Backend;

pub struct Events {
    send: broadcast::Sender<(String, String)>,
}

impl Default for Events {
    fn default() -> Events {
        Events { send: broadcast::channel(256).0 }
    }
}

const OBJECTS: &str = "Stats: max last_state_change\nStats: max last_hard_state_change\nStats: sum state\n\
                       Stats: sum acknowledged\nStats: sum scheduled_downtime_depth\nStats: sum notifications_enabled\n\
                       Stats: sum active_checks_enabled\nStats: state >= 0";
const ENTRIES: &str = "Stats: max id\nStats: id >= 0";

/// What a backend looks like now, as text to compare with last time.
async fn fingerprint(backend: &dyn Backend) -> Result<String, String> {
    let mut out = String::new();
    for request in [
        "GET status\nColumns: program_start".to_string(),
        format!("GET hosts\n{OBJECTS}"),
        format!("GET services\n{OBJECTS}"),
        format!("GET comments\n{ENTRIES}"),
        format!("GET downtimes\n{ENTRIES}"),
    ] {
        let rows = backend.query(&request).await?;
        out.push_str(&serde_json::Value::Array(rows).to_string());
    }
    Ok(out)
}

pub fn start(app: Arc<App>) {
    for backend in app.backends.clone() {
        let app = app.clone();
        // One task per backend: one that does not answer holds up no other.
        tokio::spawn(async move {
            let mut last: Option<Result<String, ()>> = None;
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if app.events.send.receiver_count() == 0 {
                    last = None;
                    continue;
                }
                let now = fingerprint(backend.as_ref()).await.map_err(|_| ());
                if let Some(before) = &last {
                    if before.is_ok() != now.is_ok() {
                        let data = json!({ "name": backend.name(), "ok": now.is_ok() }).to_string();
                        let _ = app.events.send.send(("backend".into(), data));
                    } else if *before != now {
                        let data = json!({ "backend": backend.name() }).to_string();
                        let _ = app.events.send.send(("changed".into(), data));
                    }
                }
                last = Some(now);
            }
        });
    }
}

pub async fn stream(State(app): State<Arc<App>>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let inbox = BroadcastStream::new(app.events.send.subscribe());
    let events = inbox.map(|item| {
        Ok(match item {
            Ok((kind, data)) => Event::default().event(kind).data(data),
            // Too slow to keep up: told to read everything again.
            Err(_) => Event::default().event("changed").data("{}"),
        })
    });
    Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
