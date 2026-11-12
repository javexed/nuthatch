//! nuthatch: a web interface for monitoring engines that answer
//! Livestatus, such as checkd and Naemon.
//!
//! This server is what the browser talks to. It knows who is logged in and
//! what they may see and do, asks the engines over Livestatus, sends them
//! commands, tells the browser when something changed, and serves the
//! interface's files.

mod auth;
mod backend;
mod commands;
mod events;
mod livestatus;
mod policy;
mod query;
mod store;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use backend::Backend;
use commands::Target;
use policy::{Role, Roles};

const USAGE: &str = "usage: nuthatch <config file>\n\nSee README.md for the config file.";
const COOKIE: &str = "nuthatch_session";
const CSRF_HEADER: &str = "x-nuthatch-csrf";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    #[serde(default = "default_listen")]
    listen: String,
    /// The built interface (web/dist).
    web_root: Option<PathBuf>,
    /// Where nuthatch keeps sessions, tokens, preferences and its audit log.
    store: PathBuf,
    /// The users and their passwords.
    htpasswd: Option<PathBuf>,
    /// For trying things out on one machine: everyone is this user, and
    /// nobody logs in. Only with a loopback `listen`.
    dev_user: Option<String>,
    /// A proxy in front does TLS. Needed to listen beyond this machine.
    #[serde(default)]
    behind_proxy: bool,
    #[serde(default)]
    roles: HashMap<String, Vec<String>>,
    #[serde(rename = "backend", default)]
    backends: Vec<BackendConfig>,
}

fn default_listen() -> String {
    "127.0.0.1:8080".into()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackendConfig {
    name: String,
    livestatus: String,
}

/// Who a request is from.
#[derive(Clone)]
pub struct Identity {
    pub user: String,
    /// The session's cookie, when that is how they logged in.
    cookie: Option<String>,
    csrf: Option<String>,
}

/// What nuthatch knows of a user, from the config and the backends.
#[derive(Clone)]
pub struct Who {
    pub roles: Roles,
    /// Per backend: whether the contact of this name may send commands.
    can_submit: HashMap<String, bool>,
}

pub struct App {
    pub backends: Vec<Arc<dyn Backend>>,
    pub store: store::Store,
    pub events: events::Events,
    htpasswd: Option<auth::Htpasswd>,
    dev_user: Option<String>,
    roles: policy::RolesConfig,
    limiter: auth::Limiter,
    cookie_secure: bool,
    known: Mutex<HashMap<String, (Who, Instant)>>,
}

const WHO_FOR: Duration = Duration::from_secs(30);

impl App {
    /// The user's roles and command rights. The contact groups come from
    /// the backends, and are remembered for half a minute.
    pub async fn who(&self, user: &str) -> Who {
        if let Some((who, at)) = self.known.lock().unwrap().get(user) {
            if at.elapsed() < WHO_FOR {
                return who.clone();
            }
        }
        let mut groups: Vec<String> = Vec::new();
        let mut can_submit = HashMap::new();
        for backend in &self.backends {
            if let Ok(rows) = backend.query("GET contactgroups\nColumns: name members").await {
                for row in rows {
                    let member = row.get(1).and_then(Value::as_array).is_some_and(|m| m.iter().any(|n| n.as_str() == Some(user)));
                    if let (true, Some(name)) = (member, row.get(0).and_then(Value::as_str)) {
                        if !groups.iter().any(|g| g == name) {
                            groups.push(name.to_string());
                        }
                    }
                }
            }
            let request = format!("GET contacts\nColumns: can_submit_commands\nFilter: name = {user}");
            let allowed = backend.query(&request).await.ok().and_then(|rows| rows.first().and_then(|r| r.get(0)).and_then(Value::as_f64));
            can_submit.insert(backend.name().to_string(), allowed == Some(1.0));
        }
        let who = Who { roles: self.roles.resolve(user, &groups), can_submit };
        self.known.lock().unwrap().insert(user.to_string(), (who.clone(), Instant::now()));
        who
    }
}

/// A name that can be a user's: it goes into Livestatus headers and
/// command lines, so it is one line without the separators of either.
fn user_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.contains(|c: char| c.is_control() || c == ';') && name.trim() == name
}

pub fn refuse(status: StatusCode, message: String) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn load(path: &str) -> Result<(ConfigFile, Vec<Arc<dyn Backend>>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let config: ConfigFile = toml::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    if config.backends.is_empty() {
        return Err(format!("{path}: no [[backend]]"));
    }
    let mut backends: Vec<Arc<dyn Backend>> = Vec::new();
    for b in &config.backends {
        if b.name.is_empty() || backends.iter().any(|x| x.name() == b.name) {
            return Err(format!("{path}: each backend needs a name of its own"));
        }
        backends.push(Arc::new(backend::LivestatusBackend::new(&b.name, livestatus::Address::parse(&b.livestatus)?)));
    }
    Ok((config, backends))
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), None) = (args.next(), args.next()) else {
        eprintln!("{USAGE}");
        std::process::exit(2);
    };
    if let Err(err) = serve(&path).await {
        eprintln!("{err}");
        std::process::exit(2);
    }
}

async fn serve(path: &str) -> Result<(), String> {
    let (config, backends) = load(path)?;
    let addr: SocketAddr = config.listen.parse().map_err(|_| format!("listen: '{}' is not address:port", config.listen))?;
    let local = addr.ip().is_loopback();
    if !local && !config.behind_proxy {
        return Err(format!(
            "listen = {addr} reaches beyond this machine, and nuthatch speaks plain HTTP: passwords would cross the network \
             in the clear. Listen on 127.0.0.1 behind a proxy that does TLS, and set behind_proxy = true"
        ));
    }
    let htpasswd = match (&config.htpasswd, &config.dev_user) {
        (Some(_), Some(_)) => return Err("give htpasswd or dev_user, not both".into()),
        (Some(file), None) => {
            let (htpasswd, warnings) = auth::Htpasswd::open(file)?;
            for warning in warnings {
                eprintln!("warning: {warning}");
            }
            Some(htpasswd)
        }
        (None, Some(user)) => {
            if !local || config.behind_proxy || !user_name(user) {
                return Err("dev_user is for a loopback listen without a proxy only, and must be a user's name".into());
            }
            eprintln!("warning: dev_user = {user}: nobody logs in, everyone is {user}");
            None
        }
        (None, None) => return Err("give htpasswd, the file of the users and their passwords".into()),
    };
    let app = Arc::new(App {
        backends,
        store: store::Store::open(&config.store)?,
        events: events::Events::default(),
        htpasswd,
        dev_user: config.dev_user.clone(),
        roles: policy::RolesConfig::parse(&config.roles)?,
        limiter: auth::Limiter::default(),
        cookie_secure: config.behind_proxy,
        known: Mutex::new(HashMap::new()),
    });
    events::start(app.clone());

    let api = Router::new()
        .route("/api/v1/session", get(session))
        .route("/api/v1/logout", post(logout))
        .route("/api/v1/tokens", get(tokens).post(new_token))
        .route("/api/v1/tokens/{id}", delete(delete_token))
        .route("/api/v1/prefs/{key}", get(pref).put(set_pref))
        .route("/api/v1/query", post(query::query))
        .route("/api/v1/stats", post(query::stats))
        .route("/api/v1/command", post(command))
        .route("/api/v1/audit", get(audit))
        .route("/api/v1/events", get(events::stream))
        .layer(middleware::from_fn_with_state(app.clone(), identify))
        // Before anyone is known.
        .route("/api/v1/login", post(login));
    let mut router = api.fallback(|| async { refuse(StatusCode::NOT_FOUND, "no such thing".into()) });
    if let Some(root) = &config.web_root {
        // The interface's files hold nothing secret and are served to
        // anyone, so that the login page can load.
        let index = root.join("index.html");
        let files = tower_http::services::ServeDir::new(root).fallback(tower_http::services::ServeFile::new(index));
        router = Router::new().merge(router.fallback_service(files));
    }
    let router = router.with_state(app.clone());

    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("cannot listen at {addr}: {e}"))?;
    eprintln!("nuthatch {} listening at http://{addr}", env!("CARGO_PKG_VERSION"));
    let stop = async {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signals");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    };
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(stop)
        .await
        .map_err(|e| e.to_string())
}

fn cookie_of(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').filter_map(|c| c.trim().split_once('=')).find(|(name, _)| *name == COOKIE).map(|(_, value)| value.to_string())
}

/// Finds out who a request is from: an API token, a session's cookie, or
/// the `dev_user`. A request that changes something and comes with a
/// cookie must also carry the session's CSRF value in a header, which a
/// page of another site cannot read or send.
async fn identify(State(app): State<Arc<App>>, mut request: Request, next: Next) -> Response {
    let headers = request.headers();
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let identity = if let Some(token) = bearer {
        app.store.token_user(token.trim()).map(|user| Identity { user, cookie: None, csrf: None })
    } else if let Some(cookie) = cookie_of(headers) {
        app.store.session(&cookie).map(|s| Identity { user: s.user, cookie: Some(cookie), csrf: Some(s.csrf) })
    } else {
        app.dev_user.clone().map(|user| Identity { user, cookie: None, csrf: None })
    };
    let Some(identity) = identity else {
        return refuse(StatusCode::UNAUTHORIZED, "log in first".into());
    };
    let changes = !matches!(*request.method(), Method::GET | Method::HEAD);
    if let (true, Some(csrf)) = (changes, &identity.csrf) {
        let sent = headers.get(CSRF_HEADER).and_then(|v| v.to_str().ok());
        if sent != Some(csrf.as_str()) {
            return refuse(StatusCode::FORBIDDEN, format!("the header {CSRF_HEADER} is missing or wrong"));
        }
    }
    request.extensions_mut().insert(identity);
    next.run(request).await
}

#[derive(Deserialize)]
struct Login {
    user: String,
    password: String,
}

async fn login(State(app): State<Arc<App>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, Json(login): Json<Login>) -> Response {
    let Some(htpasswd) = &app.htpasswd else {
        return refuse(StatusCode::BAD_REQUEST, "nobody logs in here: dev_user is set".into());
    };
    let keys = vec![format!("user:{}", login.user), format!("addr:{}", peer.ip())];
    if app.limiter.blocked(&keys) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "too many failed logins; wait five minutes".into());
    }
    if !user_name(&login.user) || !htpasswd.check(&login.user, &login.password).await {
        app.limiter.failed(&keys);
        app.store.audit(&login.user.chars().take(128).collect::<String>(), "", "login failed", &peer.ip().to_string());
        return refuse(StatusCode::UNAUTHORIZED, "wrong user or password".into());
    }
    app.limiter.succeeded(&keys[0]);
    let (cookie, session) = match app.store.new_session(&login.user) {
        Ok(made) => made,
        Err(why) => return refuse(StatusCode::INTERNAL_SERVER_ERROR, why),
    };
    app.store.audit(&login.user, "", "login", &peer.ip().to_string());
    let secure = if app.cookie_secure { "; Secure" } else { "" };
    let set = format!("{COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800{secure}");
    ([(header::SET_COOKIE, set)], Json(json!({ "user": session.user, "csrf": session.csrf }))).into_response()
}

async fn logout(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>) -> Response {
    if let Some(cookie) = &identity.cookie {
        app.store.end_session(cookie);
    }
    let gone = format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    ([(header::SET_COOKIE, gone)], Json(json!({}))).into_response()
}

/// Who is logged in, what they may do, and how the backends are.
async fn session(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>) -> Json<Value> {
    let who = app.who(&identity.user).await;
    let system = who.roles.has(Role::SystemInformation);
    let asks = app.backends.iter().map(|b| async move {
        let status = b.query("GET status\nColumns: program_version livestatus_version program_start").await;
        let limits = b.enforces_auth().await;
        match status {
            Ok(rows) => {
                let row = rows.first().cloned().unwrap_or(Value::Null);
                let mut out = json!({ "name": b.name(), "ok": true, "limits_users": limits });
                if system {
                    out["program_version"] = row[0].clone();
                    out["livestatus_version"] = row[1].clone();
                    out["program_start"] = row[2].clone();
                }
                out
            }
            Err(err) => json!({ "name": b.name(), "ok": false, "error": if system { err } else { "not answering".into() } }),
        }
    });
    let backends = futures_util::future::join_all(asks).await;
    Json(json!({
        "user": identity.user,
        "roles": who.roles.names(),
        "can_submit_commands": who.can_submit,
        "csrf": identity.csrf,
        "version": env!("CARGO_PKG_VERSION"),
        "commands": commands::names(),
        "tables": policy::TABLES,
        "backends": backends,
    }))
}

async fn tokens(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>) -> Json<Value> {
    Json(json!(app.store.tokens(&identity.user)))
}

#[derive(Deserialize)]
struct NewToken {
    name: String,
}

async fn new_token(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>, Json(new): Json<NewToken>) -> Response {
    // A token is made by someone who logged in, not with another token.
    if identity.cookie.is_none() && app.dev_user.is_none() {
        return refuse(StatusCode::FORBIDDEN, "log in with a password to make a token".into());
    }
    let name: String = new.name.chars().filter(|c| !c.is_control()).take(64).collect();
    match app.store.new_token(&identity.user, &name) {
        Ok((id, token)) => {
            app.store.audit(&identity.user, "", "token made", &name);
            Json(json!({ "id": id, "name": name, "token": token })).into_response()
        }
        Err(why) => refuse(StatusCode::INTERNAL_SERVER_ERROR, why),
    }
}

async fn delete_token(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>, Path(id): Path<i64>) -> Response {
    if app.store.delete_token(&identity.user, id) {
        app.store.audit(&identity.user, "", "token deleted", &id.to_string());
        Json(json!({})).into_response()
    } else {
        refuse(StatusCode::NOT_FOUND, "no such token".into())
    }
}

fn pref_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

async fn pref(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>, Path(key): Path<String>) -> Response {
    match app.store.pref(&identity.user, &key).and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
        Some(value) => Json(value).into_response(),
        None => Json(Value::Null).into_response(),
    }
}

async fn set_pref(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>, Path(key): Path<String>, Json(value): Json<Value>) -> Response {
    let text = value.to_string();
    if !pref_key(&key) || text.len() > 256 * 1024 {
        return refuse(StatusCode::BAD_REQUEST, "a preference has a short plain name and at most 256 kB".into());
    }
    match app.store.set_pref(&identity.user, &key, &text) {
        Ok(()) => Json(json!({})).into_response(),
        Err(why) => refuse(StatusCode::INTERNAL_SERVER_ERROR, why),
    }
}

async fn audit(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>) -> Response {
    if !app.who(&identity.user).await.roles.has(Role::SystemInformation) {
        return refuse(StatusCode::FORBIDDEN, "the audit log needs the role system_information".into());
    }
    let rows: Vec<Value> = app
        .store
        .audit_tail(500)
        .into_iter()
        .map(|(time, user, backend, action, detail)| json!({ "time": time, "user": user, "backend": backend, "action": action, "detail": detail }))
        .collect();
    Json(json!(rows)).into_response()
}

/// Whether the user, as a contact, sees what a command is about: asked of
/// the engine with `AuthUser`, the way the lists are.
async fn sees(backend: &dyn Backend, user: &str, target: &Target) -> bool {
    let request = match target {
        Target::Host(host) => format!("GET hosts\nFilter: name = {host}\nAuthUser: {user}\nStats: state >= 0"),
        Target::Service(host, service) => {
            format!("GET services\nFilter: host_name = {host}\nFilter: description = {service}\nAuthUser: {user}\nStats: state >= 0")
        }
        Target::Downtime { id, service } => {
            format!("GET downtimes\nFilter: id = {id}\nFilter: is_service = {}\nAuthUser: {user}\nStats: id >= 0", *service as u8)
        }
        Target::Comment { id, service } => {
            format!("GET comments\nFilter: id = {id}\nFilter: is_service = {}\nAuthUser: {user}\nStats: id >= 0", *service as u8)
        }
    };
    let count = backend.query(&request).await.ok().and_then(|rows| rows.first().and_then(|r| r.get(0)).and_then(Value::as_f64));
    count == Some(1.0)
}

async fn command(State(app): State<Arc<App>>, Extension(identity): Extension<Identity>, Json(command): Json<commands::Command>) -> Response {
    let user = &identity.user;
    let Some(backend) = app.backends.iter().find(|b| b.name() == command.backend) else {
        return refuse(StatusCode::BAD_REQUEST, format!("no backend '{}'", command.backend));
    };
    let checked = match command.check(user, store::now()) {
        Ok(checked) => checked,
        Err(why) => return refuse(StatusCode::BAD_REQUEST, why),
    };
    let who = app.who(user).await;
    let service = checked.target.is_service();
    let by_role = who.roles.has(Role::AllHostCommands) || (service && who.roles.has(Role::AllServiceCommands));
    let allowed = if who.roles.has(Role::ReadOnly) {
        Err("this user is read-only")
    } else if by_role {
        Ok(())
    } else if !who.can_submit.get(backend.name()).copied().unwrap_or(false) {
        Err("this user is not a contact that may send commands (can_submit_commands)")
    } else if !backend.enforces_auth().await {
        Err("this backend does not limit what a user sees (AuthUser); commands need the role all_host_commands here")
    } else if !sees(backend.as_ref(), user, &checked.target).await {
        Err("not one of this user's hosts or services")
    } else {
        Ok(())
    };
    if let Err(why) = allowed {
        app.store.audit(user, backend.name(), "command refused", &format!("{}: {why}", checked.line));
        return refuse(StatusCode::FORBIDDEN, why.into());
    }
    match backend.command(&checked.line).await {
        Ok(()) => {
            app.store.audit(user, backend.name(), "command", &checked.line);
            Json(json!({ "sent": checked.line })).into_response()
        }
        Err(why) => refuse(StatusCode::BAD_GATEWAY, why),
    }
}
