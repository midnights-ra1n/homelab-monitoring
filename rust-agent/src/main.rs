//! hlm-agent: collects host metrics and streams them to the hlm hub over a WebSocket.
//!
//! Authentication is mutual, like Beszel: the agent presents its TOKEN, and the hub
//! must sign the agent's random nonce with the private key matching KEY. An agent
//! therefore never talks to an impostor hub, even behind a compromised proxy.

mod collect;
mod smart;
mod update;
mod updates;

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{self, Message, client::IntoClientRequest};

pub const VERSION: &str = match option_env!("HLM_VERSION") {
    Some(v) => v,
    None => "dev",
};

// Must match agentAuthContext in server/hosts.go.
const AUTH_CONTEXT: &[u8] = b"hlm-agent-auth-v1:";

struct Config {
    ws_url: String,
    token: String,
    key: VerifyingKey,
    auto_update: bool,
    repo: String,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn load_config() -> Result<Config, String> {
    let hub = env("HUB_URL").ok_or("HUB_URL is required")?;
    let token = env("TOKEN").ok_or("TOKEN is required")?;
    let key_b64 = env("KEY").ok_or("KEY is required (hub public key)")?;
    let insecure = env("ALLOW_INSECURE").as_deref() == Some("true");
    let key_bytes: [u8; 32] = B64
        .decode(key_b64)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("KEY must be a base64 ed25519 public key")?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| "KEY is not a valid ed25519 key")?;
    let base = hub.trim_end_matches('/');
    let ws_url = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}/api/agent/ws")
    } else if let Some(rest) = base.strip_prefix("http://") {
        if !insecure {
            return Err("HUB_URL uses plain http: set ALLOW_INSECURE=true to accept an unencrypted link".into());
        }
        format!("ws://{rest}/api/agent/ws")
    } else {
        return Err("HUB_URL must start with https:// (or http:// with ALLOW_INSECURE=true)".into());
    };
    Ok(Config {
        ws_url,
        token,
        key,
        auto_update: env("AUTO_UPDATE").as_deref() != Some("false"),
        repo: env("UPDATE_REPO").unwrap_or_else(|| "midnights-ra1n/homelab-monitoring".into()),
    })
}

#[derive(Deserialize)]
struct Hello {
    #[serde(rename = "type")]
    kind: String,
    sig: String,
    interval: u64,
    /// Personal token, sent once to an agent that enrolled with a shared enrollment token.
    token: Option<String>,
}

/// Where an enrolled agent keeps its personal token: $STATE_DIRECTORY, set by systemd's
/// StateDirectory= (/var/lib/hlm-agent/state, mode 0700).
fn state_token_path() -> String {
    std::env::var("STATE_DIRECTORY").unwrap_or_else(|_| "/var/lib/hlm-agent/state".into()) + "/token"
}

fn state_token() -> Option<String> {
    std::fs::read_to_string(state_token_path()).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

fn save_state_token(tok: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = state_token_path();
    let tmp = format!("{path}.tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(tok.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(tmp, path)
}

/// The hub signs AUTH_CONTEXT || nonce || sha256(token); see handleAgentWS in server/hosts.go.
fn hub_signature_ok(key: &VerifyingKey, nonce: &[u8; 32], token: &str, sig_b64: &str) -> bool {
    let mut msg = AUTH_CONTEXT.to_vec();
    msg.extend_from_slice(nonce);
    msg.extend_from_slice(&Sha256::digest(token.as_bytes()));
    B64.decode(sig_b64)
        .ok()
        .and_then(|b| <[u8; 64]>::try_from(b).ok())
        .is_some_and(|b| key.verify_strict(&msg, &Signature::from_bytes(&b)).is_ok())
}

enum Failure {
    Retry(String),
    Fatal(String),
    Rejected,
}

async fn session(cfg: &Config, token: &str, collector: &mut collect::Collector) -> Failure {
    let mut nonce = [0u8; 32];
    if let Err(e) = getrandom::fill(&mut nonce) {
        return Failure::Fatal(format!("no randomness: {e}"));
    }
    let mut req = match cfg.ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => return Failure::Fatal(format!("invalid HUB_URL: {e}")),
    };
    let h = req.headers_mut();
    h.insert("Authorization", format!("Bearer {token}").parse().unwrap());
    if let Some(name) = sysinfo::System::host_name().and_then(|n| n.parse().ok()) {
        h.insert("X-Agent-Hostname", name); // name used when enrolling with a shared token
    }
    h.insert("X-Agent-Nonce", B64.encode(nonce).parse().unwrap());
    h.insert("User-Agent", format!("hlm-agent/{VERSION}").parse().unwrap());

    let ws = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(req)).await;
    let mut ws = match ws {
        Err(_) => return Failure::Retry("connection timed out".into()),
        Ok(Err(tungstenite::Error::Http(resp))) if resp.status() == 401 => {
            // A wrong token never fixes itself; slow retry is handled by the caller.
            return Failure::Rejected;
        }
        Ok(Err(e)) => return Failure::Retry(e.to_string()),
        Ok(Ok((ws, _))) => ws,
    };

    let hello: Hello = match tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => match serde_json::from_str(&t) {
            Ok(h) => h,
            Err(e) => return Failure::Retry(format!("bad hello: {e}")),
        },
        _ => return Failure::Retry("no hello from hub".into()),
    };
    if hello.kind != "hello" || !hub_signature_ok(&cfg.key, &nonce, token, &hello.sig) {
        let _ = ws.close(None).await;
        return Failure::Fatal("hub signature invalid: KEY does not match this hub".into());
    }
    if let Some(personal) = &hello.token {
        match save_state_token(personal) {
            Ok(()) => eprintln!("hlm-agent: enrolled, personal token saved to {}", state_token_path()),
            Err(e) => eprintln!("hlm-agent: enrolled but cannot save {}: {e}", state_token_path()),
        }
    }
    let interval = Duration::from_secs(hello.interval.clamp(5, 3600));
    eprintln!("hlm-agent: connected, reporting every {}s", interval.as_secs());

    let info = serde_json::json!({"type": "info", "info": collector.info()});
    if let Err(e) = ws.send(Message::Text(info.to_string().into())).await {
        return Failure::Retry(e.to_string());
    }
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Pending updates change slowly; apt-daily refreshes the lists about twice a day.
    let mut upd = tokio::time::interval(Duration::from_secs(6 * 3600));
    // The root collector refreshes SMART hourly; forward each new file once.
    let mut smart_tick = tokio::time::interval(Duration::from_secs(600));
    let mut smart_sent = 0u64;
    loop {
        tokio::select! {
            _ = smart_tick.tick() => {
                if let Some(rep) = smart::read_report().filter(|r| r.collected_at != smart_sent) {
                    smart_sent = rep.collected_at;
                    let m = serde_json::json!({"type": "smart", "smart": rep});
                    if let Err(e) = ws.send(Message::Text(m.to_string().into())).await {
                        return Failure::Retry(e.to_string());
                    }
                }
            }
            _ = upd.tick() => {
                if let Ok(Some(u)) = tokio::task::spawn_blocking(updates::check).await {
                    let m = serde_json::json!({"type": "updates", "updates": u});
                    if let Err(e) = ws.send(Message::Text(m.to_string().into())).await {
                        return Failure::Retry(e.to_string());
                    }
                }
            }
            _ = tick.tick() => {
                let m = serde_json::json!({"type": "metrics", "metrics": collector.collect()});
                if let Err(e) = ws.send(Message::Text(m.to_string().into())).await {
                    return Failure::Retry(e.to_string());
                }
            }
            msg = ws.next() => match msg {
                // Pings are answered by tungstenite on the next write/flush.
                Some(Ok(Message::Close(f))) => return Failure::Retry(format!("closed by hub: {f:?}")),
                Some(Ok(_)) => {}
                Some(Err(e)) => return Failure::Retry(e.to_string()),
                None => return Failure::Retry("connection closed".into()),
            }
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{VERSION}");
        return;
    }
    let cfg = match load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("hlm-agent: {e}");
            std::process::exit(2);
        }
    };
    eprintln!("hlm-agent {VERSION} starting, hub {}", cfg.ws_url);

    if cfg.auto_update {
        let repo = cfg.repo.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(300)).await;
            loop {
                let r = repo.clone();
                match tokio::task::spawn_blocking(move || update::check(&r)).await {
                    Ok(Ok(true)) => std::process::exit(0), // systemd restarts the new binary
                    Ok(Err(e)) => eprintln!("hlm-agent: update check failed: {e}"),
                    _ => {}
                }
                tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
            }
        });
    }

    let mut collector = collect::Collector::new();
    let mut backoff = 1u64;
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
    loop {
        let started = std::time::Instant::now();
        // An enrolled agent uses its personal token; TOKEN from the config is the fallback.
        let personal = state_token();
        let token = personal.clone().unwrap_or_else(|| cfg.token.clone());
        let wait = tokio::select! {
            f = session(&cfg, &token, &mut collector) => match f {
                Failure::Retry(e) => { eprintln!("hlm-agent: disconnected: {e}"); None }
                Failure::Fatal(e) => { eprintln!("hlm-agent: {e}"); Some(300) }
                Failure::Rejected if personal.is_some() => {
                    // Host deleted or token rotated in the UI: enroll again with the shared token.
                    eprintln!("hlm-agent: personal token rejected, falling back to TOKEN");
                    let _ = std::fs::remove_file(state_token_path());
                    Some(1)
                }
                Failure::Rejected => { eprintln!("hlm-agent: hub rejected TOKEN (401)"); Some(300) }
            },
            _ = term.recv() => return,
        };
        if started.elapsed() > Duration::from_secs(60) {
            backoff = 1;
        }
        let secs = wait.unwrap_or(backoff);
        backoff = (backoff * 2).min(60);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(secs)) => {}
            _ = term.recv() => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn verifies_only_the_genuine_hub() {
        let hub = SigningKey::from_bytes(&[7u8; 32]);
        let nonce = [1u8; 32];
        let mut msg = AUTH_CONTEXT.to_vec();
        msg.extend_from_slice(&nonce);
        msg.extend_from_slice(&Sha256::digest(b"tok"));
        let sig = B64.encode(hub.sign(&msg).to_bytes());
        let key = hub.verifying_key();
        assert!(hub_signature_ok(&key, &nonce, "tok", &sig));
        assert!(!hub_signature_ok(&key, &[2u8; 32], "tok", &sig), "replayed for another nonce");
        assert!(!hub_signature_ok(&key, &nonce, "other", &sig), "signature bound to another token");
        let impostor = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        assert!(!hub_signature_ok(&impostor, &nonce, "tok", &sig));
        assert!(!hub_signature_ok(&key, &nonce, "tok", "not base64!"));
    }
}
