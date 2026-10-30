use raio_engine::segment::{ColumnId, ColumnValue, Document, NativeRole};
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn native_cli_wire_keeps_flat_fields_and_float_bits() -> Result<(), String> {
    let mut attributes = BTreeMap::new();
    assert!(
        attributes
            .insert("title".into(), serde_json::json!("attr-title"))
            .is_none()
    );
    let document = Document::native(
        "doc",
        4,
        "role-title",
        "role-text",
        attributes,
        Some(vec![f32::MAX, -0.0]),
    );
    let encoded = document.to_native_vec()?;
    let value: serde_json::Value =
        serde_json::from_slice(&encoded).map_err(|cause| cause.to_string())?;
    let keys = value
        .as_object()
        .ok_or("Native document is not an object")?
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    assert_eq!(
        keys,
        BTreeSet::from([
            "attributes".into(),
            "id".into(),
            "revision".into(),
            "text".into(),
            "title".into(),
            "vector".into(),
        ])
    );
    assert_eq!(value["title"], "role-title");
    assert_eq!(value["attributes"]["title"], "attr-title");
    let decoded = Document::from_native_slice(&encoded)?;
    let bits = match decoded.column(ColumnId::Role(NativeRole::Vector)) {
        Some(ColumnValue::Vector(values)) => values
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        Some(ColumnValue::Text(_) | ColumnValue::Attribute(_)) | None => {
            return Err("Native vector role disappeared".into());
        }
    };
    assert_eq!(bits, vec![f32::MAX.to_bits(), (-0.0f32).to_bits()]);
    let canonical = document.to_canonical_vec()?;
    assert!(Document::from_native_slice(&canonical).is_err());
    assert!(
        Document::from_native_slice(
            br#"{"id":"doc","title":null,"text":"role-text","attributes":{}}"#,
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn native_document_defaults_preserve_legacy_shape() -> Result<(), String> {
    let document =
        Document::from_native_slice(br#"{"id":"boundary","text":"native","attributes":{}}"#)?;
    if document.id != "boundary" || document.revision != 0 {
        return Err("Native document wire changed the id or revision".into());
    }
    match document.column(ColumnId::Role(NativeRole::Title)) {
        Some(ColumnValue::Text("")) => {}
        Some(ColumnValue::Text(_) | ColumnValue::Vector(_) | ColumnValue::Attribute(_)) | None => {
            return Err("Omitted native title must stay an empty role".into());
        }
    }
    let encoded = document.to_native_vec()?;
    let parsed: serde_json::Value =
        serde_json::from_slice(&encoded).map_err(|cause| cause.to_string())?;
    if parsed.get("roles").is_some()
        || parsed.get("id").and_then(serde_json::Value::as_str) != Some("boundary")
        || parsed.get("title").and_then(serde_json::Value::as_str) != Some("")
        || parsed.get("text").and_then(serde_json::Value::as_str) != Some("native")
    {
        return Err("Native document wire changed the legacy object".into());
    }
    Ok(())
}
