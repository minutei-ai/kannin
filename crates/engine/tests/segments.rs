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
    let actual = search(docs, "alpha beta", "any", &[], &[], 10)?;
    assert_eq!(
        actual.iter().map(|h| &h.0).collect::<Vec<_>>(),
        expected.iter().take(10).map(|h| &h.0).collect::<Vec<_>>()
    );
    for (actual, expected) in actual.iter().zip(expected.iter()) {
        assert!((actual.1 - expected.1).abs() < 1e-10);
    }

    Ok(())
}

#[test]
fn equal_score_blocks_preserve_exact_top_k_ties() -> Result<(), Box<dyn std::error::Error>> {
    let docs = (0..2048)
        .map(|index| document(format!("{index:05}"), "equal terms"))
        .collect();
    let hits = search(docs, "equal terms", "any", &[], &[], 10)?;
    assert_eq!(
        hits.iter().map(|h| h.0.clone()).collect::<Vec<_>>(),
        (0..10)
            .map(|index| format!("{index:05}"))
            .collect::<Vec<_>>()
    );

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
