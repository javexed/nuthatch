//! Queries from the browser: checked against the user's rights, sent to
//! the backends, and their answers put together.
//!
//! - `POST /api/v1/query`: rows of a table as objects keyed by column,
//!   each with its `backend`. With `sort`, all matching rows are fetched,
//!   sorted here over all backends, and `offset` and `limit` cut the page;
//!   `total` is how many there are. Without `sort`, `limit` goes to each
//!   engine and `total` is not known.
//! - `POST /api/v1/stats`: `Stats:` lines, optionally grouped by columns;
//!   counts and sums of the backends are added, `min` and `max` taken.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::backend::Backend;
use crate::policy::{self, Access, Merge};
use crate::{App, Identity, refuse};

#[derive(Deserialize)]
pub struct Sort {
    column: String,
    #[serde(default)]
    desc: bool,
}

#[derive(Deserialize)]
pub struct Query {
    table: String,
    columns: Vec<String>,
    #[serde(default)]
    headers: Vec<String>,
    #[serde(default)]
    sort: Vec<Sort>,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
    /// The backends to ask, by name; all of them when empty.
    #[serde(default)]
    backends: Vec<String>,
}

#[derive(Deserialize)]
pub struct Stats {
    table: String,
    headers: Vec<String>,
    #[serde(default)]
    group_by: Vec<String>,
    #[serde(default)]
    backends: Vec<String>,
}

fn chosen(app: &App, names: &[String]) -> Result<Vec<Arc<dyn Backend>>, String> {
    if let Some(unknown) = names.iter().find(|n| !app.backends.iter().any(|b| b.name() == n.as_str())) {
        return Err(format!("no backend '{unknown}'"));
    }
    Ok(app.backends.iter().filter(|b| names.is_empty() || names.iter().any(|n| n == b.name())).cloned().collect())
}

/// The lines that limit a request to what the user may see.
fn limits(table: &str, access: &Access, user: &str) -> String {
    let mut lines = String::new();
    if *access == Access::Limited {
        lines.push_str(&format!("AuthUser: {user}\n"));
        // The engine gives the log's lines about no object (the program's
        // own, external commands) to everyone.
        if table == "log" {
            lines.push_str("Filter: host_name != \n");
        }
    }
    lines
}

/// Asks each backend. One that cannot limit what is shown is not asked
/// for a user who must be limited.
async fn ask(backends: &[Arc<dyn Backend>], request: &str, limited: bool) -> Vec<(String, Result<Vec<Value>, String>)> {
    let asks = backends.iter().map(|backend| async move {
        if limited && !backend.enforces_auth().await {
            let why = "this backend does not limit what a user sees (AuthUser); only users with the role all_hosts can use it";
            return (backend.name().to_string(), Err(why.to_string()));
        }
        (backend.name().to_string(), backend.query(request).await)
    });
    futures_util::future::join_all(asks).await
}

fn compare(a: &Value, b: &Value) -> Ordering {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        _ => match (a.as_str(), b.as_str()) {
            (Some(x), Some(y)) => x.cmp(y),
            _ => a.to_string().cmp(&b.to_string()),
        },
    }
}

pub async fn query(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>, Json(query): Json<Query>) -> Response {
    let who = app.who(&identity.user).await;
    let access = policy::access(&query.table, &who.roles);
    if let Access::Denied(why) = &access {
        return refuse(StatusCode::FORBIDDEN, why.clone());
    }
    if query.columns.is_empty() {
        return refuse(StatusCode::BAD_REQUEST, "name the columns".into());
    }
    if let Err(why) = policy::check_columns(&query.columns, &who.roles).and(policy::check_headers(&query.headers, false, &who.roles).map(|_| ())) {
        return refuse(StatusCode::BAD_REQUEST, why);
    }
    let mut keys = Vec::new();
    for sort in &query.sort {
        match query.columns.iter().position(|c| *c == sort.column) {
            Some(at) => keys.push((at, sort.desc)),
            None => return refuse(StatusCode::BAD_REQUEST, format!("sort: '{}' is not among the columns", sort.column)),
        }
    }
    let backends = match chosen(&app, &query.backends) {
        Ok(backends) => backends,
        Err(why) => return refuse(StatusCode::BAD_REQUEST, why),
    };
    let mut request = format!("GET {}\nColumns: {}\n", query.table, query.columns.join(" "));
    for line in &query.headers {
        request.push_str(line);
        request.push('\n');
    }
    request.push_str(&limits(&query.table, &access, &identity.user));
    if let (true, Some(limit)) = (keys.is_empty(), query.limit) {
        request.push_str(&format!("Limit: {}\n", query.offset + limit));
    }

    let mut errors = Map::new();
    let mut rows: Vec<(String, Vec<Value>)> = Vec::new();
    for (name, answer) in ask(&backends, &request, access == Access::Limited).await {
        match answer {
            Ok(answer) => rows.extend(answer.into_iter().filter_map(|row| match row {
                Value::Array(values) => Some((name.clone(), values)),
                _ => None,
            })),
            Err(why) => {
                errors.insert(name, json!(why));
            }
        }
    }
    let total = if keys.is_empty() { Value::Null } else { json!(rows.len()) };
    if !keys.is_empty() {
        rows.sort_by(|a, b| {
            for (at, desc) in &keys {
                let order = compare(a.1.get(*at).unwrap_or(&Value::Null), b.1.get(*at).unwrap_or(&Value::Null));
                if order != Ordering::Equal {
                    return if *desc { order.reverse() } else { order };
                }
            }
            a.0.cmp(&b.0)
        });
    }
    let page = rows.into_iter().skip(query.offset).take(query.limit.unwrap_or(usize::MAX));
    let rows: Vec<Value> = page
        .map(|(backend, values)| {
            let mut object: Map<String, Value> = query.columns.iter().cloned().zip(values).collect();
            object.insert("backend".into(), json!(backend));
            Value::Object(object)
        })
        .collect();
    Json(json!({ "rows": rows, "total": total, "errors": errors })).into_response()
}

fn merge(into: &mut Vec<f64>, more: &[f64], merges: &[Merge]) {
    if into.is_empty() {
        *into = more.to_vec();
        return;
    }
    for ((value, new), how) in into.iter_mut().zip(more).zip(merges) {
        *value = match how {
            Merge::Add => *value + new,
            Merge::Min => value.min(*new),
            Merge::Max => value.max(*new),
        };
    }
}

pub async fn stats(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>, Json(stats): Json<Stats>) -> Response {
    let who = app.who(&identity.user).await;
    let access = policy::access(&stats.table, &who.roles);
    if let Access::Denied(why) = &access {
        return refuse(StatusCode::FORBIDDEN, why.clone());
    }
    let merges = match policy::check_columns(&stats.group_by, &who.roles).and(policy::check_headers(&stats.headers, true, &who.roles)) {
        Ok(merges) if !merges.is_empty() => merges,
        Ok(_) => return refuse(StatusCode::BAD_REQUEST, "no Stats: line".into()),
        Err(why) => return refuse(StatusCode::BAD_REQUEST, why),
    };
    let backends = match chosen(&app, &stats.backends) {
        Ok(backends) => backends,
        Err(why) => return refuse(StatusCode::BAD_REQUEST, why),
    };
    let mut request = format!("GET {}\n", stats.table);
    if !stats.group_by.is_empty() {
        request.push_str(&format!("Columns: {}\n", stats.group_by.join(" ")));
    }
    for line in &stats.headers {
        request.push_str(line);
        request.push('\n');
    }
    request.push_str(&limits(&stats.table, &access, &identity.user));

    let keys = stats.group_by.len();
    let mut errors = Map::new();
    let mut by_backend = Map::new();
    // Groups in the order of their keys.
    let mut groups: BTreeMap<String, (Vec<Value>, Vec<f64>)> = BTreeMap::new();
    for (name, answer) in ask(&backends, &request, access == Access::Limited).await {
        let rows = match answer {
            Ok(rows) => rows,
            Err(why) => {
                errors.insert(name, json!(why));
                continue;
            }
        };
        let mut own = Vec::new();
        for row in rows {
            let Value::Array(values) = row else { continue };
            if values.len() < keys {
                continue;
            }
            let key: Vec<Value> = values[..keys].to_vec();
            let numbers: Vec<f64> = values[keys..].iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
            own.push(json!({ "key": key, "values": numbers }));
            let group = groups.entry(Value::Array(key.clone()).to_string()).or_insert_with(|| (key, Vec::new()));
            merge(&mut group.1, &numbers, &merges);
        }
        by_backend.insert(name, Value::Array(own));
    }
    let groups: Vec<Value> = groups.into_values().map(|(key, values)| json!({ "key": key, "values": values })).collect();
    Json(json!({ "groups": groups, "by_backend": by_backend, "errors": errors })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_and_order() {
        let mut total = Vec::new();
        let merges = [Merge::Add, Merge::Min, Merge::Max];
        merge(&mut total, &[1.0, 5.0, 5.0], &merges);
        merge(&mut total, &[2.0, 3.0, 9.0], &merges);
        assert_eq!(total, vec![3.0, 3.0, 9.0]);
        assert_eq!(compare(&json!(2), &json!(10)), Ordering::Less);
        assert_eq!(compare(&json!("b"), &json!("a")), Ordering::Greater);
        assert_eq!(limits("log", &Access::Limited, "ann"), "AuthUser: ann\nFilter: host_name != \n");
        assert_eq!(limits("hosts", &Access::All, "ann"), "");
    }
}
