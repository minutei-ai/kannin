use raio_engine::segment::{self, Document};
use std::collections::BTreeMap;

fn frame(payload: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut encoded = b"RAIODIR3".to_vec();
    encoded.extend_from_slice(&4096_u32.to_le_bytes());
    encoded.extend_from_slice(&u32::try_from(payload.len())?.to_le_bytes());
    let mut checksum = crc32fast::Hasher::new();
    checksum.update(&encoded);
    checksum.update(payload);
    encoded.extend_from_slice(&checksum.finalize().to_le_bytes());
    encoded.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(payload, 3));
    Ok(encoded)
}

#[test]
fn directory_budget_is_exact_and_unicode_and_u64_values_are_lossless()
-> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(
        (0..256)
            .map(|index| Document {
                id: format!("ação{index:04}😀"),
                revision: u64::MAX,
                title: "日本語 busca".into(),
                text: format!("rust busca unique{index}"),
                attributes: BTreeMap::from([
                    ("escape\nkey".into(), serde_json::json!("\0á😀")),
                    ("number".into(), serde_json::json!(-0.0)),
                ]),
                vector: None,
            })
            .collect(),
    )?;
    let mut header = built.header;
    header.total_title_length = u64::MAX;
    header.total_body_length = u64::MAX;
    let json = serde_json::to_vec(&header)?;
    let mut canonical = b"RAIOSEG1".to_vec();
    canonical.extend_from_slice(&u32::try_from(json.len())?.to_le_bytes());
    canonical.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
    canonical.extend_from_slice(&json);
    let encoded = segment::compress_directory(&canonical)?;
    let decoded = segment::parse_compressed_directory(&encoded, canonical.len(), 40 * 1024 * 1024)?;
    assert_eq!(
        serde_json::to_string(&header)?,
        serde_json::to_string(&decoded)?
    );
    let budget = decoded.heap_bytes();
    let exact = segment::parse_compressed_directory(&encoded, canonical.len(), budget)?;
    assert_eq!(exact.heap_bytes(), budget);
    assert!(segment::parse_compressed_directory(&encoded, canonical.len(), budget - 1).is_err());
    Ok(())
}

#[test]
fn directory_counts_are_rejected_before_reserving_unsupported_arrays()
-> Result<(), Box<dyn std::error::Error>> {
    for (payload, expected) in [
        (vec![1, 145, 78], "Directory document limit exceeded"),
        (vec![1, 0, 160, 194, 30, 0, 0], "Truncated directory terms"),
        (vec![255, 255, 255, 255, 16], "Overflowing varint"),
    ] {
        let encoded = frame(&payload)?;
        let result = segment::parse_compressed_directory(&encoded, 4096, 40 * 1024 * 1024);
        assert_eq!(result.err().ok_or("Invalid frame was accepted")?, expected);
    }
    Ok(())
}

#[test]
fn directory_rejects_invalid_strings_flags_order_overflows_and_trailing_data()
-> Result<(), Box<dyn std::error::Error>> {
    let valid = vec![1, 1, 1, b'a', 0, 0, 0, 2, b'{', b'}', 0, 0, 0, 0, 0, 0];
    let encoded = frame(&valid)?;
    assert!(segment::parse_compressed_directory(&encoded, 4096, 40 * 1024 * 1024).is_ok());
    for end in 0..valid.len() {
        let encoded = frame(&valid[..end])?;
        assert!(segment::parse_compressed_directory(&encoded, 4096, 40 * 1024 * 1024).is_err());
    }
    let mut invalid_utf8 = valid.clone();
    invalid_utf8[3] = 255;
    let mut invalid_flag = valid.clone();
    invalid_flag[12] = 2;
    let mut invalid_attributes = valid.clone();
    invalid_attributes[9] = b'[';
    let mut trailing = valid.clone();
    trailing.push(0);
    let mut overflowing_revision = valid;
    overflowing_revision.splice(4..5, [128, 128, 128, 128, 128, 128, 128, 128, 128, 2]);
    for payload in [
        invalid_utf8,
        vec![1, 0, 1, 1, 255, 0, 0, 0, 0],
        vec![1, 0, 1, 127, b'a', 0, 0, 0, 0],
        invalid_flag,
        invalid_attributes,
        trailing,
        overflowing_revision,
        vec![1, 0, 2, 1, b'b', 0, 0, 1, b'a', 0, 0, 0, 0],
        vec![1, 0, 2, 1, b'b', 0, 0, 1, b'b', 0, 0, 0, 0],
    ] {
        let encoded = frame(&payload)?;
        assert!(segment::parse_compressed_directory(&encoded, 4096, 40 * 1024 * 1024).is_err());
    }
    Ok(())
}

#[test]
fn pooled_terms_preserve_unicode_order_last_duplicate_and_independent_clones()
-> Result<(), Box<dyn std::error::Error>> {
    let mut dictionary: segment::TermDictionary = serde_json::from_str(
        r#"{"日本語":{"df":6,"blocks":[]},"a":{"df":1,"blocks":[]},"":{"df":0,"blocks":[]},"😀":{"df":7,"blocks":[]},"aé":{"df":3,"blocks":[]},"\u0061":{"df":2,"blocks":[]},"é":{"df":4,"blocks":[]}}"#,
    )?;
    assert_eq!(
        dictionary.keys().collect::<Vec<_>>(),
        ["", "a", "aé", "é", "日本語", "😀"]
    );
    assert_eq!(dictionary.get("a").ok_or("Missing duplicate term")?.df, 2);
    for absent in ["aa", "aê", "日", "日本語a", "😃"] {
        assert!(dictionary.get(absent).is_none());
        assert!(dictionary.get_mut(absent).is_none());
    }
    let cloned = dictionary.clone();
    dictionary
        .get_mut("日本語")
        .ok_or("Missing Unicode term")?
        .df = 9;
    assert_eq!(cloned.get("日本語").ok_or("Missing cloned term")?.df, 6);
    assert_eq!(dictionary.iter().len(), 6);
    assert_eq!((&dictionary).into_iter().len(), 6);
    assert_eq!(
        dictionary
            .iter()
            .map(|(key, metadata)| (key, metadata.df))
            .collect::<Vec<_>>(),
        (&dictionary)
            .into_iter()
            .map(|(key, metadata)| (key, metadata.df))
            .collect::<Vec<_>>()
    );
    let encoded = serde_json::to_string(&dictionary)?;
    let decoded: segment::TermDictionary = serde_json::from_str(&encoded)?;
    assert_eq!(serde_json::to_string(&decoded)?, encoded);
    assert_eq!(decoded.get("日本語").ok_or("Missing decoded term")?.df, 9);
    let empty: segment::TermDictionary = serde_json::from_str("{}")?;
    assert!(empty.is_empty());
    assert!(empty.get("").is_none());
    assert_eq!(empty.iter().len(), 0);
    Ok(())
}
