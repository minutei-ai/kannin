use std::fmt;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use unicode_segmentation::UnicodeSegmentation;

pub mod segment;

pub const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
const HEADER_BYTES: usize = 16;
const MAGIC: &[u8; 8] = b"RAIOLOG1";

#[derive(Debug, PartialEq, Eq)]
pub enum LogError {
    TooLarge,
    InvalidHeader,
    InvalidLength,
    InvalidHeaderWidth(String),
    InvalidCompression(String),
    InvalidChecksum,
    InvalidUtf8(std::string::FromUtf8Error),
}

impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for LogError {}

pub fn encode_log(json: &str) -> Result<Vec<u8>, LogError> {
    if json.len() > MAX_LOG_BYTES {
        return Err(LogError::TooLarge);
    }
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(json.as_bytes(), 3);
    let mut output = Vec::with_capacity(HEADER_BYTES + compressed.len());
    output.extend_from_slice(MAGIC);
    output.extend_from_slice(&(json.len() as u32).to_le_bytes());
    output.extend_from_slice(&crc32fast::hash(json.as_bytes()).to_le_bytes());
    output.extend_from_slice(&compressed);
    Ok(output)
}

pub fn decode_log(bytes: &[u8]) -> Result<String, LogError> {
    if bytes.len() < HEADER_BYTES || &bytes[..8] != MAGIC {
        return Err(LogError::InvalidHeader);
    }
    if bytes.len() > MAX_LOG_BYTES + 8192 {
        return Err(LogError::TooLarge);
    }
    let length = u32::from_le_bytes(bytes[8..12].try_into().map_err(
        |cause: std::array::TryFromSliceError| LogError::InvalidHeaderWidth(cause.to_string()),
    )?) as usize;
    if length > MAX_LOG_BYTES {
        return Err(LogError::TooLarge);
    }
    let checksum = u32::from_le_bytes(bytes[12..16].try_into().map_err(
        |cause: std::array::TryFromSliceError| LogError::InvalidHeaderWidth(cause.to_string()),
    )?);
    let decoded = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(
        &bytes[HEADER_BYTES..],
        MAX_LOG_BYTES,
    )
    .map_err(|cause| LogError::InvalidCompression(cause.to_string()))?;
    if decoded.len() != length {
        return Err(LogError::InvalidLength);
    }
    if crc32fast::hash(&decoded) != checksum {
        return Err(LogError::InvalidChecksum);
    }
    String::from_utf8(decoded).map_err(LogError::InvalidUtf8)
}

pub fn normalize_text(text: &str) -> String {
    let normalized: String = text
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect();
    normalized
        .unicode_words()
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn pack(json: &str) -> Result<Vec<u8>, JsValue> {
        super::encode_log(json).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn unpack(bytes: &[u8]) -> Result<String, JsValue> {
        super::decode_log(bytes).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn tokenize(text: &str) -> String {
        super::normalize_text(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_search_is_case_and_accent_insensitive() -> Result<(), Box<dyn std::error::Error>> {
        assert_eq!(
            normalize_text("AÇÃO São ﬂores CAFÉ"),
            "acao sao flores cafe"
        );
        assert_eq!(normalize_text("cafe\u{301}"), "cafe");
        assert_eq!(normalize_text("日本語 中文 rust🔥"), "日 本 語 中 文 rust");
        assert_eq!(normalize_text("\" OR * NEAR(a)"), "or near a");

        Ok(())
    }

    #[test]
    fn logs_roundtrip_and_compress() -> Result<(), Box<dyn std::error::Error>> {
        let json = "{\"text\":\"açãõ日本語\"}".repeat(4096);
        let encoded = encode_log(&json)?;
        assert!(encoded.len() < json.len() / 10);
        assert_eq!(decode_log(&encoded)?, json);
        assert_eq!(decode_log(&encode_log("")?)?, "");

        Ok(())
    }

    #[test]
    fn rejects_truncation_and_wrong_version() -> Result<(), Box<dyn std::error::Error>> {
        let encoded = encode_log("hello")?;
        for length in 0..encoded.len() {
            assert!(decode_log(&encoded[..length]).is_err());
        }
        let mut wrong = encoded;
        wrong[7] = b'2';
        assert_eq!(decode_log(&wrong), Err(LogError::InvalidHeader));

        Ok(())
    }

    #[test]
    fn rejects_corruption_and_mismatched_length() -> Result<(), Box<dyn std::error::Error>> {
        let mut encoded = encode_log("hello")?;
        encoded[12] ^= 1;
        assert_eq!(decode_log(&encoded), Err(LogError::InvalidChecksum));
        encoded[12] ^= 1;
        encoded[8] += 1;
        assert_eq!(decode_log(&encoded), Err(LogError::InvalidLength));

        Ok(())
    }

    #[test]
    fn bounded_decode_rejects_zip_bombs() -> Result<(), Box<dyn std::error::Error>> {
        let bomb = "x".repeat(MAX_LOG_BYTES + 1);
        assert_eq!(encode_log(&bomb), Err(LogError::TooLarge));
        let mut header = encode_log("x")?[..HEADER_BYTES].to_vec();
        header.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(
            bomb.as_bytes(),
            9,
        ));
        assert!(matches!(
            decode_log(&header),
            Err(LogError::InvalidCompression(_))
        ));

        Ok(())
    }

    #[test]
    fn maximum_log_size_roundtrips() -> Result<(), Box<dyn std::error::Error>> {
        let text = "x".repeat(MAX_LOG_BYTES);
        assert_eq!(decode_log(&encode_log(&text)?)?, text);

        Ok(())
    }
}
