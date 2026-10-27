use raio_engine::segment::{self, CommonDirectory, Document, Filter, PreparedQuery, Statistics};
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn common_directory_matches_full_positional_search_and_rejects_uncovered_terms()
-> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(
        (0_u32..512)
            .map(|index| Document {
                id: format!("row{index:04}"),
                revision: u64::from(index),
                title: "cloudflare rust".into(),
                text: format!(
                    "{} unique{index}",
                    "rust cloudflare rust ".repeat(1 + (index % 5) as usize)
                ),
                attributes: BTreeMap::from([("group".into(), serde_json::json!(index % 3))]),
                vector: None,
            })
            .collect(),
        None,
    )?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    let full_frame = segment::compress_directory(&built.bytes[..base])?;
    let frame = segment::compress_common_directory_segment(&built.bytes)?;
    assert_eq!(&frame[..8], b"RAIOCOM3");
    assert!(frame.len() < full_frame.len());
    assert!(segment::parse_compressed_directory(&frame, base, 40 * 1024 * 1024).is_err());
    assert!(CommonDirectory::compressed(&full_frame, base, 40 * 1024 * 1024).is_err());
    let projected = CommonDirectory::compressed(&frame, base, 40 * 1024 * 1024)?;
    assert!(projected.heap_bytes() < header.heap_bytes());
    assert!(CommonDirectory::compressed(&frame, base, projected.heap_bytes() - 1).is_err());
    for end in [0, 7, 19, frame.len() - 1] {
        assert!(CommonDirectory::compressed(&frame[..end], base, 40 * 1024 * 1024).is_err());
    }
    let mut corrupt = frame;
    corrupt[16] ^= 1;
    assert!(CommonDirectory::compressed(&corrupt, base, 40 * 1024 * 1024).is_err());
    let statistics = || Statistics {
        documents: 512,
        title_length: header.total_title_length,
        body_length: header.total_body_length,
        frequencies: header
            .terms
            .iter()
            .map(|(term, meta)| (term.to_owned(), u64::from(meta.df)))
            .collect(),
    };
    for mode in ["any", "all", "phrase"] {
        for text in [
            "cloudflare rust",
            "rust cloudflare rust",
            "RUST",
            "rust rust",
        ] {
            for filtered in [false, true] {
                let filters = if filtered {
                    vec![Filter {
                        field: "group".into(),
                        op: "eq".into(),
                        value: serde_json::json!(1),
                    }]
                } else {
                    Vec::new()
                };
                let query = PreparedQuery::new(statistics(), text, mode.into(), 100, filters)?;
                assert!(projected.covers(&query));
                for dead in [Vec::new(), (0..128).collect()] {
                    let mut full = query.ranker(header.clone(), &dead)?;
                    let partial = projected.ranker(&query, &dead)?;
                    let words: BTreeSet<_> = full.words.iter().cloned().collect();
                    for term in words {
                        let metadata = header.terms.get(&term).ok_or("Missing covered term")?;
                        for block in &metadata.blocks {
                            let start = base + block.data.offset as usize;
                            let bytes = &built.bytes[start..start + block.data.length as usize];
                            full.add(&term, bytes)?;
                        }
                    }
                    assert_eq!(full.finish()?, partial.finish()?);
                }
            }
        }
    }
    for text in ["unique1", "rust unique1", "absent", "rust absent"] {
        for mode in ["any", "all", "phrase"] {
            let query = PreparedQuery::new(statistics(), text, mode.into(), 10, Vec::new())?;
            assert!(!projected.covers(&query));
            assert!(projected.ranker(&query, &[]).is_err());
        }
    }
    Ok(())
}

#[test]
fn covering_common_headers_keep_uncached_terms_in_remaining_spans()
-> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(
        (0_u32..256)
            .map(|index| Document {
                id: format!("row{index:04}"),
                revision: 1,
                title: "common dense".into(),
                text: "dense ".repeat(512),
                attributes: BTreeMap::from([("group".into(), serde_json::json!(index % 2))]),
                vector: None,
            })
            .collect(),
        None,
    )?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    let header_only = segment::compress_common_directory(&built.bytes[..base])?;
    let cached = segment::compress_common_directory_segment(&built.bytes)?;
    for (bytes, expected_missing) in [
        (&header_only, vec!["common", "dense"]),
        (&cached, vec!["dense"]),
    ] {
        let common = CommonDirectory::compressed(bytes, base, 40 * 1024 * 1024)?;
        for mode in ["any", "all", "phrase"] {
            let query = PreparedQuery::new(
                Statistics {
                    documents: 256,
                    title_length: header.total_title_length,
                    body_length: header.total_body_length,
                    frequencies: header
                        .terms
                        .iter()
                        .map(|(term, metadata)| (term.to_owned(), u64::from(metadata.df)))
                        .collect(),
                },
                "common dense",
                mode.into(),
                10,
                vec![Filter {
                    field: "group".into(),
                    op: "eq".into(),
                    value: serde_json::json!(1),
                }],
            )?;
            assert!(common.covers(&query));
            let mut projected = common.ranker(&query, &[0, 7])?;
            let mut full = query.ranker(header.clone(), &[0, 7])?;
            let missing: BTreeSet<_> = projected
                .posting_spans()
                .iter()
                .map(|span| span.term.to_owned())
                .collect();
            assert_eq!(
                missing.iter().map(String::as_str).collect::<Vec<_>>(),
                expected_missing
            );
            for term in ["common", "dense"] {
                let metadata = header.terms.get(term).ok_or("Missing fixture term")?;
                for block in &metadata.blocks {
                    let start = base + block.data.offset as usize;
                    let page = &built.bytes[start..start + block.data.length as usize];
                    full.add(term, page)?;
                    if missing.contains(term) {
                        projected.add(term, page)?;
                    }
                }
            }
            assert_eq!(projected.finish()?, full.finish()?);
        }
    }
    Ok(())
}
