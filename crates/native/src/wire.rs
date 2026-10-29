use raio_engine::segment::{ColumnId, ColumnValue, Document, NativeRole};

#[doc = "# Errors\nRejects JSON that is not the historical native document wire."]
pub(crate) fn document_from_native_wire(bytes: &[u8]) -> Result<Document, String> {
    Document::from_native_slice(bytes)
}

#[doc = "# Errors\nRejects a document that cannot be encoded on the historical native wire."]
pub(crate) fn document_to_native_wire(document: &Document) -> Result<Vec<u8>, String> {
    document.to_native_vec()
}

#[doc = "Checks the historical native document wire once before the ranker serves traffic.\n\n`/rank` carries prepared segments, not documents. Omitted `title` stays an empty native role.\n\n# Errors\nRejects a native document wire that does not round-trip id, revision, title, text, or object shape."]
pub(crate) fn retain_native_document_boundary() -> Result<(), String> {
    let document =
        document_from_native_wire(br#"{"id":"boundary","text":"native","attributes":{}}"#)?;
    if document.id != "boundary" || document.revision != 0 {
        return Err("Native document wire changed the id or revision".into());
    }
    match document.column(ColumnId::Role(NativeRole::Title)) {
        Some(ColumnValue::Text("")) => {}
        Some(ColumnValue::Text(_) | ColumnValue::Vector(_) | ColumnValue::Attribute(_)) | None => {
            return Err("Omitted native title must stay an empty role".into());
        }
    }
    let encoded = document_to_native_wire(&document)?;
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

#[cfg(test)]
mod tests {
    use super::{document_from_native_wire, document_to_native_wire};
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
        let encoded = document_to_native_wire(&document)?;
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
        let decoded = document_from_native_wire(&encoded)?;
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
        assert!(document_from_native_wire(&canonical).is_err());
        assert!(
            document_from_native_wire(
                br#"{"id":"doc","title":null,"text":"role-text","attributes":{}}"#,
            )
            .is_err()
        );
        Ok(())
    }
}
