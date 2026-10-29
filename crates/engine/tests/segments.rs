use raio_engine::segment::{self, Document, Filter, Header, Search, Statistics};
use std::collections::{BTreeMap, BTreeSet};

fn document(id: impl Into<String>, text: impl Into<String>) -> Document {
    Document::native(id, 0, String::new(), text, BTreeMap::new(), None)
}

fn role_text(
    document: &Document,
    role: segment::NativeRole,
) -> Result<&str, Box<dyn std::error::Error>> {
    match document.column(segment::ColumnId::Role(role)) {
        Some(segment::ColumnValue::Text(text)) => Ok(text),
        _ => Err("missing native text role".into()),
    }
}

fn role_words(document: &Document, role: segment::NativeRole) -> Vec<&str> {
    match document.column(segment::ColumnId::Role(role)) {
        Some(segment::ColumnValue::Text(text)) => text.split_whitespace().collect(),
        _ => Vec::new(),
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
            .map(|(term, meta)| (term.to_owned(), u64::from(meta.df)))
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
    let built = segment::build(docs, None)?;
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
        .map(|hit| {
            (
                header.documents.row(hit.row as usize).id.to_string(),
                hit.score,
            )
        })
        .collect())
}

#[test]
fn object_ranges_are_self_contained_and_crc_checked() -> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(
        vec![document("b", "ação cloudflare"), document("a", "rust rust")],
        None,
    )?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    assert_eq!(header.documents.row(0).id, "a");
    for metadata in header.documents.iter() {
        let start = base + metadata.data.offset as usize;
        let mut page = built.bytes[start..start + metadata.data.length as usize].to_vec();
        let query: serde_json::Value =
            serde_json::from_str(&segment::query_document_from_metadata(&page)?)?;
        assert_eq!(query["id"].as_str(), Some(metadata.id));
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
    title
        .columns_mut()
        .set_text(segment::NativeRole::Title, "cloudflare".into())?;
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
        .columns_mut()
        .attributes_mut()
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
    assert_eq!(
        search(vec![document("a", "rust")], "rust", "any", &[0], &[], 10)?,
        Vec::<(String, f64)>::new()
    );

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
                doc.columns_mut()
                    .set_text(segment::NativeRole::Title, "alpha title".into())?;
            }
            Ok(doc)
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    let built = segment::build(docs.clone(), None)?;
    let stats = statistics(&built.header);
    let mut expected: Vec<_> = docs
        .iter()
        .map(|doc| {
            let title = raio_engine::normalize_text(role_text(doc, segment::NativeRole::Title)?);
            let body = raio_engine::normalize_text(role_text(doc, segment::NativeRole::Text)?);
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
    let built = segment::build(docs, None)?;
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
        let mut bytes = b"RAIOSEG3".to_vec();
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
            doc.columns_mut().attributes_mut().insert(
                "group".into(),
                serde_json::json!(!(128..384).contains(&index)),
            );
            doc
        })
        .collect();
    let built = segment::build(docs, None)?;
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
            doc.columns_mut().attributes_mut().insert(
                "group".into(),
                serde_json::json!(!(128..256).contains(&index)),
            );
            doc
        })
        .collect();
    let built = segment::build(docs, None)?;
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
    assert_eq!(
        segment::bloom_filter_many(&[], &[0], &values)?,
        Vec::<Vec<&str>>::new()
    );
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
                doc.columns_mut()
                    .set_text(segment::NativeRole::Title, "alpha beta".into())?;
            }
            doc.columns_mut()
                .attributes_mut()
                .insert("group".into(), serde_json::json!(index % 4));
            Ok(doc)
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
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
                            let title = role_words(doc, segment::NativeRole::Title);
                            let body = role_words(doc, segment::NativeRole::Text);
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
    assert_eq!(
        search(
            vec![document("a", "alpha"), document("b", "beta")],
            "alpha beta",
            "all",
            &[],
            &[],
            10
        )?,
        Vec::<(String, f64)>::new()
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
    let built = segment::build(docs, None)?;
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
        None,
    )?;
    let (original, length) = segment::parse_header(&built.bytes)?;
    let canonical = segment::parse_directory(&built.bytes[..length], length)?;
    assert_eq!(
        serde_json::to_value(&original)?,
        serde_json::to_value(canonical)?
    );
    assert!(segment::parse_directory(&built.bytes, built.bytes.len()).is_err());
    assert!(segment::parse_directory(&built.bytes[..length], length + 1).is_err());
    for end in 0..length {
        assert!(segment::parse_directory(&built.bytes[..end], length).is_err());
    }
    for index in [0, 8, 12, 16, length - 1] {
        let mut damaged = built.bytes[..length].to_vec();
        damaged[index] ^= 1;
        assert!(segment::parse_directory(&damaged, length).is_err());
    }
    let encoded = segment::compress_directory(&built.bytes[..length])?;
    let decoded = segment::parse_compressed_directory(&encoded, length, 40 * 1024 * 1024)?;
    assert_eq!(
        serde_json::to_value(original)?,
        serde_json::to_value(decoded)?
    );
    assert!(encoded.len() < length);
    assert!(segment::compress_directory(&built.bytes).is_err());
    assert!(segment::parse_compressed_directory(&encoded, length + 1, 40 * 1024 * 1024).is_err());
    for end in 0..encoded.len() {
        assert!(
            segment::parse_compressed_directory(&encoded[..end], length, 40 * 1024 * 1024).is_err()
        );
    }
    for index in [0, 8, 12, 16, encoded.len() - 1] {
        let mut damaged = encoded.clone();
        damaged[index] ^= 1;
        assert!(segment::parse_compressed_directory(&damaged, length, 40 * 1024 * 1024).is_err());
    }
    let compact = miniz_oxide::inflate::decompress_to_vec_zlib(&encoded[20..])
        .map_err(|cause| cause.to_string())?;
    let mut payload = compact;
    payload[0] = 3;
    let mut forged = encoded[..12].to_vec();
    forged.extend_from_slice(&u32::try_from(payload.len())?.to_le_bytes());
    let mut checksum = crc32fast::Hasher::new();
    checksum.update(&forged);
    checksum.update(&payload);
    forged.extend_from_slice(&checksum.finalize().to_le_bytes());
    forged.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(&payload, 3));
    assert!(segment::parse_compressed_directory(&forged, length, 40 * 1024 * 1024).is_err());
    let mut legacy = encoded.clone();
    legacy[..8].copy_from_slice(b"RAIODIR2");
    assert!(segment::parse_compressed_directory(&legacy, length, 40 * 1024 * 1024).is_err());
    let mut oversized = encoded.clone();
    oversized[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(
        segment::parse_compressed_directory(&oversized, u32::MAX as usize, 40 * 1024 * 1024)
            .is_err()
    );
    let mut undersized = encoded;
    undersized[8..12].copy_from_slice(&16_u32.to_le_bytes());
    assert!(segment::parse_compressed_directory(&undersized, 16, 40 * 1024 * 1024).is_err());
    Ok(())
}

#[test]
fn compressed_directories_exceed_the_separate_mutation_log_budget()
-> Result<(), Box<dyn std::error::Error>> {
    let documents = (0..260)
        .map(|index| {
            let mut doc = document(format!("large{index:04}"), "rust");
            doc.columns_mut().attributes_mut().insert(
                "context".into(),
                serde_json::Value::String("x".repeat(8192)),
            );
            doc
        })
        .collect();
    let built = segment::build(documents, None)?;
    let (_, length) = segment::parse_header(&built.bytes)?;
    assert!(length > raio_engine::MAX_LOG_BYTES);
    let compressed = segment::compress_directory(&built.bytes[..length])?;
    let decoded = segment::parse_compressed_directory(&compressed, length, 40 * 1024 * 1024)?;
    assert_eq!(decoded.documents.len(), 260);
    assert_eq!(decoded.documents.row(0).id, "large0000");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(decoded.documents.row(0).attributes.get())?["context"],
        "x".repeat(8192)
    );
    Ok(())
}

#[test]
fn decoded_term_maps_match_native_serde_order_and_duplicate_semantics()
-> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(
        vec![document("a", "alpha beta gamma delta epsilon zeta")],
        None,
    )?;
    let encoded = serde_json::to_string(&built.header)?;
    let original: BTreeMap<String, Box<serde_json::value::RawValue>> =
        serde_json::from_str(&encoded)?;
    let entries = built
        .header
        .terms
        .iter()
        .map(|(term, meta)| {
            Ok(format!(
                "{}:{}",
                serde_json::to_string(term)?,
                serde_json::to_string(meta)?
            ))
        })
        .collect::<Result<Vec<_>, serde_json::Error>>()?;
    let alpha = built.header.terms.get("alpha").ok_or("Missing alpha")?;
    let mut changed = alpha.clone();
    changed.df = 19;
    let changed = serde_json::to_string(&changed)?;
    let canonical = entries.join(",");
    let reversed = entries.iter().rev().cloned().collect::<Vec<_>>().join(",");
    for dictionary in [
        format!("{{{canonical}}}"),
        format!("{{{reversed}}}"),
        format!("{{\"alpha\":{changed},{canonical}}}"),
        format!("{{{canonical},\"alpha\":{changed}}}"),
        format!("{{\"\\u0061lpha\":{changed},{canonical},\"alpha\":{changed}}}"),
        String::from("{}"),
    ] {
        let expected: BTreeMap<String, segment::TermMeta> = serde_json::from_str(&dictionary)?;
        let mut fields = original.clone();
        fields.insert(
            String::from("terms"),
            serde_json::value::RawValue::from_string(dictionary)?,
        );
        let encoded = serde_json::to_string(&fields)?;
        for decoded in [
            serde_json::from_str::<Header>(&encoded)?,
            serde_json::from_slice::<Header>(encoded.as_bytes())?,
            serde_json::from_reader::<_, Header>(std::io::Cursor::new(encoded.as_bytes()))?,
        ] {
            assert_eq!(
                serde_json::to_string(&decoded.terms)?,
                serde_json::to_string(&expected)?
            );
            assert_eq!(decoded.documents.len(), built.header.documents.len());
        }
    }
    Ok(())
}

#[test]
fn decoded_term_maps_reject_invalid_entries_and_object_framing()
-> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(vec![document("a", "alpha")], None)?;
    let original: BTreeMap<String, Box<serde_json::value::RawValue>> =
        serde_json::from_str(&serde_json::to_string(&built.header)?)?;
    for dictionary in [
        "[]",
        "null",
        "{\"alpha\":{}}",
        "{\"alpha\":{\"df\":-1,\"blocks\":[]}}",
        "{\"alpha\":{\"df\":4294967296,\"blocks\":[]}}",
        "{\"alpha\":{\"df\":1,\"blocks\":[false]}}",
        "{\"alpha\":{\"df\":1,\"df\":2,\"blocks\":[]}}",
    ] {
        let mut fields = original.clone();
        fields.insert(
            String::from("terms"),
            serde_json::value::RawValue::from_string(dictionary.into())?,
        );
        assert!(serde_json::from_str::<Header>(&serde_json::to_string(&fields)?).is_err());
    }
    Ok(())
}

#[test]
fn prepared_queries_reuse_global_terms_without_retaining_segment_tombstones()
-> Result<(), Box<dyn std::error::Error>> {
    let sources = [
        segment::build(
            vec![
                document("a", "alpha beta alpha"),
                document("b", "beta alpha"),
                document("c", "alpha beta"),
            ],
            None,
        )?,
        segment::build(
            vec![
                document("d", "beta beta"),
                document("e", "alpha beta alpha"),
                document("f", "alpha"),
            ],
            None,
        )?,
    ];
    for mode in ["any", "all", "phrase"] {
        for documents in [6, 19] {
            let global = Statistics {
                documents,
                title_length: 0,
                body_length: 15,
                frequencies: BTreeMap::from([
                    (String::from("alpha"), 5),
                    (String::from("beta"), 5),
                ]),
            };
            let prepared = segment::PreparedQuery::new(
                global.clone(),
                "alpha beta alpha",
                mode.into(),
                10,
                Vec::new(),
            )?;
            for (source, dead) in sources.iter().zip([vec![0], vec![1]]) {
                let (header, base) = segment::parse_header(&source.bytes)?;
                for dead in [dead, Vec::new()] {
                    let mut normal = Search::new(
                        header.clone(),
                        global.clone(),
                        "alpha beta alpha",
                        mode,
                        10,
                        &dead,
                        &[],
                    )?;
                    let mut shared = prepared.ranker(header.clone(), &dead)?;
                    for term in ["alpha", "beta"] {
                        if let Some(metadata) = header.terms.get(term) {
                            for block in &metadata.blocks {
                                let start = base + block.data.offset as usize;
                                let bytes =
                                    &source.bytes[start..start + block.data.length as usize];
                                normal.add(term, bytes)?;
                                shared.add(term, bytes)?;
                            }
                        }
                    }
                    let expected = normal
                        .finish()?
                        .into_iter()
                        .map(|hit| (hit.row, hit.score.to_bits()))
                        .collect::<Vec<_>>();
                    let actual = shared
                        .finish()?
                        .into_iter()
                        .map(|hit| (hit.row, hit.score.to_bits()))
                        .collect::<Vec<_>>();
                    assert_eq!(actual, expected);
                }
            }
        }
    }
    Ok(())
}

#[test]
fn retained_directories_release_unused_document_capacity() -> Result<(), Box<dyn std::error::Error>>
{
    for count in [513, 5000] {
        let built = segment::build(
            (0..count)
                .map(|index| document(format!("{index:05}"), format!("alpha unique{index}")))
                .collect(),
            None,
        )?;
        let expected = serde_json::to_string(&built.header)?;
        let (canonical, length) = segment::parse_header(&built.bytes)?;
        let frame = segment::compress_directory(&built.bytes[..length])?;
        let compressed = segment::parse_compressed_directory(&frame, length, 40 * 1024 * 1024)?;
        for directory in [canonical, compressed] {
            assert_eq!(serde_json::to_string(&directory)?, expected);
            assert_eq!(directory.documents.len(), count);
            assert_eq!(directory.documents.capacity(), count);
        }
    }
    Ok(())
}

#[test]
fn compact_term_dictionary_preserves_map_order_duplicates_and_lookup()
-> Result<(), Box<dyn std::error::Error>> {
    let encoded = r#"{"z":{"df":1,"blocks":[]},"a":{"df":2,"blocks":[]},"é":{"df":3,"blocks":[]},"z":{"df":4,"blocks":[]}}"#;
    let mut expected: BTreeMap<String, segment::TermMeta> = serde_json::from_str(encoded)?;
    let mut actual: segment::TermDictionary = serde_json::from_str(encoded)?;
    assert_eq!(actual.len(), expected.len());
    assert!(!actual.is_empty());
    assert_eq!(serde_json::to_vec(&actual)?, serde_json::to_vec(&expected)?);
    for term in ["", "a", "b", "z", "é", "missing"] {
        assert_eq!(
            serde_json::to_vec(&actual.get(term))?,
            serde_json::to_vec(&expected.get(term))?,
        );
    }
    actual.get_mut("a").ok_or("Missing dictionary entry")?.df = 9;
    expected.get_mut("a").ok_or("Missing oracle entry")?.df = 9;
    assert_eq!(serde_json::to_vec(&actual)?, serde_json::to_vec(&expected)?);
    assert_eq!(
        actual.keys().collect::<Vec<_>>(),
        expected.keys().collect::<Vec<_>>(),
    );
    assert_eq!(
        actual.values().map(|term| term.df).collect::<Vec<_>>(),
        expected.values().map(|term| term.df).collect::<Vec<_>>(),
    );
    let empty: segment::TermDictionary = serde_json::from_str("{}")?;
    assert!(empty.is_empty());
    assert!(empty.get("a").is_none());
    assert_eq!(serde_json::to_string(&empty)?, "{}");
    Ok(())
}

#[test]
fn canonical_headers_reuse_compact_tuples_and_preserve_object_readers()
-> Result<(), Box<dyn std::error::Error>> {
    let mut first = document("ação", "rust busca frase");
    first.revision = u64::MAX;
    first
        .columns_mut()
        .set_text(segment::NativeRole::Title, "日本語 😀".into())?;
    first
        .columns_mut()
        .attributes_mut()
        .insert("escape\nkey".into(), serde_json::json!("á\n😀"));
    let built = segment::build(vec![first, document("𐀀", "rust storage")], None)?;
    assert_eq!(built.bytes[16], b'[');
    let (compact, base) = segment::parse_header(&built.bytes)?;
    assert_eq!(
        serde_json::to_string(&compact)?,
        serde_json::to_string(&built.header)?
    );
    let json = serde_json::to_vec(&built.header)?;
    assert!(base < json.len() + 16);
    let mut object = b"RAIOSEG3".to_vec();
    object.extend_from_slice(&u32::try_from(json.len())?.to_le_bytes());
    object.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
    object.extend_from_slice(&json);
    object.extend_from_slice(&built.bytes[base..]);
    let (original, original_base) = segment::parse_header(&object)?;
    assert_eq!(
        serde_json::to_string(&original)?,
        serde_json::to_string(&compact)?
    );
    assert_eq!(&object[original_base..], &built.bytes[base..]);
    Ok(())
}

#[test]
fn unordered_unicode_query_terms_reject_unknown_pages_before_decode()
-> Result<(), Box<dyn std::error::Error>> {
    let built = segment::build(vec![document("match", "中文 rust rust éclair Ωμέγα")], None)?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    for mode in ["any", "all", "phrase"] {
        let mut ranker = Search::new(
            header.clone(),
            statistics(&header),
            "中文 rust rust éclair Ωμέγα",
            mode,
            10,
            &[],
            &[],
        )?;
        for term in ["rustx", "RUST", "中文x", "éclair", "missing"] {
            assert_eq!(
                ranker.add(term, &[]),
                Err("Unrequested posting term".into())
            );
        }
        for (term, metadata) in header.terms.iter().collect::<Vec<_>>().into_iter().rev() {
            for block in &metadata.blocks {
                let start = base + block.data.offset as usize;
                ranker.add(
                    term,
                    &built.bytes[start..start + block.data.length as usize],
                )?;
            }
        }
        let hits = ranker.finish()?;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row, 0);
    }
    Ok(())
}
