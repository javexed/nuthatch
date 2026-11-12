//! Who may see and do what. Decided here, on the server, for every
//! request; the browser is never trusted with it.
//!
//! The model is the one Nagios' web interface and Thruk use, with their
//! names: a user is the contact of the same name, sees the hosts and
//! services that contact belongs to, and roles widen that.
//!
//! What the engines do with a query's `AuthUser` was measured on Naemon
//! 1.5.2 (`docs/permissions.md`): hosts, services, host and service groups,
//! comments, downtimes and the log's lines about objects are limited to
//! the contact's; contacts, contact groups, commands, timeperiods and the
//! status table are given to anyone, so those need a role here.

use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    AllHosts,
    AllServices,
    AllHostCommands,
    AllServiceCommands,
    SystemCommands,
    SystemInformation,
    ConfigurationInformation,
    ReadOnly,
    ConfigEdit,
}

pub const ROLES: &[(Role, &str)] = &[
    (Role::AllHosts, "all_hosts"),
    (Role::AllServices, "all_services"),
    (Role::AllHostCommands, "all_host_commands"),
    (Role::AllServiceCommands, "all_service_commands"),
    (Role::SystemCommands, "system_commands"),
    (Role::SystemInformation, "system_information"),
    (Role::ConfigurationInformation, "configuration_information"),
    (Role::ReadOnly, "read_only"),
    (Role::ConfigEdit, "config_edit"),
];

/// The `[roles]` table of the config: `authorized_for_<role>` lists
/// users, `authorized_contactgroup_for_<role>` contact groups; `*` is
/// everyone.
#[derive(Default, Debug)]
pub struct RolesConfig {
    users: HashMap<Role, Vec<String>>,
    groups: HashMap<Role, Vec<String>>,
}

impl RolesConfig {
    pub fn parse(table: &HashMap<String, Vec<String>>) -> Result<RolesConfig, String> {
        let mut config = RolesConfig::default();
        for (key, names) in table {
            let (by_group, role_name) = match key.strip_prefix("authorized_contactgroup_for_") {
                Some(rest) => (true, rest),
                None => (false, key.strip_prefix("authorized_for_").ok_or(format!("[roles]: '{key}' is not a role setting"))?),
            };
            let role = ROLES.iter().find(|(_, n)| *n == role_name).ok_or(format!("[roles]: no role '{role_name}'"))?.0;
            let into = if by_group { &mut config.groups } else { &mut config.users };
            into.entry(role).or_default().extend(names.iter().cloned());
        }
        Ok(config)
    }

    /// The roles of a user who is in these contact groups.
    pub fn resolve(&self, user: &str, groups: &[String]) -> Roles {
        let mut held = HashSet::new();
        for (role, _) in ROLES {
            let by_name = self.users.get(role).is_some_and(|names| names.iter().any(|n| n == "*" || n == user));
            let by_group = self.groups.get(role).is_some_and(|names| names.iter().any(|n| n == "*" || groups.contains(n)));
            if by_name || by_group {
                held.insert(*role);
            }
        }
        Roles(held)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Roles(HashSet<Role>);

impl Roles {
    pub fn has(&self, role: Role) -> bool {
        self.0.contains(&role)
    }

    pub fn names(&self) -> Vec<&'static str> {
        ROLES.iter().filter(|(r, _)| self.has(*r)).map(|(_, n)| *n).collect()
    }

    #[cfg(test)]
    pub fn of(roles: &[Role]) -> Roles {
        Roles(roles.iter().copied().collect())
    }
}

pub const TABLES: &[&str] = &[
    "hosts",
    "services",
    "hostgroups",
    "servicegroups",
    "hostsbygroup",
    "servicesbygroup",
    "servicesbyhostgroup",
    "comments",
    "downtimes",
    "log",
    "statehist",
    "contacts",
    "contactgroups",
    "commands",
    "timeperiods",
    "status",
    "columns",
];

/// How a query of a table is limited for a user.
#[derive(Debug, PartialEq)]
pub enum Access {
    /// Everything: no `AuthUser`.
    All,
    /// The engine limits it, by `AuthUser`. A backend that does not
    /// enforce `AuthUser` is not asked.
    Limited,
    Denied(String),
}

pub fn access(table: &str, roles: &Roles) -> Access {
    let needs = |role: Role, name: &str| {
        if roles.has(role) { Access::All } else { Access::Denied(format!("the table {table} needs the role {name}")) }
    };
    match table {
        // Who may see all hosts may see all services too, as in Nagios.
        "hosts" | "hostgroups" | "hostsbygroup" => {
            if roles.has(Role::AllHosts) { Access::All } else { Access::Limited }
        }
        "services" | "servicegroups" | "servicesbygroup" | "servicesbyhostgroup" => {
            if roles.has(Role::AllHosts) || roles.has(Role::AllServices) { Access::All } else { Access::Limited }
        }
        "comments" | "downtimes" | "log" | "statehist" => {
            if roles.has(Role::AllHosts) { Access::All } else { Access::Limited }
        }
        "contacts" | "contactgroups" | "commands" | "timeperiods" => needs(Role::ConfigurationInformation, "configuration_information"),
        "status" => needs(Role::SystemInformation, "system_information"),
        "columns" => Access::All,
        _ => Access::Denied(format!("no table '{table}'")),
    }
}

/// Columns that can carry secrets: command lines with their arguments and
/// custom variables. They need the role configuration_information.
pub fn secret_column(name: &str) -> bool {
    ["custom_variable", "check_command", "event_handler", "command_line"].iter().any(|part| name.contains(part))
}

pub fn column_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// How the numbers of one `Stats:` line from several backends become one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Merge {
    Add,
    Min,
    Max,
}

/// Checks the header lines of a query: one line each, filters only, or
/// filters and stats when `stats` is on, and no secret column without the
/// role. The answer is how each stats column is merged.
pub fn check_headers(headers: &[String], stats: bool, roles: &Roles) -> Result<Vec<Merge>, String> {
    let mut merges: Vec<Merge> = Vec::new();
    let see_secrets = roles.has(Role::ConfigurationInformation);
    for line in headers {
        if line.contains(['\n', '\r', '\0']) || line.len() > 4096 {
            return Err("a header must be one line".into());
        }
        let (name, rest) = line.split_once(':').ok_or(format!("not a header: '{line}'"))?;
        let words: Vec<&str> = rest.split_whitespace().collect();
        let mut column = None;
        match name {
            "Filter" => column = words.first().copied(),
            "And" | "Or" | "Negate" => {}
            "Stats" if stats => match words.as_slice() {
                [op @ ("sum" | "min" | "max"), col] => {
                    column = Some(*col);
                    merges.push(match *op {
                        "min" => Merge::Min,
                        "max" => Merge::Max,
                        _ => Merge::Add,
                    });
                }
                [op @ ("avg" | "std" | "suminv" | "avginv"), _] => {
                    return Err(format!("Stats: {op} cannot be merged over backends; use sum and a count"));
                }
                [col, _op, ..] => {
                    column = Some(*col);
                    merges.push(Merge::Add);
                }
                _ => return Err(format!("not a stats line: '{line}'")),
            },
            "StatsAnd" | "StatsOr" if stats => {
                let n: usize = words.first().and_then(|w| w.parse().ok()).ok_or(format!("not a header: '{line}'"))?;
                if n == 0 || n > merges.len() {
                    return Err(format!("'{line}' combines more stats than there are"));
                }
                merges.truncate(merges.len() - n);
                merges.push(Merge::Add);
            }
            "StatsNegate" if stats => {}
            _ => return Err(format!("only filter{} lines are allowed, not '{line}'", if stats { " and stats" } else { "" })),
        }
        if let Some(column) = column {
            if !column_name(column) {
                return Err(format!("'{column}' is not a column name"));
            }
            if secret_column(column) && !see_secrets {
                return Err(format!("the column {column} needs the role configuration_information"));
            }
        }
    }
    Ok(merges)
}

pub fn check_columns(columns: &[String], roles: &Roles) -> Result<(), String> {
    for column in columns {
        if !column_name(column) {
            return Err(format!("'{column}' is not a column name"));
        }
        if secret_column(column) && !roles.has(Role::ConfigurationInformation) {
            return Err(format!("the column {column} needs the role configuration_information"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_from_names_and_groups() {
        let mut table = HashMap::new();
        table.insert("authorized_for_all_hosts".to_string(), vec!["ann".to_string()]);
        table.insert("authorized_contactgroup_for_read_only".to_string(), vec!["guests".to_string()]);
        table.insert("authorized_for_system_information".to_string(), vec!["*".to_string()]);
        let config = RolesConfig::parse(&table).unwrap();
        assert_eq!(config.resolve("ann", &[]).names(), vec!["all_hosts", "system_information"]);
        assert_eq!(config.resolve("bob", &["guests".into()]).names(), vec!["system_information", "read_only"]);
        table.insert("authorized_for_everything".to_string(), vec![]);
        assert!(RolesConfig::parse(&table).is_err());
    }

    #[test]
    fn tables() {
        let none = Roles::default();
        let all = Roles::of(&[Role::AllHosts]);
        assert_eq!(access("hosts", &none), Access::Limited);
        assert_eq!(access("hosts", &all), Access::All);
        assert_eq!(access("services", &all), Access::All);
        assert_eq!(access("services", &Roles::of(&[Role::AllServices])), Access::All);
        assert_eq!(access("log", &Roles::of(&[Role::AllServices])), Access::Limited);
        assert!(matches!(access("contacts", &all), Access::Denied(_)));
        assert_eq!(access("contacts", &Roles::of(&[Role::ConfigurationInformation])), Access::All);
        assert!(matches!(access("status", &none), Access::Denied(_)));
        assert!(matches!(access("nothing", &all), Access::Denied(_)));
    }

    #[test]
    fn headers() {
        let none = Roles::default();
        let h = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert!(check_headers(&h(&["Filter: state > 0", "Filter: name ~ web", "Or: 2"]), false, &none).is_ok());
        assert!(check_headers(&h(&["Filter: state = 0\nCOMMAND [1] SHUTDOWN_PROGRAM"]), false, &none).is_err());
        assert!(check_headers(&h(&["AuthUser: admin"]), true, &none).is_err());
        assert!(check_headers(&h(&["Stats: state = 0"]), false, &none).is_err());
        assert!(check_headers(&h(&["Filter: custom_variables ~ PASSWORD secret"]), false, &none).is_err());
        assert!(check_headers(&h(&["Filter: custom_variables ~ X y"]), false, &Roles::of(&[Role::ConfigurationInformation])).is_ok());
        assert_eq!(
            check_headers(&h(&["Stats: state = 0", "Stats: state = 1", "StatsOr: 2", "Stats: max last_check", "Stats: sum state"]), true, &none).unwrap(),
            vec![Merge::Add, Merge::Max, Merge::Add]
        );
        assert!(check_headers(&h(&["Stats: avg latency"]), true, &none).is_err());
        assert!(check_columns(&h(&["name", "check_command"]), &none).is_err());
        assert!(check_columns(&h(&["name", "state"]), &none).is_ok());
    }
}
