use super::{
    Document, Filter, PreparedQuery, Statistics, build, compress_directory,
    parse_compressed_directory, parse_header,
};
use std::collections::BTreeMap;

fn frame(payload: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut bytes = b"RAIODIR3".to_vec();
    bytes.extend_from_slice(&4096_u32.to_le_bytes());
    bytes.extend_from_slice(&u32::try_from(payload.len())?.to_le_bytes());
    let mut checksum = crc32fast::Hasher::new();
    checksum.update(&bytes);
    checksum.update(payload);
    bytes.extend_from_slice(&checksum.finalize().to_le_bytes());
    bytes.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(payload, 3));
    Ok(bytes)
}

#[test]
fn unrequested_terms_are_still_validated() -> Result<(), Box<dyn std::error::Error>> {
    let query = PreparedQuery::new(
        Statistics {
            documents: 1,
            title_length: 0,
            body_length: 1,
            frequencies: BTreeMap::new(),
        },
        "missing",
        "any".into(),
        10,
        Vec::new(),
    )?;
    let valid = vec![
        1, 1, 1, b'a', 0, 0, 1, 2, b'{', b'}', 0, 0, 0, 1, 1, b'z', 1, 1, 0, 0, 1, 0, 1, 0, 1, 0,
        1, 0, 1,
    ];
    let encoded = frame(&valid)?;
    assert_eq!(
        parse_compressed_directory(&encoded, 4096, 40 * 1024 * 1024)?
            .terms
            .len(),
        1
    );
    let selected = query.ranker_compressed(&encoded, 4096, 40 * 1024 * 1024, &[])?;
    assert!(selected.header.terms.is_empty());
    assert_eq!(selected.header.documents.len(), 1);
    for (index, value) in [(16, 2), (19, 1), (18, 1), (15, 255), (0, 2)] {
        let mut payload = valid.clone();
        payload[index] = value;
        let encoded = frame(&payload)?;
        assert!(parse_compressed_directory(&encoded, 4096, 40 * 1024 * 1024).is_err());
        assert!(
            query
                .ranker_compressed(&encoded, 4096, 40 * 1024 * 1024, &[])
                .is_err()
        );
    }
    let mut excessive_count = valid.clone();
    excessive_count.splice(20..21, [129, 1]);
    let encoded = frame(&excessive_count)?;
    assert!(
        query
            .ranker_compressed(&encoded, 4096, 40 * 1024 * 1024, &[])
            .is_err()
    );
    for end in 0..valid.len() {
        let encoded = frame(&valid[..end])?;
        assert!(
            query
                .ranker_compressed(&encoded, 4096, 40 * 1024 * 1024, &[])
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn selected_rankers_preserve_documents_scores_filters_tombstones_and_modes()
-> Result<(), Box<dyn std::error::Error>> {
    let built = build(
        (0..300)
            .map(|index| Document {
                id: format!("ação{index:04}"),
                revision: index,
                title: "common".into(),
                text: format!("alpha beta unique{index} ação 日本語"),
                attributes: BTreeMap::from([("group".into(), serde_json::json!(index % 3))]),
                vector: None,
            })
            .collect(),
    )?;
    let base = parse_header(&built.bytes)?.1;
    let encoded = compress_directory(&built.bytes[..base])?;
    let header = built.header;
    let statistics = Statistics {
        documents: 300,
        title_length: header.total_title_length,
        body_length: header.total_body_length,
        frequencies: header
            .terms
            .iter()
            .map(|(term, meta)| (term.clone(), u64::from(meta.df)))
            .collect(),
    };
    for text in [
        "alpha",
        "beta alpha",
        "unique17 alpha",
        "absent alpha",
        "alpha alpha beta",
        "AÇÃO 日本語",
    ] {
        for mode in ["any", "all", "phrase"] {
            for filtered in [false, true] {
                let mut filters = Vec::new();
                if filtered {
                    filters.push(Filter {
                        field: "group".into(),
                        op: "eq".into(),
                        value: serde_json::json!(1),
                    });
                }
                let query = PreparedQuery::new(statistics.clone(), text, mode.into(), 10, filters)?;
                for dead in [Vec::new(), vec![0, 19, 129]] {
                    let mut full = query.ranker(header.clone(), &dead)?;
                    let mut selected =
                        query.ranker_compressed(&encoded, base, 40 * 1024 * 1024, &dead)?;
                    assert_eq!(
                        serde_json::to_string(&full.header.documents)?,
                        serde_json::to_string(&selected.header.documents)?
                    );
                    assert!(selected.header.terms.len() <= query.terms.order.len());
                    assert!(selected.header.heap_bytes() < header.heap_bytes());
                    for index in &query.terms.order {
                        let term = &query.terms.words[*index];
                        let Some(metadata) = header.terms.get(term) else {
                            continue;
                        };
                        for block in &metadata.blocks {
                            let start = base + block.data.offset as usize;
                            let end = start + block.data.length as usize;
                            full.add(term, &built.bytes[start..end])?;
                            selected.add(term, &built.bytes[start..end])?;
                        }
                    }
                    assert_eq!(full.finish()?, selected.finish()?);
                }
            }
        }
    }
    Ok(())
}
