//! Pure `~/.ssh/config` parsing.
//!
//! Import-only: Terax reads the user's OpenSSH config to seed remote
//! profiles, it never writes it back. Resolution follows OpenSSH's
//! first-obtained-value-wins rule, so a `Host *` block at the top of the
//! file shadows later blocks exactly as `ssh` would resolve it.

use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    pub proxy_jump: Option<String>,
    pub forward_agent: Option<bool>,
    pub identities_only: Option<bool>,
    pub connect_timeout: Option<u32>,
    pub server_alive_interval: Option<u32>,
    pub compression: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Block {
    patterns: Vec<String>,
    entries: Vec<(String, String)>,
}

/// A pattern that can only ever match itself is a concrete host worth
/// importing; `Host *` and friends are defaults, not servers.
fn is_literal(pattern: &str) -> bool {
    !pattern.contains(['*', '?', '!'])
}

fn match_pattern(pattern: &str, alias: &str) -> bool {
    glob_match(pattern.as_bytes(), alias.as_bytes())
}

/// OpenSSH globbing: `*` spans any run, `?` exactly one byte. Iterative so a
/// pathological pattern cannot blow the stack.
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while t < text.len() {
        match pattern.get(p) {
            Some(b'*') => {
                star = p;
                p += 1;
                mark = t;
            }
            Some(&b'?') => {
                p += 1;
                t += 1;
            }
            Some(&c) if c == text[t] => {
                p += 1;
                t += 1;
            }
            _ if star != usize::MAX => {
                p = star + 1;
                mark += 1;
                t = mark;
            }
            _ => return false,
        }
    }
    while pattern.get(p) == Some(&b'*') {
        p += 1;
    }
    p == pattern.len()
}

fn split_directive(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    // OpenSSH accepts `Key Value`, `Key=Value`, `Key = Value`, and `Key =Value`.
    // The key ends at the first separator of either kind; an `=` that follows
    // is part of the separator, not the value.
    let split = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..split].trim();
    let value = line[split..].trim_start();
    let value = value.strip_prefix('=').unwrap_or(value).trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key.to_ascii_lowercase(), value.to_owned()))
}

fn parse_blocks(contents: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    for line in contents.lines() {
        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        if key == "host" {
            blocks.push(Block {
                patterns: value.split_whitespace().map(str::to_owned).collect(),
                entries: Vec::new(),
            });
            continue;
        }
        // `Match` blocks depend on runtime state we do not evaluate; treat the
        // block as inert rather than misattributing its keys to the last Host.
        if key == "match" {
            blocks.push(Block {
                patterns: Vec::new(),
                entries: Vec::new(),
            });
            continue;
        }
        if let Some(block) = blocks.last_mut() {
            block.entries.push((key, value));
        }
    }
    blocks
}

fn block_applies(block: &Block, alias: &str) -> bool {
    if block.patterns.is_empty() {
        return false;
    }
    let mut matched = false;
    for pattern in &block.patterns {
        if let Some(rest) = pattern.strip_prefix('!') {
            if glob_match(rest.as_bytes(), alias.as_bytes()) {
                return false;
            }
        } else if match_pattern(pattern, alias) {
            matched = true;
        }
    }
    matched
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "yes" | "true" => Some(true),
        "no" | "false" => Some(false),
        _ => None,
    }
}

/// Resolve every literal `Host` alias in the config into a flat profile.
pub fn parse_ssh_config(contents: &str) -> Vec<SshConfigHost> {
    let blocks = parse_blocks(contents);

    let mut aliases: Vec<String> = Vec::new();
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    for block in &blocks {
        for pattern in &block.patterns {
            if is_literal(pattern) && seen.insert(pattern.clone(), ()).is_none() {
                aliases.push(pattern.clone());
            }
        }
    }

    aliases
        .into_iter()
        .map(|alias| resolve_alias(&blocks, &alias))
        .collect()
}

/// First obtained value wins, so a slot that already holds a value is never
/// overwritten. A directive that fails to parse leaves the slot open for a
/// later block rather than pinning it to a default.
fn set_once<T>(slot: &mut Option<T>, value: Option<T>) {
    if slot.is_none() {
        if let Some(value) = value {
            *slot = Some(value);
        }
    }
}

fn resolve_alias(blocks: &[Block], alias: &str) -> SshConfigHost {
    let mut host = SshConfigHost {
        alias: alias.to_owned(),
        ..Default::default()
    };

    for block in blocks.iter().filter(|b| block_applies(b, alias)) {
        for (key, value) in &block.entries {
            match key.as_str() {
                "hostname" => set_once(&mut host.hostname, Some(value.to_owned())),
                "user" => set_once(&mut host.user, Some(value.to_owned())),
                "proxyjump" => set_once(&mut host.proxy_jump, Some(value.to_owned())),
                "port" => set_once(&mut host.port, value.parse().ok()),
                "identityfile" => {
                    let path = value.to_owned();
                    if !host.identity_files.contains(&path) {
                        host.identity_files.push(path);
                    }
                }
                "forwardagent" => set_once(&mut host.forward_agent, parse_bool(value)),
                "identitiesonly" => set_once(&mut host.identities_only, parse_bool(value)),
                "compression" => set_once(&mut host.compression, parse_bool(value)),
                "connecttimeout" => set_once(&mut host.connect_timeout, value.parse().ok()),
                "serveraliveinterval" => {
                    set_once(&mut host.server_alive_interval, value.parse().ok())
                }
                _ => {}
            }
        }
    }
    host
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_basic_host_block() {
        let hosts =
            parse_ssh_config("Host web\n  HostName web.example.com\n  User deploy\n  Port 2222\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "web");
        assert_eq!(hosts[0].hostname.as_deref(), Some("web.example.com"));
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[0].port, Some(2222));
    }

    #[test]
    fn accepts_equals_separated_directives() {
        let hosts = parse_ssh_config("Host web\n  HostName=web.example.com\n  Port = 2200\n");
        assert_eq!(hosts[0].hostname.as_deref(), Some("web.example.com"));
        assert_eq!(hosts[0].port, Some(2200));
    }

    #[test]
    fn wildcard_defaults_apply_to_literal_hosts() {
        let hosts = parse_ssh_config("Host *\n  User root\n\nHost web\n  HostName w.example\n");
        assert_eq!(hosts.len(), 1, "wildcard blocks are not importable hosts");
        assert_eq!(hosts[0].alias, "web");
        assert_eq!(hosts[0].user.as_deref(), Some("root"));
    }

    #[test]
    fn first_obtained_value_wins() {
        let hosts = parse_ssh_config("Host *\n  User root\n\nHost web\n  User deploy\n");
        assert_eq!(
            hosts[0].user.as_deref(),
            Some("root"),
            "an earlier block must shadow a later one, as ssh resolves it"
        );
    }

    #[test]
    fn later_block_wins_when_it_comes_first() {
        let hosts = parse_ssh_config("Host web\n  User deploy\n\nHost *\n  User root\n");
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn identity_files_accumulate_in_order() {
        let hosts = parse_ssh_config(
            "Host *\n  IdentityFile ~/.ssh/id_ed25519\n\nHost web\n  IdentityFile ~/.ssh/work\n",
        );
        assert_eq!(
            hosts[0].identity_files,
            vec!["~/.ssh/id_ed25519".to_string(), "~/.ssh/work".to_string()]
        );
    }

    #[test]
    fn duplicate_identity_files_are_not_repeated() {
        let hosts =
            parse_ssh_config("Host web\n  IdentityFile ~/.ssh/k\n  IdentityFile ~/.ssh/k\n");
        assert_eq!(hosts[0].identity_files.len(), 1);
    }

    #[test]
    fn multiple_patterns_on_one_host_line_each_import() {
        let hosts = parse_ssh_config("Host alpha beta\n  User shared\n");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].alias, "alpha");
        assert_eq!(hosts[1].alias, "beta");
        assert_eq!(hosts[1].user.as_deref(), Some("shared"));
    }

    #[test]
    fn glob_patterns_apply_to_matching_aliases_only() {
        let hosts = parse_ssh_config(
            "Host prod-*\n  User admin\n\nHost prod-db\n  HostName db\n\nHost dev-api\n  HostName dev\n",
        );
        let prod = hosts.iter().find(|h| h.alias == "prod-db").unwrap();
        let dev = hosts.iter().find(|h| h.alias == "dev-api").unwrap();
        assert_eq!(prod.user.as_deref(), Some("admin"));
        assert_eq!(dev.user, None);
    }

    #[test]
    fn negated_pattern_vetoes_the_block() {
        let hosts = parse_ssh_config(
            "Host * !secret\n  User common\n\nHost secret\n  HostName s\n\nHost open\n  HostName o\n",
        );
        let secret = hosts.iter().find(|h| h.alias == "secret").unwrap();
        let open = hosts.iter().find(|h| h.alias == "open").unwrap();
        assert_eq!(secret.user, None, "negation must veto the whole block");
        assert_eq!(open.user.as_deref(), Some("common"));
    }

    #[test]
    fn question_mark_matches_exactly_one_character() {
        assert!(glob_match(b"web?", b"web1"));
        assert!(!glob_match(b"web?", b"web"));
        assert!(!glob_match(b"web?", b"web12"));
    }

    #[test]
    fn star_matches_empty_and_multi_segment_runs() {
        assert!(glob_match(b"*", b""));
        assert!(glob_match(b"a*z", b"az"));
        assert!(glob_match(b"a*z", b"a-long-run-z"));
        assert!(!glob_match(b"a*z", b"a-long-run"));
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let hosts = parse_ssh_config("# leading\n\nHost web\n\n  # inner\n  User deploy\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn match_blocks_do_not_leak_into_the_previous_host() {
        let hosts = parse_ssh_config("Host web\n  User deploy\n\nMatch exec true\n  User leaked\n");
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn directives_before_any_host_are_dropped() {
        let hosts = parse_ssh_config("User orphan\n\nHost web\n  HostName w\n");
        assert_eq!(hosts[0].user, None);
    }

    #[test]
    fn boolean_directives_parse_both_spellings() {
        let hosts = parse_ssh_config(
            "Host web\n  ForwardAgent yes\n  IdentitiesOnly no\n  Compression TRUE\n",
        );
        assert_eq!(hosts[0].forward_agent, Some(true));
        assert_eq!(hosts[0].identities_only, Some(false));
        assert_eq!(hosts[0].compression, Some(true));
    }

    #[test]
    fn malformed_numbers_are_dropped_not_defaulted() {
        let hosts = parse_ssh_config("Host web\n  Port notanumber\n");
        assert_eq!(hosts[0].port, None);
    }

    #[test]
    fn empty_config_yields_no_hosts() {
        assert!(parse_ssh_config("").is_empty());
        assert!(parse_ssh_config("# only a comment\n").is_empty());
    }

    #[test]
    fn repeated_alias_is_imported_once() {
        let hosts = parse_ssh_config("Host web\n  User a\n\nHost web\n  Port 2222\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].user.as_deref(), Some("a"));
        assert_eq!(hosts[0].port, Some(2222));
    }
}
