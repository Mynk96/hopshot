//! HTTP to `api.hopshot.xyz` (ARCHITECTURE §7).
//!
//! Only ever carries HOP1 ciphertext. The key never reaches this module — it is generated
//! in `cloud::drops`, used to seal, and put straight into the URL fragment, which browsers
//! do not send to servers (CLAUDE.md privacy invariant).

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use thiserror::Error;

/// Overridable so a staging Worker can be pointed at without a rebuild.
const DEFAULT_BASE: &str = "https://api.hopshot.xyz/v1";
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("Offline — sending paused")]
    Offline,
    #[error("{message}")]
    Api { code: String, message: String },
    #[error("the server sent something unexpected: {0}")]
    Protocol(String),
}

impl ClientError {
    /// Is this the daily cap rather than a real failure (DESIGN §5 limit copy)?
    pub fn is_limit(&self) -> bool {
        matches!(self, ClientError::Api { code, .. } if code == "limit_reached")
    }
}

/// The error shape every route uses (ARCHITECTURE §7).
#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorBody,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    code: String,
    message: String,
}

/// Base URL for the API.
///
/// `HOPSHOT_API_BASE` lets a staging build talk to a preview Worker; unset, it is
/// production.
pub fn base_url() -> String {
    std::env::var("HOPSHOT_API_BASE").unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

/// Log which endpoints this run will use.
///
/// `HOPSHOT_API_BASE` is easy to lose — a shell that does not support `VAR=x cmd` drops it
/// silently and the app falls back to production, which does not resolve yet. One line at
/// startup turns that into something you can see.
pub fn log_endpoints() {
    log::info!("API base: {}", base_url());
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        // Let a 4xx come back as a response so its body can be read. The API puts the
        // user-facing copy in `{error:{code,message}}` (ARCHITECTURE §7), and treating the
        // status as a transport error would throw that away.
        .http_status_as_error(false)
        .build()
        .into()
}

/// Turn a non-2xx response into the API's error shape, falling back to the status code.
fn api_error(status: u16, body: &str) -> ClientError {
    match serde_json::from_str::<ApiError>(body) {
        Ok(parsed) => ClientError::Api {
            code: parsed.error.code,
            message: parsed.error.message,
        },
        // A proxy or gateway error has no JSON body; fall back to copy for the status.
        Err(_) => ClientError::Api {
            code: format!("http_{status}"),
            message: status_message(status),
        },
    }
}

/// `POST {path}` with a raw ciphertext body.
pub fn post_bytes<T: DeserializeOwned>(
    path: &str,
    body: Vec<u8>,
    headers: &[(&str, &str)],
) -> Result<T, ClientError> {
    let url = format!("{}{path}", base_url());
    let mut request = agent()
        .post(&url)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", &body.len().to_string());

    for (name, value) in headers {
        request = request.header(*name, *value);
    }

    match request.send(&body[..]) {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let text = response
                .body_mut()
                .read_to_string()
                .map_err(|e| ClientError::Protocol(e.to_string()))?;

            if !(200..300).contains(&status) {
                return Err(api_error(status, &text));
            }
            serde_json::from_str(&text).map_err(|e| ClientError::Protocol(e.to_string()))
        }
        Err(error) => Err(classify(&url, error)),
    }
}

/// `DELETE {path}` with a bearer token. 204 and 404 are both "it is gone".
pub fn delete(path: &str, bearer: &str) -> Result<(), ClientError> {
    let url = format!("{}{path}", base_url());

    match agent()
        .delete(&url)
        .header("Authorization", &format!("Bearer {bearer}"))
        .call()
    {
        Ok(mut response) => {
            let status = response.status().as_u16();
            // Already gone is the outcome the caller wanted.
            if (200..300).contains(&status) || status == 404 || status == 410 {
                return Ok(());
            }
            let text = response.body_mut().read_to_string().unwrap_or_default();
            Err(api_error(status, &text))
        }
        Err(error) => Err(classify(&url, error)),
    }
}

/// `POST {path}` with a JSON body. Used by the vault routes (ARCHITECTURE §7.2, §7.4).
pub fn post_json<B: serde::Serialize, T: DeserializeOwned>(
    path: &str,
    body: &B,
    headers: &[(&str, &str)],
) -> Result<T, ClientError> {
    let url = format!("{}{path}", base_url());
    let payload =
        serde_json::to_vec(body).map_err(|e| ClientError::Protocol(e.to_string()))?;

    let mut request = agent()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Content-Length", &payload.len().to_string());

    for (name, value) in headers {
        request = request.header(*name, *value);
    }

    match request.send(&payload[..]) {
        Ok(mut response) => read_json(response.status().as_u16(), &mut response),
        Err(error) => Err(classify(&url, error)),
    }
}

/// `GET {path}` returning JSON, with a bearer token.
pub fn get_json<T: DeserializeOwned>(path: &str, bearer: &str) -> Result<T, ClientError> {
    let url = format!("{}{path}", base_url());

    match agent()
        .get(&url)
        .header("Authorization", &format!("Bearer {bearer}"))
        .call()
    {
        Ok(mut response) => read_json(response.status().as_u16(), &mut response),
        Err(error) => Err(classify(&url, error)),
    }
}

/// `GET {path}` returning raw bytes — a vault item's ciphertext (ARCHITECTURE §7.3).
pub fn get_bytes(path: &str, bearer: &str) -> Result<Vec<u8>, ClientError> {
    let url = format!("{}{path}", base_url());

    match agent()
        .get(&url)
        .header("Authorization", &format!("Bearer {bearer}"))
        .call()
    {
        Ok(mut response) => {
            let status = response.status().as_u16();
            if !(200..300).contains(&status) {
                let text = response.body_mut().read_to_string().unwrap_or_default();
                return Err(api_error(status, &text));
            }
            // Capped so a hostile or corrupted response cannot exhaust memory; the server's
            // own limit is maxCiphertextBytes, and this is comfortably above it.
            response
                .body_mut()
                .with_config()
                .limit(32 * 1024 * 1024)
                .read_to_vec()
                .map_err(|e| ClientError::Protocol(e.to_string()))
        }
        Err(error) => Err(classify(&url, error)),
    }
}

/// Shared tail of the JSON helpers: status check, then parse.
fn read_json<T: DeserializeOwned>(
    status: u16,
    response: &mut ureq::http::Response<ureq::Body>,
) -> Result<T, ClientError> {
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|e| ClientError::Protocol(e.to_string()))?;

    if !(200..300).contains(&status) {
        return Err(api_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| ClientError::Protocol(e.to_string()))
}

fn classify(url: &str, error: ureq::Error) -> ClientError {
    match error {
        // No DNS, no route, or a timeout: all the same thing to the *user*, who only needs
        // to know sending is paused. But "offline" and "pointed at a host that does not
        // exist" are indistinguishable from the outside, so the log names the URL — without
        // it a misconfigured base looks exactly like a dropped connection.
        ureq::Error::Io(_) | ureq::Error::Timeout(_) => {
            log::warn!("could not reach {url}: {error}");
            ClientError::Offline
        }
        other => {
            log::warn!("{url} failed: {other}");
            ClientError::Protocol(other.to_string())
        }
    }
}

/// DESIGN §5 voice for the statuses the drops routes actually return.
fn status_message(status: u16) -> String {
    match status {
        403 => "Links can't last that long on your plan.".to_string(),
        409 => "That link id was already taken. Try again.".to_string(),
        413 => "That image is too big to send. 10 MB is the limit.".to_string(),
        429 => "That's all your sends for today.".to_string(),
        _ => "Hopshot couldn't reach the server.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_base_url_defaults_to_production() {
        // Only meaningful when the override is absent, which is the normal case.
        if std::env::var("HOPSHOT_API_BASE").is_err() {
            assert_eq!(base_url(), "https://api.hopshot.xyz/v1");
        }
    }

    #[test]
    fn an_api_error_body_keeps_its_code_and_message() {
        let error = api_error(429, r#"{"error":{"code":"limit_reached","message":"That's 10 sends today."}}"#);
        assert!(error.is_limit());
        assert_eq!(error.to_string(), "That's 10 sends today.");
    }

    #[test]
    fn an_unparsable_body_still_produces_a_usable_error() {
        let error = api_error(500, "<html>502 Bad Gateway</html>");
        assert!(!error.is_limit());
        assert_eq!(error.to_string(), "Hopshot couldn't reach the server.");
    }

    #[test]
    fn limit_copy_follows_the_design_voice() {
        for status in [403, 409, 413, 429] {
            let message = status_message(status);
            assert!(!message.contains('!'), "{message}");
            assert!(message.ends_with('.'), "{message}");
        }
    }
}
