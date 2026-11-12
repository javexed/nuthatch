//! The external commands nuthatch sends, each with the kind of every
//! argument, so that the server knows which object a command is about and
//! can check it before anything reaches an engine.
//!
//! The author of acknowledgements, downtimes and comments is the user who
//! is logged in, whatever the browser sent.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Arg {
    Host,
    Service,
    /// A whole number.
    Int,
    /// 0 or 1.
    Flag,
    /// Seconds since 1970.
    Time,
    Author,
    /// Free text, the last argument only.
    Text,
    Id,
}

/// What a command is about.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Host(String),
    Service(String, String),
    Downtime { id: u64, service: bool },
    Comment { id: u64, service: bool },
}

impl Target {
    /// Whether it takes the rights for services, not for hosts.
    pub fn is_service(&self) -> bool {
        matches!(self, Target::Service(..) | Target::Downtime { service: true, .. } | Target::Comment { service: true, .. })
    }
}

#[derive(Clone, Copy, PartialEq)]
enum About {
    Object,
    HostDowntime,
    ServiceDowntime,
    HostComment,
    ServiceComment,
}

use About::*;
use Arg::*;

const COMMANDS: &[(&str, &[Arg], About)] = &[
    ("ACKNOWLEDGE_HOST_PROBLEM", &[Host, Int, Flag, Flag, Author, Text], Object),
    ("ACKNOWLEDGE_SVC_PROBLEM", &[Host, Service, Int, Flag, Flag, Author, Text], Object),
    ("REMOVE_HOST_ACKNOWLEDGEMENT", &[Host], Object),
    ("REMOVE_SVC_ACKNOWLEDGEMENT", &[Host, Service], Object),
    ("SCHEDULE_HOST_DOWNTIME", &[Host, Time, Time, Flag, Int, Int, Author, Text], Object),
    ("SCHEDULE_SVC_DOWNTIME", &[Host, Service, Time, Time, Flag, Int, Int, Author, Text], Object),
    ("SCHEDULE_HOST_SVC_DOWNTIME", &[Host, Time, Time, Flag, Int, Int, Author, Text], Object),
    ("DEL_HOST_DOWNTIME", &[Id], HostDowntime),
    ("DEL_SVC_DOWNTIME", &[Id], ServiceDowntime),
    ("ADD_HOST_COMMENT", &[Host, Flag, Author, Text], Object),
    ("ADD_SVC_COMMENT", &[Host, Service, Flag, Author, Text], Object),
    ("DEL_HOST_COMMENT", &[Id], HostComment),
    ("DEL_SVC_COMMENT", &[Id], ServiceComment),
    ("SCHEDULE_FORCED_HOST_CHECK", &[Host, Time], Object),
    ("SCHEDULE_FORCED_SVC_CHECK", &[Host, Service, Time], Object),
    ("SCHEDULE_FORCED_HOST_SVC_CHECKS", &[Host, Time], Object),
    ("ENABLE_HOST_NOTIFICATIONS", &[Host], Object),
    ("DISABLE_HOST_NOTIFICATIONS", &[Host], Object),
    ("ENABLE_SVC_NOTIFICATIONS", &[Host, Service], Object),
    ("DISABLE_SVC_NOTIFICATIONS", &[Host, Service], Object),
    ("ENABLE_HOST_CHECK", &[Host], Object),
    ("DISABLE_HOST_CHECK", &[Host], Object),
    ("ENABLE_SVC_CHECK", &[Host, Service], Object),
    ("DISABLE_SVC_CHECK", &[Host, Service], Object),
    ("PROCESS_HOST_CHECK_RESULT", &[Host, Int, Text], Object),
    ("PROCESS_SERVICE_CHECK_RESULT", &[Host, Service, Int, Text], Object),
];

pub fn names() -> Vec<&'static str> {
    COMMANDS.iter().map(|c| c.0).collect()
}

#[derive(Deserialize)]
pub struct Command {
    pub backend: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// A command that passed: its line for the engine, and what it is about.
#[derive(Debug, PartialEq)]
pub struct Checked {
    pub line: String,
    pub target: Target,
}

impl Command {
    pub fn check(&self, author: &str, now: i64) -> Result<Checked, String> {
        let Some(&(name, kinds, about)) = COMMANDS.iter().find(|c| c.0 == self.command) else {
            return Err(format!("'{}' is not a command nuthatch sends", self.command));
        };
        if self.args.len() != kinds.len() {
            return Err(format!("{name} takes {} arguments, not {}", kinds.len(), self.args.len()));
        }
        let mut args = self.args.clone();
        let (mut host, mut service, mut id) = (None, None, None);
        for (n, (arg, kind)) in args.iter_mut().zip(kinds).enumerate() {
            let bad = |what: &str| format!("{name}: argument {} must be {what}", n + 1);
            if arg.contains(['\n', '\r', '\0']) {
                return Err(bad("one line"));
            }
            if *kind != Text && arg.contains(';') {
                return Err(bad("without ';'"));
            }
            match kind {
                Host | Service => {
                    if arg.is_empty() {
                        return Err(bad("a name"));
                    }
                    if *kind == Host { host = Some(arg.clone()) } else { service = Some(arg.clone()) }
                }
                Int => {
                    arg.parse::<i64>().map_err(|_| bad("a whole number"))?;
                }
                Flag => {
                    if arg != "0" && arg != "1" {
                        return Err(bad("0 or 1"));
                    }
                }
                Time => {
                    arg.parse::<u64>().map_err(|_| bad("a time in seconds"))?;
                }
                Id => id = Some(arg.parse::<u64>().map_err(|_| bad("an id"))?),
                Author => *arg = author.to_string(),
                Text => {}
            }
        }
        if author.contains([';', '\n', '\r']) {
            return Err("the user's name cannot be an author".into());
        }
        let target = match about {
            Object => match (host, service) {
                (Some(host), Some(service)) => Target::Service(host, service),
                (Some(host), None) => Target::Host(host),
                _ => return Err(format!("{name} names no object")),
            },
            HostDowntime | ServiceDowntime => Target::Downtime { id: id.unwrap_or(0), service: about == ServiceDowntime },
            HostComment | ServiceComment => Target::Comment { id: id.unwrap_or(0), service: about == ServiceComment },
        };
        Ok(Checked { line: format!("[{now}] {name};{}", args.join(";")), target })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(name: &str, args: &[&str]) -> Command {
        Command { backend: "a".into(), command: name.into(), args: args.iter().map(|a| a.to_string()).collect() }
    }

    #[test]
    fn commands_are_checked() {
        let ack = command("ACKNOWLEDGE_SVC_PROBLEM", &["web1", "http", "2", "1", "1", "someone else", "on it; looking"]);
        let checked = ack.check("ann", 100).unwrap();
        assert_eq!(checked.line, "[100] ACKNOWLEDGE_SVC_PROBLEM;web1;http;2;1;1;ann;on it; looking");
        assert_eq!(checked.target, Target::Service("web1".into(), "http".into()));
        assert!(checked.target.is_service());

        assert!(command("ACKNOWLEDGE_SVC_PROBLEM", &["web1;x", "http", "2", "1", "1", "a", "b"]).check("ann", 1).is_err());
        assert!(command("ACKNOWLEDGE_SVC_PROBLEM", &["web1", "http", "two", "1", "1", "a", "b"]).check("ann", 1).is_err());
        assert!(command("ACKNOWLEDGE_SVC_PROBLEM", &["web1", "http", "2", "yes", "1", "a", "b"]).check("ann", 1).is_err());
        assert!(command("ADD_HOST_COMMENT", &["web1", "1", "a", "line\nSHUTDOWN_PROGRAM"]).check("ann", 1).is_err());
        assert!(command("SHUTDOWN_PROGRAM", &[]).check("ann", 1).is_err());
        assert!(command("DEL_HOST_COMMENT", &[]).check("ann", 1).is_err());
        assert!(command("ADD_HOST_COMMENT", &["web1", "1", "a", "b"]).check("an;n", 1).is_err());

        let del = command("DEL_SVC_DOWNTIME", &["7"]).check("ann", 1).unwrap();
        assert_eq!(del.target, Target::Downtime { id: 7, service: true });
        assert!(command("DEL_SVC_DOWNTIME", &["7 OR 1"]).check("ann", 1).is_err());
        let both = command("SCHEDULE_HOST_SVC_DOWNTIME", &["web1", "10", "20", "1", "0", "0", "x", "work"]).check("ann", 1).unwrap();
        assert_eq!(both.target, Target::Host("web1".into()));
    }
}
