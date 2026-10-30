use super::{
    AttributeSchema, Cell, CellType, ColumnSpec, MAX_ARRAY_ITEMS, MAX_BYTES_CELL, ScalarType,
    TypedFilter, decode_base64, decode_typed_attributes, encode_base64,
    validate_directory_attributes,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

type Check = Result<(), Box<dyn std::error::Error>>;

#[test]
fn directory_validation_streams_large_arrays_and_bounds_attribute_names() -> Check {
    let array = serde_json::to_string(&vec![""; MAX_ARRAY_ITEMS])?;
    let entries = (0..64)
        .map(|index| format!("\"field{index}\":{array}"))
        .collect::<Vec<_>>();
    let raw = format!("{{{}}}", entries.join(","));
    validate_directory_attributes(&raw)?;
    for invalid in [
        format!("{{{},\"extra\":true}}", entries.join(",")),
        format!("{{\"{}\":true}}", "a".repeat(129)),
        r#"{"":true}"#.to_owned(),
        r#"{"$reserved":true}"#.to_owned(),
        r#"{"a":true,"\u0061":false}"#.to_owned(),
        r#"{"a":[true,"text"]}"#.to_owned(),
        r#"{"a":[null]}"#.to_owned(),
        r#"{"a":[[]]}"#.to_owned(),
        r#"{"a":1}"#.to_owned(),
        r#"{"a":{"bytes":"AA=="}}"#.to_owned(),
        r#"{"a":{"i64":"1","u64":"1"}}"#.to_owned(),
        format!(
            "{{\"a\":[{}]}}",
            vec!["true"; MAX_ARRAY_ITEMS + 1].join(",")
        ),
    ] {
        assert!(validate_directory_attributes(&invalid).is_err());
    }
    validate_directory_attributes(r#"{"\u0061":[{"u64":"18446744073709551615"}]}"#)?;
    Ok(())
}

fn one(cell: &Cell) -> Result<String, serde_json::Error> {
    serde_json::to_string(&BTreeMap::from([("a", cell)]))
}

fn decode(text: &str) -> Result<Cell, String> {
    decode_typed_attributes(&format!(r#"{{"a":{text}}}"#))?
        .remove("a")
        .ok_or_else(|| "missing decoded attribute".to_owned())
}

fn filter(op: &str, operand: &Value, actual: Option<&Cell>) -> Result<bool, String> {
    TypedFilter::prepare(op, operand)?.matches(actual)
}

#[test]
fn integer_endpoints_and_neighbors_beyond_2_pow_53_stay_exact() -> Check {
    let boundary = 1_i64 << 53;
    for value in [
        i64::MIN,
        i64::MIN + 1,
        -boundary - 1,
        -boundary,
        -1,
        0,
        1,
        boundary - 1,
        boundary,
        boundary + 1,
        i64::MAX - 1,
        i64::MAX,
    ] {
        let wire = format!(r#"{{"i64":"{value}"}}"#);
        assert_eq!(one(&Cell::I64(value))?, format!(r#"{{"a":{wire}}}"#));
        assert_eq!(decode(&wire)?, Cell::I64(value));
        let datetime = format!(r#"{{"datetime_ms":"{value}"}}"#);
        assert_eq!(decode(&datetime)?, Cell::DatetimeMs(value));
        assert_eq!(
            one(&Cell::DatetimeMs(value))?,
            format!(r#"{{"a":{datetime}}}"#)
        );
    }
    let unsigned = 1_u64 << 53;
    for value in [
        0,
        1,
        unsigned - 1,
        unsigned,
        unsigned + 1,
        u64::from(u32::MAX) + 1,
        u64::MAX - 1,
        u64::MAX,
    ] {
        let wire = format!(r#"{{"u64":"{value}"}}"#);
        assert_eq!(one(&Cell::U64(value))?, format!(r#"{{"a":{wire}}}"#));
        assert_eq!(decode(&wire)?, Cell::U64(value));
    }
    assert_ne!(Cell::I64(boundary), Cell::I64(boundary + 1));
    assert_ne!(Cell::U64(unsigned), Cell::U64(unsigned + 1));
    Ok(())
}

#[test]
fn malformed_and_overflowing_integers_are_rejected() {
    for text in [
        r#"{"i64":"9223372036854775808"}"#,
        r#"{"i64":"-9223372036854775809"}"#,
        r#"{"i64":"01"}"#,
        r#"{"i64":"-0"}"#,
        r#"{"i64":"+1"}"#,
        r#"{"i64":" 1"}"#,
        r#"{"i64":"1.0"}"#,
        r#"{"i64":"1e3"}"#,
        r#"{"i64":""}"#,
        r#"{"i64":1}"#,
        r#"{"u64":"18446744073709551616"}"#,
        r#"{"u64":"-1"}"#,
        r#"{"u64":"00"}"#,
        r#"{"u64":"+1"}"#,
        r#"{"u64":""}"#,
        r#"{"datetime_ms":"9223372036854775808"}"#,
        r#"{"datetime_ms":"-0"}"#,
        r#"{"datetime_ms":"2024-01-01T00:00:00Z"}"#,
    ] {
        assert!(decode(text).is_err(), "{text}");
    }
}

#[test]
fn floats_use_sixteen_lowercase_hex_digits_and_reject_non_finite_values() -> Check {
    for value in [
        0.0_f64,
        -0.0,
        1.5,
        -2.25,
        f64::MAX,
        f64::MIN,
        f64::MIN_POSITIVE,
        f64::from_bits(1),
        f64::EPSILON,
    ] {
        let wire = format!(r#"{{"f64":"{:016x}"}}"#, value.to_bits());
        assert_eq!(one(&Cell::F64(value))?, format!(r#"{{"a":{wire}}}"#));
        let Cell::F64(decoded) = decode(&wire)? else {
            return Err("not a float".into());
        };
        assert_eq!(decoded.to_bits(), value.to_bits());
    }
    assert_eq!(Cell::F64(-0.0), Cell::F64(0.0));
    let Cell::F64(negative_zero) = decode(r#"{"f64":"8000000000000000"}"#)? else {
        return Err("not a float".into());
    };
    assert!(negative_zero.is_sign_negative());
    assert_eq!(negative_zero, 0.0);
    for text in [
        r#"{"f64":"7ff8000000000000"}"#,
        r#"{"f64":"7ff0000000000000"}"#,
        r#"{"f64":"fff0000000000000"}"#,
        r#"{"f64":"3FF8000000000000"}"#,
        r#"{"f64":"3ff800000000000"}"#,
        r#"{"f64":"03ff8000000000000"}"#,
        r#"{"f64":"0x3ff8000000000000"}"#,
        r#"{"f64":"1.5"}"#,
        r#"{"f64":1.5}"#,
        r#"{"f64":"NaN"}"#,
    ] {
        assert!(decode(text).is_err(), "{text}");
    }
    assert!(Cell::F64(f64::NAN).validate().is_err());
    assert!(Cell::F64(f64::INFINITY).validate().is_err());
    Ok(())
}

#[test]
fn uuid_cells_require_canonical_lowercase_hyphenated_form() -> Check {
    let canonical = "00112233-4455-6677-8899-aabbccddeeff";
    let expected = Cell::Uuid([
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
    ]);
    assert_eq!(decode(&format!(r#"{{"uuid":"{canonical}"}}"#))?, expected);
    assert_eq!(
        one(&expected)?,
        format!(r#"{{"a":{{"uuid":"{canonical}"}}}}"#)
    );
    for text in [
        "00112233-4455-6677-8899-AABBCCDDEEFF",
        "00112233445566778899aabbccddeeff",
        "00112233-4455-6677-8899-aabbccddeef",
        "00112233-4455-6677-8899-aabbccddeeff0",
        "{00112233-4455-6677-8899-aabbccddeeff}",
        "00112233-4455-6677-8899-aabbccddeefg",
        "",
    ] {
        assert!(
            decode(&format!(r#"{{"uuid":"{text}"}}"#)).is_err(),
            "{text}"
        );
    }
    Ok(())
}

#[test]
fn bare_numbers_unknown_tags_and_malformed_objects_are_rejected() {
    for text in [
        "1",
        "-1",
        "1.5",
        "[1]",
        "{}",
        r#"{"i32":"1"}"#,
        r#"{"I64":"1"}"#,
        r#"{"i64":"1","u64":"1"}"#,
        r#"{"i64":"1","i64":"2"}"#,
        r#"{"i64":null}"#,
        r#"{"i64":["1"]}"#,
        r#"{"$date":"1"}"#,
        r#"{"kind":"uint","value":"1"}"#,
        r#"{"i64":{"i64":"1"}}"#,
    ] {
        assert!(decode(text).is_err(), "{text}");
    }
    assert!(decode_typed_attributes(r#"{"a":true,"a":false}"#).is_err());
    assert!(decode_typed_attributes(r#"{"a":true} trailing"#).is_err());
    assert!(decode_typed_attributes("[]").is_err());
}

#[test]
fn null_is_a_value_and_stays_distinct_from_a_missing_entry() -> Check {
    let present = decode_typed_attributes(r#"{"a":null}"#)?;
    let missing = decode_typed_attributes("{}")?;
    assert_eq!(present.get("a"), Some(&Cell::Null));
    assert_eq!(missing.get("a"), None);
    assert_eq!(serde_json::to_string(&present)?, r#"{"a":null}"#);
    assert_eq!(serde_json::to_string(&missing)?, "{}");
    assert!(filter("exists", &json!(true), present.get("a"))?);
    assert!(!filter("exists", &json!(true), missing.get("a"))?);
    assert!(filter("eq", &json!(null), present.get("a"))?);
    assert!(!filter("eq", &json!(null), missing.get("a"))?);
    assert!(filter("ne", &json!(null), missing.get("a"))?);
    assert!(!filter("ne", &json!(null), present.get("a"))?);
    Ok(())
}

#[test]
fn arrays_are_homogeneous_flat_and_bounded() -> Check {
    assert_eq!(
        decode(r#"["a","b"]"#)?,
        Cell::Array(vec![Cell::String("a".into()), Cell::String("b".into())])
    );
    assert_eq!(
        decode(r#"[{"i64":"1"},{"i64":"2"}]"#)?,
        Cell::Array(vec![Cell::I64(1), Cell::I64(2)])
    );
    assert_eq!(decode("[]")?, Cell::Array(Vec::new()));
    assert_eq!(one(&Cell::Array(Vec::new()))?, r#"{"a":[]}"#);
    for text in [
        r#"["a",true]"#,
        r#"[{"i64":"1"},{"u64":"1"}]"#,
        r#"[{"i64":"1"},"1"]"#,
        r#"[["a"]]"#,
        r#"["a",null]"#,
        "[null]",
        "[1]",
        r#"[{"bytes":"Zg=="}]"#,
    ] {
        assert!(decode(text).is_err(), "{text}");
    }
    let at_bound = format!("[{}]", vec!["true"; MAX_ARRAY_ITEMS].join(","));
    assert!(decode(&at_bound).is_ok());
    let beyond = format!("[{}]", vec!["true"; MAX_ARRAY_ITEMS + 1].join(","));
    assert!(decode(&beyond).is_err());
    assert!(
        Cell::Array(vec![Cell::Bool(true); MAX_ARRAY_ITEMS + 1])
            .validate()
            .is_err()
    );
    assert!(
        Cell::Array(vec![Cell::I64(1), Cell::U64(1)])
            .validate()
            .is_err()
    );
    assert!(Cell::Array(vec![Cell::Null]).validate().is_err());
    assert!(
        Cell::Array(vec![Cell::Array(Vec::new())])
            .validate()
            .is_err()
    );
    Ok(())
}

#[test]
fn bytes_use_strict_lossless_padded_base64_within_the_decoded_bound() -> Check {
    for (raw, encoded) in [
        (b"".as_slice(), ""),
        (b"f".as_slice(), "Zg=="),
        (b"fo".as_slice(), "Zm8="),
        (b"foo".as_slice(), "Zm9v"),
        (b"foob".as_slice(), "Zm9vYg=="),
        (b"fooba".as_slice(), "Zm9vYmE="),
        (b"foobar".as_slice(), "Zm9vYmFy"),
    ] {
        assert_eq!(encode_base64(raw), encoded);
        assert_eq!(decode_base64(encoded)?, raw);
        assert_eq!(
            decode(&format!(r#"{{"bytes":"{encoded}"}}"#))?,
            Cell::Bytes(raw.to_vec())
        );
    }
    let every_byte: Vec<u8> = (0..=255).collect();
    assert_eq!(decode_base64(&encode_base64(&every_byte))?, every_byte);
    for text in [
        "Zg",
        "Zg=",
        "Zh==",
        "Zm9=",
        "Zm9v\n",
        " Zm9v",
        "Zm-v",
        "Zm_v",
        "Zg==Zg==",
        "Z===",
        "====",
        "Zm9vYg==Zm9v",
    ] {
        assert!(decode_base64(text).is_err(), "{text:?}");
    }
    assert!(Cell::Bytes(vec![0; MAX_BYTES_CELL]).validate().is_ok());
    assert!(Cell::Bytes(vec![0; MAX_BYTES_CELL + 1]).validate().is_err());
    assert!(decode_base64(&encode_base64(&vec![0; MAX_BYTES_CELL + 1])).is_err());
    Ok(())
}

#[test]
fn bytes_are_rejected_wherever_filtering_or_indexing_could_read_them() -> Check {
    assert!(validate_directory_attributes(r#"{"a":{"bytes":"Zg=="}}"#).is_err());
    assert!(validate_directory_attributes(r#"{"a":{"i64":"1"},"b":["x"]}"#).is_ok());
    assert!(validate_directory_attributes(r#"{"a":1}"#).is_err());
    assert!(validate_directory_attributes(r#"{"a":true,"a":false}"#).is_err());
    assert!(TypedFilter::prepare("eq", &json!({"bytes": "Zg=="})).is_err());
    assert!(TypedFilter::prepare("in", &json!([{"bytes": "Zg=="}])).is_err());
    assert!(
        ColumnSpec {
            name: "blob".into(),
            ty: CellType::Scalar(ScalarType::Bytes),
            filterable: true,
            nullable: false,
        }
        .validate()
        .is_err()
    );
    assert!(CellType::parse("[bytes]").is_err());
    let schema = AttributeSchema::from_json(r#"[{"name":"blob","type":"bytes"}]"#)?;
    assert_eq!(schema.filterable_names(), [] as [String; 0]);
    assert!(schema.validate_text_field("blob").is_err());
    Ok(())
}

#[test]
fn legacy_cells_keep_raw_json_and_never_become_typed_by_shape() -> Check {
    let lookalike = json!({"i64": "5"});
    let legacy = Cell::from(lookalike.clone());
    assert!(legacy.is_legacy());
    assert_eq!(legacy.as_legacy(), Some(&lookalike));
    assert_eq!(serde_json::to_value(&legacy)?, lookalike);
    assert_eq!(one(&legacy)?, r#"{"a":{"i64":"5"}}"#);
    assert_ne!(legacy, Cell::I64(5));
    assert_ne!(Cell::from(json!(5)), Cell::I64(5));
    assert!(legacy.validate().is_err());
    assert!(
        filter("eq", &json!({"i64": "5"}), Some(&legacy))
            .is_err_and(|cause| cause.contains("Legacy"))
    );
    let raw = json!({"n": 18_014_398_509_481_985_u64, "o": {"u64": "1"}, "a": [1, 2.5, null]});
    let text = serde_json::to_string(&raw)?;
    let cells: BTreeMap<String, Cell> = raw
        .as_object()
        .ok_or("object")?
        .iter()
        .map(|(name, value)| (name.clone(), Cell::from(value.clone())))
        .collect();
    assert_eq!(serde_json::to_string(&cells)?, text);
    Ok(())
}

#[test]
fn typed_equality_ranges_and_membership_are_exact_and_never_coerce() -> Check {
    let boundary = 1_i64 << 53;
    let actual = Cell::I64(boundary + 1);
    assert!(filter(
        "eq",
        &json!({"i64": (boundary + 1).to_string()}),
        Some(&actual)
    )?);
    assert!(!filter(
        "eq",
        &json!({"i64": boundary.to_string()}),
        Some(&actual)
    )?);
    assert!(filter(
        "gt",
        &json!({"i64": boundary.to_string()}),
        Some(&actual)
    )?);
    assert!(filter(
        "gte",
        &json!({"i64": (boundary + 1).to_string()}),
        Some(&actual)
    )?);
    assert!(!filter(
        "lt",
        &json!({"i64": (boundary + 1).to_string()}),
        Some(&actual)
    )?);
    assert!(filter(
        "lte",
        &json!({"i64": (boundary + 1).to_string()}),
        Some(&actual)
    )?);
    let top = Cell::U64(u64::MAX);
    assert!(filter(
        "eq",
        &json!({"u64": u64::MAX.to_string()}),
        Some(&top)
    )?);
    assert!(filter(
        "gt",
        &json!({"u64": (u64::MAX - 1).to_string()}),
        Some(&top)
    )?);
    assert!(!filter(
        "gt",
        &json!({"u64": u64::MAX.to_string()}),
        Some(&top)
    )?);
    let bottom = Cell::I64(i64::MIN);
    assert!(filter(
        "lt",
        &json!({"i64": (i64::MIN + 1).to_string()}),
        Some(&bottom)
    )?);
    assert!(filter(
        "in",
        &json!([{"i64": i64::MIN.to_string()}, {"i64": "7"}]),
        Some(&bottom)
    )?);
    assert!(filter("notIn", &json!([{"i64": "7"}]), Some(&bottom))?);
    assert!(!filter("in", &json!([{"i64": "7"}]), None)?);
    assert!(filter("notIn", &json!([{"i64": "7"}]), None)?);

    Ok(())
}

#[test]
fn typed_comparisons_never_coerce_kinds() -> Check {
    // Cross-kind operands never equal and never order: no widening, no float coercion.
    let signed = Cell::I64(1);
    let unsigned = json!({"u64": "1"});
    assert!(!filter("eq", &unsigned, Some(&signed))?);
    assert!(filter("ne", &unsigned, Some(&signed))?);
    for op in ["gt", "gte", "lt", "lte"] {
        assert!(!filter(op, &unsigned, Some(&signed))?, "{op}");
        assert!(
            !filter(op, &json!({"datetime_ms": "1"}), Some(&signed))?,
            "{op}"
        );
        assert!(
            !filter(
                op,
                &json!({"f64": format!("{:016x}", 1.0_f64.to_bits())}),
                Some(&signed)
            )?,
            "{op}"
        );
        assert!(!filter(op, &json!("1"), Some(&signed))?, "{op}");
    }
    assert!(!filter("eq", &json!("1"), Some(&signed))?);
    assert!(!filter("eq", &json!(true), Some(&Cell::Bool(false)))?);
    for op in ["gt", "gte", "lt", "lte"] {
        assert!(!filter(op, &json!(true), Some(&Cell::Bool(false)))?, "{op}");
        assert!(!filter(op, &json!(null), Some(&Cell::Null))?, "{op}");
    }

    // Floats compare numerically with -0 == 0 and only among finite values.
    let float = |value: f64| json!({"f64": format!("{:016x}", value.to_bits())});
    assert!(filter("eq", &float(0.0), Some(&Cell::F64(-0.0)))?);
    assert!(filter("lte", &float(-0.0), Some(&Cell::F64(0.0)))?);
    assert!(filter("gte", &float(-0.0), Some(&Cell::F64(0.0)))?);
    assert!(!filter("gt", &float(-0.0), Some(&Cell::F64(0.0)))?);
    assert!(filter("lt", &float(1.5), Some(&Cell::F64(-1.5)))?);
    assert!(filter("gt", &float(f64::MIN), Some(&Cell::F64(f64::MAX)))?);
    assert!(TypedFilter::prepare("eq", &json!({"f64": "7ff8000000000000"})).is_err());

    // Strings order by their characters; uuid and datetime order by their own kind.
    assert!(filter("lt", &json!("b"), Some(&Cell::String("a".into())))?);
    assert!(filter(
        "gt",
        &json!({"datetime_ms": "-1"}),
        Some(&Cell::DatetimeMs(0))
    )?);
    assert!(filter(
        "gt",
        &json!({"uuid": "00000000-0000-0000-0000-000000000000"}),
        Some(&Cell::Uuid([
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
        ]))
    )?);
    Ok(())
}

#[test]
fn typed_array_membership_uses_exact_element_equality() -> Check {
    let tags = Cell::Array(vec![Cell::String("a".into()), Cell::String("b".into())]);
    assert!(filter("contains", &json!("a"), Some(&tags))?);
    assert!(!filter("contains", &json!("c"), Some(&tags))?);
    assert!(filter("notContains", &json!("c"), Some(&tags))?);
    assert!(filter("containsAny", &json!(["z", "b"]), Some(&tags))?);
    assert!(!filter("containsAny", &json!(["z"]), Some(&tags))?);
    assert!(filter("notContainsAny", &json!(["z"]), Some(&tags))?);
    assert!(!filter("contains", &json!("a"), None)?);
    assert!(filter("notContains", &json!("a"), None)?);
    assert!(!filter(
        "contains",
        &json!("a"),
        Some(&Cell::String("a".into()))
    )?);
    assert!(filter("eq", &json!(["a", "b"]), Some(&tags))?);
    assert!(!filter("eq", &json!(["b", "a"]), Some(&tags))?);
    let numbers = Cell::Array(vec![Cell::I64(1), Cell::I64(2)]);
    assert!(filter("contains", &json!({"i64": "2"}), Some(&numbers))?);
    assert!(!filter("contains", &json!({"u64": "2"}), Some(&numbers))?);
    assert!(filter("contains", &json!(null), Some(&numbers)).is_err());
    assert!(filter("contains", &json!(["a"]), Some(&tags)).is_err());
    Ok(())
}

#[test]
fn typed_filters_reject_raw_numbers_unknown_operators_and_malformed_lists() {
    assert!(TypedFilter::prepare("eq", &json!(1)).is_err());
    assert!(TypedFilter::prepare("gt", &json!(1.5)).is_err());
    assert!(TypedFilter::prepare("in", &json!([1])).is_err());
    assert!(TypedFilter::prepare("in", &json!("a")).is_err());
    assert!(TypedFilter::prepare("notIn", &json!({"i64": "1"})).is_err());
    assert!(TypedFilter::prepare("exists", &json!("yes")).is_err());
    assert!(TypedFilter::prepare("mystery", &json!("a")).is_err());
    assert!(TypedFilter::prepare("eq", &json!({"i64": "01"})).is_err());
    assert!(TypedFilter::prepare("eq", &json!({"i64": "1", "extra": 1})).is_err());
    assert!(TypedFilter::prepare("exists", &json!(false)).is_ok());
}

#[test]
fn declarations_reject_unimplemented_features_unknown_members_and_bad_flags() -> Check {
    let schema = AttributeSchema::from_json(
        r#"[
            {"name":"n","type":"i64","filterable":true,"nullable":true},
            {"name":"tags","type":"[string]","filterable":true},
            {"name":"at","type":"datetime_ms"},
            {"name":"blob","type":"bytes","nullable":true}
        ]"#,
    )?;
    assert_eq!(schema.filterable_names(), ["n", "tags"]);
    assert_eq!(
        schema.get("tags").map(|column| column.ty),
        Some(CellType::Array(ScalarType::String))
    );
    assert_eq!(CellType::Array(ScalarType::I64).name(), "[i64]");
    for declaration in [
        r#"[{"name":"a","type":"string","fullTextSearch":true}]"#,
        r#"[{"name":"a","type":"string","full_text_search":true}]"#,
        r#"[{"name":"a","type":"[f32]","ann":true}]"#,
        r#"[{"name":"a","type":"string","inference":{}}]"#,
        r#"[{"name":"a","type":"string","drop":true}]"#,
        r#"[{"name":"a","type":"string","vector":{}}]"#,
        r#"[{"name":"a","type":"string","filterable":"yes"}]"#,
        r#"[{"name":"a","type":"string","nullable":1}]"#,
        r#"[{"name":"a","type":"string","filterable":null}]"#,
        r#"[{"name":"a"}]"#,
        r#"[{"type":"string"}]"#,
        r#"[{"name":"a","type":"int"}]"#,
        r#"[{"name":"a","type":"I64"}]"#,
        r#"[{"name":"a","type":"[]"}]"#,
        r#"[{"name":"a","type":"[[i64]]"}]"#,
        r#"[{"name":"a","type":"[i64"}]"#,
        r#"[{"name":"a","type":"[bytes]"}]"#,
        r#"[{"name":"a","type":"bytes","filterable":true}]"#,
        r#"[{"name":"","type":"string"}]"#,
        r#"[{"name":"$id","type":"string"}]"#,
        r#"[{"name":"a","type":"string"},{"name":"a","type":"bool"}]"#,
        r#"{"name":"a","type":"string"}"#,
        "[1]",
        "",
    ] {
        assert!(
            AttributeSchema::from_json(declaration).is_err(),
            "{declaration}"
        );
    }
    let too_many_filterable = (0..65)
        .map(|index| format!(r#"{{"name":"f{index}","type":"bool","filterable":true}}"#))
        .collect::<Vec<_>>()
        .join(",");
    assert!(AttributeSchema::from_json(&format!("[{too_many_filterable}]")).is_err());
    let long = "x".repeat(129);
    assert!(
        AttributeSchema::from_json(&format!(r#"[{{"name":"{long}","type":"bool"}}]"#)).is_err()
    );
    Ok(())
}

#[test]
fn schema_validation_checks_kinds_nullability_and_keeps_missing_distinct() -> Check {
    let schema = AttributeSchema::from_json(
        r#"[
            {"name":"n","type":"i64","nullable":true},
            {"name":"u","type":"u64"},
            {"name":"tags","type":"[string]"},
            {"name":"title","type":"string"}
        ]"#,
    )?;
    let attributes = |entries: Vec<(&str, Cell)>| -> BTreeMap<String, Cell> {
        entries
            .into_iter()
            .map(|(name, cell)| (name.to_owned(), cell))
            .collect()
    };
    schema.validate_attributes(&attributes(vec![]))?;
    schema.validate_attributes(&attributes(vec![
        ("n", Cell::Null),
        ("u", Cell::U64(u64::MAX)),
        ("tags", Cell::Array(vec![])),
        ("title", Cell::String("attribute named like a role".into())),
    ]))?;
    for invalid in [
        vec![("undeclared", Cell::Bool(true))],
        vec![("n", Cell::U64(1))],
        vec![("u", Cell::I64(1))],
        vec![("u", Cell::Null)],
        vec![("n", Cell::F64(1.0))],
        vec![("tags", Cell::String("a".into()))],
        vec![("tags", Cell::Array(vec![Cell::I64(1)]))],
        vec![("title", Cell::Array(vec![Cell::String("a".into())]))],
        vec![("n", Cell::from(json!(1)))],
        vec![("title", Cell::from(json!("legacy")))],
    ] {
        assert!(
            schema
                .validate_attributes(&attributes(invalid.clone()))
                .is_err(),
            "{invalid:?}"
        );
    }
    assert!(schema.validate_text_field("tags").is_ok());
    assert!(schema.validate_text_field("title").is_ok());
    assert!(schema.validate_text_field("n").is_err());
    assert!(schema.validate_text_field("undeclared").is_err());
    Ok(())
}
