//! A Livestatus client: one request per connection, over a Unix socket or
//! TCP, with the answer in JSON behind a fixed16 response header.

use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Where an engine answers.
#[derive(Clone, Debug)]
pub enum Address {
    Unix(String),
    Tcp(String),
}

impl Address {
    pub fn parse(text: &str) -> Result<Address, String> {
        if let Some(path) = text.strip_prefix("unix:") {
            Ok(Address::Unix(path.to_string()))
        } else if let Some(addr) = text.strip_prefix("tcp:") {
            Ok(Address::Tcp(addr.to_string()))
        } else if text.starts_with('/') {
            Ok(Address::Unix(text.to_string()))
        } else {
            Err(format!("'{text}': give unix:<socket> or tcp:<host:port>"))
        }
    }
}

const LIMIT: Duration = Duration::from_secs(15);
/// Answers larger than this are refused, so that one query cannot take
/// the server's memory.
const MAX_ANSWER: usize = 64 << 20;

async fn exchange<S: AsyncReadExt + AsyncWriteExt + Unpin>(mut stream: S, request: &str) -> Result<Vec<u8>, String> {
    stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut head = [0u8; 16];
    stream.read_exact(&mut head).await.map_err(|e| format!("no answer: {e}"))?;
    let head = String::from_utf8_lossy(&head).to_string();
    let code: u16 = head.get(0..3).and_then(|c| c.parse().ok()).ok_or(format!("not a Livestatus answer: {head:?}"))?;
    let len: usize = head.get(4..15).and_then(|l| l.trim().parse().ok()).ok_or(format!("not a Livestatus answer: {head:?}"))?;
    if len > MAX_ANSWER {
        return Err(format!("the answer is too large ({len} bytes)"));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await.map_err(|e| e.to_string())?;
    if code != 200 {
        return Err(format!("{code}: {}", String::from_utf8_lossy(&body).trim()));
    }
    Ok(body)
}

/// Sends one request (without the empty line that ends it) and gives the
/// answer's rows.
pub async fn query(address: &Address, request: &str) -> Result<Vec<Value>, String> {
    let full = format!("{}\nOutputFormat: json\nResponseHeader: fixed16\nKeepAlive: off\n\n", request.trim_end());
    let work = async {
        match address {
            Address::Unix(path) => {
                let stream = tokio::net::UnixStream::connect(path).await.map_err(|e| format!("{path}: {e}"))?;
                exchange(stream, &full).await
            }
            Address::Tcp(addr) => {
                let stream = tokio::net::TcpStream::connect(addr).await.map_err(|e| format!("{addr}: {e}"))?;
                exchange(stream, &full).await
            }
        }
    };
    let body = tokio::time::timeout(LIMIT, work).await.map_err(|_| "no answer within 15 seconds".to_string())??;
    match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Array(rows)) => Ok(rows),
        Ok(_) => Err("the answer is not a list".into()),
        Err(e) => Err(format!("the answer is not JSON: {e}")),
    }
}

/// Sends an external command. Livestatus gives no answer to one.
pub async fn command(address: &Address, line: &str) -> Result<(), String> {
    let full = format!("COMMAND {line}\n\n");
    let work = async {
        match address {
            Address::Unix(path) => {
                let mut stream = tokio::net::UnixStream::connect(path).await.map_err(|e| format!("{path}: {e}"))?;
                stream.write_all(full.as_bytes()).await.map_err(|e| e.to_string())
            }
            Address::Tcp(addr) => {
                let mut stream = tokio::net::TcpStream::connect(addr).await.map_err(|e| format!("{addr}: {e}"))?;
                stream.write_all(full.as_bytes()).await.map_err(|e| e.to_string())
            }
        }
    };
    tokio::time::timeout(LIMIT, work).await.map_err(|_| "no connection within 15 seconds".to_string())?
}
