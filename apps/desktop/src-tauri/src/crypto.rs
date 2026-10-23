//! HOP1 envelope in Rust (ARCHITECTURE §6). Must pass packages/crypto/test-vectors.json
//! alongside the TypeScript implementation.
//!
//! ```text
//! "HOP1" (4 ASCII) ‖ nonce (12) ‖ ciphertext‖tag
//! ```
//!
//! AES-256-GCM, 96-bit nonce, 128-bit tag. The AAD is UTF-8 of `hopshot/v1/{kind}/{id}`,
//! which binds a ciphertext to the record it belongs to: a blob moved to a different id
//! fails to open rather than decrypting into the wrong place.
//!
//! The vectors file is compiled in with `include_str!`, so the Rust suite cannot silently
//! test a different copy from the TypeScript one.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const ENVELOPE_MAGIC: &[u8; 4] = b"HOP1";
pub const NONCE_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;
pub const KEY_BYTES: usize = 32;
/// 128 bits in base62.
pub const ID_CHARS: usize = 22;

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("this is not a HOP1 envelope")]
    NotHop1,
    #[error("this envelope is too short to be HOP1")]
    TooShort,
    #[error("this envelope failed its authentication check")]
    Authentication,
    #[error("a key needs {KEY_BYTES} bytes, got {0}")]
    KeyLength(usize),
    #[error("a nonce needs {NONCE_BYTES} bytes, got {0}")]
    NonceLength(usize),
    #[error("not base64url")]
    NotBase64Url,
}

/// What the AAD binds a ciphertext to, so blobs can't be swapped between records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Drop,
    Item,
    Meta,
}

impl Kind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Kind::Drop => "drop",
            Kind::Item => "item",
            Kind::Meta => "meta",
        }
    }
}

/// UTF-8 of this string is the AES-GCM additional authenticated data.
pub fn aad(kind: Kind, id: &str) -> String {
    format!("hopshot/v1/{}/{id}", kind.as_str())
}

// ── base64url (no padding) ───────────────────────────────────────────────────

pub fn to_base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        out.push(BASE64URL[(a >> 2) as usize] as char);

        let Some(&b) = chunk.get(1) else {
            out.push(BASE64URL[((a & 0x03) << 4) as usize] as char);
            break;
        };
        out.push(BASE64URL[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);

        let Some(&c) = chunk.get(2) else {
            out.push(BASE64URL[((b & 0x0f) << 2) as usize] as char);
            break;
        };
        out.push(BASE64URL[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char);
        out.push(BASE64URL[(c & 0x3f) as usize] as char);
    }

    out
}

pub fn from_base64url(text: &str) -> Result<Vec<u8>, EnvelopeError> {
    let mut out = Vec::with_capacity(text.len() * 6 / 8);
    let mut acc: u32 = 0;
    let mut bits = 0;

    for byte in text.bytes() {
        let value = BASE64URL
            .iter()
            .position(|&c| c == byte)
            .ok_or(EnvelopeError::NotBase64Url)? as u32;

        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }

    Ok(out)
}

// ── ids and keys ─────────────────────────────────────────────────────────────

/// A 22-char base62 id from 128 random bits (ARCHITECTURE §6).
pub fn new_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Entropy is unavailable only if something is deeply wrong with the OS. An id that
        // collides is better than a panic in the middle of a capture.
        log::error!("the OS entropy source is unavailable; falling back to a clock-based id");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        bytes.copy_from_slice(&stamp.to_be_bytes());
    }
    id_from_bytes(&bytes)
}

/// Deterministic half of [`new_id`], so the vectors can pin it.
pub fn id_from_bytes(bytes: &[u8; 16]) -> String {
    let mut value = u128::from_be_bytes(*bytes);

    // Fixed width: leading zeros stay, so every id is exactly 22 chars.
    let mut out = [b'0'; ID_CHARS];
    for slot in out.iter_mut().rev() {
        *slot = BASE62[(value % 62) as usize];
        value /= 62;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A fresh 256-bit key, base64url-encoded for a URL fragment.
pub fn new_key() -> Result<String, EnvelopeError> {
    let mut bytes = [0u8; KEY_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| EnvelopeError::KeyLength(0))?;
    Ok(to_base64url(&bytes))
}

pub fn key_from_base64url(key: &str) -> Result<[u8; KEY_BYTES], EnvelopeError> {
    let bytes = from_base64url(key)?;
    <[u8; KEY_BYTES]>::try_from(bytes.as_slice()).map_err(|_| EnvelopeError::KeyLength(bytes.len()))
}

// ── seal / open ──────────────────────────────────────────────────────────────

fn cipher(key: &[u8]) -> Result<Aes256Gcm, EnvelopeError> {
    if key.len() != KEY_BYTES {
        return Err(EnvelopeError::KeyLength(key.len()));
    }
    Ok(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)))
}

/// Encrypt into a HOP1 envelope with a fresh random nonce.
pub fn seal(
    key: &[u8],
    kind: Kind,
    id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let mut nonce = [0u8; NONCE_BYTES];
    getrandom::fill(&mut nonce).map_err(|_| EnvelopeError::NonceLength(0))?;
    seal_with_nonce(key, kind, id, plaintext, &nonce)
}

/// Encrypt with a caller-supplied nonce.
///
/// Only for the test vectors: reusing a nonce under the same key breaks GCM completely, so
/// production code calls [`seal`].
pub fn seal_with_nonce(
    key: &[u8],
    kind: Kind,
    id: &str,
    plaintext: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    if nonce.len() != NONCE_BYTES {
        return Err(EnvelopeError::NonceLength(nonce.len()));
    }

    let associated = aad(kind, id);
    let sealed = cipher(key)?
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad: associated.as_bytes(),
            },
        )
        .map_err(|_| EnvelopeError::Authentication)?;

    let mut envelope = Vec::with_capacity(ENVELOPE_MAGIC.len() + NONCE_BYTES + sealed.len());
    envelope.extend_from_slice(ENVELOPE_MAGIC);
    envelope.extend_from_slice(nonce);
    envelope.extend_from_slice(&sealed);
    Ok(envelope)
}

/// Open a HOP1 envelope.
///
/// Fails if the magic is wrong, the envelope is truncated, or the tag does not verify —
/// including when `kind`/`id` do not match what it was sealed with.
pub fn open(key: &[u8], kind: Kind, id: &str, envelope: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let header = ENVELOPE_MAGIC.len() + NONCE_BYTES;

    // Below this there is not even a tag, let alone a payload.
    if envelope.len() < header + TAG_BYTES {
        return Err(EnvelopeError::TooShort);
    }
    if &envelope[..ENVELOPE_MAGIC.len()] != ENVELOPE_MAGIC {
        return Err(EnvelopeError::NotHop1);
    }

    let associated = aad(kind, id);
    cipher(key)?
        .decrypt(
            Nonce::from_slice(&envelope[ENVELOPE_MAGIC.len()..header]),
            Payload {
                msg: &envelope[header..],
                aad: associated.as_bytes(),
            },
        )
        .map_err(|_| EnvelopeError::Authentication)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same file the TypeScript suite loads. `include_str!` means a divergent copy
    /// cannot creep in (ARCHITECTURE §6).
    const VECTORS: &str = include_str!("../../../../packages/crypto/test-vectors.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        algorithm: String,
        magic: String,
        nonce_bytes: usize,
        tag_bits: usize,
        vectors: Vec<Vector>,
        tampered: Vec<Tampered>,
        wrong_context: Vec<WrongContext>,
        ids: Vec<IdVector>,
        base64url: Vec<Base64Vector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        name: String,
        kind: Kind,
        id: String,
        key_base64_url: String,
        nonce_hex: String,
        aad: String,
        plaintext_hex: String,
        envelope_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Tampered {
        name: String,
        envelope_hex: String,
        reason: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WrongContext {
        name: String,
        kind: Kind,
        id: String,
        key_base64_url: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct IdVector {
        bytes_hex: String,
        id: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Base64Vector {
        bytes_hex: String,
        text: String,
    }

    fn load() -> Vectors {
        serde_json::from_str(VECTORS).expect("test-vectors.json")
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
            .collect()
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn the_vectors_describe_the_algorithm_in_architecture_6() {
        let v = load();
        assert_eq!(v.algorithm, "AES-256-GCM");
        assert_eq!(v.magic, "HOP1");
        assert_eq!(v.nonce_bytes, NONCE_BYTES);
        assert_eq!(v.tag_bits, TAG_BYTES * 8);
    }

    /// The whole point of the shared file: Rust must produce the exact bytes the
    /// TypeScript implementation produced.
    #[test]
    fn sealing_reproduces_every_vector_byte_for_byte() {
        for vector in load().vectors {
            let key = key_from_base64url(&vector.key_base64_url).expect("key");
            let sealed = seal_with_nonce(
                &key,
                vector.kind,
                &vector.id,
                &hex(&vector.plaintext_hex),
                &hex(&vector.nonce_hex),
            )
            .expect("seal");

            assert_eq!(to_hex(&sealed), vector.envelope_hex, "{}", vector.name);
        }
    }

    #[test]
    fn opening_recovers_every_plaintext() {
        for vector in load().vectors {
            let key = key_from_base64url(&vector.key_base64_url).expect("key");
            let opened = open(&key, vector.kind, &vector.id, &hex(&vector.envelope_hex))
                .unwrap_or_else(|e| panic!("{}: {e}", vector.name));

            assert_eq!(to_hex(&opened), vector.plaintext_hex, "{}", vector.name);
        }
    }

    #[test]
    fn the_aad_matches_the_vectors() {
        for vector in load().vectors {
            assert_eq!(aad(vector.kind, &vector.id), vector.aad, "{}", vector.name);
        }
    }

    #[test]
    fn every_tampered_envelope_is_rejected() {
        let v = load();
        let good = &v.vectors[1];
        let key = key_from_base64url(&good.key_base64_url).expect("key");

        for case in v.tampered {
            let result = open(&key, good.kind, &good.id, &hex(&case.envelope_hex));
            let error = result.expect_err(&format!("{} must not open", case.name));

            let expected = match case.reason.as_str() {
                "magic" => EnvelopeError::NotHop1,
                "short" => EnvelopeError::TooShort,
                _ => EnvelopeError::Authentication,
            };
            assert_eq!(error, expected, "{}", case.name);
        }
    }

    /// The AAD is what stops a blob being swapped between records (ARCHITECTURE §6).
    #[test]
    fn the_wrong_kind_key_or_id_cannot_open_it() {
        let v = load();
        let good = &v.vectors[1];

        for case in v.wrong_context {
            let key = key_from_base64url(
                case.key_base64_url.as_deref().unwrap_or(&good.key_base64_url),
            )
            .expect("key");

            assert_eq!(
                open(&key, case.kind, &case.id, &hex(&good.envelope_hex)),
                Err(EnvelopeError::Authentication),
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn ids_match_the_vectors() {
        for vector in load().ids {
            let bytes = <[u8; 16]>::try_from(hex(&vector.bytes_hex).as_slice()).expect("16 bytes");
            assert_eq!(id_from_bytes(&bytes), vector.id);
            assert_eq!(vector.id.len(), ID_CHARS);
        }
    }

    #[test]
    fn base64url_matches_the_vectors_both_ways() {
        for vector in load().base64url {
            let bytes = hex(&vector.bytes_hex);
            assert_eq!(to_base64url(&bytes), vector.text, "{}", vector.bytes_hex);
            assert_eq!(from_base64url(&vector.text).expect("decode"), bytes);
        }
    }

    #[test]
    fn a_round_trip_with_a_random_nonce_still_opens() {
        let key = [7u8; KEY_BYTES];
        let sealed = seal(&key, Kind::Item, "abc", b"payload").expect("seal");

        assert_eq!(&sealed[..4], ENVELOPE_MAGIC);
        assert_eq!(open(&key, Kind::Item, "abc", &sealed).expect("open"), b"payload");
    }

    /// Two seals of the same plaintext must differ, or the nonce is not random.
    #[test]
    fn each_seal_uses_a_fresh_nonce() {
        let key = [7u8; KEY_BYTES];
        let first = seal(&key, Kind::Drop, "abc", b"same").expect("seal");
        let second = seal(&key, Kind::Drop, "abc", b"same").expect("seal");
        assert_ne!(first, second);
    }

    #[test]
    fn keys_are_43_chars_of_base64url() {
        let key = new_key().expect("key");
        assert_eq!(key.len(), 43);
        assert_eq!(key_from_base64url(&key).expect("decode").len(), KEY_BYTES);
    }

    #[test]
    fn a_wrong_length_key_is_rejected_rather_than_padded() {
        assert_eq!(
            seal(&[0u8; 16], Kind::Drop, "abc", b"x"),
            Err(EnvelopeError::KeyLength(16))
        );
    }
}
