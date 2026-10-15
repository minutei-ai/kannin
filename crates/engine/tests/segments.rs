use raio_engine::segment::{self, Document, Filter, Header, Search, Statistics};
use std::collections::{BTreeMap, BTreeSet};

fn document(id: impl Into<String>, text: impl Into<String>) -> Document {
    Document {
        id: id.into(),
        revision: 0,
        title: String::new(),
        text: text.into(),
        attributes: BTreeMap::new(),
        vector: None,
    }
}

fn statistics(header: &Header) -> Statistics {
    Statistics {
        documents: header.documents.len() as u64,
        title_length: header.total_title_length,
        body_length: header.total_body_length,
        frequencies: header
            .terms
            .iter()
            .map(|(term, meta)| (term.clone(), u64::from(meta.df)))
            .collect(),
    }
}

fn search(
    docs: Vec<Document>,
    query: &str,
    mode: &str,
    dead: &[u32],
    filters: &[Filter],
    k: usize,
) -> Result<Vec<(String, f64)>, Box<dyn std::error::Error>> {
    let built = segment::build(docs)?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    let mut search = Search::new(
        header.clone(),
        statistics(&header),
        query,
        mode,
        k,
        dead,
        filters,
    )?;
    let terms: BTreeSet<_> = search.words.iter().cloned().collect();
    for term in terms {
        if let Some(meta) = header.terms.get(&term) {
            for block in &meta.blocks {
                let start = base + block.data.offset as usize;
                let end = start + block.data.length as usize;
                search.add(&term, &built.bytes[start..end])?;
            }
        }
    }
    Ok(search
        .finish()?
        .into_iter()
        .map(|hit| (header.documents[hit.row as usize].id.clone(), hit.score))
        .collect())
}

#[test]
fn object_ranges_are_self_contained_and_crc_checked() -> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(vec![
        document("b", "ação cloudflare"),
        document("a", "rust rust"),
    ])?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    assert_eq!(header.documents[0].id, "a");
    for metadata in &header.documents {
        let start = base + metadata.data.offset as usize;
        let mut page = built.bytes[start..start + metadata.data.length as usize].to_vec();
        let decoded: Document = serde_json::from_slice(&segment::decode_page(&page)?)?;
        assert_eq!(decoded.id, metadata.id);
        page[4] ^= 1;
        assert!(segment::decode_page(&page).is_err());
    }
    for index in 0..16 {
        assert!(segment::parse_header(&built.bytes[..index]).is_err());
    }

    Ok(())
}

#[test]
fn bm25_rewards_frequency_and_penalizes_unrelated_length() -> Result<(), Box<dyn std::error::Error>>
{
    let hits = search(
        vec![
            document("a", "rust rust rust"),
            document("b", format!("rust {}", "unrelated ".repeat(100))),
            document("c", "missing"),
        ],
        "rust",
        "any",
        &[],
        &[],
        10,
    )?;
    assert_eq!(
        hits.iter().map(|hit| hit.0.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert!(hits[0].1 > hits[1].1);

    Ok(())
}

#[test]
fn phrase_positions_preserve_repeated_words_and_field_boundaries()
-> Result<(), Box<dyn std::error::Error>> {
    let mut title = document("split", "rust");
    title.title = "cloudflare".into();
    let docs = vec![
        document("repeated", "rust rust worker"),
        document("separated", "rust cloudflare rust"),
        title,
    ];
    assert_eq!(
        search(docs.clone(), "rust rust", "phrase", &[], &[], 10)?
            .iter()
            .map(|h| h.0.as_str())
            .collect::<Vec<_>>(),
        vec!["repeated"]
    );
    assert_eq!(
        search(docs, "cloudflare rust", "phrase", &[], &[], 10)?
            .iter()
            .map(|hit| hit.0.as_str())
            .collect::<Vec<_>>(),
        vec!["separated"]
    );

    Ok(())
}

#[test]
fn tombstones_and_filters_apply_before_top_k() -> Result<(), Box<dyn std::error::Error>> {
    let mut allowed = document("b", "rust");
    allowed
        .attributes
        .insert("public".into(), serde_json::json!(true));
    let private = document("a", "rust rust rust");
    let filter = Filter {
        field: "public".into(),
        op: "eq".into(),
        value: serde_json::json!(true),
    };
    assert_eq!(
        search(vec![private, allowed], "rust", "any", &[], &[filter], 1)?[0].0,
        "b"
    );
    assert!(search(vec![document("a", "rust")], "rust", "any", &[0], &[], 10)?.is_empty());

    Ok(())
}

#[test]
fn filters_preserve_json_types_and_missing_values() -> Result<(), Box<dyn std::error::Error>> {
    let mut attrs = BTreeMap::new();
    attrs.insert("value".into(), serde_json::json!(1));
    attrs.insert("empty".into(), serde_json::Value::Null);
    assert!(!segment::matches(
        &attrs,
        &[Filter {
            field: "value".into(),
            op: "eq".into(),
            value: serde_json::json!(true)
        }]
    )?);
    assert!(segment::matches(
        &attrs,
        &[Filter {
            field: "empty".into(),
            op: "exists".into(),
            value: serde_json::json!(true)
        }]
    )?);
    assert!(!segment::matches(
        &attrs,
        &[Filter {
            field: "absent".into(),
            op: "eq".into(),
            value: serde_json::Value::Null
        }]
    )?);
    assert!(
        segment::matches(
            &attrs,
            &[Filter {
                field: "value".into(),
                op: "mystery".into(),
                value: serde_json::json!(1)
            }]
        )
        .is_err()
    );

    Ok(())
}

#[test]
fn block_pruning_matches_exhaustive_bm25_on_varied_documents()
-> Result<(), Box<dyn std::error::Error>> {
    let docs: Vec<_> = (0..1024)
        .map(|index| {
            let mut doc = document(
                format!("{index:05}"),
                format!(
                    "{} {} {}",
                    "alpha ".repeat(1 + index % 11),
                    "beta ".repeat(index % 7),
                    "padding ".repeat(index % 31)
                ),
            );
            if index % 3 == 0 {
                doc.title = "alpha title".into();
            }
            doc
        })
        .collect();
    let built = segment::build(docs.clone())?;
    let stats = statistics(&built.header);
    let mut expected: Vec<_> = docs
        .iter()
        .map(|doc| {
            let title = raio_engine::normalize_text(&doc.title);
            let body = raio_engine::normalize_text(&doc.text);
            let title_tokens: Vec<_> = title.split_whitespace().collect();
            let body_tokens: Vec<_> = body.split_whitespace().collect();
            let scores = ["alpha", "beta"]
                .iter()
                .map(|term| {
                    let a = f64::from(u32::try_from(
                        title_tokens.iter().filter(|word| **word == *term).count(),
                    )?);
                    let b = f64::from(u32::try_from(
                        body_tokens.iter().filter(|word| **word == *term).count(),
                    )?);
                    let n = f64::from(u32::try_from(stats.documents)?);
                    let title_mean = f64::from(u32::try_from(stats.title_length)?) / n;
                    let body_mean = f64::from(u32::try_from(stats.body_length)?) / n;
                    let tf = 2.0 * a
                        / (0.25
                            + 0.75 * f64::from(u32::try_from(title_tokens.len())?) / title_mean)
                        + b / (0.25
                            + 0.75 * f64::from(u32::try_from(body_tokens.len())?) / body_mean);
                    let df = f64::from(u32::try_from(stats.frequencies[*term])?);
                    Ok::<_, Box<dyn std::error::Error>>(
                        ((n - df + 0.5) / (df + 0.5)).ln_1p() * 2.2 * tf / (1.2 + tf),
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            let score = scores.into_iter().sum::<f64>();
            Ok::<_, Box<dyn std::error::Error>>((doc.id.clone(), score))
        })
        .collect::<Result<Vec<_>, _>>()?;
    expected.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for top_k in [1, 4, 8, 10, 64, 100] {
        let actual = search(docs.clone(), "alpha beta", "any", &[], &[], top_k)?;
        assert_eq!(
            actual.iter().map(|h| &h.0).collect::<Vec<_>>(),
            expected
                .iter()
                .take(top_k)
                .map(|h| &h.0)
                .collect::<Vec<_>>()
        );
        for (actual, expected) in actual.iter().zip(expected.iter()) {
            assert!((actual.1 - expected.1).abs() < 1e-10);
        }
    }

    Ok(())
}

#[test]
fn equal_score_blocks_preserve_exact_top_k_ties() -> Result<(), Box<dyn std::error::Error>> {
    let docs: Vec<_> = (0..2048)
        .map(|index| document(format!("{index:05}"), "equal terms"))
        .collect();
    for top_k in [1, 4, 8, 10, 64, 100] {
        let hits = search(docs.clone(), "equal terms", "any", &[], &[], top_k)?;
        assert_eq!(
            hits.iter().map(|h| h.0.clone()).collect::<Vec<_>>(),
            (0..top_k)
                .map(|index| format!("{index:05}"))
                .collect::<Vec<_>>()
        );
    }

    Ok(())
}

#[test]
fn posting_directory_rejects_reordered_and_overlapping_rows()
-> Result<(), Box<dyn std::error::Error>> {
    let docs = (0..512)
        .map(|index| document(format!("{index:05}"), "alpha beta"))
        .collect();
    let built = segment::build(docs)?;
    for overlap in [false, true] {
        let mut header: serde_json::Value = serde_json::to_value(&built.header)?;
        let blocks = header["terms"]["alpha"]["blocks"]
            .as_array_mut()
            .ok_or("Missing blocks")?;
        if overlap {
            blocks[1]["first"] = blocks[0]["last"].clone();
        } else {
            blocks.swap(0, 1);
        }
        let json = serde_json::to_vec(&header)?;
        let mut bytes = b"RAIOSEG1".to_vec();
        bytes.extend_from_slice(&u32::try_from(json.len())?.to_le_bytes());
        bytes.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
        bytes.extend_from_slice(&json);
        assert_eq!(
            segment::parse_header(&bytes).err().as_deref(),
            Some("Posting block rows are not strictly ordered")
        );
    }
    Ok(())
}

#[test]
fn eligible_posting_spans_preserve_scores_across_gaps_and_tombstones()
-> Result<(), Box<dyn std::error::Error>> {
    let docs = (0..512)
        .map(|index| {
            let mut doc = document(format!("{index:05}"), "alpha beta alpha");
            doc.attributes.insert(
                "group".into(),
                serde_json::json!(!(128..384).contains(&index)),
            );
            doc
        })
        .collect();
    let built = segment::build(docs)?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    let filters = [Filter {
        field: "group".into(),
        op: "eq".into(),
        value: serde_json::json!(true),
    }];
    for mode in ["any", "all", "phrase"] {
        for dead in [Vec::new(), (0..128).collect()] {
            let mut selected = Search::new(
                header.clone(),
                statistics(&header),
                "alpha beta alpha",
                mode,
                100,
                &dead,
                &filters,
            )?;
            let mut exhaustive = Search::new(
                header.clone(),
                statistics(&header),
                "alpha beta alpha",
                mode,
                100,
                &dead,
                &filters,
            )?;
            let spans = selected.posting_spans();
            assert_eq!(spans.len(), 2);
            assert_eq!(
                spans.iter().map(|span| span.blocks.len()).sum::<usize>(),
                if dead.is_empty() { 4 } else { 2 },
            );
            let pages: Vec<_> = spans
                .iter()
                .flat_map(|span| {
                    span.blocks.iter().map(|block| {
                        let start = base + block.data.offset as usize;
                        (
                            span.term.to_owned(),
                            start,
                            start + block.data.length as usize,
                        )
                    })
                })
                .collect();
            for (term, start, end) in pages {
                selected.add(&term, &built.bytes[start..end])?;
            }
            for (term, metadata) in &header.terms {
                for block in &metadata.blocks {
                    let start = base + block.data.offset as usize;
                    exhaustive.add(
                        term,
                        &built.bytes[start..start + block.data.length as usize],
                    )?;
                }
            }
            assert_eq!(selected.finish()?, exhaustive.finish()?);
        }
    }
    Ok(())
}

#[test]
fn posting_spans_bound_gap_overfetch() -> Result<(), Box<dyn std::error::Error>> {
    let docs = (0..384)
        .map(|index| {
            let mut doc = document(format!("{index:05}"), "alpha");
            doc.attributes.insert(
                "group".into(),
                serde_json::json!(!(128..256).contains(&index)),
            );
            doc
        })
        .collect();
    let built = segment::build(docs)?;
    for gap in [4096, 4097] {
        let mut header = built.header.clone();
        let metadata = header.terms.get_mut("alpha").ok_or("Missing term")?;
        metadata.blocks[0].data.offset = 0;
        metadata.blocks[0].data.length = 10;
        metadata.blocks[2].data.offset = 10 + gap;
        let selected = Search::new(
            header,
            statistics(&built.header),
            "alpha",
            "any",
            10,
            &[],
            &[Filter {
                field: "group".into(),
                op: "eq".into(),
                value: serde_json::json!(true),
            }],
        )?;
        let spans = selected.posting_spans();
        assert_eq!(spans.len(), if gap == 4096 { 1 } else { 2 });
        assert_eq!(spans.iter().map(|span| span.blocks.len()).sum::<usize>(), 2);
    }
    Ok(())
}

#[test]
fn bloom_filters_have_no_false_negatives_and_bounded_false_positives()
-> Result<(), Box<dyn std::error::Error>> {
    let values: Vec<_> = (0..1000).map(|index| format!("document-{index}")).collect();
    let bloom = segment::bloom_build(&values)?;
    for value in &values {
        assert!(segment::bloom_contains(&bloom, value)?);
    }
    let mut false_positives = 0;
    for index in 1000..11000 {
        if segment::bloom_contains(&bloom, &format!("document-{index}"))? {
            false_positives += 1;
        }
    }
    assert!(false_positives < 200, "{false_positives} false positives");

    Ok(())
}

#[test]
fn batched_blooms_match_independent_membership_and_reject_bad_framing()
-> Result<(), Box<dyn std::error::Error>> {
    let values: Vec<_> = (0..500).map(|index| format!("ação-{index}")).collect();
    let mut bytes = Vec::new();
    let mut offsets = vec![0];
    let mut blooms = Vec::new();
    for group in 0..64 {
        let entries: Vec<_> = (group..group + 500)
            .map(|index| format!("ação-{index}"))
            .collect();
        let bloom = segment::bloom_build(&entries)?;
        bytes.extend_from_slice(&bloom);
        offsets.push(u32::try_from(bytes.len())?);
        blooms.push(bloom);
    }
    let actual = segment::bloom_filter_many(&bytes, &offsets, &values)?;
    for (selected, bloom) in actual.iter().zip(&blooms) {
        let mut expected = Vec::new();
        for value in &values {
            if segment::bloom_contains(bloom, value)? {
                expected.push(value.as_str());
            }
        }
        assert_eq!(selected, &expected);
    }
    assert!(segment::bloom_filter_many(&bytes, &[0, 2, 1], &values).is_err());
    assert!(segment::bloom_filter_many(&bytes, &[1], &values).is_err());
    assert!(segment::bloom_filter_many(&bytes, &[0, u32::MAX], &values).is_err());
    assert!(segment::bloom_filter_many(&[], &[], &values).is_err());
    assert!(segment::bloom_filter_many(&[], &[0], &values)?.is_empty());
    Ok(())
}

#[test]
fn intersections_match_exhaustive_membership_and_phrase_positions()
-> Result<(), Box<dyn std::error::Error>> {
    let docs: Vec<_> = (0..64)
        .map(|index| {
            let body = match index % 7 {
                0 => "alpha beta gamma alpha",
                1 => "alpha gamma",
                2 => "beta gamma",
                3 => "alpha beta gamma",
                4 => "beta alpha beta gamma alpha",
                5 => "gamma alpha",
                _ => "gamma alpha beta gamma alpha",
            };
            let mut doc = document(format!("{index:03}"), body);
            if index % 7 == 5 {
                doc.title = "alpha beta".into();
            }
            doc.attributes
                .insert("group".into(), serde_json::json!(index % 4));
            doc
        })
        .collect();
    for dead in [vec![], vec![0, 7, 14, 21]] {
        for filters in [
            vec![],
            vec![Filter {
                field: "group".into(),
                op: "eq".into(),
                value: serde_json::json!(1),
            }],
        ] {
            let all = search(
                docs.clone(),
                "alpha beta gamma alpha",
                "any",
                &dead,
                &filters,
                100,
            )?;
            for mode in ["all", "phrase"] {
                let expected: Vec<_> = all
                    .iter()
                    .filter(|(id, _)| {
                        docs.iter().find(|doc| doc.id == *id).is_some_and(|doc| {
                            let title: Vec<_> = doc.title.split_whitespace().collect();
                            let body: Vec<_> = doc.text.split_whitespace().collect();
                            if mode == "all" {
                                return ["alpha", "beta", "gamma"]
                                    .iter()
                                    .all(|term| title.contains(term) || body.contains(term));
                            }
                            [title, body].iter().any(|tokens| {
                                tokens
                                    .windows(4)
                                    .any(|window| window == ["alpha", "beta", "gamma", "alpha"])
                            })
                        })
                    })
                    .cloned()
                    .collect();
                for k in [1, 10, 100] {
                    let actual = search(
                        docs.clone(),
                        "alpha beta gamma alpha",
                        mode,
                        &dead,
                        &filters,
                        k,
                    )?;
                    assert_eq!(actual, expected.iter().take(k).cloned().collect::<Vec<_>>());
                }
            }
        }
    }
    assert!(
        search(
            vec![document("a", "alpha"), document("b", "beta")],
            "alpha beta",
            "all",
            &[],
            &[],
            10
        )?
        .is_empty()
    );
    Ok(())
}

#[test]
fn cutoff_posting_spans_preserve_gap_budgets() -> Result<(), Box<dyn std::error::Error>> {
    let docs = (0..384)
        .map(|index| {
            let text = if (128..256).contains(&index) {
                format!("alpha {}", "padding ".repeat(1000))
            } else {
                "alpha".into()
            };
            document(format!("{index:05}"), text)
        })
        .collect();
    let built = segment::build(docs)?;
    let statistics = statistics(&built.header);
    let cutoff = segment::bm25(0, 1, 0, 1, &statistics, 384) * 0.9;
    for gap in [4096, 4097] {
        let mut header = built.header.clone();
        let metadata = header.terms.get_mut("alpha").ok_or("Missing term")?;
        metadata.blocks[0].data.offset = 0;
        metadata.blocks[0].data.length = 10;
        metadata.blocks[2].data.offset = 10 + gap;
        let selected = Search::new(header, statistics.clone(), "alpha", "any", 10, &[], &[])?;
        let spans = selected.posting_spans_after(cutoff, "")?;
        assert_eq!(spans.len(), if gap == 4096 { 1 } else { 2 });
        assert_eq!(spans.iter().map(|span| span.blocks.len()).sum::<usize>(), 2);
    }
    Ok(())
}

#[test]
fn compressed_directories_preserve_headers_and_reject_frame_corruption()
-> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(
        (0..100)
            .map(|index| {
                document(
                    format!("id{index:04}"),
                    format!("rust storage unique{index}"),
                )
            })
            .collect(),
    )?;
    let (original, length) = segment::parse_header(&built.bytes)?;
    let encoded = segment::compress_directory(&built.bytes[..length])?;
    let decoded = segment::parse_compressed_directory(&encoded, length)?;
    assert_eq!(
        &encoded[12..16],
        &crc32fast::hash(&built.bytes[..length]).to_le_bytes()
    );
    assert_eq!(
        serde_json::to_value(original)?,
        serde_json::to_value(decoded)?
    );
    assert!(encoded.len() < length);
    assert!(segment::compress_directory(&built.bytes).is_err());
    assert!(segment::parse_compressed_directory(&encoded, length + 1).is_err());
    for end in 0..encoded.len() {
        assert!(segment::parse_compressed_directory(&encoded[..end], length).is_err());
    }
    for index in [0, 8, 12, 16, encoded.len() - 1] {
        let mut damaged = encoded.clone();
        damaged[index] ^= 1;
        assert!(segment::parse_compressed_directory(&damaged, length).is_err());
    }
    let mut invalid_header = built.bytes[..length].to_vec();
    invalid_header[15] ^= 1;
    let mut forged = b"RAIODIR1".to_vec();
    forged.extend_from_slice(&u32::try_from(length)?.to_le_bytes());
    forged.extend_from_slice(&crc32fast::hash(&invalid_header).to_le_bytes());
    forged.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(
        &invalid_header,
        3,
    ));
    assert!(segment::parse_compressed_directory(&forged, length).is_err());

    let mut invalid_payload = built.bytes[..length].to_vec();
    let field = b"\"total_body_length\":";
    let value = invalid_payload
        .windows(field.len())
        .position(|bytes| bytes == field)
        .ok_or("Missing body length")?
        + field.len();
    let digit = invalid_payload
        .get_mut(value)
        .ok_or("Missing length digit")?;
    *digit = if *digit == b'9' { b'8' } else { b'9' };
    let mut forged_payload = encoded[..16].to_vec();
    forged_payload.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(
        &invalid_payload,
        3,
    ));
    assert!(segment::parse_compressed_directory(&forged_payload, length).is_err());
    forged_payload[12..16].copy_from_slice(&crc32fast::hash(&invalid_payload).to_le_bytes());
    assert!(segment::parse_compressed_directory(&forged_payload, length).is_err());
    let mut oversized = encoded.clone();
    oversized[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(segment::parse_compressed_directory(&oversized, u32::MAX as usize).is_err());
    let mut undersized = encoded;
    undersized[8..12].copy_from_slice(&16_u32.to_le_bytes());
    assert!(segment::parse_compressed_directory(&undersized, 16).is_err());
    Ok(())
}

#[test]
fn compressed_directories_exceed_the_separate_mutation_log_budget()
-> Result<(), Box<dyn std::error::Error>> {
    let documents = (0..260)
        .map(|index| {
            let mut doc = document(format!("large{index:04}"), "rust");
            doc.attributes.insert(
                "context".into(),
                serde_json::Value::String("x".repeat(8192)),
            );
            doc
        })
        .collect();
    let built = segment::build(documents)?;
    let (_, length) = segment::parse_header(&built.bytes)?;
    assert!(length > raio_engine::MAX_LOG_BYTES);
    let compressed = segment::compress_directory(&built.bytes[..length])?;
    let decoded = segment::parse_compressed_directory(&compressed, length)?;
    assert_eq!(decoded.documents.len(), 260);
    assert_eq!(decoded.documents[0].id, "large0000");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(decoded.documents[0].attributes.get())?["context"],
        "x".repeat(8192)
    );
    Ok(())
}
