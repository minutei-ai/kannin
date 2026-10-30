use raio_engine::segment::{
    self, AttributeSchema, Cell, ColumnId, ColumnValue, CommonDirectory, Document, DocumentId,
    Filter, Header, NativeRole, Search, Statistics,
};
use std::collections::{BTreeMap, BTreeSet};

type Check = Result<(), Box<dyn std::error::Error>>;

const BOUNDARY: i64 = 1 << 53;
const BUDGET: usize = 40 * 1024 * 1024;

const SCHEMA: &str = r#"[
    {"name":"stamp","type":"i64","filterable":true,"nullable":true},
    {"name":"count","type":"u64","filterable":true},
    {"name":"score","type":"f64","filterable":true},
    {"name":"owner","type":"uuid","filterable":true},
    {"name":"at","type":"datetime_ms","filterable":true},
    {"name":"public","type":"bool","filterable":true},
    {"name":"tags","type":"[string]","filterable":true},
    {"name":"title","type":"string","filterable":true},
    {"name":"text","type":"string","filterable":true},
    {"name":"blob","type":"bytes","nullable":true}
]"#;

fn schema() -> Result<AttributeSchema, String> {
    AttributeSchema::from_json(SCHEMA)
}

fn typed(
    id: &str,
    title: &str,
    text: &str,
    attributes: Vec<(&str, Cell)>,
    vector: Option<Vec<f32>>,
) -> Result<Document, String> {
    Document::typed(
        DocumentId::String(id.into()),
        7,
        title,
        text,
        attributes
            .into_iter()
            .map(|(name, cell)| (name.to_owned(), cell))
            .collect(),
        vector,
    )
}

fn statistics(header: &Header) -> Statistics {
    Statistics {
        documents: header.documents.len() as u64,
        title_length: header.total_title_length(),
        body_length: header.total_body_length(),
        frequencies: header
            .terms()
            .iter()
            .map(|(term, meta)| (term.to_owned(), u64::from(meta.df)))
            .collect(),
    }
}

fn filter(field: &str, op: &str, value: serde_json::Value) -> Filter {
    Filter {
        field: field.into(),
        op: op.into(),
        value,
    }
}

fn ranked(
    built: &segment::BuiltSegment,
    query: &str,
    dead: &[u32],
    filters: &[Filter],
    k: usize,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let (header, base) = segment::parse_header(&built.bytes)?;
    let mut search = Search::new(
        header.clone(),
        statistics(&header),
        query,
        "any",
        k,
        dead,
        filters,
    )?;
    let terms: BTreeSet<_> = search.words.iter().cloned().collect();
    for term in terms {
        if let Some(meta) = header.terms().get(&term) {
            for block in &meta.blocks {
                let start = base + block.data.offset as usize;
                search.add(
                    &term,
                    &built.bytes[start..start + block.data.length as usize],
                )?;
            }
        }
    }
    search
        .finish()?
        .into_iter()
        .map(|hit| {
            Ok(header
                .documents
                .row(hit.row as usize)
                .id
                .native_str()?
                .to_owned())
        })
        .collect()
}

fn stamped_documents() -> Result<Vec<Document>, String> {
    Ok(vec![
        typed(
            "a",
            "",
            "rust rust rust rust",
            vec![("stamp", Cell::I64(BOUNDARY + 1))],
            None,
        )?,
        typed(
            "b",
            "",
            "rust",
            vec![("stamp", Cell::I64(BOUNDARY + 2))],
            None,
        )?,
        typed(
            "c",
            "",
            "rust rust",
            vec![("stamp", Cell::I64(BOUNDARY))],
            None,
        )?,
        typed("d", "", "rust rust rust", vec![("stamp", Cell::Null)], None)?,
        typed("e", "", "rust rust rust rust rust", vec![], None)?,
    ])
}

fn every_kind() -> Result<Vec<Document>, String> {
    let owner = Cell::Uuid([
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
    ]);
    Ok(vec![
        typed(
            "full",
            "alpha title",
            "shared body",
            vec![
                ("stamp", Cell::I64(i64::MIN)),
                ("count", Cell::U64(u64::MAX)),
                ("score", Cell::F64(-0.0)),
                ("owner", owner),
                ("at", Cell::DatetimeMs(i64::MAX)),
                ("public", Cell::Bool(true)),
                (
                    "tags",
                    Cell::Array(vec![Cell::String("a".into()), Cell::String("b".into())]),
                ),
                ("title", Cell::String("attribute title".into())),
                ("text", Cell::String("attribute text".into())),
                ("blob", Cell::Bytes((0..=255).collect())),
            ],
            Some(vec![1.0, 0.0]),
        )?,
        typed(
            "nulls",
            "",
            "shared",
            vec![
                ("stamp", Cell::Null),
                ("blob", Cell::Null),
                ("tags", Cell::Array(Vec::new())),
            ],
            None,
        )?,
        typed("missing", "", "shared", vec![], Some(vec![0.0, 1.0]))?,
    ])
}

#[test]
fn typed_builds_use_the_new_formats_while_native_builds_keep_theirs() -> Check {
    let built = segment::build_typed(every_kind()?, &schema()?, &[])?;
    assert_eq!(&built.bytes[..8], b"RAIOSEG6");
    let (header, base) = segment::parse_header(&built.bytes)?;
    assert_eq!(header.version, 6);

    let frame = segment::compress_directory(&built.bytes[..base])?;
    assert_eq!(&frame[..8], b"RAIODIR8");
    let decoded = segment::parse_compressed_directory(&frame, base, BUDGET)?;
    assert_eq!(decoded.version, 6);
    for (left, right) in decoded.documents.iter().zip(header.documents.iter()) {
        assert_eq!(left.attributes.get(), right.attributes.get());
    }
    assert!(segment::parse_compressed_directory(&frame, base, decoded.heap_bytes() - 1).is_err());
    for end in [0, 7, 19, frame.len() - 1] {
        assert!(segment::parse_compressed_directory(&frame[..end], base, BUDGET).is_err());
    }
    let mut forged = frame.clone();
    forged[..8].copy_from_slice(b"RAIODIR7");
    assert!(segment::parse_compressed_directory(&forged, base, BUDGET).is_err());
    let mut corrupt = frame;
    corrupt[20] ^= 1;
    assert!(segment::parse_compressed_directory(&corrupt, base, BUDGET).is_err());

    let common = segment::compress_common_directory_segment(&built.bytes)?;
    assert_eq!(&common[..8], b"RAIOCOM6");
    let projected = CommonDirectory::compressed(&common, base, BUDGET)?;
    assert!(CommonDirectory::compressed(&common, base, projected.heap_bytes() - 1).is_err());
    assert!(segment::parse_compressed_directory(&common, base, BUDGET).is_err());

    // A reader that only knows the older magics cannot be tricked into the typed reading.
    assert_eq!(segment::migrate_segment(&built.bytes)?, built.bytes);
    let mut forged_segment = built.bytes;
    forged_segment[7] = b'5';
    assert!(segment::parse_header(&forged_segment).is_err());

    // Native-only builds are untouched: string ids stay segment 4, integer ids segment 5.
    let native = Document::native("a", 1, "t", "rust", BTreeMap::new(), None);
    let native_built = segment::build(vec![native], None)?;
    assert_eq!(&native_built.bytes[..8], b"RAIOSEG4");
    let (_, native_base) = segment::parse_header(&native_built.bytes)?;
    assert_eq!(
        &segment::compress_directory(&native_built.bytes[..native_base])?[..8],
        b"RAIODIR6"
    );
    let mut integer = Document::native("a", 1, "t", "rust", BTreeMap::new(), None);
    integer.id = DocumentId::Uint(u64::MAX);
    let integer_built = segment::build(vec![integer], None)?;
    assert_eq!(&integer_built.bytes[..8], b"RAIOSEG5");
    let (_, integer_base) = segment::parse_header(&integer_built.bytes)?;
    assert_eq!(
        &segment::compress_directory(&integer_built.bytes[..integer_base])?[..8],
        b"RAIODIR7"
    );
    Ok(())
}

#[test]
fn typed_filters_and_tombstones_apply_before_text_top_k() -> Check {
    let built = segment::build_typed(stamped_documents()?, &schema()?, &[])?;
    let above = filter(
        "stamp",
        "gt",
        serde_json::json!({"i64": (BOUNDARY + 1).to_string()}),
    );
    // Without a filter the densest document wins; the exact i64 range keeps only "b".
    assert_eq!(ranked(&built, "rust", &[], &[], 1)?, ["e"]);
    assert_eq!(
        ranked(&built, "rust", &[], std::slice::from_ref(&above), 1)?,
        ["b"]
    );
    // Rows are ordered by id: a=0 b=1 c=2 d=3 e=4. A tombstone removes the only eligible row.
    assert_eq!(
        ranked(&built, "rust", &[1], std::slice::from_ref(&above), 5)?,
        [] as [String; 0]
    );
    assert_eq!(
        ranked(&built, "rust", &[4, 0], &[], 1)?,
        ["d"],
        "tombstones are applied before top-k"
    );
    let inclusive = filter(
        "stamp",
        "gte",
        serde_json::json!({"i64": BOUNDARY.to_string()}),
    );
    assert_eq!(
        ranked(&built, "rust", &[], std::slice::from_ref(&inclusive), 5)?,
        ["a", "c", "b"]
    );
    // Null is a stored value and missing is not.
    let nulls = filter("stamp", "eq", serde_json::Value::Null);
    assert_eq!(
        ranked(&built, "rust", &[], std::slice::from_ref(&nulls), 5)?,
        ["d"]
    );
    let present = filter("stamp", "exists", serde_json::json!(true));
    assert_eq!(
        ranked(&built, "rust", &[], std::slice::from_ref(&present), 5)?.len(),
        4
    );
    // A different kind never matches and is never coerced through floating point.
    let wrong_kind = filter(
        "stamp",
        "eq",
        serde_json::json!({"u64": (BOUNDARY + 1).to_string()}),
    );
    assert_eq!(
        ranked(&built, "rust", &[], std::slice::from_ref(&wrong_kind), 5)?,
        [] as [String; 0]
    );
    // Raw numbers and malformed tags are not typed operands.
    for invalid in [
        filter("stamp", "eq", serde_json::json!(BOUNDARY)),
        filter(
            "stamp",
            "gt",
            serde_json::json!({"i64": "09007199254740993"}),
        ),
        filter("stamp", "in", serde_json::json!([1, 2])),
        filter("stamp", "mystery", serde_json::json!({"i64": "1"})),
    ] {
        assert!(ranked(&built, "rust", &[], std::slice::from_ref(&invalid), 5).is_err());
    }
    Ok(())
}

#[test]
fn typed_documents_roundtrip_through_frames_and_rebuild_to_identical_bytes() -> Check {
    let schema = schema()?;
    let sources = every_kind()?;
    let built = segment::build_typed(sources.clone(), &schema, &[])?;
    let (header, base) = segment::parse_header(&built.bytes)?;
    let mut rebuilt = Vec::new();
    for row in 0..header.documents.len() {
        let metadata = header.documents.row(row);
        let start = base + metadata.data.offset as usize;
        let page = &built.bytes[start..start + metadata.data.length as usize];
        let vector = match header.vector_range(row)? {
            Some(range) => {
                let start = base + range.offset as usize;
                &built.bytes[start..start + range.length as usize]
            }
            None => &[][..],
        };
        let json = segment::full_typed_document_from_frames(page, vector)?;
        let decoded = Document::from_typed_canonical_slice(json.as_bytes(), &schema)?;
        let source = sources
            .iter()
            .find(|source| source.id == decoded.id)
            .ok_or("decoded an unknown document")?;
        assert_eq!(decoded.revision, source.revision);
        assert_eq!(
            decoded.columns().attributes(),
            source.columns().attributes()
        );
        assert_eq!(decoded.to_typed_canonical_json()?, json);
        let projection: serde_json::Value =
            serde_json::from_str(&segment::query_typed_document_from_metadata(page)?)?;
        assert_eq!(
            projection["attributes"],
            serde_json::from_str::<serde_json::Value>(&json)?["attributes"]
        );
        // The legacy projections refuse typed pages instead of misreading them.
        assert!(segment::query_document_from_metadata(page).is_err());
        assert!(segment::full_document_from_frames(page, vector).is_err());
        assert!(
            segment::query_documents_from_metadata(page, &[0, u32::try_from(page.len())?]).is_err()
        );
        rebuilt.push(decoded);
    }
    let again = segment::build_typed(rebuilt, &schema, &[])?;
    assert_eq!(again.bytes, built.bytes);
    assert_eq!(again.common_projection, built.common_projection);

    // Exact scalars survive: the signed minimum, the unsigned maximum and the -0 bit pattern.
    let full = &sources[0];
    assert_eq!(
        full.columns().attributes().get("stamp"),
        Some(&Cell::I64(i64::MIN))
    );
    let Some(Cell::F64(score)) = full.columns().attributes().get("score") else {
        return Err("missing score".into());
    };
    assert!(score.is_sign_negative());

    // Null and missing stay distinct after the round trip.
    let nulls = sources
        .iter()
        .find(|source| source.id == "nulls")
        .ok_or("nulls")?;
    assert_eq!(nulls.columns().attributes().get("stamp"), Some(&Cell::Null));
    assert_eq!(nulls.columns().attributes().get("count"), None);
    let missing = sources
        .iter()
        .find(|source| source.id == "missing")
        .ok_or("missing")?;
    assert!(missing.columns().attributes().is_empty());
    Ok(())
}

#[test]
fn typed_documents_cannot_cross_into_legacy_adapters_or_builders() -> Check {
    let documents = every_kind()?;
    assert!(documents[0].to_canonical_json().is_err());
    assert!(documents[0].to_canonical_vec().is_err());
    assert!(documents[0].to_native_json().is_err());
    assert!(documents[0].to_native_vec().is_err());
    assert!(segment::build(documents.clone(), None).is_err());
    assert!(segment::build_text_fields(documents, None, &[]).is_err());
    // Legacy cells and undeclared or mistyped attributes are not typed ingress.
    let legacy = Document::native(
        "legacy",
        1,
        "",
        "rust",
        BTreeMap::from([("stamp".into(), serde_json::json!(1))]),
        None,
    );
    assert!(segment::build_typed(vec![legacy], &schema()?, &[]).is_err());
    for invalid in [
        vec![("undeclared", Cell::Bool(true))],
        vec![("stamp", Cell::U64(1))],
        vec![("count", Cell::Null)],
        vec![("blob", Cell::String("Zg==".into()))],
        vec![("tags", Cell::Array(vec![Cell::I64(1)]))],
    ] {
        let document = typed("bad", "", "rust", invalid, None)?;
        assert!(segment::build_typed(vec![document], &schema()?, &[]).is_err());
    }
    assert!(typed("bad", "", "rust", vec![("n", Cell::F64(f64::NAN))], None).is_err());
    assert!(
        typed(
            "bad",
            "",
            "rust",
            vec![("n", Cell::from(serde_json::json!(1)))],
            None
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn legacy_objects_shaped_like_tags_remain_opaque_json() -> Check {
    let shaped = serde_json::json!({"i64": "5"});
    let document = Document::native(
        "x",
        1,
        "t",
        "rust",
        BTreeMap::from([
            ("n".into(), shaped.clone()),
            ("w".into(), serde_json::json!(5)),
        ]),
        None,
    );
    assert_eq!(
        document.to_native_json()?,
        r#"{"id":"x","revision":1,"title":"t","text":"rust","attributes":{"n":{"i64":"5"},"w":5}}"#
    );
    let parsed = Document::from_native_json(&document.to_native_json()?)?;
    assert_eq!(
        parsed
            .columns()
            .attributes()
            .get("n")
            .and_then(Cell::as_legacy),
        Some(&shaped)
    );

    let built = segment::build(vec![document], None)?;
    assert_eq!(&built.bytes[..8], b"RAIOSEG4");
    let length = u32::from_le_bytes(built.bytes[8..12].try_into()?) as usize;
    let directory = std::str::from_utf8(&built.bytes[16..16 + length])?;
    assert!(directory.contains(r#"{"n":{"i64":"5"},"w":5}"#));
    // Legacy equality is raw JSON equality: the object matches itself and a number never does.
    let object = filter("n", "eq", shaped.clone());
    assert_eq!(
        ranked(&built, "rust", &[], std::slice::from_ref(&object), 5)?,
        ["x"]
    );
    for other in [
        serde_json::json!(5),
        serde_json::json!("5"),
        serde_json::json!({"u64": "5"}),
    ] {
        let mismatch = filter("n", "eq", other);
        assert_eq!(
            ranked(&built, "rust", &[], std::slice::from_ref(&mismatch), 5)?,
            [] as [String; 0]
        );
    }
    let number = filter("w", "eq", serde_json::json!(5));
    assert_eq!(
        ranked(&built, "rust", &[], std::slice::from_ref(&number), 5)?,
        ["x"]
    );

    // The same bytes read with the typed grammar are a different value in a different segment.
    let schema = AttributeSchema::from_json(r#"[{"name":"n","type":"i64"}]"#)?;
    let typed_text = r#"{"id":"x","revision":1,"roles":{"title":"t","text":"rust"},"attributes":{"n":{"i64":"5"}}}"#;
    let typed_document = Document::from_typed_canonical_slice(typed_text.as_bytes(), &schema)?;
    assert_eq!(
        typed_document.columns().attributes().get("n"),
        Some(&Cell::I64(5))
    );
    let legacy_reading = Document::from_canonical_json(typed_text)?;
    assert_eq!(
        legacy_reading
            .columns()
            .attributes()
            .get("n")
            .and_then(Cell::as_legacy),
        Some(&shaped)
    );
    Ok(())
}

#[test]
fn native_wire_bytes_are_preserved_for_unusual_legacy_values()
-> Result<(), Box<dyn std::error::Error>> {
    let document = Document::native(
        "fixture",
        3,
        "title",
        "body",
        BTreeMap::from([
            ("big".into(), serde_json::json!(18_014_398_509_481_985_u64)),
            ("float".into(), serde_json::json!(0.1)),
            (
                "nested".into(),
                serde_json::json!({"a": [1, null, "x"], "b": {}}),
            ),
            ("null".into(), serde_json::Value::Null),
        ]),
        Some(vec![0.5, -0.25]),
    );
    let expected = concat!(
        r#"{"id":"fixture","revision":3,"title":"title","text":"body","#,
        r#""attributes":{"big":18014398509481985,"float":0.1,"nested":{"a":[1,null,"x"],"b":{}},"null":null},"#,
        r#""vector":[0.5,-0.25]}"#
    );
    assert_eq!(document.to_native_json()?, expected);
    assert_eq!(
        Document::from_native_json(expected)?.to_native_json()?,
        expected
    );
    let canonical = document.to_canonical_json()?;
    assert_eq!(
        Document::from_canonical_json(&canonical)?.to_canonical_json()?,
        canonical
    );
    Ok(())
}

#[test]
fn attributes_named_like_roles_stay_distinct_from_roles_in_typed_segments() -> Check {
    let documents = vec![
        typed(
            "a",
            "alpha",
            "beta",
            vec![
                ("title", Cell::String("zzz".into())),
                ("text", Cell::String("yyy".into())),
            ],
            None,
        )?,
        typed("b", "gamma", "delta", vec![], None)?,
    ];
    assert!(matches!(
        documents[0].column(ColumnId::Role(NativeRole::Title)),
        Some(ColumnValue::Text("alpha"))
    ));
    assert!(matches!(
        documents[0].column(ColumnId::Attribute("title")),
        Some(ColumnValue::Attribute(Cell::String(value))) if value == "zzz"
    ));
    let built = segment::build_typed(documents, &schema()?, &[])?;
    assert_eq!(ranked(&built, "beta", &[], &[], 5)?, ["a"]);
    // Attribute values are never indexed as role text.
    assert_eq!(ranked(&built, "yyy", &[], &[], 5)?, [] as [String; 0]);
    assert_eq!(ranked(&built, "zzz", &[], &[], 5)?, [] as [String; 0]);
    let by_title = filter("title", "eq", serde_json::json!("zzz"));
    assert_eq!(
        ranked(
            &built,
            "beta delta",
            &[],
            std::slice::from_ref(&by_title),
            5
        )?,
        ["a"]
    );
    let by_role_value = filter("title", "eq", serde_json::json!("alpha"));
    assert_eq!(
        ranked(
            &built,
            "beta delta",
            &[],
            std::slice::from_ref(&by_role_value),
            5
        )?,
        [] as [String; 0]
    );
    Ok(())
}
