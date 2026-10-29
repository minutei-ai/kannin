use super::super::{
    COMMON_DIRECTORY_MAGIC_V4, CommonDirectory, DIRECTORY_MAGIC_V6, Document, DocumentColumnId,
    Filter, NativeRole, PostingShape, Search, Statistics, binary_directory, build,
    build_text_fields, build_versioned, compress_common_directory_segment, compress_directory,
    compress_directory_payload, decode_shaped_rows, document_terms, parse_compressed_directory,
    parse_header, put_int, rank_fields,
};
use super::NamedTextField;
use std::collections::{BTreeMap, BTreeSet};

fn rejection<T>(result: Result<T, String>) -> Result<String, String> {
    result.err().ok_or_else(|| "Unexpected success".to_owned())
}

fn tags(name: &str) -> DocumentColumnId {
    DocumentColumnId::attribute(name)
}

fn bare(attributes: BTreeMap<String, serde_json::Value>) -> Vec<Document> {
    vec![Document::native("a", 1, "title", "body", attributes, None)]
}

fn single(name: &str, value: serde_json::Value) -> Vec<Document> {
    bare(BTreeMap::from([(name.to_owned(), value)]))
}

fn varied_documents(count: u32) -> Vec<Document> {
    (0..count)
        .map(|index| {
            let title = if index % 3 == 0 { "red fox" } else { "red" };
            let repeated = "fox ".repeat(usize::from(u8::try_from(index % 4).unwrap_or(0)));
            Document::native(
                format!("row{index:04}"),
                1,
                title,
                format!("fox {repeated}"),
                BTreeMap::new(),
                None,
            )
        })
        .collect()
}

fn statistics_for(bytes: &[u8]) -> Result<Statistics, String> {
    let (header, _) = parse_header(bytes)?;
    Ok(Statistics {
        documents: u64::try_from(header.documents.len()).map_err(|cause| cause.to_string())?,
        title_length: header.total_title_length(),
        body_length: header.total_body_length(),
        frequencies: header
            .terms()
            .iter()
            .map(|(term, metadata)| (term.to_owned(), u64::from(metadata.df)))
            .collect(),
    })
}

fn page<'a>(
    bytes: &'a [u8],
    base: usize,
    block: &super::super::BlockMeta,
) -> Result<&'a [u8], String> {
    let start = base + block.data.offset as usize;
    bytes
        .get(start..start + block.data.length as usize)
        .ok_or_else(|| "Missing posting page".to_owned())
}

fn native_hits(
    bytes: &[u8],
    statistics: Statistics,
    text: &str,
    mode: &str,
    top_k: usize,
) -> Result<Vec<(String, u64)>, String> {
    let (header, base) = parse_header(bytes)?;
    let mut search = Search::new(header.clone(), statistics, text, mode, top_k, &[], &[])?;
    let normalized = crate::normalize_text(text);
    let terms = normalized.split_whitespace().collect::<BTreeSet<_>>();
    for term in terms {
        if let Some(metadata) = header.terms().get(term) {
            for block in &metadata.blocks {
                search.add(term, page(bytes, base, block)?)?;
            }
        }
    }
    Ok(search
        .finish()?
        .into_iter()
        .map(|hit| {
            (
                header.documents.row(hit.row as usize).id.to_owned(),
                hit.score.to_bits(),
            )
        })
        .collect())
}

fn selected_pages(
    bytes: &[u8],
    statistics: Statistics,
    text: &str,
    mode: &str,
) -> Result<Vec<(String, Vec<u32>)>, String> {
    let (header, _) = parse_header(bytes)?;
    let search = Search::new(header, statistics, text, mode, 10, &[], &[])?;
    Ok(search
        .posting_spans_seeded()?
        .into_iter()
        .map(|span| {
            (
                span.term.to_owned(),
                span.blocks.iter().map(|block| block.data.offset).collect(),
            )
        })
        .collect())
}

fn ranked_ids(
    bytes: &[u8],
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    top_k: usize,
    dead: &[u32],
    filters: &[Filter],
) -> Result<Vec<u32>, String> {
    Ok(
        rank_fields(bytes, fields, text, mode, top_k, dead, filters)?
            .into_iter()
            .map(|hit| hit.row)
            .collect(),
    )
}

#[test]
fn generic_pair_matches_legacy_scores_order_and_pruning_across_the_block_boundary()
-> Result<(), String> {
    for count in [127_u32, 128, 129, 300] {
        let documents = varied_documents(count);
        let legacy = build_versioned(documents.clone(), None, &[], 3)?;
        let generic = build(documents, None)?;
        assert_eq!(&legacy.bytes[..8], b"RAIOSEG3");
        assert_eq!(&generic.bytes[..8], b"RAIOSEG4");
        let (_, legacy_base) = parse_header(&legacy.bytes)?;
        let (_, generic_base) = parse_header(&generic.bytes)?;
        assert_eq!(
            legacy.bytes.get(legacy_base..),
            generic.bytes.get(generic_base..)
        );
        let statistics = statistics_for(&generic.bytes)?;
        for (text, mode) in [
            ("fox", "any"),
            ("red fox", "all"),
            ("fox fox", "any"),
            ("red fox", "phrase"),
        ] {
            assert_eq!(
                selected_pages(&legacy.bytes, statistics.clone(), text, mode)?,
                selected_pages(&generic.bytes, statistics.clone(), text, mode)?
            );
            for top_k in [1_usize, 10, 100] {
                assert_eq!(
                    native_hits(&legacy.bytes, statistics.clone(), text, mode, top_k)?,
                    native_hits(&generic.bytes, statistics.clone(), text, mode, top_k)?
                );
            }
        }
    }
    Ok(())
}

#[test]
fn mixed_version_segments_score_identically_under_shared_statistics() -> Result<(), String> {
    let documents = varied_documents(260);
    let (first, second) = documents.split_at(130);
    let whole = build(documents.clone(), None)?;
    let statistics = statistics_for(&whole.bytes)?;
    let mixed = [
        build_versioned(first.to_vec(), None, &[], 3)?,
        build(second.to_vec(), None)?,
    ];
    let uniform = [build(first.to_vec(), None)?, build(second.to_vec(), None)?];
    for (text, mode) in [("fox", "any"), ("red fox", "phrase"), ("red fox", "all")] {
        let collect = |segments: &[super::super::BuiltSegment; 2]| -> Result<Vec<_>, String> {
            let mut hits = Vec::new();
            for segment in segments {
                hits.extend(native_hits(
                    &segment.bytes,
                    statistics.clone(),
                    text,
                    mode,
                    100,
                )?);
            }
            Ok(hits)
        };
        assert_eq!(collect(&mixed)?, collect(&uniform)?);
    }
    Ok(())
}

#[test]
fn legacy_headers_synthesize_the_same_generic_native_pair() -> Result<(), String> {
    let documents = varied_documents(3);
    for version in [3, 4] {
        let built = build_versioned(documents.clone(), None, &[], version)?;
        let (header, _) = parse_header(&built.bytes)?;
        let ids = header
            .fields
            .iter()
            .map(|field| field.id().clone())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                DocumentColumnId::Role(NativeRole::Title),
                DocumentColumnId::Role(NativeRole::Text)
            ]
        );
        assert!(
            header
                .fields
                .iter()
                .all(|field| field.analysis().config().is_none())
        );
        assert_eq!(header.total_title_length(), 4);
        assert_eq!(header.total_body_length(), 6);
    }
    Ok(())
}

#[test]
fn native_phrases_never_cross_the_title_and_text_lanes() -> Result<(), String> {
    let built = build(
        vec![
            Document::native("a", 1, "red", "fox", BTreeMap::new(), None),
            Document::native("b", 1, "red fox", "dog", BTreeMap::new(), None),
        ],
        None,
    )?;
    let statistics = statistics_for(&built.bytes)?;
    let hits = native_hits(&built.bytes, statistics, "red fox", "phrase", 10)?;
    assert_eq!(
        hits.iter().map(|hit| hit.0.as_str()).collect::<Vec<_>>(),
        ["b"]
    );
    assert_eq!(
        ranked_ids(
            &built.bytes,
            &[DocumentColumnId::Role(NativeRole::Title)],
            "red fox",
            "phrase",
            10,
            &[],
            &[],
        )?,
        [1]
    );
    Ok(())
}

#[test]
fn per_field_scoring_reads_native_lanes_from_the_same_index_owner() -> Result<(), String> {
    let built = build(
        vec![
            Document::native("a", 1, "fox", "dog", BTreeMap::new(), None),
            Document::native("b", 1, "dog", "fox fox", BTreeMap::new(), None),
        ],
        None,
    )?;
    let title = [DocumentColumnId::Role(NativeRole::Title)];
    let text = [DocumentColumnId::Role(NativeRole::Text)];
    assert_eq!(
        ranked_ids(&built.bytes, &title, "fox", "any", 10, &[], &[])?,
        [0]
    );
    assert_eq!(
        ranked_ids(&built.bytes, &text, "fox", "any", 10, &[], &[])?,
        [1]
    );
    assert_eq!(
        ranked_ids(
            &built.bytes,
            &[title[0].clone(), text[0].clone()],
            "fox",
            "any",
            10,
            &[],
            &[]
        )?,
        [1, 0]
    );
    assert_eq!(
        rejection(rank_fields(
            &built.bytes,
            &[DocumentColumnId::Role(NativeRole::Vector)],
            "fox",
            "any",
            1,
            &[],
            &[],
        ))?,
        "Native vector role is not text"
    );
    Ok(())
}

#[test]
fn attributes_named_title_or_text_stay_isolated_from_native_roles() -> Result<(), String> {
    let document = Document::native(
        "a",
        1,
        "other",
        "body",
        BTreeMap::from([
            ("tags".into(), serde_json::json!("quasar")),
            ("text".into(), serde_json::json!("nebula")),
            ("title".into(), serde_json::json!("pulsar")),
        ]),
        None,
    );
    let plain = build(vec![document.clone()], None)?;
    let named = build_text_fields(
        vec![document.clone()],
        None,
        &[
            NamedTextField::new("tags"),
            NamedTextField::new("text"),
            NamedTextField::new("title"),
        ],
    )?;
    assert_eq!(
        plain.header.total_title_length(),
        named.header.total_title_length()
    );
    assert_eq!(
        plain.header.total_body_length(),
        named.header.total_body_length()
    );
    for term in ["quasar", "nebula", "pulsar"] {
        assert!(named.header.terms().get(term).is_none());
        let statistics = statistics_for(&named.bytes)?;
        assert_eq!(
            native_hits(&named.bytes, statistics, term, "any", 10)?,
            Vec::<(String, u64)>::new()
        );
    }
    assert!(
        !document_terms(&document)?
            .iter()
            .any(|term| term == "quasar")
    );
    assert_eq!(
        ranked_ids(
            &named.bytes,
            &[tags("title")],
            "pulsar",
            "any",
            10,
            &[],
            &[]
        )?,
        [0]
    );
    assert_eq!(
        ranked_ids(
            &named.bytes,
            &[DocumentColumnId::Role(NativeRole::Title)],
            "pulsar",
            "any",
            10,
            &[],
            &[]
        )?,
        Vec::<u32>::new()
    );
    assert_eq!(
        ranked_ids(
            &named.bytes,
            &[DocumentColumnId::Role(NativeRole::Title)],
            "other",
            "any",
            10,
            &[],
            &[]
        )?,
        [0]
    );
    Ok(())
}

#[test]
fn attribute_only_terms_do_not_change_native_statistics_bloom_or_common_selection()
-> Result<(), String> {
    let documents = vec![
        Document::native(
            "a",
            1,
            "fox",
            "fox",
            BTreeMap::from([("tags".into(), serde_json::json!("quasar fox"))]),
            None,
        ),
        Document::native("b", 1, "fox", "fox", BTreeMap::new(), None),
    ];
    let plain = build(documents.clone(), None)?;
    let named = build_text_fields(documents.clone(), None, &[NamedTextField::new("tags")])?;
    assert_eq!(
        plain.header.total_title_length(),
        named.header.total_title_length()
    );
    assert_eq!(
        plain.header.total_body_length(),
        named.header.total_body_length()
    );
    assert_eq!(
        plain
            .header
            .terms()
            .iter()
            .map(|(term, meta)| (term, meta.df))
            .collect::<Vec<_>>(),
        named
            .header
            .terms()
            .iter()
            .map(|(term, meta)| (term, meta.df))
            .collect::<Vec<_>>(),
    );
    assert!(named.header.terms().get("quasar").is_none());
    assert_eq!(
        statistics_for(&plain.bytes)?.frequencies,
        statistics_for(&named.bytes)?.frequencies
    );
    assert_eq!(plain.common_projection, named.common_projection);
    for document in &documents {
        assert!(
            !document_terms(document)?
                .iter()
                .any(|term| term == "quasar")
        );
    }
    let (terms, _) = named.header.fields.dictionary(2).ok_or("Missing group")?;
    assert_eq!(terms.get("quasar").map(|meta| meta.df), Some(1));
    assert_eq!(terms.get("fox").map(|meta| meta.df), Some(1));
    assert_eq!(named.header.terms().get("fox").map(|meta| meta.df), Some(2));
    Ok(())
}

#[test]
fn retained_length_column_capacity_is_charged_to_the_directory_budget() -> Result<(), String> {
    let built = build(bare(BTreeMap::new()), None)?;
    let mut header = built.header;
    let before = header.heap_bytes();
    let old_capacity = header.documents.lengths.capacity();
    header.documents.lengths.reserve_exact(64);
    let added = header.documents.lengths.capacity() - old_capacity;
    assert!(added > 0);
    assert_eq!(
        header.heap_bytes() - before,
        added * size_of::<super::super::ScalarColumn<u32>>()
    );
    Ok(())
}

#[test]
fn directory_frames_round_trip_the_generic_table_and_keep_common_frames_native()
-> Result<(), String> {
    let built = build_text_fields(
        single("tags", serde_json::json!(["quasar fox", "dog"])),
        None,
        &[NamedTextField::new("tags")],
    )?;
    let (header, length) = parse_header(&built.bytes)?;
    let full = compress_directory(&built.bytes[..length])?;
    assert_eq!(&full[..8], DIRECTORY_MAGIC_V6);
    let decoded = parse_compressed_directory(&full, length, 40 * 1024 * 1024)?;
    assert_eq!(decoded.compact_json()?, header.compact_json()?);
    assert_eq!(
        serde_json::to_string(&decoded.fields).map_err(|cause| cause.to_string())?,
        serde_json::to_string(&built.header.fields).map_err(|cause| cause.to_string())?
    );
    let budget = decoded.heap_bytes();
    assert!(parse_compressed_directory(&full, length, budget).is_ok());
    assert!(parse_compressed_directory(&full, length, budget - 1).is_err());
    let common = compress_common_directory_segment(&built.bytes)?;
    assert_eq!(&common[..8], COMMON_DIRECTORY_MAGIC_V4);
    let projected = CommonDirectory::compressed(&common, length, 40 * 1024 * 1024)?;
    assert_eq!(projected.header.fields.len(), 3);
    assert!(
        projected
            .header
            .fields
            .dictionary(2)
            .is_some_and(|(terms, _)| terms.is_empty())
    );
    let compact = binary_directory::encode(&header)?;
    let mut layered = u32::try_from(compact.len())
        .map_err(|cause| cause.to_string())?
        .to_le_bytes()
        .to_vec();
    layered.extend_from_slice(&compact);
    layered.extend_from_slice(&[0, 0]);
    let forged = compress_directory_payload(&layered, length, *COMMON_DIRECTORY_MAGIC_V4)?;
    assert_eq!(
        rejection(CommonDirectory::compressed(
            &forged,
            length,
            40 * 1024 * 1024
        ))?,
        "Common directory cannot carry named postings"
    );
    Ok(())
}

#[test]
fn directory_versions_reject_mismatched_magic_trailing_bytes_and_counts() -> Result<(), String> {
    let built = build_text_fields(
        single("tags", serde_json::json!("fox")),
        None,
        &[NamedTextField::new("tags")],
    )?;
    let (header, length) = parse_header(&built.bytes)?;
    let compact = binary_directory::encode(&header)?;
    let mut trailed = compact.clone();
    trailed.push(1);
    let frame = compress_directory_payload(&trailed, length, *DIRECTORY_MAGIC_V6)?;
    assert_eq!(
        parse_compressed_directory(&frame, length, 40 * 1024 * 1024)
            .err()
            .as_deref(),
        Some("Trailing directory bytes")
    );
    let legacy_magic =
        compress_directory_payload(&compact, length, *super::super::DIRECTORY_MAGIC)?;
    assert!(
        rejection(parse_compressed_directory(
            &legacy_magic,
            length,
            40 * 1024 * 1024
        ))?
        .contains("version")
    );
    let mut forged = compact.clone();
    forged[0] = 5;
    let forged = compress_directory_payload(&forged, length, *DIRECTORY_MAGIC_V6)?;
    assert!(
        rejection(parse_compressed_directory(
            &forged,
            length,
            40 * 1024 * 1024
        ))?
        .contains("version")
    );
    for end in 0..compact.len() {
        let truncated = compress_directory_payload(&compact[..end], length, *DIRECTORY_MAGIC_V6)?;
        assert!(parse_compressed_directory(&truncated, length, 40 * 1024 * 1024).is_err());
    }
    Ok(())
}

#[test]
fn word_v4_phrases_do_not_cross_array_elements_or_stopword_gaps() -> Result<(), String> {
    let adjacent = build_text_fields(
        single("tags", serde_json::json!(["fox", "dog"])),
        None,
        &[NamedTextField::new("tags")],
    )?;
    let field = [tags("tags")];
    assert_eq!(
        ranked_ids(&adjacent.bytes, &field, "fox dog", "phrase", 10, &[], &[])?,
        Vec::<u32>::new()
    );
    assert_eq!(
        ranked_ids(&adjacent.bytes, &field, "fox dog", "all", 10, &[], &[])?,
        [0]
    );
    let built = build_text_fields(
        vec![
            Document::native(
                "array",
                1,
                "native",
                "native",
                BTreeMap::from([(
                    "tags".into(),
                    serde_json::json!(["the CAFÉ", "", "and foxes"]),
                )]),
                None,
            ),
            Document::native(
                "string",
                1,
                "native",
                "native",
                BTreeMap::from([("tags".into(), serde_json::json!("the café and foxes"))]),
                None,
            ),
        ],
        None,
        &[NamedTextField::new("tags")],
    )?;
    assert_eq!(
        ranked_ids(&built.bytes, &field, "café", "any", 10, &[], &[])?,
        [0, 1]
    );
    assert_eq!(
        ranked_ids(&built.bytes, &field, "café foxes", "phrase", 10, &[], &[])?,
        Vec::<u32>::new()
    );
    assert_eq!(
        ranked_ids(&built.bytes, &field, "cafe", "any", 10, &[], &[])?,
        Vec::<u32>::new()
    );
    assert_eq!(
        ranked_ids(
            &built.bytes,
            &field,
            "café and foxes",
            "phrase",
            10,
            &[],
            &[]
        )?,
        [1]
    );
    Ok(())
}

#[test]
fn filters_and_tombstones_run_before_named_top_k() -> Result<(), String> {
    let document = |id: &str, keep: bool, tags: &str| {
        Document::native(
            id,
            1,
            "title",
            "body",
            BTreeMap::from([
                ("keep".into(), serde_json::json!(keep)),
                ("tags".into(), serde_json::json!(tags)),
            ]),
            None,
        )
    };
    let built = build_text_fields(
        vec![
            document("a", false, "fox fox fox"),
            document("b", true, "fox fox"),
            document("c", true, "fox"),
        ],
        None,
        &[NamedTextField::new("tags")],
    )?;
    let field = [tags("tags")];
    assert_eq!(
        ranked_ids(&built.bytes, &field, "fox", "any", 1, &[], &[])?,
        [0]
    );
    assert_eq!(
        ranked_ids(&built.bytes, &field, "fox", "any", 1, &[0], &[])?,
        [1]
    );
    assert_eq!(
        ranked_ids(&built.bytes, &field, "fox", "any", 10, &[0], &[])?,
        [1, 2]
    );
    let keep = Filter {
        field: "keep".into(),
        op: "eq".into(),
        value: serde_json::json!(true),
    };
    assert_eq!(
        ranked_ids(&built.bytes, &field, "fox", "any", 1, &[], &[keep])?,
        [1]
    );
    let bogus = Filter {
        field: "keep".into(),
        op: "bogus".into(),
        value: serde_json::json!(true),
    };
    assert_eq!(
        rejection(rank_fields(
            &built.bytes,
            &field,
            "",
            "any",
            1,
            &[],
            &[bogus]
        ))?,
        "Unknown filter operation"
    );
    assert_eq!(
        rejection(rank_fields(
            &built.bytes,
            &field,
            "fox",
            "any",
            1,
            &[9],
            &[]
        ))?,
        "Invalid deleted row"
    );
    Ok(())
}

#[test]
fn field_declarations_and_values_fail_closed() -> Result<(), String> {
    let declare = |names: &[&str]| {
        let fields = names
            .iter()
            .map(|name| NamedTextField::new(name))
            .collect::<Vec<_>>();
        build_text_fields(bare(BTreeMap::new()), None, &fields).map(|_| ())
    };
    assert_eq!(
        rejection(declare(&["b", "a"]))?,
        "Named text fields are not strictly sorted"
    );
    assert_eq!(
        rejection(declare(&["a", "a"]))?,
        "Named text fields are not strictly sorted"
    );
    assert_eq!(rejection(declare(&["$meta"]))?, "Invalid named text field");
    assert_eq!(rejection(declare(&[""]))?, "Invalid named text field");
    assert_eq!(
        rejection(declare(&["é", "z"]))?,
        "Named text fields are not strictly sorted"
    );
    assert!(declare(&["z", "é"]).is_ok());
    let names = (0..65)
        .map(|index| format!("f{index:02}"))
        .collect::<Vec<_>>();
    let refs = names.iter().map(String::as_str).collect::<Vec<_>>();
    assert_eq!(rejection(declare(&refs))?, "Named text fields exceed 64");
    let fields = [NamedTextField::new("tags")];
    assert_eq!(
        rejection(build_text_fields(
            single("tags", serde_json::json!(1)),
            None,
            &fields
        ))?,
        "Full-text attributes must be strings or string arrays"
    );
    assert_eq!(
        rejection(build_text_fields(
            single("tags", serde_json::json!(["fox", 1])),
            None,
            &fields
        ))?,
        "Full-text arrays must contain only strings"
    );
    assert_eq!(
        rejection(build_versioned(bare(BTreeMap::new()), None, &fields, 3))?,
        "Named text requires segment version 4"
    );
    let empty = build_text_fields(single("tags", serde_json::Value::Null), None, &fields)?;
    assert_eq!(empty.header.fields.total(2), 0);
    assert_eq!(empty.header.documents.row(0).title_length, 1);
    Ok(())
}

#[test]
fn stored_headers_reject_inconsistent_field_tables() -> Result<(), String> {
    let built = build_text_fields(
        single("tags", serde_json::json!("fox dog")),
        None,
        &[NamedTextField::new("tags")],
    )?;
    let (_, base) = parse_header(&built.bytes)?;
    let reframe = |value: &serde_json::Value| -> Result<Vec<u8>, String> {
        let json = serde_json::to_vec(value).map_err(|cause| cause.to_string())?;
        let mut bytes = b"RAIOSEG4".to_vec();
        bytes.extend_from_slice(
            &u32::try_from(json.len())
                .map_err(|cause| cause.to_string())?
                .to_le_bytes(),
        );
        bytes.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes.extend_from_slice(&built.bytes[base..]);
        Ok(bytes)
    };
    let original: serde_json::Value =
        serde_json::from_slice(&built.bytes[16..base]).map_err(|cause| cause.to_string())?;
    assert!(parse_header(&reframe(&original)?).is_ok());
    let mutate = |change: &dyn Fn(&mut serde_json::Value)| -> Result<String, String> {
        let mut value = original.clone();
        change(&mut value);
        rejection(parse_header(&reframe(&value)?))
    };
    for ordinal in [0, 1, 2] {
        assert_eq!(
            mutate(&|value| value[2][ordinal][3] = serde_json::json!(99))?,
            "Text field totals do not match lengths"
        );
    }
    assert_eq!(
        mutate(&|value| value[2][2][4] = serde_json::json!([]))?,
        "Field lengths do not match the document count"
    );
    assert_eq!(
        mutate(&|value| value[2][0][0] = serde_json::json!(1))?,
        "Native text fields must lead the field table"
    );
    assert_eq!(
        mutate(&|value| value[3] = serde_json::json!([]))?,
        "Invalid text field table"
    );
    assert_eq!(
        mutate(&|value| value[2][2][2] = serde_json::Value::Null)?,
        "Invalid text field declaration"
    );
    assert_eq!(
        mutate(&|value| value[3][1]["fox"][1][0][3] = serde_json::json!(0))?,
        "Invalid named posting block directory"
    );
    Ok(())
}

#[test]
fn named_queries_reject_bad_budgets_and_fields() -> Result<(), String> {
    let built = build_text_fields(
        single("tags", serde_json::json!("fox")),
        None,
        &[NamedTextField::new("tags")],
    )?;
    let check = |fields: &[DocumentColumnId], text: &str, mode: &str, top_k: usize| {
        rejection(rank_fields(
            &built.bytes,
            fields,
            text,
            mode,
            top_k,
            &[],
            &[],
        ))
    };
    let field = [tags("tags")];
    assert_eq!(check(&[], "fox", "any", 1)?, "Text fields are required");
    assert_eq!(
        check(&[tags("tags"), tags("tags")], "fox", "any", 1)?,
        "Duplicate text field"
    );
    assert_eq!(
        check(&[tags("missing")], "fox", "any", 1)?,
        "Unknown text field missing"
    );
    assert_eq!(check(&field, "fox", "nope", 1)?, "Unknown match mode");
    assert_eq!(check(&field, "fox", "any", 0)?, "Invalid search budget");
    assert_eq!(check(&field, "fox", "any", 101)?, "Invalid search budget");
    assert_eq!(
        check(&field, &"fox ".repeat(65), "phrase", 1)?,
        "Phrase exceeds budget"
    );
    let many = (0..513_u16)
        .map(|index| format!("t{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(check(&field, &many, "any", 1)?, "Invalid search budget");
    Ok(())
}

#[test]
fn posting_pages_reject_corruption_regressed_inputs_and_trailing_bytes() -> Result<(), String> {
    let built = build_text_fields(
        single("tags", serde_json::json!("fox")),
        None,
        &[NamedTextField::new("tags")],
    )?;
    let (_, base) = parse_header(&built.bytes)?;
    let (terms, _) = built.header.fields.dictionary(2).ok_or("Missing group")?;
    let block = terms
        .get("fox")
        .and_then(|meta| meta.blocks.first())
        .ok_or("Missing named block")?;
    let checksum = base + block.data.offset as usize + 4;
    let mut damaged = built.bytes.clone();
    damaged[checksum] ^= 1;
    let field = [tags("tags")];
    assert_eq!(
        rank_fields(&damaged, &field, "fox", "any", 1, &[], &[])
            .err()
            .as_deref(),
        Some("Page integrity check failed")
    );
    let end = base + block.data.offset as usize;
    assert_eq!(
        rank_fields(&built.bytes[..end], &field, "fox", "any", 1, &[], &[])
            .err()
            .as_deref(),
        Some("Invalid posting range")
    );
    let shape = PostingShape::single(true);
    let decode = |values: &[u32]| -> Result<String, String> {
        let mut data = Vec::new();
        for value in values {
            put_int(*value, &mut data);
        }
        let mut payload = Vec::new();
        super::super::append(&mut payload, &data)?;
        rejection(decode_shaped_rows::<true, _>(
            &payload,
            shape,
            |row, _, _| row,
        ))
    };
    assert_eq!(decode(&[1, 0, 1, 0, 0, 1])?, "Trailing posting bytes");
    assert_eq!(decode(&[1, 0, 0])?, "Empty posting");
    assert_eq!(decode(&[1, 0, 2, 1, 1, 1, 0])?, "Token input regressed");
    Ok(())
}
