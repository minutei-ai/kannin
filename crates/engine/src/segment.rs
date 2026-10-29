mod binary_directory;
mod fields;
mod ids;
mod numbers;
pub use ids::{DocumentId, DocumentIdRef};

pub use fields::{
    Bm25Parameters, CorpusStatistics, FieldAnalysis, FieldMeta, FieldQuery, FieldStatistics,
    FieldTable, NamedTextField,
};

use crate::analysis::WordV4Config;
use crate::normalize_text;
use bit_vec::BitVec;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, VecDeque};
use std::rc::Rc;

const MAGIC_V2: &[u8; 8] = b"RAIOSEG2";
const MAGIC_V3: &[u8; 8] = b"RAIOSEG3";
const MAGIC_V4: &[u8; 8] = b"RAIOSEG4";
const MAGIC_V5: &[u8; 8] = b"RAIOSEG5";
const METADATA_CODEC_FACTS: u8 = 2;
const METADATA_CODEC_CANONICAL: u8 = 3;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const BLOCK_SIZE: usize = 128;
const FILTER_CACHE_BYTES: usize = 32 * 1024;
const MAX_QUERY_TERMS: usize = 512;
const LANES: usize = 2;

fn segment_magic(version: u32) -> Result<&'static [u8; 8], String> {
    match version {
        2 => Ok(MAGIC_V2),
        3 => Ok(MAGIC_V3),
        4 => Ok(MAGIC_V4),
        5 => Ok(MAGIC_V5),
        _ => Err("Invalid segment version".into()),
    }
}

pub(crate) fn compare_document_ids<'a, 'b>(
    left: impl Into<DocumentIdRef<'a>>,
    right: impl Into<DocumentIdRef<'b>>,
) -> Ordering {
    ids::compare(left.into(), right.into())
}

#[doc = "# Errors\nRejects malformed canonical ID JSON, noncanonical integer/UUID tags or native string IDs outside 1..=128 UTF-16 code units."]
pub(crate) fn decode_document_id(encoded: &str) -> Result<DocumentId, String> {
    let id: DocumentId = serde_json::from_str(encoded).map_err(|cause| cause.to_string())?;
    if !id.is_valid() {
        return Err("Invalid canonical document ID".into());
    }
    Ok(id)
}

#[derive(Clone, Default)]
struct FilterMasks {
    representatives: Option<(String, Box<[u16]>)>,
    entries: VecDeque<(String, BitVec, usize)>,
    bytes: usize,
}

impl FilterMasks {
    fn reserve(&mut self, bytes: usize) -> bool {
        let retained = self.representatives.as_ref().map_or(0, |(scope, rows)| {
            scope.capacity() + size_of_val(rows.as_ref()) + 128
        });
        if bytes > FILTER_CACHE_BYTES.saturating_sub(retained) {
            return false;
        }
        while self.bytes + bytes > FILTER_CACHE_BYTES || self.entries.len() >= 16 {
            let Some((_, _, removed)) = self.entries.pop_front() else {
                return false;
            };
            self.bytes -= removed;
        }
        true
    }

    fn prepare_representatives(
        &mut self,
        documents: &DocumentTable,
        fields: &BTreeSet<&str>,
    ) -> Result<(), String> {
        use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher};

        let mut required: BTreeSet<String> =
            fields.iter().map(|field| (*field).to_owned()).collect();
        if let Some((scope, _)) = &self.representatives {
            let previous: BTreeSet<String> =
                serde_json::from_str(scope).map_err(|cause| cause.to_string())?;
            if required.is_subset(&previous) {
                return Ok(());
            }
            required.extend(previous);
            if required.len() > 16 {
                required.retain(|field| fields.contains(field.as_str()));
            }
        }
        let scope = serde_json::to_string(&required).map_err(|cause| cause.to_string())?;
        let fields: BTreeSet<_> = required.iter().map(String::as_str).collect();
        if let Some((scope, rows)) = self.representatives.take() {
            self.bytes -= scope.capacity() + size_of_val(rows.as_ref()) + 128;
        }
        if scope.capacity() + documents.len() * size_of::<u16>() + 128 > FILTER_CACHE_BYTES {
            return Ok(());
        }

        let row_hasher = BuildHasherDefault::<DefaultHasher>::default();
        let mut observed = std::collections::HashMap::new();
        let repeated = (0..documents.len().min(128)).any(|sample| {
            let hash = row_hasher.hash_one(sample).to_le_bytes();
            let row = usize::from(u16::from_le_bytes([hash[0], hash[1]])) % documents.len();
            observed
                .insert(documents.attributes.get(row).get(), row)
                .is_some_and(|previous| previous != row)
        });
        if repeated {
            let mut raw_groups = std::collections::HashMap::new();
            let mut shared_groups = hashbrown::HashMap::new();
            let mut groups = std::collections::HashMap::new();
            let mut group_bytes = 0;
            let mut values: BTreeMap<_, Option<serde_json::Value>> =
                fields.iter().map(|field| (*field, None)).collect();
            let representatives = documents
                .metadata()
                .enumerate()
                .map(|(index, doc)| {
                    let row = u16::try_from(index).map_err(|cause| cause.to_string())?;
                    let shared = doc.attributes.shared_identity();
                    let previous = shared.map_or_else(
                        || raw_groups.get(doc.attributes.get()),
                        |key| shared_groups.get(&key),
                    );
                    if let Some(previous) = previous {
                        return Ok(*previous);
                    }
                    for value in values.values_mut() {
                        *value = None;
                    }
                    let mut decoder = serde_json::Deserializer::from_str(doc.attributes.get());
                    serde::de::DeserializeSeed::deserialize(
                        FilterAttributes {
                            fields: &fields,
                            values: &mut values,
                        },
                        &mut decoder,
                    )
                    .map_err(|cause| cause.to_string())?;
                    decoder.end().map_err(|cause| cause.to_string())?;
                    let representative = if values.values().flatten().all(|value| {
                        !value.is_array()
                            && !value.is_object()
                            && value.as_str().is_none_or(|text| text.len() <= 256)
                    }) {
                        let projected: Vec<_> = values.values().map(Option::as_slice).collect();
                        let key =
                            serde_json::to_string(&projected).map_err(|cause| cause.to_string())?;
                        let representative = groups.get(&key).copied().unwrap_or(row);
                        if representative == row && group_bytes + key.capacity() + 64 <= 16 * 1024 {
                            group_bytes += key.capacity() + 64;
                            groups.insert(key, row);
                        }
                        representative
                    } else {
                        row
                    };
                    if raw_groups.len() + shared_groups.len() < 2048 {
                        shared.map_or_else(
                            || raw_groups.insert(doc.attributes.get(), representative),
                            |key| shared_groups.insert(key, representative),
                        );
                    }
                    Ok(representative)
                })
                .collect::<Result<Box<[_]>, String>>()?;
            let bytes = scope.capacity() + size_of_val(representatives.as_ref()) + 128;
            if self.reserve(bytes) {
                self.bytes += bytes;
                self.representatives = Some((scope, representatives));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeRole {
    Title,
    Text,
    Vector,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnId<'a> {
    Role(NativeRole),
    Attribute(&'a str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocumentColumnId {
    Role(NativeRole),
    Attribute(String),
}

impl DocumentColumnId {
    #[must_use]
    pub fn attribute(name: impl Into<String>) -> Self {
        Self::Attribute(name.into())
    }

    #[must_use]
    pub fn as_column(&self) -> ColumnId<'_> {
        match self {
            Self::Role(role) => ColumnId::Role(*role),
            Self::Attribute(name) => ColumnId::Attribute(name),
        }
    }
}

impl From<ColumnId<'_>> for DocumentColumnId {
    fn from(id: ColumnId<'_>) -> Self {
        match id {
            ColumnId::Role(role) => Self::Role(role),
            ColumnId::Attribute(name) => Self::Attribute(name.to_owned()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ColumnValue<'a> {
    Text(&'a str),
    Vector(&'a [f32]),
    Attribute(&'a serde_json::Value),
}

#[derive(Clone)]
pub struct Columns {
    title: String,
    text: String,
    vector: Option<Vec<f32>>,
    attributes: BTreeMap<String, serde_json::Value>,
}

impl Columns {
    const fn new(
        title: String,
        text: String,
        attributes: BTreeMap<String, serde_json::Value>,
        vector: Option<Vec<f32>>,
    ) -> Self {
        Self {
            title,
            text,
            vector,
            attributes,
        }
    }

    #[must_use]
    pub fn get(&self, id: ColumnId<'_>) -> Option<ColumnValue<'_>> {
        match id {
            ColumnId::Role(NativeRole::Title) => Some(ColumnValue::Text(&self.title)),
            ColumnId::Role(NativeRole::Text) => Some(ColumnValue::Text(&self.text)),
            ColumnId::Role(NativeRole::Vector) => self.vector.as_deref().map(ColumnValue::Vector),
            ColumnId::Attribute(name) => self.attributes.get(name).map(ColumnValue::Attribute),
        }
    }

    #[must_use]
    pub const fn attributes(&self) -> &BTreeMap<String, serde_json::Value> {
        &self.attributes
    }

    #[must_use]
    pub const fn attributes_mut(&mut self) -> &mut BTreeMap<String, serde_json::Value> {
        &mut self.attributes
    }

    #[doc = "# Errors\nRejects the native vector role because it is not stored as text."]
    pub fn set_text(&mut self, role: NativeRole, value: String) -> Result<(), String> {
        match role {
            NativeRole::Title => {
                self.title = value;
                Ok(())
            }
            NativeRole::Text => {
                self.text = value;
                Ok(())
            }
            NativeRole::Vector => Err("Native vector role is not text".into()),
        }
    }

    pub fn set_vector(&mut self, vector: Option<Vec<f32>>) {
        self.vector = vector;
    }
}

#[derive(Clone)]
pub struct Document {
    pub id: DocumentId,
    pub revision: u64,
    columns: Columns,
}

#[derive(Serialize)]
struct CanonicalRolesRef<'a> {
    title: &'a str,
    text: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalRoles {
    title: String,
    text: String,
}

#[derive(Serialize)]
struct CanonicalDocumentRef<'a> {
    id: DocumentIdRef<'a>,
    revision: u64,
    roles: CanonicalRolesRef<'a>,
    attributes: &'a BTreeMap<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vector: Option<DocumentVectorRef<'a>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalDocumentDto {
    id: DocumentId,
    revision: u64,
    roles: CanonicalRoles,
    attributes: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    vector: Option<Vec<f32>>,
}

#[derive(Serialize)]
struct StoredCanonicalRef<'a> {
    id: DocumentIdRef<'a>,
    revision: u64,
    roles: CanonicalRolesRef<'a>,
    attributes: &'a BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCanonicalDocument {
    id: DocumentId,
    revision: u64,
    roles: CanonicalRoles,
    attributes: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize)]
struct NativeDocumentRef<'a> {
    id: &'a str,
    revision: u64,
    title: &'a str,
    text: &'a str,
    attributes: &'a BTreeMap<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vector: Option<DocumentVectorRef<'a>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeDocumentDto {
    id: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    title: String,
    text: String,
    attributes: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    vector: Option<Vec<f32>>,
}

#[derive(Serialize)]
struct CanonicalQueryRef<'a> {
    id: DocumentIdRef<'a>,
    revision: u64,
    roles: CanonicalRolesRef<'a>,
    attributes: &'a BTreeMap<String, serde_json::Value>,
    #[serde(rename = "vectorSummary")]
    vector_summary: Option<(usize, bool, bool)>,
}

fn serialize_f32_slice<S: serde::Serializer>(
    values: &[f32],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq as _;

    if !values
        .iter()
        .any(|value| value.abs().to_bits() == f32::MAX.to_bits())
    {
        return values.serialize(serializer);
    }
    let mut sequence = serializer.serialize_seq(Some(values.len()))?;
    for value in values {
        if value.abs().to_bits() == f32::MAX.to_bits() {
            sequence.serialize_element(&f64::from(*value))?;
        } else {
            sequence.serialize_element(value)?;
        }
    }
    sequence.end()
}

struct DocumentVectorRef<'a>(&'a [f32]);

impl Serialize for DocumentVectorRef<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize_f32_slice(self.0, serializer)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct VectorFacts {
    flags: u8,
    dimensions: u32,
}

fn vector_facts(vector: Option<&[f32]>) -> Result<VectorFacts, String> {
    vector.map_or(
        Ok(VectorFacts {
            flags: 0,
            dimensions: 0,
        }),
        |values| {
            let dimensions = u32::try_from(values.len()).map_err(|cause| cause.to_string())?;
            let finite = values.iter().all(|value| value.is_finite());
            let nonzero = values.iter().any(|value| *value != 0.0);
            Ok(VectorFacts {
                flags: 1 | (u8::from(finite) << 1) | (u8::from(nonzero) << 2),
                dimensions,
            })
        },
    )
}

fn write_vector_facts(facts: VectorFacts, output: &mut Vec<u8>) {
    output.extend_from_slice(&[METADATA_CODEC_FACTS, facts.flags]);
    output.extend_from_slice(&facts.dimensions.to_le_bytes());
}

fn read_vector_facts(bytes: &[u8]) -> Result<(VectorFacts, &[u8]), String> {
    if bytes.len() < 6 || bytes[0] != METADATA_CODEC_FACTS {
        return Err("Invalid separated document metadata prefix".into());
    }
    let flags = bytes[1];
    if flags & !7 != 0 {
        return Err("Unknown separated document vector flags".into());
    }
    let dimensions = u32::from_le_bytes(
        bytes[2..6]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    );
    if flags & 1 == 0 && (flags != 0 || dimensions != 0) {
        return Err("Absent vector metadata must have zero flags and dimensions".into());
    }
    Ok((VectorFacts { flags, dimensions }, &bytes[6..]))
}

impl Document {
    #[must_use]
    pub fn native(
        id: impl Into<String>,
        revision: u64,
        title: impl Into<String>,
        text: impl Into<String>,
        attributes: BTreeMap<String, serde_json::Value>,
        vector: Option<Vec<f32>>,
    ) -> Self {
        Self {
            id: DocumentId::String(id.into()),
            revision,
            columns: Columns::new(title.into(), text.into(), attributes, vector),
        }
    }

    #[must_use]
    pub const fn columns(&self) -> &Columns {
        &self.columns
    }

    #[must_use]
    pub const fn columns_mut(&mut self) -> &mut Columns {
        &mut self.columns
    }

    #[must_use]
    pub fn column(&self, id: ColumnId<'_>) -> Option<ColumnValue<'_>> {
        self.columns.get(id)
    }

    fn role_text(&self, role: NativeRole) -> Result<&str, String> {
        match self.column(ColumnId::Role(role)) {
            Some(ColumnValue::Text(text)) => Ok(text),
            Some(ColumnValue::Vector(_) | ColumnValue::Attribute(_)) => {
                Err("Native text role is not text".into())
            }
            None => Err("Missing native text role".into()),
        }
    }

    fn vector_values(&self) -> Result<Option<&[f32]>, String> {
        match self.column(ColumnId::Role(NativeRole::Vector)) {
            Some(ColumnValue::Vector(values)) => Ok(Some(values)),
            None => Ok(None),
            Some(ColumnValue::Text(_) | ColumnValue::Attribute(_)) => {
                Err("Native vector role is not a vector".into())
            }
        }
    }

    fn roles_ref(&self) -> Result<CanonicalRolesRef<'_>, String> {
        Ok(CanonicalRolesRef {
            title: self.role_text(NativeRole::Title)?,
            text: self.role_text(NativeRole::Text)?,
        })
    }

    fn from_parts(
        id: DocumentId,
        revision: u64,
        title: String,
        text: String,
        attributes: BTreeMap<String, serde_json::Value>,
        vector: Option<Vec<f32>>,
    ) -> Self {
        Self {
            id,
            revision,
            columns: Columns::new(title, text, attributes, vector),
        }
    }

    fn from_native_dto(dto: NativeDocumentDto) -> Self {
        Self::from_parts(
            dto.id.into(),
            dto.revision,
            dto.title,
            dto.text,
            dto.attributes,
            dto.vector,
        )
    }

    fn from_canonical_dto(dto: CanonicalDocumentDto) -> Self {
        Self::from_parts(
            dto.id,
            dto.revision,
            dto.roles.title,
            dto.roles.text,
            dto.attributes,
            dto.vector,
        )
    }

    fn from_stored_dto(dto: StoredCanonicalDocument) -> Self {
        Self::from_parts(
            dto.id,
            dto.revision,
            dto.roles.title,
            dto.roles.text,
            dto.attributes,
            None,
        )
    }

    #[doc = "# Errors\nRejects JSON that is not the historical native document wire."]
    pub fn from_native_slice(bytes: &[u8]) -> Result<Self, String> {
        let dto: NativeDocumentDto =
            serde_json::from_slice(bytes).map_err(|cause| cause.to_string())?;
        Ok(Self::from_native_dto(dto))
    }

    #[doc = "# Errors\nRejects JSON that is not the historical native document wire."]
    pub fn from_native_json(json: &str) -> Result<Self, String> {
        Self::from_native_slice(json.as_bytes())
    }

    #[doc = "# Errors\nRejects JSON that is not the historical native document wire."]
    pub fn from_native_value(value: serde_json::Value) -> Result<Self, serde_json::Error> {
        Ok(Self::from_native_dto(serde_json::from_value(value)?))
    }

    #[doc = "# Errors\nRejects a document that cannot be encoded on the historical native wire."]
    pub fn to_native_vec(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&self.native_ref()?).map_err(|cause| cause.to_string())
    }

    #[doc = "# Errors\nRejects a document that cannot be encoded on the historical native wire."]
    pub fn to_native_json(&self) -> Result<String, String> {
        serde_json::to_string(&self.native_ref()?).map_err(|cause| cause.to_string())
    }

    #[cfg(test)]
    fn to_native_metadata_vec(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&NativeDocumentRef {
            id: self.id.native_str()?,
            revision: self.revision,
            title: self.role_text(NativeRole::Title)?,
            text: self.role_text(NativeRole::Text)?,
            attributes: self.columns.attributes(),
            vector: None,
        })
        .map_err(|cause| cause.to_string())
    }

    fn native_ref(&self) -> Result<NativeDocumentRef<'_>, String> {
        Ok(NativeDocumentRef {
            id: self.id.native_str()?,
            revision: self.revision,
            title: self.role_text(NativeRole::Title)?,
            text: self.role_text(NativeRole::Text)?,
            attributes: self.columns.attributes(),
            vector: self.vector_values()?.map(DocumentVectorRef),
        })
    }

    #[doc = "# Errors\nRejects JSON that is not the canonical document interchange."]
    pub fn from_canonical_slice(bytes: &[u8]) -> Result<Self, String> {
        let dto: CanonicalDocumentDto =
            serde_json::from_slice(bytes).map_err(|cause| cause.to_string())?;
        Ok(Self::from_canonical_dto(dto))
    }

    #[doc = "# Errors\nRejects JSON that is not the canonical document interchange."]
    pub fn from_canonical_json(json: &str) -> Result<Self, String> {
        Self::from_canonical_slice(json.as_bytes())
    }

    #[doc = "# Errors\nRejects a document that cannot be encoded as canonical interchange."]
    pub fn to_canonical_json(&self) -> Result<String, String> {
        serde_json::to_string(&self.canonical_ref()?).map_err(|cause| cause.to_string())
    }

    #[doc = "# Errors\nRejects a document that cannot be encoded as canonical interchange."]
    pub fn to_canonical_vec(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&self.canonical_ref()?).map_err(|cause| cause.to_string())
    }

    fn canonical_ref(&self) -> Result<CanonicalDocumentRef<'_>, String> {
        Ok(CanonicalDocumentRef {
            id: self.id.borrowed(),
            revision: self.revision,
            roles: self.roles_ref()?,
            attributes: self.columns.attributes(),
            vector: self.vector_values()?.map(DocumentVectorRef),
        })
    }

    fn to_stored_canonical_vec(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&StoredCanonicalRef {
            id: self.id.borrowed(),
            revision: self.revision,
            roles: self.roles_ref()?,
            attributes: self.columns.attributes(),
        })
        .map_err(|cause| cause.to_string())
    }

    fn query_ref(&self, facts: VectorFacts) -> Result<CanonicalQueryRef<'_>, String> {
        Ok(CanonicalQueryRef {
            id: self.id.borrowed(),
            revision: self.revision,
            roles: self.roles_ref()?,
            attributes: self.columns.attributes(),
            vector_summary: (facts.flags & 1 != 0).then_some((
                facts.dimensions as usize,
                facts.flags & 2 != 0,
                facts.flags & 4 != 0,
            )),
        })
    }
}

fn serialize_query_document_with_facts(
    document: &Document,
    facts: VectorFacts,
) -> Result<String, String> {
    serde_json::to_string(&document.query_ref(facts)?).map_err(|cause| cause.to_string())
}

#[cfg(test)]
fn serialize_query_document(document: &Document) -> Result<String, String> {
    let facts = vector_facts(document.vector_values()?)?;
    serialize_query_document_with_facts(document, facts)
}

fn vector_frame_bytes(values: &[f32]) -> Result<Vec<u8>, String> {
    let capacity = values
        .len()
        .checked_mul(size_of::<f32>())
        .ok_or_else(|| "Vector frame size overflow".to_owned())?;
    let mut raw = Vec::with_capacity(capacity);
    for value in values {
        raw.extend_from_slice(&value.to_le_bytes());
    }
    Ok(raw)
}

fn f32_values(decoded: &[u8]) -> Result<Vec<f32>, String> {
    let (chunks, remainder) = decoded.as_chunks::<4>();
    if !remainder.is_empty() {
        return Err("Vector frame length is not divisible by four".into());
    }
    Ok(chunks
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect())
}

fn attach_vector_frame(
    document: &mut Document,
    vector_bytes: &[u8],
    facts: VectorFacts,
) -> Result<(), String> {
    let vector = if vector_bytes.is_empty() {
        None
    } else {
        Some(f32_values(&decode_page(vector_bytes)?)?)
    };
    let actual = vector_facts(vector.as_deref())?;
    if actual != facts {
        return Err("Vector frame does not match metadata vector summary".into());
    }
    document.columns_mut().set_vector(vector);
    Ok(())
}

fn parse_native_metadata(
    bytes: &[u8],
    facts: VectorFacts,
) -> Result<(VectorFacts, Document), String> {
    let dto: NativeDocumentDto =
        serde_json::from_slice(bytes).map_err(|cause| cause.to_string())?;
    if dto.vector.is_some() {
        return Err("Separated document metadata contains a vector".into());
    }
    Ok((facts, Document::from_native_dto(dto)))
}

fn parse_document_metadata(decoded: &[u8]) -> Result<(VectorFacts, Document), String> {
    match decoded.first().copied() {
        Some(b'{') => parse_native_metadata(
            decoded,
            VectorFacts {
                flags: 0,
                dimensions: 0,
            },
        ),
        Some(METADATA_CODEC_FACTS) => {
            let (facts, document_bytes) = read_vector_facts(decoded)?;
            parse_native_metadata(document_bytes, facts)
        }
        Some(METADATA_CODEC_CANONICAL) => {
            let (facts, document_bytes) = read_vector_facts(decoded.get(1..).unwrap_or(&[]))?;
            let dto: StoredCanonicalDocument =
                serde_json::from_slice(document_bytes).map_err(|cause| cause.to_string())?;
            Ok((facts, Document::from_stored_dto(dto)))
        }
        _ => Err("Unknown document metadata codec".into()),
    }
}

#[doc = "# Errors\nRejects invalid metadata framing, vector summaries, or document JSON."]
pub fn query_document_from_metadata(bytes: &[u8]) -> Result<String, String> {
    let decoded = decode_page(bytes)?;
    let (facts, document) = parse_document_metadata(&decoded)?;
    drop(decoded);
    serialize_query_document_with_facts(&document, facts)
}

#[doc = "# Errors\nRejects invalid metadata ranges, corrupt frames, or document JSON. Returns None above sixty-four KiB declared decoded bytes for scalar fallback."]
pub fn query_documents_from_metadata(
    bytes: &[u8],
    ranges: &[u32],
) -> Result<Option<String>, String> {
    use serde::Serializer as _;
    use serde::ser::SerializeSeq;

    if ranges.is_empty() || !ranges.len().is_multiple_of(2) || ranges.len() > 32 {
        return Err("Invalid metadata batch framing".into());
    }
    let frames = ranges
        .as_chunks::<2>()
        .0
        .iter()
        .map(|range| {
            let offset = usize::try_from(range[0]).map_err(|cause| cause.to_string())?;
            let length = usize::try_from(range[1]).map_err(|cause| cause.to_string())?;
            let end = offset
                .checked_add(length)
                .ok_or("Metadata range overflow")?;
            let frame = bytes
                .get(offset..end)
                .ok_or("Metadata range exceeds body")?;
            if !(8..=MAX_BYTES).contains(&frame.len()) {
                return Err("Invalid metadata page size".into());
            }
            let decoded = u32::from_le_bytes(
                frame[..4]
                    .try_into()
                    .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
            ) as usize;
            if decoded > MAX_BYTES {
                return Err("Metadata page exceeds decoded size budget".into());
            }
            Ok((frame, decoded))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let decoded_bytes = frames.iter().map(|(_, decoded)| decoded).sum::<usize>();
    if decoded_bytes > 64 * 1024 {
        return Ok(None);
    }
    let mut output = Vec::with_capacity(decoded_bytes + frames.len() * 64 + 2);
    let mut serializer = serde_json::Serializer::new(&mut output);
    let mut sequence = (&mut serializer)
        .serialize_seq(Some(ranges.len() / 2))
        .map_err(|cause| cause.to_string())?;
    let mut inflater = zlib_rs::Inflate::new(true, 15);
    let mut decoded =
        Vec::with_capacity(frames.iter().map(|(_, length)| *length).max().unwrap_or(0));
    for (frame, length) in frames {
        decoded.resize(length.max(1), 0);
        inflater.reset(true);
        let status = inflater.decompress(&frame[8..], &mut decoded, zlib_rs::InflateFlush::Finish);
        if status != Ok(zlib_rs::Status::StreamEnd) || inflater.total_out() != length as u64 {
            return Err(format!("Invalid compressed page: {status:?}"));
        }
        let crc = u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
        if crc32fast::hash(&decoded[..length]) != crc {
            return Err("Page integrity check failed".into());
        }
        let (facts, document) = parse_document_metadata(&decoded[..length])?;
        sequence
            .serialize_element(&document.query_ref(facts)?)
            .map_err(|cause| cause.to_string())?;
    }
    sequence.end().map_err(|cause| cause.to_string())?;
    String::from_utf8(output)
        .map(Some)
        .map_err(|cause| cause.to_string())
}

#[doc = "# Errors\nRejects mismatched or corrupt metadata and vector frames."]
pub fn full_document_from_frames(
    metadata_bytes: &[u8],
    vector_bytes: &[u8],
) -> Result<String, String> {
    let decoded = decode_page(metadata_bytes)?;
    let (facts, mut document) = parse_document_metadata(&decoded)?;
    drop(decoded);
    attach_vector_frame(&mut document, vector_bytes, facts)?;
    document.to_canonical_json()
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Range {
    pub offset: u32,
    pub length: u32,
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum DocumentAttributes {
    Owned(Box<serde_json::value::RawValue>),
    Shared(Rc<serde_json::value::RawValue>),
}

impl<'de> Deserialize<'de> for DocumentAttributes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Box::<serde_json::value::RawValue>::deserialize(deserializer).map(Self::Owned)
    }
}

impl DocumentAttributes {
    fn shared_identity(&self) -> Option<*const ()> {
        match self {
            Self::Shared(value) => Some(Rc::as_ptr(value).cast::<()>()),
            Self::Owned(_) => None,
        }
    }

    #[must_use]
    pub fn get(&self) -> &str {
        self.as_ref().get()
    }
}

impl AsRef<serde_json::value::RawValue> for DocumentAttributes {
    fn as_ref(&self) -> &serde_json::value::RawValue {
        match self {
            Self::Owned(value) => value,
            Self::Shared(value) => value,
        }
    }
}

impl From<Box<serde_json::value::RawValue>> for DocumentAttributes {
    fn from(value: Box<serde_json::value::RawValue>) -> Self {
        Self::Owned(value)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DocumentMeta<
    Id = DocumentId<Box<str>>,
    Attributes = DocumentAttributes,
    Length = u32,
    Vector = bool,
> {
    pub id: Id,
    pub revision: u64,
    pub title_length: Length,
    pub body_length: Length,
    pub attributes: Attributes,
    pub data: Range,
    pub vector: Vector,
}

#[derive(Clone)]
enum ScalarColumn<T> {
    Constant { value: T, len: usize },
    Dense(Vec<T>),
}

impl<T: Copy + PartialEq> ScalarColumn<T> {
    const fn new() -> Self {
        Self::Dense(Vec::new())
    }

    fn push(&mut self, value: T, capacity: usize) {
        self.push_charged(value, capacity, |_| Ok::<(), std::convert::Infallible>(()))
            .unwrap_or_else(|never| match never {});
    }

    fn push_charged<E>(
        &mut self,
        value: T,
        capacity: usize,
        charge: impl FnOnce(usize) -> Result<(), E>,
    ) -> Result<(), E> {
        match self {
            Self::Constant { value: first, len } if *first == value => *len += 1,
            Self::Constant { value: first, len } => {
                charge(capacity * size_of::<T>())?;
                let mut values = Vec::with_capacity(capacity);
                values.resize(*len, *first);
                values.push(value);
                *self = Self::Dense(values);
            }
            Self::Dense(values) if values.is_empty() => *self = Self::Constant { value, len: 1 },
            Self::Dense(values) => values.push(value),
        }
        Ok(())
    }

    const fn len(&self) -> usize {
        match self {
            Self::Constant { len, .. } => *len,
            Self::Dense(values) => values.len(),
        }
    }

    #[inline]
    fn get(&self, index: usize) -> T {
        match self {
            Self::Constant { value, len } => {
                assert!(index < *len);
                *value
            }
            Self::Dense(values) => values[index],
        }
    }

    fn iter(&self) -> impl ExactSizeIterator<Item = T> + DoubleEndedIterator {
        (0..self.len()).map(|index| self.get(index))
    }

    const fn heap_bytes(&self) -> usize {
        match self {
            Self::Constant { .. } => 0,
            Self::Dense(values) => values.capacity() * size_of::<T>(),
        }
    }

    fn shrink_to_fit(&mut self) {
        if let Self::Dense(values) = self {
            values.shrink_to_fit();
        }
    }

    #[cfg(test)]
    fn set(&mut self, index: usize, value: T) {
        if let Self::Constant { value: first, len } = self {
            *self = Self::Dense(vec![*first; *len]);
        }
        if let Self::Dense(values) = self {
            values[index] = value;
        }
    }
}

#[derive(Clone)]
enum AttributeColumn {
    Dense(Vec<DocumentAttributes>),
    Dictionary {
        values: Vec<DocumentAttributes>,
        indexes: Vec<u16>,
        counts: Vec<u16>,
    },
}

impl AttributeColumn {
    fn validate_expansion(&self, maximum: usize) -> Result<(), String> {
        let failure = "Directory attributes exceed canonical size budget";
        let mut remaining = maximum;
        match self {
            Self::Dense(values) => {
                for value in values {
                    remaining = remaining.checked_sub(value.get().len()).ok_or(failure)?;
                }
            }
            Self::Dictionary { values, counts, .. } => {
                for (value, count) in values.iter().zip(counts) {
                    let bytes = value
                        .get()
                        .len()
                        .checked_mul(usize::from(*count))
                        .ok_or(failure)?;
                    remaining = remaining.checked_sub(bytes).ok_or(failure)?;
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn dense_mut(&mut self) -> &mut Vec<DocumentAttributes> {
        match self {
            Self::Dense(values) => values,
            Self::Dictionary {
                values, indexes, ..
            } => {
                let dense = indexes
                    .iter()
                    .map(|index| values[usize::from(*index)].clone())
                    .collect();
                *self = Self::Dense(dense);
                self.dense_mut()
            }
        }
    }

    fn get(&self, row: usize) -> &DocumentAttributes {
        match self {
            Self::Dense(values) => &values[row],
            Self::Dictionary {
                values, indexes, ..
            } => &values[usize::from(indexes[row])],
        }
    }
    fn heap_bytes(&self) -> usize {
        let (values, indexes) = match self {
            Self::Dense(values) => (values, 0),
            Self::Dictionary {
                values,
                indexes,
                counts,
            } => (
                values,
                (indexes.capacity() + counts.capacity()) * size_of::<u16>(),
            ),
        };
        values.capacity() * size_of::<DocumentAttributes>()
            + values
                .iter()
                .map(|value| value.get().len() + 16)
                .sum::<usize>()
            + indexes
    }
    fn shrink_to_fit(&mut self) {
        match self {
            Self::Dense(values) => values.shrink_to_fit(),
            Self::Dictionary {
                values,
                indexes,
                counts,
            } => {
                values.shrink_to_fit();
                indexes.shrink_to_fit();
                counts.shrink_to_fit();
            }
        }
    }
}

#[derive(Clone, Copy)]
enum FixedId {
    Uint(u64),
    Uuid([u8; 16]),
}

#[derive(Clone)]
pub struct DocumentTable {
    ids: String,
    typed_ids: Box<[(usize, FixedId)]>,
    rows: Vec<DocumentMeta<std::ops::Range<usize>, (), (), ()>>,
    lengths: Vec<ScalarColumn<u32>>,
    vectors: ScalarColumn<bool>,
    attributes: AttributeColumn,
}

impl DocumentTable {
    #[must_use]
    pub const fn len(&self) -> usize {
        self.rows.len()
    }
    #[must_use]
    pub const fn capacity(&self) -> usize {
        self.rows.capacity()
    }
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
    #[must_use]
    pub fn row(&self, index: usize) -> DocumentMeta<DocumentIdRef<'_>, &DocumentAttributes> {
        let row = &self.rows[index];
        DocumentMeta {
            id: self.id(index),
            revision: row.revision,
            title_length: self.field_length(fields::NATIVE_TITLE, index),
            body_length: self.field_length(fields::NATIVE_TEXT, index),
            attributes: self.attributes.get(index),
            data: row.data.clone(),
            vector: self.vectors.get(index),
        }
    }
    fn id(&self, index: usize) -> DocumentIdRef<'_> {
        if let Ok(position) = self.typed_ids.binary_search_by_key(&index, |(row, _)| *row) {
            return match self.typed_ids[position].1 {
                FixedId::Uint(value) => DocumentId::Uint(value),
                FixedId::Uuid(value) => DocumentId::Uuid(value),
            };
        }
        DocumentId::String(&self.ids[self.rows[index].id.clone()])
    }

    fn field_length(&self, ordinal: usize, index: usize) -> u32 {
        self.lengths
            .get(ordinal)
            .map_or(0, |column| column.get(index))
    }
    fn push_field_lengths(&mut self, lengths: impl IntoIterator<Item = u32>) {
        let capacity = self.rows.len();
        let mut column = ScalarColumn::new();
        for length in lengths {
            column.push(length, capacity);
        }
        self.lengths.push(column);
    }
    #[must_use]
    fn get(&self, index: usize) -> Option<DocumentMeta<DocumentIdRef<'_>, &DocumentAttributes>> {
        self.rows.get(index).map(|_| self.row(index))
    }
    #[cfg(any(test, target_arch = "wasm32"))]
    fn first(&self) -> Option<DocumentMeta<DocumentIdRef<'_>, &DocumentAttributes>> {
        self.get(0)
    }
    pub fn iter(
        &self,
    ) -> impl ExactSizeIterator<Item = DocumentMeta<DocumentIdRef<'_>, &DocumentAttributes>>
    + DoubleEndedIterator {
        (0..self.len()).map(|index| self.row(index))
    }
    #[doc = "# Errors\nReturns the insertion position when the canonical identity is absent."]
    pub fn find_id<'a>(&self, id: impl Into<DocumentIdRef<'a>>) -> Result<usize, usize> {
        let id = id.into();
        let mut low = 0;
        let mut high = self.len();
        while low < high {
            let middle = low + (high - low) / 2;
            match compare_document_ids(self.id(middle), id) {
                Ordering::Less => low = middle + 1,
                Ordering::Equal => return Ok(middle),
                Ordering::Greater => high = middle,
            }
        }
        Err(low)
    }
    fn metadata(
        &self,
    ) -> impl ExactSizeIterator<Item = DocumentMeta<std::ops::Range<usize>, &DocumentAttributes>>
    + DoubleEndedIterator {
        self.rows
            .iter()
            .enumerate()
            .map(|(index, row)| DocumentMeta {
                id: row.id.clone(),
                revision: row.revision,
                title_length: self.field_length(fields::NATIVE_TITLE, index),
                body_length: self.field_length(fields::NATIVE_TEXT, index),
                attributes: self.attributes.get(index),
                data: row.data.clone(),
                vector: self.vectors.get(index),
            })
    }
    fn lengths(&self) -> impl ExactSizeIterator<Item = (u32, u32)> + DoubleEndedIterator {
        (0..self.len()).map(|index| {
            (
                self.field_length(fields::NATIVE_TITLE, index),
                self.field_length(fields::NATIVE_TEXT, index),
            )
        })
    }
    fn shrink_to_fit(&mut self) {
        self.ids.shrink_to_fit();
        self.rows.shrink_to_fit();
        self.attributes.shrink_to_fit();
        for column in &mut self.lengths {
            column.shrink_to_fit();
        }
        self.lengths.shrink_to_fit();
        self.vectors.shrink_to_fit();
    }
}

impl From<Vec<DocumentMeta>> for DocumentTable {
    fn from(documents: Vec<DocumentMeta>) -> Self {
        let mut ids = String::with_capacity(
            documents
                .iter()
                .map(|document| match &document.id {
                    DocumentId::String(value) => value.len(),
                    DocumentId::Uint(_) | DocumentId::Uuid(_) => 0,
                })
                .sum(),
        );
        let mut typed_ids = Vec::new();
        let mut attributes = Vec::with_capacity(documents.len());
        let count = documents.len();
        let mut title_lengths = ScalarColumn::new();
        let mut body_lengths = ScalarColumn::new();
        let mut vectors = ScalarColumn::new();
        let rows = documents
            .into_iter()
            .enumerate()
            .map(|(index, document)| {
                let start = ids.len();
                match &document.id {
                    DocumentId::String(value) => ids.push_str(value),
                    DocumentId::Uint(value) => typed_ids.push((index, FixedId::Uint(*value))),
                    DocumentId::Uuid(value) => typed_ids.push((index, FixedId::Uuid(*value))),
                }
                let end = ids.len();
                attributes.push(document.attributes);
                title_lengths.push(document.title_length, count);
                body_lengths.push(document.body_length, count);
                vectors.push(document.vector, count);
                DocumentMeta {
                    id: start..end,
                    revision: document.revision,
                    title_length: (),
                    body_length: (),
                    attributes: (),
                    data: document.data,
                    vector: (),
                }
            })
            .collect();
        Self {
            ids,
            typed_ids: typed_ids.into_boxed_slice(),
            rows,
            attributes: AttributeColumn::Dense(attributes),
            lengths: vec![title_lengths, body_lengths],
            vectors,
        }
    }
}

impl Serialize for DocumentTable {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.iter())
    }
}

impl<'de> Deserialize<'de> for DocumentTable {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<DocumentMeta>::deserialize(deserializer).map(Self::from)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(from = "BlockWire", into = "BlockWire")]
pub struct BlockMeta {
    pub first: u32,
    pub last: u32,
    pub count: u32,
    pub max_tf: [u32; LANES],
    pub min_length: [u32; LANES],
    pub data: Range,
}

#[derive(Serialize, Deserialize)]
struct BlockWire {
    first: u32,
    last: u32,
    count: u32,
    max_title_tf: u32,
    max_body_tf: u32,
    min_title_length: u32,
    min_body_length: u32,
    data: Range,
}

impl From<BlockWire> for BlockMeta {
    fn from(wire: BlockWire) -> Self {
        Self {
            first: wire.first,
            last: wire.last,
            count: wire.count,
            max_tf: [wire.max_title_tf, wire.max_body_tf],
            min_length: [wire.min_title_length, wire.min_body_length],
            data: wire.data,
        }
    }
}

impl From<BlockMeta> for BlockWire {
    fn from(block: BlockMeta) -> Self {
        Self {
            first: block.first,
            last: block.last,
            count: block.count,
            max_title_tf: block.max_tf[0],
            max_body_tf: block.max_tf[1],
            min_title_length: block.min_length[0],
            min_body_length: block.min_length[1],
            data: block.data,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TermMeta {
    pub df: u32,
    pub blocks: Box<[BlockMeta]>,
}

#[derive(Clone, Default)]
pub struct TermDictionary {
    text: Box<str>,
    entries: Box<[(std::ops::Range<usize>, TermMeta)]>,
}

impl TermDictionary {
    fn from_entries<T: AsRef<str>>(entries: Vec<(T, TermMeta)>) -> Self {
        let mut text =
            String::with_capacity(entries.iter().map(|(term, _)| term.as_ref().len()).sum());
        let entries = entries
            .into_iter()
            .map(|(term, metadata)| {
                let start = text.len();
                text.push_str(term.as_ref());
                (start..text.len(), metadata)
            })
            .collect();
        Self {
            text: text.into_boxed_str(),
            entries,
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn heap_bytes(&self) -> usize {
        self.entries.len() * size_of::<(std::ops::Range<usize>, TermMeta)>()
            + self.text.len()
            + 16
            + self
                .values()
                .map(|meta| meta.blocks.len() * size_of::<BlockMeta>())
                .sum::<usize>()
    }

    #[must_use]
    pub fn get(&self, term: &str) -> Option<&TermMeta> {
        self.entries
            .binary_search_by(|(key, _)| self.text[key.clone()].cmp(term))
            .ok()
            .map(|index| &self.entries[index].1)
    }

    pub fn get_mut(&mut self, term: &str) -> Option<&mut TermMeta> {
        self.entries
            .binary_search_by(|(key, _)| self.text[key.clone()].cmp(term))
            .ok()
            .map(|index| &mut self.entries[index].1)
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&str, &TermMeta)> {
        self.entries
            .iter()
            .map(|(term, metadata)| (&self.text[term.clone()], metadata))
    }

    pub fn keys(&self) -> impl ExactSizeIterator<Item = &str> {
        self.entries
            .iter()
            .map(|(term, _)| &self.text[term.clone()])
    }

    pub fn values(&self) -> impl ExactSizeIterator<Item = &TermMeta> {
        self.entries.iter().map(|(_, metadata)| metadata)
    }
}

pub struct TermIterator<'a> {
    text: &'a str,
    entries: std::slice::Iter<'a, (std::ops::Range<usize>, TermMeta)>,
}

impl<'a> Iterator for TermIterator<'a> {
    type Item = (&'a str, &'a TermMeta);

    fn next(&mut self) -> Option<Self::Item> {
        self.entries
            .next()
            .map(|(range, metadata)| (&self.text[range.clone()], metadata))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.entries.size_hint()
    }
}

impl ExactSizeIterator for TermIterator<'_> {}

impl<'a> IntoIterator for &'a TermDictionary {
    type Item = (&'a str, &'a TermMeta);
    type IntoIter = TermIterator<'a>;

    fn into_iter(self) -> Self::IntoIter {
        TermIterator {
            text: &self.text,
            entries: self.entries.iter(),
        }
    }
}

impl Serialize for TermDictionary {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.iter())
    }
}

#[derive(Clone)]
pub struct Header {
    filter_masks: RefCell<FilterMasks>,
    pub version: u32,
    pub documents: DocumentTable,
    pub fields: FieldTable,
    pub metadata_end: u32,
    pub vector_end: u32,
    pub vector_ranges: Vec<Range>,
    vector_prefix: Vec<u32>,
}

#[derive(Deserialize)]
struct NativeHeader {
    version: u32,
    documents: DocumentTable,
    terms: TermDictionary,
    total_title_length: u64,
    total_body_length: u64,
    metadata_end: u32,
    vector_end: u32,
    vector_ranges: Vec<Range>,
}

impl<'de> Deserialize<'de> for Header {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let native = NativeHeader::deserialize(deserializer)?;
        Self::from_parts(
            native.version,
            native.documents,
            FieldTable::native(
                native.total_title_length,
                native.total_body_length,
                native.terms,
            ),
            (native.metadata_end, native.vector_end),
            native.vector_ranges,
        )
        .map_err(serde::de::Error::custom)
    }
}

/// The only adapter from the generic field table to the legacy native wire shape.
/// Root 6 consumers read this projection until the next public schema cut; named
/// text fields are intentionally absent from it and are exposed through `FieldTable`.
impl Serialize for Header {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("Header", 8)?;
        state.serialize_field("version", &self.version)?;
        state.serialize_field("documents", &self.documents)?;
        state.serialize_field("terms", self.terms())?;
        state.serialize_field("total_title_length", &self.total_title_length())?;
        state.serialize_field("total_body_length", &self.total_body_length())?;
        state.serialize_field("metadata_end", &self.metadata_end)?;
        state.serialize_field("vector_end", &self.vector_end)?;
        state.serialize_field("vector_ranges", &self.vector_ranges)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for TermDictionary {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(transparent)]
        struct TermKey<'a>(#[serde(borrow)] std::borrow::Cow<'a, str>);

        struct Terms;

        impl<'de> serde::de::Visitor<'de> for Terms {
            type Value = TermDictionary;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a term dictionary")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::<(std::borrow::Cow<'de, str>, TermMeta)>::new();
                while let Some((term, metadata)) = map.next_entry::<TermKey<'de>, TermMeta>()? {
                    entries.push((term.0, metadata));
                }
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                entries.dedup_by(|later, earlier| {
                    if later.0 != earlier.0 {
                        return false;
                    }
                    std::mem::swap(&mut later.1, &mut earlier.1);
                    true
                });
                Ok(TermDictionary::from_entries(entries))
            }
        }

        deserializer.deserialize_map(Terms)
    }
}

#[derive(Clone, Debug)]
pub struct Posting {
    pub row: u32,
    pub title: Vec<u32>,
    pub body: Vec<u32>,
}

struct ValidatedDiscard;

impl<'de> Deserialize<'de> for ValidatedDiscard {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(Self)
    }
}

impl<'de> serde::de::Visitor<'de> for ValidatedDiscard {
    type Value = Self;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a valid JSON value")
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self, E> {
        if !value.is_finite() {
            return Err(E::custom("number out of range"));
        }
        Ok(self)
    }

    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut sequence: A) -> Result<Self, A::Error> {
        while sequence.next_element::<Self>()?.is_some() {}
        Ok(self)
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        while map.next_key::<Self>()?.is_some() {
            map.next_value::<Self>()?;
        }
        Ok(self)
    }
}

#[cfg(any(test, target_arch = "wasm32"))]
struct SelectedAttributes<'a>(&'a BTreeSet<&'a str>);

struct SelectedAttribute<'a>(&'a BTreeSet<&'a str>);

impl<'a, 'de> serde::de::DeserializeSeed<'de> for SelectedAttribute<'a> {
    type Value = Option<&'a str>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'a> serde::de::Visitor<'_> for SelectedAttribute<'a> {
    type Value = Option<&'a str>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an attribute name")
    }

    fn visit_str<E: serde::de::Error>(self, field: &str) -> Result<Self::Value, E> {
        Ok(self.0.get(field).copied())
    }
}

#[cfg(any(test, target_arch = "wasm32"))]
impl<'de> serde::de::DeserializeSeed<'de> for SelectedAttributes<'_> {
    type Value = BTreeMap<String, serde_json::Value>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

#[cfg(any(test, target_arch = "wasm32"))]
impl<'de> serde::de::Visitor<'de> for SelectedAttributes<'_> {
    type Value = BTreeMap<String, serde_json::Value>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an attribute object")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut selected = BTreeMap::new();
        while let Some(field) = map.next_key_seed(SelectedAttribute(self.0))? {
            if let Some(field) = field {
                selected.insert(field.to_owned(), map.next_value::<serde_json::Value>()?);
            } else {
                map.next_value::<ValidatedDiscard>()?;
            }
        }
        Ok(selected)
    }
}

struct FilterAttributes<'a, 'b> {
    fields: &'a BTreeSet<&'a str>,
    values: &'b mut BTreeMap<&'a str, Option<serde_json::Value>>,
}

impl<'de> serde::de::DeserializeSeed<'de> for FilterAttributes<'_, '_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for FilterAttributes<'_, '_> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an attribute object")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while let Some(field) = map.next_key_seed(SelectedAttribute(self.fields))? {
            if let Some(field) = field {
                self.values.insert(field, Some(map.next_value()?));
            } else {
                map.next_value::<ValidatedDiscard>()?;
            }
        }
        Ok(())
    }
}

fn vector_prefix(documents: &DocumentTable) -> Result<Vec<u32>, String> {
    let mut prefix = Vec::with_capacity(documents.len().div_ceil(64));
    let mut count = 0_u32;
    for (index, vector) in documents.vectors.iter().enumerate() {
        if index % 64 == 0 {
            prefix.push(count);
        }
        count = count
            .checked_add(u32::from(vector))
            .ok_or("Vector count overflow")?;
    }
    Ok(prefix)
}

fn validate_columns(header: &Header) -> Result<(), String> {
    if header.metadata_end > header.vector_end || header.vector_end as usize > MAX_BYTES {
        return Err("Invalid segment column boundaries".into());
    }
    let mut cursor = 0_u32;
    for document in &header.documents.rows {
        if document.data.offset != cursor || document.data.length < 8 {
            return Err("Document frames do not partition the metadata column".into());
        }
        cursor = cursor
            .checked_add(document.data.length)
            .ok_or("Metadata range overflow")?;
    }
    if cursor != header.metadata_end {
        return Err("Metadata column does not match document ranges".into());
    }
    if header.vector_ranges.len()
        != header
            .documents
            .vectors
            .iter()
            .filter(|vector| *vector)
            .count()
    {
        return Err("Vector column count does not match document presence".into());
    }
    for range in &header.vector_ranges {
        if range.offset != cursor || range.length < 8 {
            return Err("Vector frames do not partition the vector column".into());
        }
        cursor = cursor
            .checked_add(range.length)
            .ok_or("Vector range overflow")?;
    }
    if cursor != header.vector_end {
        return Err("Vector column does not match vector ranges".into());
    }
    for term in header
        .fields
        .dictionaries()
        .flat_map(TermDictionary::values)
    {
        for block in &term.blocks {
            let end = block
                .data
                .offset
                .checked_add(block.data.length)
                .ok_or("Posting range overflow")?;
            if block.data.offset < header.vector_end
                || block.data.length < 8
                || end as usize > MAX_BYTES
            {
                return Err(
                    "Posting block overlaps document columns or exceeds segment budget".into(),
                );
            }
        }
    }
    Ok(())
}

#[cfg(any(test, target_arch = "wasm32"))]
struct VectorScan {
    header: Rc<Header>,
    allowed: BitVec,
    position: usize,
}

#[cfg(any(test, target_arch = "wasm32"))]
#[derive(Serialize)]
struct VectorLocation<'a> {
    row: u32,
    id: DocumentIdRef<'a>,
    data: Range,
    #[serde(rename = "vectorData")]
    vector_data: Range,
}

#[cfg(any(test, target_arch = "wasm32"))]
#[derive(Serialize)]
struct VectorPage<'a> {
    complete: bool,
    rows: Vec<VectorLocation<'a>>,
}

#[cfg(any(test, target_arch = "wasm32"))]
impl VectorScan {
    fn new(header: Rc<Header>, filters: &[Filter], dead: &[u32]) -> Result<Self, String> {
        let allowed = header.allowed(filters, dead)?;
        Ok(Self {
            header,
            allowed,
            position: 0,
        })
    }

    fn page(&mut self) -> Result<VectorPage<'_>, String> {
        let mut rows = Vec::with_capacity(64);
        while self.position < self.header.documents.len() && rows.len() < 64 {
            let index = self.position;
            self.position += 1;
            if !self.allowed[index] || !self.header.documents.vectors.get(index) {
                continue;
            }
            let document = self.header.documents.row(index);
            rows.push(VectorLocation {
                row: u32::try_from(index).map_err(|cause| cause.to_string())?,
                id: document.id,
                data: document.data,
                vector_data: self
                    .header
                    .vector_range(index)?
                    .cloned()
                    .ok_or("Missing canonical vector range")?,
            });
        }
        Ok(VectorPage {
            complete: self.position == self.header.documents.len(),
            rows,
        })
    }
}

impl Header {
    #[doc = "# Errors\nRejects documents whose vector presence overflows the vector prefix index."]
    pub fn from_parts(
        version: u32,
        documents: DocumentTable,
        fields: FieldTable,
        (metadata_end, vector_end): (u32, u32),
        vector_ranges: Vec<Range>,
    ) -> Result<Self, String> {
        Ok(Self {
            filter_masks: RefCell::default(),
            version,
            vector_prefix: vector_prefix(&documents)?,
            documents,
            fields,
            metadata_end,
            vector_end,
            vector_ranges,
        })
    }

    #[must_use]
    pub const fn terms(&self) -> &TermDictionary {
        self.fields.terms()
    }

    pub const fn terms_mut(&mut self) -> &mut TermDictionary {
        self.fields.terms_mut()
    }

    #[must_use]
    pub fn total_title_length(&self) -> u64 {
        self.fields.total(fields::NATIVE_TITLE)
    }

    #[must_use]
    pub fn total_body_length(&self) -> u64 {
        self.fields.total(fields::NATIVE_TEXT)
    }

    #[doc = "# Errors\nRejects missing rows or inconsistent vector references."]
    pub fn vector_range(&self, row: usize) -> Result<Option<&Range>, String> {
        self.documents.rows.get(row).ok_or("Invalid row")?;
        if !self.documents.vectors.get(row) {
            return Ok(None);
        }
        let start = row / 64 * 64;
        let base = self
            .vector_prefix
            .get(row / 64)
            .copied()
            .ok_or("Missing vector prefix")? as usize;
        let index = base
            + self
                .documents
                .vectors
                .iter()
                .skip(start)
                .take(row - start)
                .filter(|vector| *vector)
                .count();
        self.vector_ranges
            .get(index)
            .map(Some)
            .ok_or_else(|| "Missing vector range".into())
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        let documents = self.documents.rows.capacity()
            * size_of::<DocumentMeta<std::ops::Range<usize>, (), (), ()>>()
            + self.documents.ids.capacity()
            + size_of_val(self.documents.typed_ids.as_ref())
            + self.documents.attributes.heap_bytes()
            + self.documents.lengths.capacity() * size_of::<ScalarColumn<u32>>()
            + 16
            + self
                .documents
                .lengths
                .iter()
                .map(ScalarColumn::heap_bytes)
                .sum::<usize>()
            + self.documents.vectors.heap_bytes();
        documents
            + self.fields.heap_bytes()
            + self.vector_ranges.capacity() * size_of::<Range>()
            + self.vector_prefix.capacity() * size_of::<u32>()
            + size_of::<Self>()
            + 32
            + FILTER_CACHE_BYTES
    }

    #[doc = "# Errors\nRejects headers whose version cannot carry their field table, and serialization failures."]
    pub fn compact_json(&self) -> Result<Vec<u8>, String> {
        let encoded = if self.version < 4 {
            if self.fields.len() != fields::NATIVE_FIELDS {
                return Err("Named text requires segment version 4".into());
            }
            serde_json::to_vec(&(
                self.version,
                DirectoryDocuments(&self.documents),
                DirectoryTerms(self.terms()),
                self.total_title_length(),
                self.total_body_length(),
                self.metadata_end,
                self.vector_end,
                DirectoryRanges(&self.vector_ranges),
            ))
        } else {
            serde_json::to_vec(&(
                self.version,
                StoredDocuments(&self.documents),
                StoredFields(self),
                StoredGroups(&self.fields),
                self.metadata_end,
                self.vector_end,
                DirectoryRanges(&self.vector_ranges),
            ))
        };
        encoded.map_err(|cause| cause.to_string())
    }

    fn encode(&self, payload: &[u8]) -> Result<Vec<u8>, String> {
        let json = self.compact_json()?;
        if json.len() + payload.len() + 16 > MAX_BYTES {
            return Err("Segment exceeds 16 MiB".into());
        }
        let mut bytes = Vec::with_capacity(json.len() + payload.len() + 16);
        bytes.extend_from_slice(segment_magic(self.version)?);
        bytes.extend_from_slice(
            &(u32::try_from(json.len()).map_err(|cause| cause.to_string())?).to_le_bytes(),
        );
        bytes.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes.extend_from_slice(payload);
        Ok(bytes)
    }

    #[cfg(target_arch = "wasm32")]
    fn eligible_minimum(&self, filters: &[Filter]) -> Result<Option<(u32, u32)>, String> {
        if filters.is_empty() {
            return Ok(Some((0, 0)));
        }
        let allowed = self.allowed(filters, &[])?;
        Ok(self
            .documents
            .lengths()
            .zip(allowed.iter())
            .filter(|(_, allowed)| *allowed)
            .fold(
                None,
                |minimum, ((title_length, body_length), _)| match minimum {
                    Some((title, body)) => {
                        Some((u32::min(title, title_length), u32::min(body, body_length)))
                    }
                    None => Some((title_length, body_length)),
                },
            ))
    }

    #[cfg(test)]
    fn vector_rows(&self, filters: &[Filter], dead: &[u32]) -> Result<Vec<u32>, String> {
        let allowed = self.allowed(filters, dead)?;
        self.documents
            .iter()
            .enumerate()
            .filter(|(index, document)| document.vector && allowed[*index])
            .map(|(index, _)| u32::try_from(index).map_err(|cause| cause.to_string()))
            .collect()
    }

    fn allowed(&self, filters: &[Filter], dead: &[u32]) -> Result<BitVec, String> {
        let mut allowed = if filters.is_empty() {
            BitVec::from_elem(self.documents.len(), true)
        } else {
            let key = serde_json::to_string(filters).map_err(|cause| cause.to_string())?;
            let cached = self
                .filter_masks
                .borrow()
                .entries
                .iter()
                .find(|(existing, _, _)| existing == &key)
                .map(|(_, mask, _)| mask.clone());
            if let Some(mask) = cached {
                mask
            } else {
                let mut allowed = BitVec::from_elem(self.documents.len(), true);
                let fields: BTreeSet<_> =
                    filters.iter().map(|filter| filter.field.as_str()).collect();
                let mut values: BTreeMap<_, Option<serde_json::Value>> =
                    fields.iter().map(|field| (*field, None)).collect();
                self.filter_masks
                    .borrow_mut()
                    .prepare_representatives(&self.documents, &fields)?;
                let cache = self.filter_masks.borrow();
                for (index, doc) in self.documents.metadata().enumerate() {
                    if let Some((_, representatives)) = &cache.representatives {
                        let representative = usize::from(representatives[index]);
                        if representative != index {
                            let representative_allowed = allowed[representative];
                            allowed.set(index, representative_allowed);
                            continue;
                        }
                    }
                    for value in values.values_mut() {
                        *value = None;
                    }
                    let mut decoder = serde_json::Deserializer::from_str(doc.attributes.get());
                    serde::de::DeserializeSeed::deserialize(
                        FilterAttributes {
                            fields: &fields,
                            values: &mut values,
                        },
                        &mut decoder,
                    )
                    .map_err(|cause| cause.to_string())?;
                    decoder.end().map_err(|cause| cause.to_string())?;
                    for filter in filters {
                        if !filter
                            .matches(values.get(filter.field.as_str()).and_then(Option::as_ref))?
                        {
                            allowed.set(index, false);
                            break;
                        }
                    }
                }
                drop(cache);
                let bytes = key.capacity() + allowed.capacity().div_ceil(8) + 128;
                let mut cache = self.filter_masks.borrow_mut();
                if cache.reserve(bytes) {
                    cache.bytes += bytes;
                    cache.entries.push_back((key, allowed.clone(), bytes));
                }
                allowed
            }
        };
        for row in dead {
            if *row as usize >= allowed.len() {
                return Err("Invalid deleted row".into());
            }
            allowed.set(*row as usize, false);
        }
        Ok(allowed)
    }
}

pub struct BuiltSegment {
    pub header: Header,
    pub bytes: Vec<u8>,
    pub common_projection: Option<String>,
}

type TermBound = (u32, u32, u32, u32);

fn summary_bounds(blocks: &[BlockMeta]) -> Vec<TermBound> {
    let mut bounds: Vec<_> = blocks
        .iter()
        .map(|block| {
            (
                block.max_tf[0],
                block.max_tf[1],
                block.min_length[0],
                block.min_length[1],
            )
        })
        .collect();
    bounds.sort_unstable();
    bounds.dedup();
    bounds
}

#[derive(Deserialize, Serialize)]
struct CommonTermProjection {
    terms: Vec<String>,
    partitions: Vec<Vec<Option<TermBound>>>,
    independent: Vec<Vec<TermBound>>,
}

impl CommonTermProjection {
    fn encode(mut self, header: &Header) -> Result<Option<String>, String> {
        self.independent = self
            .terms
            .iter()
            .map(|term| {
                header
                    .terms()
                    .get(term)
                    .map(|metadata| summary_bounds(&metadata.blocks))
                    .ok_or_else(|| "Missing common-term metadata".to_owned())
            })
            .collect::<Result<_, _>>()?;
        let encoded = serde_json::to_string(&self).map_err(|cause| cause.to_string())?;
        if encoded.len() > 4096 {
            return Ok(None);
        }
        Ok(Some(encoded))
    }
}

fn common_term_names<'a>(terms: impl Iterator<Item = (&'a str, usize)>) -> Vec<&'a str> {
    let mut entries: Vec<_> = terms
        .filter(|(term, df)| *df > 1 && term.len() <= 64)
        .collect();
    if entries.len() > 16 {
        entries.select_nth_unstable_by(16, |left, right| {
            right.1.cmp(&left.1).then_with(|| left.0.cmp(right.0))
        });
        entries.truncate(16);
    }
    let mut names: Vec<_> = entries.into_iter().map(|(term, _)| term).collect();
    names.sort_unstable();
    names
}

fn common_term_projection(
    metadata: &DocumentTable,
    lists: &BTreeMap<String, Vec<Posting>>,
) -> Result<Option<CommonTermProjection>, String> {
    let terms = common_term_names(
        lists
            .iter()
            .map(|(term, postings)| (term.as_str(), postings.len())),
    );
    if terms.is_empty() {
        return Ok(None);
    }
    let lengths: BTreeSet<_> = metadata.lengths().collect();
    let partition_count = lengths.len().min(32);
    let groups: BTreeMap<_, _> = lengths
        .iter()
        .enumerate()
        .map(|(index, pair)| (*pair, index * partition_count / lengths.len()))
        .collect();
    let row_groups: Vec<_> = metadata
        .lengths()
        .map(|pair| {
            groups
                .get(&pair)
                .copied()
                .ok_or_else(|| "Missing common-term projection group".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let mut partitions = vec![vec![None; terms.len()]; partition_count];
    for (column, term) in terms.iter().enumerate() {
        let postings = lists
            .get(*term)
            .ok_or_else(|| "Missing common-term postings".to_owned())?;
        for posting in postings {
            let row = usize::try_from(posting.row).map_err(|cause| cause.to_string())?;
            let document = metadata
                .get(row)
                .ok_or_else(|| "Invalid common-term posting row".to_owned())?;
            let group = *row_groups
                .get(row)
                .ok_or_else(|| "Missing common-term posting group".to_owned())?;
            let title_tf = u32::try_from(posting.title.len()).map_err(|cause| cause.to_string())?;
            let body_tf = u32::try_from(posting.body.len()).map_err(|cause| cause.to_string())?;
            let bound = partitions
                .get_mut(group)
                .and_then(|partition| partition.get_mut(column))
                .ok_or_else(|| "Invalid common-term projection cell".to_owned())?;
            let value = bound.get_or_insert((
                title_tf,
                body_tf,
                document.title_length,
                document.body_length,
            ));
            value.0 = value.0.max(title_tf);
            value.1 = value.1.max(body_tf);
            value.2 = value.2.min(document.title_length);
            value.3 = value.3.min(document.body_length);
        }
    }
    Ok(Some(CommonTermProjection {
        terms: terms.iter().map(|term| (*term).to_owned()).collect(),
        partitions,
        independent: Vec::new(),
    }))
}

pub(crate) fn append(payload: &mut Vec<u8>, data: &[u8]) -> Result<Range, String> {
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(data, 3);
    let range = Range {
        offset: u32::try_from(payload.len()).map_err(|cause| cause.to_string())?,
        length: u32::try_from(compressed.len() + 8).map_err(|cause| cause.to_string())?,
    };
    payload.extend_from_slice(
        &(u32::try_from(data.len()).map_err(|cause| cause.to_string())?).to_le_bytes(),
    );
    payload.extend_from_slice(&crc32fast::hash(data).to_le_bytes());
    payload.extend_from_slice(&compressed);
    if payload.len() > MAX_BYTES {
        return Err("Segment exceeds 16 MiB".into());
    }
    Ok(range)
}

#[doc = "# Errors\nRejects invalid framing, size budgets, decompression failures, and checksum or decoded-length mismatches."]
pub fn decode_page(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 8 || bytes.len() > MAX_BYTES {
        return Err("Invalid page size".into());
    }
    let length = u32::from_le_bytes(
        bytes[..4]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    ) as usize;
    if length > MAX_BYTES {
        return Err("Page exceeds decoded size budget".into());
    }
    let crc = u32::from_le_bytes(
        bytes[4..8]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    );
    let mut decoded = vec![0; length];
    let (output, status) =
        zlib_rs::decompress_slice(&mut decoded, &bytes[8..], zlib_rs::InflateConfig::default());
    if status != zlib_rs::ReturnCode::Ok || output.len() != length {
        return Err(format!("Invalid compressed page: {status:?}"));
    }
    if crc32fast::hash(&decoded) != crc {
        return Err("Page integrity check failed".into());
    }
    Ok(decoded)
}

fn put_int(mut value: u32, bytes: &mut Vec<u8>) {
    while value >= 128 {
        bytes.push(value.to_le_bytes()[0] | 128);
        value >>= 7;
    }
    bytes.push(value.to_le_bytes()[0]);
}

fn get_int(bytes: &[u8], offset: &mut usize) -> Result<u32, String> {
    let mut value = 0u32;
    for shift in [0, 7, 14, 21, 28] {
        let byte = *bytes.get(*offset).ok_or("Truncated varint")?;
        *offset += 1;
        if shift == 28 && byte > 15 {
            return Err("Overflowing varint".into());
        }
        value |= u32::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err("Overflowing varint".into())
}

#[derive(Clone, Copy)]
struct PostingShape {
    lanes: usize,
    inputs: [bool; LANES],
}

impl PostingShape {
    const NATIVE: Self = Self {
        lanes: LANES,
        inputs: [false; LANES],
    };

    const fn single(inputs: bool) -> Self {
        Self {
            lanes: 1,
            inputs: [inputs, false],
        }
    }
}

trait PostingSource {
    fn row(&self) -> u32;
    fn lane(&self, lane: usize) -> (&[u32], &[u32]);
}

impl PostingSource for Posting {
    fn row(&self) -> u32 {
        self.row
    }
    fn lane(&self, lane: usize) -> (&[u32], &[u32]) {
        if lane == 0 {
            (self.title.as_slice(), &[])
        } else {
            (self.body.as_slice(), &[])
        }
    }
}

struct FieldPosting {
    row: u32,
    positions: Vec<u32>,
    inputs: Vec<u32>,
}

impl PostingSource for FieldPosting {
    fn row(&self) -> u32 {
        self.row
    }
    fn lane(&self, lane: usize) -> (&[u32], &[u32]) {
        if lane == 0 {
            (self.positions.as_slice(), self.inputs.as_slice())
        } else {
            (&[], &[])
        }
    }
}

fn encode_shaped<R: PostingSource>(postings: &[R], shape: PostingShape) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    put_int(
        u32::try_from(postings.len()).map_err(|cause| cause.to_string())?,
        &mut bytes,
    );
    let mut previous = 0;
    for posting in postings {
        put_int(posting.row() - previous, &mut bytes);
        previous = posting.row();
        for (lane, preserves_inputs) in shape.inputs.iter().take(shape.lanes).enumerate() {
            let (positions, inputs) = posting.lane(lane);
            put_int(
                u32::try_from(positions.len()).map_err(|cause| cause.to_string())?,
                &mut bytes,
            );
            if *preserves_inputs && inputs.len() != positions.len() {
                return Err("Token inputs do not match token positions".into());
            }
            let mut prior = 0;
            for (index, position) in positions.iter().enumerate() {
                put_int(position - prior, &mut bytes);
                prior = *position;
                if *preserves_inputs {
                    put_int(inputs[index], &mut bytes);
                }
            }
        }
    }
    Ok(bytes)
}

#[derive(Default)]
struct DecodedPositions {
    count: u32,
    last: Option<u32>,
    values: Vec<u32>,
    inputs: Vec<u32>,
}

fn decode_positions<const POSITIONAL: bool>(
    data: &[u8],
    offset: &mut usize,
    preserves_inputs: bool,
) -> Result<DecodedPositions, String> {
    let count = get_int(data, offset)?;
    let length = count as usize;
    if length > data.len() - *offset {
        return Err("Invalid position count".into());
    }
    let mut values = if POSITIONAL {
        Vec::with_capacity(length)
    } else {
        Vec::new()
    };
    let mut inputs = Vec::new();
    let mut position = 0u32;
    let mut input = 0u32;
    for index in 0..length {
        let delta = get_int(data, offset)?;
        if index > 0 && delta == 0 {
            return Err("Duplicate token position".into());
        }
        position = position.checked_add(delta).ok_or("Position overflow")?;
        if preserves_inputs {
            let next = get_int(data, offset)?;
            if next < input {
                return Err("Token input regressed".into());
            }
            input = next;
            if POSITIONAL {
                inputs.push(input);
            }
        }
        if POSITIONAL {
            values.push(position);
        }
    }
    let last = if count == 0 { None } else { Some(position) };
    Ok(DecodedPositions {
        count,
        last,
        values,
        inputs,
    })
}

fn decode_posting_rows<const POSITIONAL: bool, T>(
    bytes: &[u8],
    make: impl Fn(u32, DecodedPositions, DecodedPositions) -> T,
) -> Result<Vec<T>, String> {
    decode_shaped_rows::<POSITIONAL, T>(bytes, PostingShape::NATIVE, make)
}

fn decode_shaped_rows<const POSITIONAL: bool, T>(
    bytes: &[u8],
    shape: PostingShape,
    make: impl Fn(u32, DecodedPositions, DecodedPositions) -> T,
) -> Result<Vec<T>, String> {
    let data = decode_page(bytes)?;
    let mut offset = 0;
    let count = get_int(&data, &mut offset)? as usize;
    if count > BLOCK_SIZE {
        return Err("Posting block exceeds 128 rows".into());
    }
    let mut rows = Vec::with_capacity(count);
    let mut row = 0u32;
    for index in 0..count {
        let delta = get_int(&data, &mut offset)?;
        if index > 0 && delta == 0 {
            return Err("Duplicate posting row".into());
        }
        row = row.checked_add(delta).ok_or("Row overflow")?;
        let title = decode_positions::<POSITIONAL>(&data, &mut offset, shape.inputs[0])?;
        let body = if shape.lanes > 1 {
            decode_positions::<POSITIONAL>(&data, &mut offset, shape.inputs[1])?
        } else {
            DecodedPositions::default()
        };
        if body.count == 0 && title.count == 0 {
            return Err("Empty posting".into());
        }
        rows.push(make(row, title, body));
    }
    if offset != data.len() {
        return Err("Trailing posting bytes".into());
    }
    Ok(rows)
}

#[doc = "# Errors\nRejects invalid pages, overflowing or truncated varints, excessive rows, duplicate positions, and trailing bytes."]
pub fn decode_postings(bytes: &[u8]) -> Result<Vec<Posting>, String> {
    decode_posting_rows::<true, _>(bytes, |row, title, body| Posting {
        row,
        title: title.values,
        body: body.values,
    })
}

#[derive(Clone)]
struct FrequencyPosting {
    row: u32,
    title: u32,
    body: u32,
}

struct DecodedFrequencyPosting {
    posting: FrequencyPosting,
    title_last: Option<u32>,
    body_last: Option<u32>,
}

enum PostingLists {
    Positions(BTreeMap<String, Vec<Posting>>),
    Frequencies(BTreeMap<String, Vec<FrequencyPosting>>),
}

trait PostingRow {
    fn row(&self) -> u32;
    fn counts(&self) -> [usize; 2];
    fn positions(&self) -> [&[u32]; 2];
}

impl PostingRow for Posting {
    fn row(&self) -> u32 {
        self.row
    }
    fn counts(&self) -> [usize; 2] {
        [self.title.len(), self.body.len()]
    }
    fn positions(&self) -> [&[u32]; 2] {
        [&self.title, &self.body]
    }
}

impl PostingRow for FrequencyPosting {
    fn row(&self) -> u32 {
        self.row
    }
    fn counts(&self) -> [usize; 2] {
        [self.title as usize, self.body as usize]
    }
    fn positions(&self) -> [&[u32]; 2] {
        [&[], &[]]
    }
}

fn merge_hot_rows<T: PostingRow>(
    list: &mut Vec<T>,
    rows: impl Iterator<Item = T>,
) -> Result<(), String> {
    list.extend(rows);
    list.sort_unstable_by_key(PostingRow::row);
    for pair in list.windows(2) {
        if pair[0].row() == pair[1].row()
            && (pair[0].counts() != pair[1].counts() || pair[0].positions() != pair[1].positions())
        {
            return Err("Conflicting common posting row".into());
        }
    }
    list.dedup_by_key(|row| row.row());
    Ok(())
}

fn validate_posting(
    header: &Header,
    row: u32,
    title: Option<u32>,
    body: Option<u32>,
    previous: Option<u32>,
) -> Result<(), String> {
    let doc = header
        .documents
        .get(row as usize)
        .ok_or("Invalid posting row")?;
    if title.is_some_and(|position| position >= doc.title_length)
        || body.is_some_and(|position| position >= doc.body_length)
    {
        return Err("Invalid token position".into());
    }
    if previous.is_some_and(|previous| previous >= row) {
        return Err("Posting blocks out of order".into());
    }
    Ok(())
}

fn encode_group<R: PostingSource>(
    payload: &mut Vec<u8>,
    shape: PostingShape,
    length: impl Fn(usize, u32) -> u32,
    lists: BTreeMap<String, Vec<R>>,
) -> Result<TermDictionary, String> {
    let mut terms = Vec::with_capacity(lists.len());
    for (term, postings) in lists {
        let mut blocks = Vec::with_capacity(postings.len().div_ceil(BLOCK_SIZE));
        for chunk in postings.chunks(BLOCK_SIZE) {
            let data = append(payload, &encode_shaped(chunk, shape)?)?;
            let mut max_tf = [0; LANES];
            let mut min_length = [0; LANES];
            for lane in 0..shape.lanes {
                max_tf[lane] = u32::try_from(
                    chunk
                        .iter()
                        .map(|posting| posting.lane(lane).0.len())
                        .max()
                        .ok_or("Empty posting block")?,
                )
                .map_err(|cause| cause.to_string())?;
                min_length[lane] = chunk
                    .iter()
                    .map(|posting| length(lane, posting.row()))
                    .min()
                    .ok_or("Empty posting block")?;
            }
            blocks.push(BlockMeta {
                first: chunk[0].row(),
                last: chunk[chunk.len() - 1].row(),
                count: u32::try_from(chunk.len()).map_err(|cause| cause.to_string())?,
                max_tf,
                min_length,
                data,
            });
        }
        terms.push((
            term,
            TermMeta {
                df: u32::try_from(postings.len()).map_err(|cause| cause.to_string())?,
                blocks: blocks.into_boxed_slice(),
            },
        ));
    }
    Ok(TermDictionary::from_entries(terms))
}

fn filterable_fields(names: &[String]) -> Result<BTreeSet<&str>, String> {
    let selected: BTreeSet<_> = names.iter().map(String::as_str).collect();
    if names.len() > 64
        || selected.len() != names.len()
        || names
            .iter()
            .any(|name| name.is_empty() || name.len() > 128 || name.starts_with('$'))
    {
        return Err("Invalid filterable attributes".to_owned());
    }
    Ok(selected)
}

fn finish_document_columns(
    payload: &mut Vec<u8>,
    vectors: &[u8],
    vector_ranges: &mut [Range],
) -> Result<(u32, u32), String> {
    let metadata_end = u32::try_from(payload.len()).map_err(|cause| cause.to_string())?;
    if payload
        .len()
        .checked_add(vectors.len())
        .is_none_or(|length| length > MAX_BYTES)
    {
        return Err("Document columns exceed segment budget".into());
    }
    for range in vector_ranges {
        range.offset = range
            .offset
            .checked_add(metadata_end)
            .ok_or("Vector offset overflow")?;
    }
    payload.extend_from_slice(vectors);
    Ok((
        metadata_end,
        u32::try_from(payload.len()).map_err(|cause| cause.to_string())?,
    ))
}

fn encode_canonical_metadata_page(
    document: &Document,
    facts: VectorFacts,
) -> Result<Vec<u8>, String> {
    let json = document.to_stored_canonical_vec()?;
    let mut metadata_bytes = Vec::with_capacity(7 + json.len());
    metadata_bytes.push(METADATA_CODEC_CANONICAL);
    write_vector_facts(facts, &mut metadata_bytes);
    metadata_bytes.extend_from_slice(&json);
    Ok(metadata_bytes)
}

fn append_document_columns(
    document: &Document,
    payload: &mut Vec<u8>,
    vector_payload: &mut Vec<u8>,
    vector_ranges: &mut Vec<Range>,
) -> Result<Range, String> {
    let vector = document.vector_values()?;
    let facts = vector_facts(vector)?;
    let data = append(payload, &encode_canonical_metadata_page(document, facts)?)?;
    if let Some(values) = vector {
        vector_ranges.push(append(vector_payload, &vector_frame_bytes(values)?)?);
    }
    Ok(data)
}

fn index_document_postings(
    document: &Document,
    row: u32,
    lists: &mut BTreeMap<String, Vec<Posting>>,
) -> Result<(u32, u32), String> {
    let title = normalize_text(document.role_text(NativeRole::Title)?);
    let body = normalize_text(document.role_text(NativeRole::Text)?);
    let title_tokens: Vec<_> = title.split_whitespace().collect();
    let body_tokens: Vec<_> = body.split_whitespace().collect();
    let mut frequencies: BTreeMap<&str, Posting> = BTreeMap::new();
    for (field, tokens) in [title_tokens.as_slice(), body_tokens.as_slice()]
        .iter()
        .enumerate()
    {
        for (position, token) in tokens.iter().enumerate() {
            let posting = frequencies.entry(token).or_insert_with(|| Posting {
                row,
                title: Vec::new(),
                body: Vec::new(),
            });
            if field == 0 {
                posting
                    .title
                    .push(u32::try_from(position).map_err(|cause| cause.to_string())?);
            } else {
                posting
                    .body
                    .push(u32::try_from(position).map_err(|cause| cause.to_string())?);
            }
        }
    }
    for (term, posting) in frequencies {
        lists.entry(term.into()).or_default().push(posting);
    }
    Ok((
        u32::try_from(title_tokens.len()).map_err(|cause| cause.to_string())?,
        u32::try_from(body_tokens.len()).map_err(|cause| cause.to_string())?,
    ))
}

#[doc = "# Errors\nRejects empty or duplicate documents, invalid field declarations, wire-size overflow, serialization errors, and segments beyond the size budget."]
pub fn build(
    documents: Vec<Document>,
    filterable: Option<&[String]>,
) -> Result<BuiltSegment, String> {
    build_versioned(documents, filterable, &[], 4)
}

#[doc = "# Errors\nRejects empty or duplicate documents, unsorted or invalid text field declarations, non-text attributes, wire-size overflow, and segments beyond the size budget."]
pub fn build_text_fields(
    documents: Vec<Document>,
    filterable: Option<&[String]>,
    text_fields: &[NamedTextField<'_>],
) -> Result<BuiltSegment, String> {
    build_versioned(documents, filterable, text_fields, 4)
}

#[doc = "# Errors\nRejects malformed bytes, unknown or duplicate fields, invalid queries, corrupt posting pages, and filters or tombstones applied before ranking."]
pub fn rank_fields(
    bytes: &[u8],
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    top_k: usize,
    dead: &[u32],
    filters: &[Filter],
) -> Result<Vec<Hit>, String> {
    rank_fields_with(
        bytes,
        &FieldQuery {
            fields,
            text,
            mode,
            top_k,
            dead,
            filters,
            bm25: Bm25Parameters::DEFAULT,
            statistics: None,
        },
    )
}

#[doc = "# Errors\nRejects everything `rank_fields` rejects, plus global statistics that do not match the selected fields and analyzed query terms exactly, duplicate identities, document frequencies above the document count, and totals below the live local rows or loaded eligible postings. Callers must supply unfiltered live corpus statistics; this operation does not prove global counts by scanning filtered-out postings."]
pub fn rank_fields_with(bytes: &[u8], query: &FieldQuery<'_>) -> Result<Vec<Hit>, String> {
    let (header, base) = parse_header(bytes)?;
    fields::rank(&header, bytes, base, query)
}

#[doc = "# Errors\nRejects malformed bytes, unknown or duplicate fields, invalid match modes, analysis over budget, invalid tombstones, and corrupt posting pages."]
pub fn local_field_statistics(
    bytes: &[u8],
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    dead: &[u32],
) -> Result<CorpusStatistics, String> {
    let (header, base) = parse_header(bytes)?;
    fields::local_statistics(&header, bytes, base, fields, text, mode, dead)
}

fn attribute_json(
    document: &Document,
    filterable: Option<&BTreeSet<&str>>,
) -> Result<Box<serde_json::value::RawValue>, String> {
    let source_attributes = document.columns().attributes();
    filterable
        .map_or_else(
            || serde_json::value::to_raw_value(source_attributes),
            |fields| {
                serde_json::value::to_raw_value(
                    &source_attributes
                        .iter()
                        .filter(|(name, _)| fields.contains(name.as_str()))
                        .collect::<BTreeMap<_, _>>(),
                )
            },
        )
        .map_err(|cause| cause.to_string())
}

fn build_versioned(
    mut documents: Vec<Document>,
    filterable: Option<&[String]>,
    text_fields: &[NamedTextField<'_>],
    version: u32,
) -> Result<BuiltSegment, String> {
    if documents.is_empty() {
        return Err("Segment must contain at least one document".into());
    }
    if documents.len() > 10000 {
        return Err("Segment exceeds 10000 documents".into());
    }
    let typed = documents
        .iter()
        .any(|document| !matches!(document.id, DocumentId::String(_)));
    let version = if typed { 5 } else { version };
    if version != 3 && version != 4 && version != 5 {
        return Err("Invalid segment version".into());
    }
    if version < 4 && !text_fields.is_empty() {
        return Err("Named text requires segment version 4".into());
    }
    if documents.iter().any(|document| !document.id.is_valid()) {
        return Err("Invalid document id".into());
    }
    let filterable = filterable.map(filterable_fields).transpose()?;
    let mut named = fields::NamedBuilder::prepare(text_fields)?;
    documents.sort_by(|a, b| compare_document_ids(&a.id, &b.id));
    if documents.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err("Duplicate segment ids".into());
    }
    let mut payload = Vec::new();
    let mut metadata = Vec::with_capacity(documents.len());
    let mut vector_payload = Vec::new();
    let mut vector_ranges = Vec::new();
    let mut lists: BTreeMap<String, Vec<Posting>> = BTreeMap::new();
    let mut total_title_length = 0;
    let mut total_body_length = 0;
    for (index, document) in documents.iter().enumerate() {
        let row = u32::try_from(index).map_err(|cause| cause.to_string())?;
        let (title_length, body_length) = index_document_postings(document, row, &mut lists)?;
        named.observe(document, row)?;
        total_title_length += u64::from(title_length);
        total_body_length += u64::from(body_length);
        let data = append_document_columns(
            document,
            &mut payload,
            &mut vector_payload,
            &mut vector_ranges,
        )?;
        let attributes = attribute_json(document, filterable.as_ref())?;
        metadata.push(DocumentMeta {
            id: document.id.borrowed().into_boxed(),
            revision: document.revision,
            title_length,
            body_length,
            attributes: attributes.into(),
            data,
            vector: document.vector_values()?.is_some(),
        });
    }
    let mut metadata = DocumentTable::from(metadata);
    let common_projection = common_term_projection(&metadata, &lists)?;
    let (metadata_end, vector_end) =
        finish_document_columns(&mut payload, &vector_payload, &mut vector_ranges)?;
    drop(vector_payload);
    let terms = encode_group(
        &mut payload,
        PostingShape::NATIVE,
        |lane, row| metadata.field_length(lane, row as usize),
        lists,
    )?;
    let mut table = FieldTable::native(total_title_length, total_body_length, terms);
    named.finish(&mut payload, &mut metadata, &mut table)?;
    let header = Header::from_parts(
        version,
        metadata,
        table,
        (metadata_end, vector_end),
        vector_ranges,
    )?;
    let common_projection = common_projection
        .map(|projection| projection.encode(&header))
        .transpose()?
        .flatten();
    let bytes = header.encode(&payload)?;
    Ok(BuiltSegment {
        header,
        bytes,
        common_projection,
    })
}

#[derive(Serialize, Deserialize)]
struct LegacySegmentHeader {
    version: u32,
    documents: Vec<DocumentMeta>,
    terms: TermDictionary,
    total_title_length: u64,
    total_body_length: u64,
}

fn parse_legacy_segment(bytes: &[u8]) -> Result<(LegacySegmentHeader, usize), String> {
    if bytes.len() < 16 || bytes.len() > MAX_BYTES || &bytes[..8] != b"RAIOSEG1" {
        return Err("Migration requires one bounded v1 segment".into());
    }
    let length = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    ) as usize;
    let expected_crc = u32::from_le_bytes(
        bytes[12..16]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    );
    let json = bytes
        .get(16..16 + length)
        .ok_or("Truncated legacy header")?;
    if crc32fast::hash(json) != expected_crc {
        return Err("Legacy header checksum mismatch".into());
    }
    let legacy: LegacySegmentHeader =
        serde_json::from_slice(json).map_err(|cause| cause.to_string())?;
    if legacy.version != 1 || legacy.documents.is_empty() || legacy.documents.len() > 10000 {
        return Err("Invalid legacy segment version or document count".into());
    }
    Ok((legacy, 16 + length))
}

fn owned_directory_row(
    row: &DocumentMeta<DocumentIdRef<'_>, &DocumentAttributes>,
    data: Range,
) -> DocumentMeta {
    DocumentMeta {
        id: row.id.into_boxed(),
        revision: row.revision,
        title_length: row.title_length,
        body_length: row.body_length,
        attributes: row.attributes.clone(),
        data,
        vector: row.vector,
    }
}

fn rebase_postings(terms: &mut TermDictionary, old_end: u32, new_end: u32) -> Result<(), String> {
    for (_, term) in &mut terms.entries {
        for block in &mut term.blocks {
            if block.data.offset < old_end {
                return Err("Posting range outside its payload".into());
            }
            block.data.offset = new_end
                .checked_add(block.data.offset - old_end)
                .ok_or("Migrated posting offset overflow")?;
        }
    }
    Ok(())
}

fn validate_migration_lengths(
    document: &Document,
    title_length: u32,
    body_length: u32,
) -> Result<(), String> {
    let title = normalize_text(document.role_text(NativeRole::Title)?);
    let body = normalize_text(document.role_text(NativeRole::Text)?);
    let actual_title =
        u32::try_from(title.split_whitespace().count()).map_err(|cause| cause.to_string())?;
    let actual_body =
        u32::try_from(body.split_whitespace().count()).map_err(|cause| cause.to_string())?;
    if actual_title != title_length || actual_body != body_length {
        return Err("Segment document token lengths do not match its directory".into());
    }
    Ok(())
}

fn migrate_v2_segment(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (header, base) = parse_header(bytes)?;
    let source = bytes.get(base..).ok_or("Truncated segment payload")?;
    let old_vector_end = header.vector_end;
    let mut metadata = Vec::with_capacity(header.documents.len());
    let mut payload = Vec::new();
    let mut vectors = Vec::new();
    let mut vector_ranges = Vec::new();
    for (index, row) in header.documents.iter().enumerate() {
        let start = usize::try_from(row.data.offset).map_err(|cause| cause.to_string())?;
        let length = usize::try_from(row.data.length).map_err(|cause| cause.to_string())?;
        let end = start.checked_add(length).ok_or("Metadata range overflow")?;
        let decoded = decode_page(
            source
                .get(start..end)
                .ok_or("Truncated document metadata")?,
        )?;
        let (facts, mut document) = parse_document_metadata(&decoded)?;
        if document.id != row.id
            || document.revision != row.revision
            || ((facts.flags & 1) != 0) != row.vector
        {
            return Err("Segment document does not match its directory".into());
        }
        validate_migration_lengths(&document, row.title_length, row.body_length)?;
        let data = append(
            &mut payload,
            &encode_canonical_metadata_page(&document, facts)?,
        )?;
        if row.vector {
            let range = header
                .vector_range(index)?
                .cloned()
                .ok_or_else(|| "Missing vector frame".to_owned())?;
            let vector_start = usize::try_from(range.offset).map_err(|cause| cause.to_string())?;
            let vector_length = usize::try_from(range.length).map_err(|cause| cause.to_string())?;
            let vector_end = vector_start
                .checked_add(vector_length)
                .ok_or("Vector range overflow")?;
            let frame = source
                .get(vector_start..vector_end)
                .ok_or("Truncated vector frame")?;
            attach_vector_frame(&mut document, frame, facts)?;
            vector_ranges.push(append_existing_frame(&mut vectors, frame)?);
        }
        metadata.push(owned_directory_row(&row, data));
    }
    let (metadata_end, vector_end) =
        finish_document_columns(&mut payload, &vectors, &mut vector_ranges)?;
    drop(vectors);
    let tail = source
        .get(old_vector_end as usize..)
        .ok_or("Missing posting tail")?;
    if payload
        .len()
        .checked_add(tail.len())
        .is_none_or(|length| length > MAX_BYTES)
    {
        return Err("Converted segment exceeds sixteen MiB before its header".into());
    }
    payload.extend_from_slice(tail);
    let mut terms = header.terms().clone();
    rebase_postings(&mut terms, old_vector_end, vector_end)?;
    let migrated = Header::from_parts(
        3,
        DocumentTable::from(metadata),
        FieldTable::native(
            header.total_title_length(),
            header.total_body_length(),
            terms,
        ),
        (metadata_end, vector_end),
        vector_ranges,
    )?;
    validate_header(&migrated)?;
    migrated.encode(&payload)
}

#[doc = "# Errors\nRejects invalid legacy segments, corrupt documents or postings, and converted segments above sixteen MiB."]
pub fn migrate_segment(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() >= 8
        && (&bytes[..8] == MAGIC_V3 || &bytes[..8] == MAGIC_V4 || &bytes[..8] == MAGIC_V5)
    {
        parse_header(bytes)?;
        return Ok(bytes.to_vec());
    }
    if bytes.len() >= 8 && &bytes[..8] == MAGIC_V2 {
        return migrate_v2_segment(bytes);
    }
    migrate_v1_segment(bytes)
}

fn migrate_v1_segment(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (legacy, base) = parse_legacy_segment(bytes)?;
    let source = bytes.get(base..).ok_or("Truncated legacy payload")?;
    let mut metadata = Vec::with_capacity(legacy.documents.len());
    let mut payload = Vec::new();
    let mut vectors = Vec::new();
    let mut vector_ranges = Vec::new();
    let mut source_end = 0_u32;
    for mut row in legacy.documents {
        if row.data.offset != source_end || row.data.length < 8 {
            return Err("Legacy document frames do not partition their prefix".into());
        }
        source_end = source_end
            .checked_add(row.data.length)
            .ok_or("Legacy document range overflow")?;
        let frame = source
            .get(row.data.offset as usize..source_end as usize)
            .ok_or("Truncated legacy document")?;
        let decoded = decode_page(frame)?;
        let document = Document::from_native_slice(&decoded)?;
        let values = document.vector_values()?;
        if document.id != row.id
            || document.revision != row.revision
            || values.is_some() != row.vector
        {
            return Err("Legacy document does not match its directory".into());
        }
        validate_migration_lengths(&document, row.title_length, row.body_length)?;
        let facts = vector_facts(values)?;
        row.data = append(
            &mut payload,
            &encode_canonical_metadata_page(&document, facts)?,
        )?;
        if let Some(values) = values {
            vector_ranges.push(append(&mut vectors, &vector_frame_bytes(values)?)?);
        }
        metadata.push(row);
    }
    let (metadata_end, vector_end) =
        finish_document_columns(&mut payload, &vectors, &mut vector_ranges)?;
    drop(vectors);
    let tail = source
        .get(source_end as usize..)
        .ok_or("Missing legacy posting tail")?;
    if payload
        .len()
        .checked_add(tail.len())
        .is_none_or(|length| length > MAX_BYTES)
    {
        return Err("Converted segment exceeds sixteen MiB before its header".into());
    }
    payload.extend_from_slice(tail);
    let mut terms = legacy.terms;
    for (_, term) in &mut terms.entries {
        for block in &mut term.blocks {
            let end = block
                .data
                .offset
                .checked_add(block.data.length)
                .ok_or("Legacy posting overflow")?;
            if block.data.offset < source_end || end as usize > source.len() {
                return Err("Legacy posting range outside its payload".into());
            }
        }
    }
    rebase_postings(&mut terms, source_end, vector_end)?;
    let header = Header::from_parts(
        3,
        DocumentTable::from(metadata),
        FieldTable::native(legacy.total_title_length, legacy.total_body_length, terms),
        (metadata_end, vector_end),
        vector_ranges,
    )?;
    validate_header(&header)?;
    header.encode(&payload)
}

fn append_existing_frame(payload: &mut Vec<u8>, frame: &[u8]) -> Result<Range, String> {
    if frame.len() < 8
        || payload
            .len()
            .checked_add(frame.len())
            .is_none_or(|length| length > MAX_BYTES)
    {
        return Err("Converted document columns exceed segment budget".into());
    }
    let range = Range {
        offset: u32::try_from(payload.len()).map_err(|cause| cause.to_string())?,
        length: u32::try_from(frame.len()).map_err(|cause| cause.to_string())?,
    };
    payload.extend_from_slice(frame);
    Ok(range)
}

#[doc = "# Errors\nRejects invalid framing, checksums, versions, ordering, frequencies, and posting directories."]
pub fn parse_header(bytes: &[u8]) -> Result<(Header, usize), String> {
    if bytes.len() < 16 {
        return Err("Invalid segment header".into());
    }
    let expected_version = if &bytes[..8] == MAGIC_V2 {
        2
    } else if &bytes[..8] == MAGIC_V3 {
        3
    } else if &bytes[..8] == MAGIC_V4 {
        4
    } else if &bytes[..8] == MAGIC_V5 {
        5
    } else {
        return Err("Invalid segment header".into());
    };
    let length = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    ) as usize;
    if length > MAX_BYTES {
        return Err("Header exceeds size budget".into());
    }
    let json = bytes
        .get(16..16 + length)
        .ok_or("Truncated segment header")?;
    let crc = u32::from_le_bytes(
        bytes[12..16]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    );
    if crc32fast::hash(json) != crc {
        return Err("Header integrity check failed".into());
    }
    let text = std::str::from_utf8(json).map_err(|cause| cause.to_string())?;
    let found = serde_json::from_str::<StoredVersion>(text)
        .map_err(|e| e.to_string())?
        .0;
    if found != expected_version {
        return Err("Segment magic does not match its version".into());
    }
    let mut header = if expected_version >= 4 {
        serde_json::from_str::<StoredHeader>(text)
            .map_err(|e| e.to_string())?
            .into_header()?
    } else {
        serde_json::from_str::<Header>(text).map_err(|e| e.to_string())?
    };
    if header.version != expected_version {
        return Err("Segment magic does not match its version".into());
    }
    validate_header(&header)?;
    header.documents.shrink_to_fit();
    Ok((header, 16 + length))
}

fn validate_header(header: &Header) -> Result<(), String> {
    if !(2..=5).contains(&header.version)
        || header.documents.is_empty()
        || header.documents.len() > 10000
    {
        return Err("Invalid segment version or document count".into());
    }
    header.fields.validate(&header.documents, header.version)?;
    let documents = &header.documents;
    if documents.iter().any(|row| {
        !row.id.is_valid() || (header.version < 5 && !matches!(row.id, DocumentId::String(_)))
    }) {
        return Err("Document id does not match segment version".into());
    }
    if (1..documents.len())
        .any(|row| compare_document_ids(documents.id(row - 1), documents.id(row)) != Ordering::Less)
    {
        return Err("Segment ids are not strictly sorted".into());
    }
    validate_columns(header)
}

const DIRECTORY_MAGIC: &[u8; 8] = b"RAIODIR5";
const DIRECTORY_MAGIC_V6: &[u8; 8] = b"RAIODIR6";
const DIRECTORY_MAGIC_V7: &[u8; 8] = b"RAIODIR7";
const COMMON_DIRECTORY_MAGIC: &[u8; 8] = b"RAIOCOM3";
const COMMON_DIRECTORY_MAGIC_V4: &[u8; 8] = b"RAIOCOM4";
const COMMON_DIRECTORY_MAGIC_V5: &[u8; 8] = b"RAIOCOM5";
const MAX_COMMON_POSTING_BYTES: usize = 32 * 1024;

fn directory_magic(version: u32) -> Result<&'static [u8; 8], String> {
    match version {
        2 | 3 => Ok(DIRECTORY_MAGIC),
        4 => Ok(DIRECTORY_MAGIC_V6),
        5 => Ok(DIRECTORY_MAGIC_V7),
        _ => Err("Invalid segment version".into()),
    }
}

fn common_directory_magic_for(version: u32) -> Result<&'static [u8; 8], String> {
    match version {
        2 | 3 => Ok(COMMON_DIRECTORY_MAGIC),
        4 => Ok(COMMON_DIRECTORY_MAGIC_V4),
        5 => Ok(COMMON_DIRECTORY_MAGIC_V5),
        _ => Err("Invalid segment version".into()),
    }
}

fn is_common_directory_magic(magic: [u8; 8]) -> bool {
    magic == *COMMON_DIRECTORY_MAGIC
        || magic == *COMMON_DIRECTORY_MAGIC_V4
        || magic == *COMMON_DIRECTORY_MAGIC_V5
}

fn frame_magic_matches(magic: [u8; 8], version: u32) -> bool {
    match version {
        2 | 3 => magic == *DIRECTORY_MAGIC || magic == *COMMON_DIRECTORY_MAGIC,
        4 => magic == *DIRECTORY_MAGIC_V6 || magic == *COMMON_DIRECTORY_MAGIC_V4,
        5 => magic == *DIRECTORY_MAGIC_V7 || magic == *COMMON_DIRECTORY_MAGIC_V5,
        _ => false,
    }
}

fn directory_frame_magic(bytes: &[u8], partial: bool) -> Result<[u8; 8], String> {
    let Some(prefix) = bytes.get(..8) else {
        return Err("Invalid compressed directory frame".into());
    };
    let magic: [u8; 8] = prefix
        .try_into()
        .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?;
    let accepted = if partial {
        is_common_directory_magic(magic)
    } else {
        &magic == DIRECTORY_MAGIC || &magic == DIRECTORY_MAGIC_V6 || &magic == DIRECTORY_MAGIC_V7
    };
    if accepted {
        Ok(magic)
    } else {
        Err("Invalid compressed directory frame".into())
    }
}
const MAX_COMMON_FRAME_BYTES: usize = 64 * 1024;
const MAX_COMMON_DECODED_POSTING_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct HotPostings {
    terms: BTreeMap<String, Vec<Box<[u8]>>>,
    bytes: usize,
}

impl HotPostings {
    fn heap_bytes(&self) -> usize {
        self.bytes
            + self
                .terms
                .iter()
                .map(|(term, blocks)| {
                    term.capacity() + 128 + blocks.capacity() * (size_of::<Box<[u8]>>() + 16)
                })
                .sum::<usize>()
            + size_of::<Self>()
            + 1024
            + 32
    }
}

struct DecodedDirectory {
    header: Header,
    hot: Option<Rc<HotPostings>>,
}

#[doc = "# Errors\nRejects invalid canonical headers, mismatched lengths, trailing bytes and directory size limits."]
pub fn parse_directory(bytes: &[u8], expected: usize) -> Result<Header, String> {
    if bytes.len() != expected || bytes.len() > MAX_BYTES {
        return Err("Directory must contain exactly one complete header".into());
    }
    let (header, length) = parse_header(bytes)?;
    if length != expected {
        return Err("Directory must contain exactly one complete header".into());
    }
    Ok(header)
}

struct DirectoryRanges<'a>(&'a [Range]);

impl Serialize for DirectoryRanges<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|range| (range.offset, range.length)))
    }
}

struct DirectoryDocuments<'a>(&'a DocumentTable);

impl Serialize for DirectoryDocuments<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|document| {
            (
                document.id,
                document.revision,
                document.title_length,
                document.body_length,
                document.attributes,
                (document.data.offset, document.data.length),
                document.vector,
            )
        }))
    }
}

struct DirectoryBlocks<'a>(&'a [BlockMeta]);

impl Serialize for DirectoryBlocks<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|block| {
            (
                block.first,
                block.last,
                block.count,
                block.max_tf[0],
                block.max_tf[1],
                block.min_length[0],
                block.min_length[1],
                (block.data.offset, block.data.length),
            )
        }))
    }
}

struct StoredDocuments<'a>(&'a DocumentTable);

impl Serialize for StoredDocuments<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|document| {
            (
                document.id,
                document.revision,
                document.attributes,
                (document.data.offset, document.data.length),
                document.vector,
            )
        }))
    }
}

struct StoredFieldLengths<'a>(&'a DocumentTable, usize);

impl Serialize for StoredFieldLengths<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq((0..self.0.len()).map(|row| self.0.field_length(self.1, row)))
    }
}

struct StoredFields<'a>(&'a Header);

impl Serialize for StoredFields<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.fields.iter().enumerate().map(|(ordinal, field)| {
            let (kind, name) = field.wire_id();
            (
                kind,
                name,
                field.analysis().config(),
                field.total(),
                StoredFieldLengths(&self.0.documents, ordinal),
            )
        }))
    }
}

struct StoredGroups<'a>(&'a FieldTable);

impl Serialize for StoredGroups<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.dictionaries().map(DirectoryTerms))
    }
}

struct StoredVersion(u32);

impl<'de> Deserialize<'de> for StoredVersion {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Probe;

        impl<'de> serde::de::Visitor<'de> for Probe {
            type Value = StoredVersion;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a stored segment header")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let version = sequence
                    .next_element::<u32>()?
                    .ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
                while sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(StoredVersion(version))
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut version = None;
                while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    if key == "version" {
                        version = Some(map.next_value::<u32>()?);
                    } else {
                        map.next_value::<serde::de::IgnoredAny>()?;
                    }
                }
                version
                    .map(StoredVersion)
                    .ok_or_else(|| serde::de::Error::missing_field("version"))
            }
        }

        deserializer.deserialize_any(Probe)
    }
}

#[derive(Deserialize)]
struct StoredRow {
    id: DocumentId<Box<str>>,
    revision: u64,
    attributes: DocumentAttributes,
    data: Range,
    vector: bool,
}

#[derive(Deserialize)]
struct StoredField {
    kind: u8,
    name: String,
    analysis: Option<WordV4Config>,
    total: u64,
    lengths: Vec<u32>,
}

#[derive(Deserialize)]
struct StoredHeader {
    version: u32,
    documents: Vec<StoredRow>,
    fields: Vec<StoredField>,
    groups: Vec<TermDictionary>,
    metadata_end: u32,
    vector_end: u32,
    vector_ranges: Vec<Range>,
}

impl StoredHeader {
    fn into_header(self) -> Result<Header, String> {
        let count = self.documents.len();
        let mut documents = DocumentTable::from(
            self.documents
                .into_iter()
                .map(|row| DocumentMeta {
                    id: row.id,
                    revision: row.revision,
                    title_length: 0,
                    body_length: 0,
                    attributes: row.attributes,
                    data: row.data,
                    vector: row.vector,
                })
                .collect::<Vec<_>>(),
        );
        documents.lengths.clear();
        let mut metas = Vec::with_capacity(self.fields.len());
        for field in self.fields {
            if field.lengths.len() != count {
                return Err("Field lengths do not match the document count".into());
            }
            metas.push(FieldMeta::from_wire(
                field.kind,
                field.name,
                field.analysis,
                field.total,
            )?);
            documents.push_field_lengths(field.lengths);
        }
        let fields = FieldTable::from_wire(metas, self.groups)?;
        Header::from_parts(
            self.version,
            documents,
            fields,
            (self.metadata_end, self.vector_end),
            self.vector_ranges,
        )
    }
}

struct DirectoryTerms<'a>(&'a TermDictionary);

impl Serialize for DirectoryTerms<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(
            self.0
                .iter()
                .map(|(term, metadata)| (term, (metadata.df, DirectoryBlocks(&metadata.blocks)))),
        )
    }
}

#[doc = "# Errors\nRejects invalid or incomplete canonical headers and directory size limits."]
pub fn compress_directory(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let header = parse_directory(bytes, bytes.len())?;
    compress_directory_header(&header, bytes.len())
}

fn compress_directory_header(header: &Header, length: usize) -> Result<Vec<u8>, String> {
    if !(16..=MAX_BYTES).contains(&length) {
        return Err("Invalid directory length".into());
    }
    let compact = binary_directory::encode(header)?;
    compress_directory_payload(&compact, length, *directory_magic(header.version)?)
}

fn compress_directory_payload(
    compact: &[u8],
    length: usize,
    magic: [u8; 8],
) -> Result<Vec<u8>, String> {
    let maximum_compact = length
        + (if is_common_directory_magic(magic) {
            MAX_COMMON_FRAME_BYTES + 4
        } else {
            0
        });
    if compact.len() > MAX_BYTES || compact.len() > maximum_compact {
        return Err("Compact directory exceeds size budget".into());
    }
    let mut encoded = Vec::with_capacity(20);
    encoded.extend_from_slice(&magic);
    encoded.extend_from_slice(
        &u32::try_from(length)
            .map_err(|cause| cause.to_string())?
            .to_le_bytes(),
    );
    encoded.extend_from_slice(
        &u32::try_from(compact.len())
            .map_err(|cause| cause.to_string())?
            .to_le_bytes(),
    );
    let mut checksum = crc32fast::Hasher::new();
    checksum.update(&encoded);
    checksum.update(compact);
    encoded.extend_from_slice(&checksum.finalize().to_le_bytes());
    let flags = miniz_oxide::deflate::core::create_comp_flags_from_zip_params(3, 1, 0);
    let mut compressor = miniz_oxide::deflate::core::CompressorOxide::new(flags);
    let (status, consumed) = miniz_oxide::deflate::core::compress_to_output(
        &mut compressor,
        compact,
        miniz_oxide::deflate::core::TDEFLFlush::Finish,
        |chunk| {
            encoded.extend_from_slice(chunk);
            true
        },
    );
    if status != miniz_oxide::deflate::core::TDEFLStatus::Done || consumed != compact.len() {
        return Err(format!("Directory compression failed: {status:?}"));
    }
    Ok(encoded)
}

#[doc = "# Errors\nRejects framing, size, compression, checksum, expected length and canonical header violations."]
pub fn parse_compressed_directory(
    bytes: &[u8],
    expected: usize,
    max_heap_bytes: usize,
) -> Result<Header, String> {
    let magic = directory_frame_magic(bytes, false)?;
    decode_directory_payload(bytes, expected, max_heap_bytes, None, magic)
}

fn decode_directory_payload(
    bytes: &[u8],
    expected: usize,
    max_heap_bytes: usize,
    validated: Option<&std::cell::Cell<bool>>,
    magic: [u8; 8],
) -> Result<Header, String> {
    decode_directory_contents(bytes, expected, max_heap_bytes, validated, magic)
        .map(|contents| contents.header)
}

fn decode_directory_contents(
    bytes: &[u8],
    expected: usize,
    max_heap_bytes: usize,
    validated: Option<&std::cell::Cell<bool>>,
    magic: [u8; 8],
) -> Result<DecodedDirectory, String> {
    let maximum_frame = MAX_BYTES + 8192;
    if bytes.len() < 20 || bytes[..8] != magic || bytes.len() > maximum_frame {
        return Err("Invalid compressed directory frame".into());
    }
    let length = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    ) as usize;
    if !(16..=MAX_BYTES).contains(&length) || length != expected {
        return Err("Invalid compressed directory length".into());
    }
    let compact_length = u32::from_le_bytes(
        bytes[12..16]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    ) as usize;
    let maximum_compact = expected
        + (if is_common_directory_magic(magic) {
            MAX_COMMON_FRAME_BYTES + 4
        } else {
            0
        });
    if compact_length > MAX_BYTES || compact_length > maximum_compact {
        return Err("Compact directory exceeds size budget".into());
    }
    let checksum = u32::from_le_bytes(
        bytes[16..20]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    );
    let mut decoded = vec![0; compact_length];
    let (output, status) = zlib_rs::decompress_slice(
        &mut decoded,
        &bytes[20..],
        zlib_rs::InflateConfig::default(),
    );
    if status != zlib_rs::ReturnCode::Ok || output.len() != compact_length {
        return Err(format!(
            "Compressed directory integrity check failed: {status:?}"
        ));
    }
    let previously_validated = validated.is_some_and(std::cell::Cell::get);
    if !previously_validated {
        let mut verified = crc32fast::Hasher::new();
        verified.update(&bytes[..16]);
        verified.update(&decoded);
        if verified.finalize() != checksum {
            return Err("Compressed directory integrity check failed".into());
        }
    }
    let (header_bytes, hot_bytes) = if is_common_directory_magic(magic) {
        let (header, hot) = common_directory_parts(&decoded, expected)?;
        (header, Some(hot))
    } else {
        (decoded.as_slice(), None)
    };
    let reserved = match hot_bytes {
        Some(bytes) => hot_postings_heap_reservation(bytes)?,
        None => 0,
    };
    if reserved > MAX_COMMON_FRAME_BYTES + 4096 || reserved > max_heap_bytes {
        return Err("Common posting payload exceeds memory budget".into());
    }
    let header = binary_directory::decode(header_bytes, max_heap_bytes.saturating_sub(reserved))?;
    if !frame_magic_matches(magic, header.version) {
        return Err("Directory magic does not match its version".into());
    }
    header.documents.attributes.validate_expansion(expected)?;
    if !previously_validated {
        validate_header(&header)?;
        if is_common_directory_magic(magic) {
            validate_common_directory_header(&header)?;
        }
    }
    let hot = match hot_bytes {
        Some(bytes) => {
            let hot = decode_hot_postings(bytes, &header)?;
            if hot.terms.is_empty() {
                None
            } else {
                Some(Rc::new(hot))
            }
        }
        None => None,
    };
    let charged = header.heap_bytes() + hot.as_ref().map_or(0, |hot| hot.heap_bytes());
    if charged > max_heap_bytes {
        return Err("Decoded directory exceeds memory budget".into());
    }
    if let Some(verified) = validated {
        verified.set(true);
    }
    Ok(DecodedDirectory { header, hot })
}

fn validate_common_directory_header(header: &Header) -> Result<(), String> {
    if header.fields.has_named_terms() {
        return Err("Common directory cannot carry named postings".into());
    }
    if header.terms().len() > 16
        || header
            .terms()
            .iter()
            .any(|(term, metadata)| term.len() > 64 || metadata.df <= 1)
    {
        return Err("Invalid common-directory term selection".into());
    }
    Ok(())
}

fn common_directory_parts(decoded: &[u8], expected: usize) -> Result<(&[u8], &[u8]), String> {
    let header_length = u32::from_le_bytes(
        decoded
            .get(..4)
            .ok_or("Truncated common-directory length")?
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    ) as usize;
    let header_end = 4_usize
        .checked_add(header_length)
        .ok_or("Common-directory length overflow")?;
    if header_length == 0
        || header_length > expected
        || header_end > decoded.len()
        || decoded.len() - header_end > MAX_COMMON_FRAME_BYTES
    {
        return Err("Invalid common-directory payload length".into());
    }
    Ok((&decoded[4..header_end], &decoded[header_end..]))
}

#[doc = "# Errors\nRejects invalid canonical headers and common-directory size budgets."]
pub fn compress_common_directory(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let header = parse_directory(bytes, bytes.len())?;
    compress_common_directory_header(&header, bytes.len(), None)
}

#[doc = "# Errors\nRejects invalid canonical segments, source ranges and common-posting budgets."]
pub fn compress_common_directory_segment(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (header, header_length) = parse_header(bytes)?;
    compress_common_directory_header(&header, header_length, Some(bytes))
}

fn compress_common_directory_header(
    header: &Header,
    expected: usize,
    source: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if !(16..=MAX_BYTES).contains(&expected) {
        return Err("Invalid directory length".into());
    }
    let names = common_term_names(
        header
            .terms()
            .iter()
            .map(|(term, meta)| (term, meta.df as usize)),
    );
    let terms = TermDictionary::from_entries(
        names
            .into_iter()
            .filter_map(|term| header.terms().get(term).map(|meta| (term, meta.clone())))
            .collect(),
    );
    let compact_header = binary_directory::encode_terms(header, &terms, true)?;
    let hot = match source {
        Some(bytes) => encode_hot_postings(header, &terms, bytes, expected)?,
        None => vec![0, 0],
    };
    let mut compact = Vec::with_capacity(4 + compact_header.len() + hot.len());
    compact.extend_from_slice(
        &u32::try_from(compact_header.len())
            .map_err(|cause| cause.to_string())?
            .to_le_bytes(),
    );
    compact.extend_from_slice(&compact_header);
    compact.extend_from_slice(&hot);
    if compact_header.len() > expected
        || hot.len() > MAX_COMMON_FRAME_BYTES
        || compact.len() > expected + MAX_COMMON_FRAME_BYTES + 4
    {
        return Err("Common-directory payload exceeds size budget".into());
    }
    compress_directory_payload(
        &compact,
        expected,
        *common_directory_magic_for(header.version)?,
    )
}

fn encode_hot_postings(
    header: &Header,
    terms: &TermDictionary,
    source: &[u8],
    expected: usize,
) -> Result<Vec<u8>, String> {
    let (source_header, header_length) = parse_header(source)?;
    if header_length != expected
        || source_header.version != header.version
        || source.len() < expected
        || binary_directory::encode(&source_header)? != binary_directory::encode(header)?
    {
        return Err("Common posting source does not match directory".into());
    }
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&0_u16.to_le_bytes());
    let mut selected = 0_u16;
    let mut posting_bytes = 0_usize;
    let mut decoded_bytes = 0_usize;
    let mut retained_bytes = size_of::<HotPostings>() + 1024 + 32;
    for (term, metadata) in terms {
        let term_bytes = term.as_bytes();
        if term_bytes.len() > 64
            || metadata.blocks.is_empty()
            || metadata.blocks.len() > u16::MAX as usize
        {
            continue;
        }
        let required = metadata.blocks.iter().try_fold(0_usize, |total, block| {
            total
                .checked_add(block.data.length as usize)
                .ok_or("Posting byte count overflow")
        })?;
        let overhead = 2 + term_bytes.len() + 2 + metadata.blocks.len() * 8;
        if posting_bytes + required > MAX_COMMON_POSTING_BYTES
            || encoded.len() + overhead + required > MAX_COMMON_FRAME_BYTES
        {
            continue;
        }
        let frames = metadata
            .blocks
            .iter()
            .map(|block| {
                let absolute = expected
                    .checked_add(block.data.offset as usize)
                    .ok_or("Posting offset overflow")?;
                let end = absolute
                    .checked_add(block.data.length as usize)
                    .ok_or("Posting length overflow")?;
                let page = source
                    .get(absolute..end)
                    .ok_or("Common posting source range is invalid")?;
                if page.len() < 8 {
                    return Err("Invalid common posting page".into());
                }
                let decoded = u32::from_le_bytes(
                    page[..4]
                        .try_into()
                        .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
                ) as usize;
                Ok((page, decoded))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let required_decoded = frames.iter().try_fold(0_usize, |sum, (_, decoded)| {
            sum.checked_add(*decoded)
                .ok_or("Common posting decoded byte overflow")
        })?;
        let required_retained = required
            + term_bytes.len()
            + 128
            + metadata.blocks.len() * (size_of::<Box<[u8]>>() + 16);
        if decoded_bytes + required_decoded > MAX_COMMON_DECODED_POSTING_BYTES
            || retained_bytes + required_retained > MAX_COMMON_FRAME_BYTES + 4096
        {
            continue;
        }
        encoded.extend_from_slice(
            &u16::try_from(term_bytes.len())
                .map_err(|cause| cause.to_string())?
                .to_le_bytes(),
        );
        encoded.extend_from_slice(term_bytes);
        encoded.extend_from_slice(
            &u16::try_from(metadata.blocks.len())
                .map_err(|cause| cause.to_string())?
                .to_le_bytes(),
        );
        for (block, (page, _)) in metadata.blocks.iter().zip(&frames) {
            validate_hot_block(header, block, page)?;
            encoded.extend_from_slice(&block.data.offset.to_le_bytes());
            encoded.extend_from_slice(&block.data.length.to_le_bytes());
            encoded.extend_from_slice(page);
        }
        posting_bytes += required;
        decoded_bytes += required_decoded;
        retained_bytes += required_retained;
        selected += 1;
    }
    encoded[..2].copy_from_slice(&selected.to_le_bytes());
    Ok(encoded)
}

fn validate_hot_block(header: &Header, metadata: &BlockMeta, bytes: &[u8]) -> Result<(), String> {
    let postings =
        decode_posting_rows::<false, _>(bytes, |row, title, body| (row, title.last, body.last))?;
    if postings.len() != metadata.count as usize
        || postings.first().map(|posting| posting.0) != Some(metadata.first)
        || postings.last().map(|posting| posting.0) != Some(metadata.last)
    {
        return Err("Common posting block does not match directory".into());
    }
    let mut previous = None;
    for (row, title, body) in postings {
        validate_posting(header, row, title, body, previous)?;
        previous = Some(row);
    }

    Ok(())
}

fn decode_hot_postings(bytes: &[u8], header: &Header) -> Result<HotPostings, String> {
    if bytes.len() > MAX_COMMON_FRAME_BYTES || bytes.len() < 2 {
        return Err("Invalid common posting payload size".into());
    }
    let mut cursor = 0_usize;
    let read_u16 = |cursor: &mut usize| -> Result<u16, String> {
        let end = cursor
            .checked_add(2)
            .ok_or("Common posting offset overflow")?;
        let value = u16::from_le_bytes(
            bytes
                .get(*cursor..end)
                .ok_or("Truncated common posting payload")?
                .try_into()
                .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
        );
        *cursor = end;
        Ok(value)
    };
    let read_u32 = |cursor: &mut usize| -> Result<u32, String> {
        let end = cursor
            .checked_add(4)
            .ok_or("Common posting offset overflow")?;
        let value = u32::from_le_bytes(
            bytes
                .get(*cursor..end)
                .ok_or("Truncated common posting payload")?
                .try_into()
                .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
        );
        *cursor = end;
        Ok(value)
    };
    let count = read_u16(&mut cursor)? as usize;
    if count > 16 {
        return Err("Too many common posting terms".into());
    }
    let mut hot = HotPostings::default();
    for _ in 0..count {
        let length = read_u16(&mut cursor)? as usize;
        if length == 0 || length > 64 {
            return Err("Invalid common posting term length".into());
        }
        let end = cursor
            .checked_add(length)
            .ok_or("Common posting offset overflow")?;
        let term = std::str::from_utf8(
            bytes
                .get(cursor..end)
                .ok_or("Truncated common posting term")?,
        )
        .map_err(|cause| cause.to_string())?
        .to_owned();
        cursor = end;
        if hot
            .terms
            .last_key_value()
            .is_some_and(|(prior, _)| prior >= &term)
            || header.terms().get(&term).is_none()
        {
            return Err("Invalid common posting term".into());
        }
        let block_count = read_u16(&mut cursor)? as usize;
        let metadata = header
            .terms()
            .get(&term)
            .ok_or("Missing common posting term")?;
        if block_count == 0 || block_count != metadata.blocks.len() {
            return Err("Incomplete common posting term".into());
        }
        let mut blocks = Vec::with_capacity(block_count);
        for meta in &metadata.blocks {
            let offset = read_u32(&mut cursor)?;
            let length = read_u32(&mut cursor)? as usize;
            let end = cursor
                .checked_add(length)
                .ok_or("Common posting length overflow")?;
            if offset != meta.data.offset || length != meta.data.length as usize || length == 0 {
                return Err("Common posting block metadata mismatch".into());
            }
            let page = bytes
                .get(cursor..end)
                .ok_or("Truncated common posting block")?;
            validate_hot_block(header, meta, page)?;
            blocks.push(page.into());
            hot.bytes += length;
            cursor = end;
        }
        hot.terms.insert(term, blocks);
    }
    if cursor != bytes.len() || hot.bytes > MAX_COMMON_POSTING_BYTES {
        return Err("Invalid common posting payload framing".into());
    }
    Ok(hot)
}

fn hot_postings_heap_reservation(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() > MAX_COMMON_FRAME_BYTES || bytes.len() < 2 {
        return Err("Invalid common posting payload size".into());
    }
    let mut cursor = 0_usize;
    let read_u16 = |cursor: &mut usize| -> Result<usize, String> {
        let end = cursor
            .checked_add(2)
            .ok_or("Common posting offset overflow")?;
        let value = u16::from_le_bytes(
            bytes
                .get(*cursor..end)
                .ok_or("Truncated common posting payload")?
                .try_into()
                .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
        ) as usize;
        *cursor = end;
        Ok(value)
    };
    let read_u32 = |cursor: &mut usize| -> Result<usize, String> {
        let end = cursor
            .checked_add(4)
            .ok_or("Common posting offset overflow")?;
        let value = u32::from_le_bytes(
            bytes
                .get(*cursor..end)
                .ok_or("Truncated common posting payload")?
                .try_into()
                .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
        ) as usize;
        *cursor = end;
        Ok(value)
    };
    let count = read_u16(&mut cursor)?;
    if count > 16 {
        return Err("Too many common posting terms".into());
    }
    if count == 0 {
        if cursor != bytes.len() {
            return Err("Invalid empty common posting payload".into());
        }
        return Ok(0);
    }
    let mut charge = size_of::<HotPostings>() + 1024 + 32;
    let mut posting_bytes = 0_usize;
    let mut decoded_bytes = 0_usize;
    for _ in 0..count {
        let term_length = read_u16(&mut cursor)?;
        let term_end = cursor
            .checked_add(term_length)
            .ok_or("Common posting offset overflow")?;
        if bytes.get(cursor..term_end).is_none() {
            return Err("Truncated common posting term".into());
        }
        cursor = term_end;
        let blocks = read_u16(&mut cursor)?;
        charge = charge
            .checked_add(term_length + 128)
            .and_then(|value| value.checked_add(blocks * (size_of::<Box<[u8]>>() + 16)))
            .ok_or("Common posting heap size overflow")?;
        for _ in 0..blocks {
            let _offset = read_u32(&mut cursor)?;
            let length = read_u32(&mut cursor)?;
            let end = cursor
                .checked_add(length)
                .ok_or("Common posting length overflow")?;
            if bytes.get(cursor..end).is_none() {
                return Err("Truncated common posting block".into());
            }
            let page = &bytes[cursor..end];
            if page.len() < 8 {
                return Err("Invalid common posting page".into());
            }
            let decoded = u32::from_le_bytes(
                page[..4]
                    .try_into()
                    .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
            ) as usize;
            posting_bytes += length;
            decoded_bytes = decoded_bytes
                .checked_add(decoded)
                .ok_or("Common posting decoded byte overflow")?;
            if posting_bytes > MAX_COMMON_POSTING_BYTES
                || decoded_bytes > MAX_COMMON_DECODED_POSTING_BYTES
            {
                return Err("Common postings exceed byte budgets".into());
            }
            charge = charge
                .checked_add(length)
                .ok_or("Common posting heap size overflow")?;
            cursor = end;
        }
    }
    if cursor != bytes.len() {
        return Err("Invalid common posting payload framing".into());
    }
    Ok(charge)
}

pub struct CommonDirectory {
    header: Rc<Header>,
    hot: Option<Rc<HotPostings>>,
}

impl CommonDirectory {
    #[doc = "# Errors\nRejects invalid common-directory framing, integrity and allocation budgets."]
    pub fn compressed(
        bytes: &[u8],
        expected: usize,
        max_heap_bytes: usize,
    ) -> Result<Self, String> {
        let contents = decode_directory_contents(
            bytes,
            expected,
            max_heap_bytes,
            None,
            directory_frame_magic(bytes, true)?,
        )?;
        Ok(Self {
            header: Rc::new(contents.header),
            hot: contents.hot,
        })
    }

    #[must_use]
    pub fn covers(&self, query: &PreparedQuery) -> bool {
        query
            .terms
            .words
            .iter()
            .all(|term| self.header.terms().get(term).is_some())
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.header.heap_bytes() + self.hot.as_ref().map_or(0, |hot| hot.heap_bytes())
    }

    #[doc = "Creates a search whose remaining posting spans must still be supplied.\n\n# Errors\nRejects uncovered terms, invalid filters and deleted rows before creating a search."]
    pub fn ranker(&self, query: &PreparedQuery, dead: &[u32]) -> Result<Search, String> {
        if !self.covers(query) {
            return Err("Common directory does not cover query".into());
        }
        let mut search = query.ranker(Rc::clone(&self.header), dead)?;
        search.pending_hot.clone_from(&self.hot);
        let selection = search.all_hot_selection()?;
        let _remaining = search.satisfy_hot_selection(selection)?;
        Ok(search)
    }
}

#[derive(Clone, Deserialize)]
pub struct Statistics {
    pub documents: u64,
    pub title_length: u64,
    pub body_length: u64,
    pub frequencies: BTreeMap<String, u64>,
}

fn count_as_f64(value: u64) -> f64 {
    let [byte0, byte1, byte2, byte3, byte4, byte5, byte6, byte7] = value.to_le_bytes();
    f64::from(u32::from_le_bytes([byte4, byte5, byte6, byte7])).mul_add(
        4_294_967_296.0,
        f64::from(u32::from_le_bytes([byte0, byte1, byte2, byte3])),
    )
}

fn contribution(tf: u32, length: u32, average: f64) -> f64 {
    if tf == 0 {
        return 0.0;
    }
    let mean = if average > 0.0 { average } else { 1.0 };
    f64::from(tf) / (0.25 + 0.75 * f64::from(length) / mean)
}

#[must_use]
pub fn bm25(
    tf_title: u32,
    tf_body: u32,
    len_title: u32,
    len_body: u32,
    statistics: &Statistics,
    df: u64,
) -> f64 {
    TermScorer::new(statistics, df).score(tf_title, tf_body, len_title, len_body)
}

struct TermScorer {
    title_average: f64,
    body_average: f64,
    idf: Option<f64>,
}

impl TermScorer {
    fn new(statistics: &Statistics, df: u64) -> Self {
        let n = count_as_f64(statistics.documents);
        let idf = if statistics.documents == 0 || df == 0 || df > statistics.documents {
            None
        } else {
            Some(((n - count_as_f64(df) + 0.5) / (count_as_f64(df) + 0.5)).ln_1p())
        };
        Self {
            title_average: count_as_f64(statistics.title_length) / n,
            body_average: count_as_f64(statistics.body_length) / n,
            idf,
        }
    }

    fn minimum_score(&self, title: u32, body: u32) -> f64 {
        match (title > 0, body > 0) {
            (true, true) => self
                .score(1, 0, title, body)
                .min(self.score(0, 1, title, body)),
            (true, false) => self.score(1, 0, title, body),
            (false, true) => self.score(0, 1, title, body),
            (false, false) => 0.0,
        }
    }

    fn denominators(&self, title: u32, body: u32) -> [f64; 2] {
        let mean = |average: f64| if average > 0.0 { average } else { 1.0 };
        [
            0.25 + 0.75 * f64::from(title) / mean(self.title_average),
            0.25 + 0.75 * f64::from(body) / mean(self.body_average),
        ]
    }

    fn score_normalized(&self, title: u32, body: u32, denominators: [f64; 2]) -> f64 {
        let Some(idf) = self.idf else {
            return 0.0;
        };
        let contribution = |tf: u32, denominator: f64| {
            if tf == 0 {
                0.0
            } else {
                f64::from(tf) / denominator
            }
        };
        let title = contribution(title, denominators[0]);
        let tf = title + title + contribution(body, denominators[1]);
        idf * tf * 2.2 / (tf + 1.2)
    }

    fn score(&self, tf_title: u32, tf_body: u32, len_title: u32, len_body: u32) -> f64 {
        let Some(idf) = self.idf else {
            return 0.0;
        };
        let title = contribution(tf_title, len_title, self.title_average);
        let tf = title + title + contribution(tf_body, len_body, self.body_average);
        idf * tf * 2.2 / (tf + 1.2)
    }
}

struct QueryTerms {
    statistics: Rc<Statistics>,
    words: Rc<Vec<String>>,
    order: Vec<usize>,
    scorers: Vec<TermScorer>,
    phrase_order: Vec<usize>,
}

impl QueryTerms {
    fn word(&self, term: &str) -> Option<&str> {
        self.order
            .binary_search_by(|index| self.words[*index].as_str().cmp(term))
            .ok()
            .map(|position| self.words[self.order[position]].as_str())
    }

    fn new(statistics: Statistics, text: &str, mode: &str, top_k: usize) -> Result<Self, String> {
        let words = normalize_text(text)
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if top_k == 0
            || top_k > 100
            || words.iter().collect::<BTreeSet<_>>().len() > MAX_QUERY_TERMS
        {
            return Err("Invalid search budget".into());
        }
        if mode != "any" && mode != "all" && mode != "phrase" {
            return Err("Unknown match mode".into());
        }
        if mode == "phrase" && words.len() > 64 {
            return Err("Phrase exceeds budget".into());
        }

        let mut order: Vec<_> = (0..words.len()).collect();
        order.sort_unstable_by(|a, b| words[*a].cmp(&words[*b]));
        order.dedup_by(|a, b| words[*a] == words[*b]);
        let scorers = order
            .iter()
            .map(|index| {
                TermScorer::new(
                    &statistics,
                    statistics
                        .frequencies
                        .get(&words[*index])
                        .copied()
                        .unwrap_or(0),
                )
            })
            .collect();
        let phrase_order = if mode == "phrase" {
            words
                .iter()
                .map(|word| order.partition_point(|index| words[*index] < *word))
                .collect()
        } else {
            Vec::new()
        };
        Ok(Self {
            statistics: Rc::new(statistics),
            words: Rc::new(words),
            order,
            scorers,
            phrase_order,
        })
    }
}

#[derive(Serialize, Deserialize)]
pub struct Filter {
    pub field: String,
    pub op: String,
    pub value: serde_json::Value,
}

fn compare_scalar(value: &serde_json::Value, expected: &serde_json::Value, op: &str) -> bool {
    let ordering = match (value, expected) {
        (serde_json::Value::String(a), serde_json::Value::String(b)) => Some(a.cmp(b)),
        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => numbers::compare(a, b),
        _ => None,
    };
    ordering.is_some_and(|order| match op {
        "gt" => order.is_gt(),
        "gte" => order.is_ge(),
        "lt" => order.is_lt(),
        "lte" => order.is_le(),
        _ => false,
    })
}

#[doc = "# Errors\nRejects unknown operators or invalid exists predicates."]
pub fn matches(
    attributes: &BTreeMap<String, serde_json::Value>,
    filters: &[Filter],
) -> Result<bool, String> {
    for filter in filters {
        if !filter.matches(attributes.get(&filter.field))? {
            return Ok(false);
        }
    }
    Ok(true)
}

impl Filter {
    fn matches(&self, actual: Option<&serde_json::Value>) -> Result<bool, String> {
        let equal = actual == Some(&self.value);
        let matched = match self.op.as_str() {
            "eq" => equal,
            "ne" => !equal,
            "exists" => actual.is_some() == self.value.as_bool().ok_or("Invalid exists filter")?,
            "in" => actual.is_some_and(|value| {
                self.value
                    .as_array()
                    .is_some_and(|items| items.contains(value))
            }),
            "notIn" => {
                let items = self.value.as_array().ok_or("Invalid notIn filter")?;
                !actual.is_some_and(|value| items.contains(value))
            }
            "contains" => actual
                .and_then(serde_json::Value::as_array)
                .is_some_and(|values| values.contains(&self.value)),
            "notContains" => !actual
                .and_then(serde_json::Value::as_array)
                .is_some_and(|values| values.contains(&self.value)),
            "containsAny" => actual
                .and_then(serde_json::Value::as_array)
                .zip(self.value.as_array())
                .is_some_and(|(values, expected)| {
                    expected.iter().any(|value| values.contains(value))
                }),
            "notContainsAny" => !actual
                .and_then(serde_json::Value::as_array)
                .zip(self.value.as_array())
                .is_some_and(|(values, expected)| {
                    expected.iter().any(|value| values.contains(value))
                }),
            "gt" | "gte" | "lt" | "lte" => {
                actual.is_some_and(|value| compare_scalar(value, &self.value, &self.op))
            }
            _ => return Err("Unknown filter operation".into()),
        };
        Ok(matched)
    }
}

#[derive(Clone, Serialize, Debug)]
pub struct Hit {
    pub row: u32,
    pub score: f64,
}

impl PartialEq for Hit {
    fn eq(&self, other: &Self) -> bool {
        self.row == other.row && self.score.total_cmp(&other.score) == Ordering::Equal
    }
}
impl Eq for Hit {}
impl PartialOrd for Hit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Hit {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .total_cmp(&self.score)
            .then_with(|| self.row.cmp(&other.row))
    }
}

fn offer_hit(heap: &mut BinaryHeap<Hit>, top_k: usize, hit: Hit) {
    if heap.len() < top_k {
        heap.push(hit);
    } else if let Some(mut cutoff) = heap.peek_mut()
        && hit < *cutoff
    {
        *cutoff = hit;
    }
}

struct PostingCursors<'a, T: PostingRow> {
    lists: Vec<&'a [T]>,
    cursors: Vec<usize>,
    allowed: &'a BitVec,
    driver: Option<usize>,
    required: Option<usize>,
    requirement: Option<(usize, f64)>,
    dense: bool,
}

impl<'a, T: PostingRow> PostingCursors<'a, T> {
    fn new(lists: Vec<&'a [T]>, allowed: &'a BitVec, intersect: bool) -> Self {
        let driver = if intersect {
            lists
                .iter()
                .enumerate()
                .min_by_key(|(_, list)| list.len())
                .map(|(index, _)| index)
        } else {
            None
        };
        let dense = intersect && lists.iter().all(|list| list.len() == allowed.len());
        Self {
            cursors: vec![0; lists.len()],
            lists,
            allowed,
            driver,
            required: None,
            requirement: None,
            dense,
        }
    }

    fn advance_before(list: &[T], target: u32) -> usize {
        if list.first().is_none_or(|posting| posting.row() >= target) {
            return 0;
        }
        let mut end = 1usize;
        while end < list.len() && list[end].row() < target {
            end = end.saturating_mul(2);
        }
        let start = end / 2;
        let stop = end.saturating_add(1).min(list.len());
        start + list[start..stop].partition_point(|posting| posting.row() < target)
    }

    fn require_term(&mut self, bounds: &[Vec<(&BlockMeta, f64)>], cutoff: &Hit) -> bool {
        if self.requirement.is_none() {
            let upper: Vec<_> = bounds
                .iter()
                .map(|blocks| {
                    blocks
                        .iter()
                        .fold(0.0_f64, |score, (_, bound)| score.max(*bound))
                })
                .collect();
            let Some((index, _)) = upper.iter().enumerate().max_by(|(left, a), (right, b)| {
                a.total_cmp(b)
                    .then_with(|| self.lists[*right].len().cmp(&self.lists[*left].len()))
            }) else {
                return false;
            };
            let others = upper.iter().enumerate().fold(0.0, |total, (term, score)| {
                if term == index { total } else { total + score }
            });
            self.requirement = Some((index, others));
        }
        if let Some((index, others)) = self.requirement
            && others + 1e-12 < cutoff.score
        {
            self.required = Some(index);
            return true;
        }
        false
    }

    fn row(&mut self) -> Option<u32> {
        if let Some(required) = self.required {
            let row = self.lists[required].get(self.cursors[required])?.row();
            for (index, list) in self.lists.iter().enumerate() {
                self.cursors[index] += Self::advance_before(&list[self.cursors[index]..], row);
            }
            return Some(row);
        }
        let Some(driver) = self.driver else {
            return self
                .lists
                .iter()
                .enumerate()
                .filter_map(|(index, list)| list.get(self.cursors[index]).map(PostingRow::row))
                .min();
        };
        let mut diverged = false;
        'candidates: loop {
            let row = self.lists[driver].get(self.cursors[driver])?.row();
            if !self.allowed[row as usize] {
                self.cursors[driver] += 1;
                diverged = true;
                continue;
            }
            if self.dense {
                if diverged {
                    self.cursors.fill(row as usize);
                }
                return Some(row);
            }
            for (index, list) in self.lists.iter().enumerate() {
                if list
                    .get(self.cursors[index])
                    .is_some_and(|posting| posting.row() < row)
                {
                    self.cursors[index] += Self::advance_before(&list[self.cursors[index]..], row);
                }
                let posting = list.get(self.cursors[index])?;
                if posting.row() > row {
                    self.cursors[driver] += Self::advance_before(
                        &self.lists[driver][self.cursors[driver]..],
                        posting.row(),
                    );
                    continue 'candidates;
                }
            }
            return Some(row);
        }
    }
}

pub struct Search {
    pub header: Rc<Header>,
    pub statistics: Rc<Statistics>,
    pub words: Rc<Vec<String>>,
    pub mode: String,
    pub top_k: usize,
    pub allowed: BitVec,
    terms: Rc<QueryTerms>,
    lists: PostingLists,
    last_decoded_rows: BTreeMap<String, Option<u32>>,
    pending_hot: Option<Rc<HotPostings>>,
    loaded_hot_blocks: BTreeMap<String, BTreeSet<u32>>,
}

struct SelectedPostingBlocks {
    term: String,
    indices: Vec<usize>,
}

#[derive(Serialize)]
pub struct PostingSpan<'a> {
    pub term: &'a str,
    pub blocks: Vec<&'a BlockMeta>,
}

pub struct PreparedQuery {
    terms: Rc<QueryTerms>,
    mode: String,
    top_k: usize,
    filters: Vec<Filter>,
}

impl PreparedQuery {
    #[doc = "# Errors\nRejects invalid top-k, match mode or term budgets."]
    pub fn new(
        statistics: Statistics,
        text: &str,
        mode: String,
        top_k: usize,
        filters: Vec<Filter>,
    ) -> Result<Self, String> {
        Ok(Self {
            terms: Rc::new(QueryTerms::new(statistics, text, &mode, top_k)?),
            mode,
            top_k,
            filters,
        })
    }

    #[doc = "# Errors\nRejects invalid filter attributes or tombstone rows."]
    pub fn ranker(&self, header: impl Into<Rc<Header>>, dead: &[u32]) -> Result<Search, String> {
        Search::with_terms(
            header.into(),
            self.terms.clone(),
            &self.mode,
            self.top_k,
            dead,
            &self.filters,
        )
    }
}

impl Search {
    #[must_use]
    pub fn uniform_hits(&self) -> Option<Vec<Hit>> {
        if self.header.documents.is_empty()
            || self.header.documents.len() > 10000
            || self.terms.order.is_empty()
            || self.mode == "phrase" && self.words.len() != 1
        {
            return None;
        }
        let count = u32::try_from(self.header.documents.len()).ok()?;
        let maximum_bytes = u32::try_from(MAX_BYTES).ok()?;
        let mut frequencies = Vec::with_capacity(self.terms.order.len());
        for term in &self.terms.order {
            let metadata = self.header.terms().get(self.words[*term].as_str())?;
            if metadata.df != count || metadata.blocks.is_empty() {
                return None;
            }
            let first = metadata.blocks.first()?;
            let frequency: (u32, u32) = first.max_tf.into();
            if frequency != (0, 1) && frequency != (1, 0) {
                return None;
            }
            let mut next_row = 0;
            let mut previous_end = 0;
            for block in &metadata.blocks {
                let end = block.data.offset.checked_add(block.data.length)?;
                if block.first != next_row
                    || block.count == 0
                    || block.count > u32::try_from(BLOCK_SIZE).ok()?
                    || block.last.checked_sub(block.first)?.checked_add(1)? != block.count
                    || <(u32, u32)>::from(block.max_tf) != frequency
                    || block.data.length == 0
                    || block.data.offset < previous_end
                    || end > maximum_bytes
                {
                    return None;
                }
                next_row = block.last.checked_add(1)?;
                previous_end = end;
            }
            if next_row != count {
                return None;
            }
            frequencies.push(frequency);
        }
        let normalization = self.terms.scorers.first()?;
        let title = frequencies.iter().any(|frequency| frequency.0 > 0);
        let body = frequencies.iter().any(|frequency| frequency.1 > 0);
        let mut heap = BinaryHeap::with_capacity(self.top_k);
        let mut score_cache = [None; 64];
        for (row, (title_length, body_length)) in self.header.documents.lengths().enumerate() {
            if title && title_length == 0 || body && body_length == 0 {
                return None;
            }
            if !self.allowed[row] {
                continue;
            }
            let identity = (u64::from(title_length) << 32) | u64::from(body_length);
            let index = (identity.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> 58) as usize;
            let cached = &mut score_cache[index];
            let score = match *cached {
                Some((key, score)) if key == identity => score,
                _ => {
                    let denominators = normalization.denominators(title_length, body_length);
                    let mut score = 0.0;
                    for (index, frequency) in frequencies.iter().enumerate() {
                        score += self.terms.scorers[index].score_normalized(
                            frequency.0,
                            frequency.1,
                            denominators,
                        );
                    }
                    *cached = Some((identity, score));
                    score
                }
            };
            if score <= 0.0 {
                continue;
            }
            offer_hit(
                &mut heap,
                self.top_k,
                Hit {
                    row: u32::try_from(row).ok()?,
                    score,
                },
            );
        }
        let mut hits = heap.into_vec();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.row.cmp(&b.row)));
        Some(hits)
    }

    #[must_use]
    pub fn posting_spans(&self) -> Vec<PostingSpan<'_>> {
        self.posting_spans_matching(|_| true)
    }

    #[doc = "# Errors\nRejects non-positive or non-finite cutoff scores."]
    pub fn posting_spans_after(
        &self,
        score: f64,
        id: &str,
    ) -> Result<Vec<PostingSpan<'_>>, String> {
        self.posting_spans_cutoff(score, DocumentId::String(id), false)
    }

    #[doc = "# Errors\nRejects malformed canonical IDs, invalid ID bounds or non-positive/non-finite cutoff scores."]
    pub fn posting_spans_after_id(
        &self,
        score: f64,
        encoded_id: &str,
    ) -> Result<Vec<PostingSpan<'_>>, String> {
        let id = decode_document_id(encoded_id)?;
        self.posting_spans_cutoff(score, id.borrowed(), false)
    }

    fn dense_cutoff(&self) -> Option<Hit> {
        if self.mode == "phrase" {
            return None;
        }
        let dense: Vec<_> = self
            .terms
            .order
            .iter()
            .enumerate()
            .filter(|(_, term)| {
                self.header
                    .terms()
                    .get(self.words[**term].as_str())
                    .is_some_and(|metadata| {
                        usize::try_from(metadata.df).ok() == Some(self.header.documents.len())
                    })
            })
            .map(|(index, _)| &self.terms.scorers[index])
            .collect();
        if dense.is_empty() || (self.mode == "all" && dense.len() != self.terms.order.len()) {
            return None;
        }
        let mut lengths = [None; 16];
        let mut distinct = 0;
        for pair in self.header.documents.lengths().take(lengths.len()) {
            if !lengths[..distinct].contains(&Some(pair)) {
                lengths[distinct] = Some(pair);
                distinct += 1;
            }
        }
        if distinct <= 8 {
            self.dense_cutoff_scores::<true>(&dense)
        } else {
            self.dense_cutoff_scores::<false>(&dense)
        }
    }

    #[inline]
    fn dense_cutoff_scores<const REUSE_LENGTHS: bool>(&self, dense: &[&TermScorer]) -> Option<Hit> {
        let mut heap: BinaryHeap<Hit> = BinaryHeap::with_capacity(self.top_k);
        let mut minimum_scores = [None; 64];
        for (row, (title_length, body_length)) in self.header.documents.lengths().enumerate() {
            if !self.allowed[row] {
                continue;
            }
            let compute = || {
                dense.iter().fold(0.0, |score, scorer| {
                    score + scorer.minimum_score(title_length, body_length)
                })
            };
            let score = if REUSE_LENGTHS {
                let identity = (u64::from(title_length) << 32) | u64::from(body_length);
                let index = (identity.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> 58) as usize;
                let cached = &mut minimum_scores[index];
                match *cached {
                    Some((key, score)) if key == identity => score,
                    _ => {
                        let score = compute();
                        *cached = Some((identity, score));
                        score
                    }
                }
            } else {
                compute()
            };
            if score <= 0.0 {
                continue;
            }
            let hit = Hit {
                row: u32::try_from(row).ok()?,
                score,
            };
            if heap.len() < self.top_k {
                heap.push(hit);
            } else if let Some(mut cutoff) = heap.peek_mut()
                && hit < *cutoff
            {
                *cutoff = hit;
            }
        }
        if heap.len() == self.top_k {
            heap.peek().cloned()
        } else {
            None
        }
    }

    #[doc = "# Errors\nRejects an invalid derived cutoff."]
    pub fn posting_spans_seeded(&self) -> Result<Vec<PostingSpan<'_>>, String> {
        self.dense_cutoff().map_or_else(
            || Ok(self.posting_spans()),
            |cutoff| {
                self.posting_spans_cutoff(
                    cutoff.score,
                    self.header.documents.row(cutoff.row as usize).id,
                    true,
                )
            },
        )
    }

    fn posting_spans_cutoff(
        &self,
        score: f64,
        id: DocumentIdRef<'_>,
        inclusive: bool,
    ) -> Result<Vec<PostingSpan<'_>>, String> {
        if !score.is_finite() || score <= 0.0 {
            return Err("Invalid ranking cutoff".into());
        }
        let bounds = self.block_bounds();
        Ok(self.posting_spans_matching(|candidate| {
            let bound = bounds.iter().fold(0.0, |total, blocks| {
                let first = blocks.partition_point(|(block, _)| block.last < candidate.first);
                total
                    + blocks[first..]
                        .iter()
                        .take_while(|(block, _)| block.first <= candidate.last)
                        .fold(0.0_f64, |maximum, (_, value)| maximum.max(*value))
            });
            if bound + 1e-12 < score {
                return false;
            }
            if bound.total_cmp(&score) != Ordering::Equal {
                return true;
            }
            (candidate.first as usize..=candidate.last as usize)
                .find(|row| self.allowed[*row])
                .is_some_and(|row| {
                    let order = compare_document_ids(self.header.documents.row(row).id, id);
                    order == Ordering::Less || (inclusive && order == Ordering::Equal)
                })
        }))
    }

    fn posting_spans_matching(
        &self,
        competitive: impl Fn(&BlockMeta) -> bool,
    ) -> Vec<PostingSpan<'_>> {
        let unrestricted = self.allowed.all();
        let mut spans: Vec<PostingSpan<'_>> = Vec::new();
        for index in &self.terms.order {
            let term = &self.words[*index];
            let Some(metadata) = self.header.terms().get(term) else {
                continue;
            };
            let mut blocks: Vec<&BlockMeta> = Vec::new();
            for block in &metadata.blocks {
                if self
                    .loaded_hot_blocks
                    .get(term)
                    .is_some_and(|loaded| loaded.contains(&block.data.offset))
                {
                    continue;
                }
                if (unrestricted
                    || (block.first as usize..=block.last as usize).any(|row| self.allowed[row]))
                    && competitive(block)
                {
                    if blocks.last().is_some_and(|previous| {
                        u64::from(block.data.offset)
                            > u64::from(previous.data.offset)
                                + u64::from(previous.data.length)
                                + 4096
                    }) {
                        spans.push(PostingSpan {
                            term,
                            blocks: std::mem::take(&mut blocks),
                        });
                    }
                    blocks.push(block);
                }
            }
            if !blocks.is_empty() {
                spans.push(PostingSpan { term, blocks });
            }
        }
        spans
    }
    #[doc = "# Errors\nRejects invalid top-k, match mode, term budgets, attributes, or tombstone rows."]
    pub fn new(
        header: impl Into<Rc<Header>>,
        statistics: Statistics,
        text: &str,
        mode: &str,
        top_k: usize,
        dead: &[u32],
        filters: &[Filter],
    ) -> Result<Self, String> {
        let header = header.into();
        Self::with_terms(
            header,
            Rc::new(QueryTerms::new(statistics, text, mode, top_k)?),
            mode,
            top_k,
            dead,
            filters,
        )
    }

    fn with_terms(
        header: Rc<Header>,
        terms: Rc<QueryTerms>,
        mode: &str,
        top_k: usize,
        dead: &[u32],
        filters: &[Filter],
    ) -> Result<Self, String> {
        let allowed = header.allowed(filters, dead)?;
        Ok(Self {
            header,
            statistics: terms.statistics.clone(),
            words: terms.words.clone(),
            terms,
            mode: mode.into(),
            top_k,
            allowed,
            last_decoded_rows: BTreeMap::new(),
            lists: if mode == "phrase" {
                PostingLists::Positions(BTreeMap::new())
            } else {
                PostingLists::Frequencies(BTreeMap::new())
            },
            pending_hot: None,
            loaded_hot_blocks: BTreeMap::new(),
        })
    }

    #[cfg(any(test, target_arch = "wasm32"))]
    fn own_posting_selection(
        &self,
        spans: &[PostingSpan<'_>],
    ) -> Result<Vec<SelectedPostingBlocks>, String> {
        spans
            .iter()
            .map(|span| {
                let metadata = self
                    .header
                    .terms()
                    .get(span.term)
                    .ok_or("Missing selected term")?;
                let indices = span
                    .blocks
                    .iter()
                    .map(|block| {
                        metadata
                            .blocks
                            .binary_search_by_key(&block.data.offset, |candidate| {
                                candidate.data.offset
                            })
                            .map_err(|index| {
                                format!("Missing selected posting block near index {index}")
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(SelectedPostingBlocks {
                    term: span.term.to_owned(),
                    indices,
                })
            })
            .collect()
    }

    fn satisfy_hot_selection(
        &mut self,
        selection: Vec<SelectedPostingBlocks>,
    ) -> Result<Vec<SelectedPostingBlocks>, String> {
        let Some(hot) = self.pending_hot.clone() else {
            return Ok(selection);
        };
        let header = Rc::clone(&self.header);
        let mut missing = Vec::with_capacity(selection.len());
        for selected in selection {
            let Some(cached) = hot.terms.get(&selected.term) else {
                missing.push(selected);
                continue;
            };
            let metadata = header
                .terms()
                .get(&selected.term)
                .ok_or("Missing selected term")?;
            for index in &selected.indices {
                let block = metadata
                    .blocks
                    .get(*index)
                    .ok_or("Missing selected posting block")?;
                let already_loaded = self
                    .loaded_hot_blocks
                    .get(&selected.term)
                    .is_some_and(|loaded| loaded.contains(&block.data.offset));
                if already_loaded {
                    continue;
                }
                let page = cached.get(*index).ok_or("Incomplete common hot term")?;
                self.add_hot_block(&selected.term, block, page)?;
                self.loaded_hot_blocks
                    .entry(selected.term.clone())
                    .or_default()
                    .insert(block.data.offset);
            }
        }
        Ok(missing)
    }

    fn add_hot_block(
        &mut self,
        term: &str,
        metadata: &BlockMeta,
        bytes: &[u8],
    ) -> Result<(), String> {
        let previous = self.last_decoded_rows.get(term).copied().flatten();
        if previous.is_none_or(|row| row < metadata.first) {
            return self.add(term, bytes);
        }
        validate_hot_block(&self.header, metadata, bytes)?;
        match &mut self.lists {
            PostingLists::Positions(lists) => {
                let rows = decode_postings(bytes)?;
                let list = lists.entry(term.into()).or_default();
                merge_hot_rows(
                    list,
                    rows.into_iter()
                        .filter(|row| self.allowed[row.row as usize]),
                )?;
            }
            PostingLists::Frequencies(lists) => {
                let rows =
                    decode_posting_rows::<false, _>(bytes, |row, title, body| FrequencyPosting {
                        row,
                        title: title.count,
                        body: body.count,
                    })?;
                let list = lists.entry(term.into()).or_default();
                merge_hot_rows(
                    list,
                    rows.into_iter()
                        .filter(|row| self.allowed[row.row as usize]),
                )?;
            }
        }
        self.last_decoded_rows.insert(
            term.into(),
            Some(previous.unwrap_or_default().max(metadata.last)),
        );
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    fn has_hot_selection(&self, spans: &[PostingSpan<'_>]) -> bool {
        self.pending_hot
            .as_ref()
            .is_some_and(|hot| spans.iter().any(|span| hot.terms.contains_key(span.term)))
    }

    fn all_hot_selection(&self) -> Result<Vec<SelectedPostingBlocks>, String> {
        let Some(hot) = self.pending_hot.as_ref() else {
            return Ok(Vec::new());
        };
        self.words
            .iter()
            .filter(|term| hot.terms.contains_key(term.as_str()))
            .map(|term| {
                let metadata = self
                    .header
                    .terms()
                    .get(term)
                    .ok_or("Missing hot posting term")?;
                Ok(SelectedPostingBlocks {
                    term: term.clone(),
                    indices: (0..metadata.blocks.len()).collect(),
                })
            })
            .collect()
    }

    #[cfg(target_arch = "wasm32")]
    fn encode_posting_selection(
        &self,
        selection: &[SelectedPostingBlocks],
    ) -> Result<String, String> {
        let mut spans = Vec::with_capacity(selection.len());
        for selected in selection {
            let term = self
                .terms
                .word(&selected.term)
                .ok_or("Missing selected query term")?;
            let metadata = self
                .header
                .terms()
                .get(term)
                .ok_or("Missing selected term")?;
            let blocks = selected
                .indices
                .iter()
                .map(|index| {
                    metadata
                        .blocks
                        .get(*index)
                        .ok_or("Missing selected posting block")
                })
                .collect::<Result<Vec<_>, _>>()?;
            spans.push(PostingSpan { term, blocks });
        }
        serde_json::to_string(&spans).map_err(|cause| cause.to_string())
    }

    #[doc = "# Errors\nRejects unrequested terms, corrupt pages, invalid rows or positions, and unordered posting blocks."]
    pub fn add(&mut self, term: &str, bytes: &[u8]) -> Result<(), String> {
        if self.terms.word(term).is_none() {
            return Err("Unrequested posting term".into());
        }
        match &mut self.lists {
            PostingLists::Positions(lists) => {
                let postings = decode_postings(bytes)?;
                let list = lists.entry(term.into()).or_default();
                let previous = self.last_decoded_rows.entry(term.into()).or_default();
                for posting in postings {
                    validate_posting(
                        &self.header,
                        posting.row,
                        posting.title.last().copied(),
                        posting.body.last().copied(),
                        *previous,
                    )?;
                    *previous = Some(posting.row);
                    if self.allowed[posting.row as usize] {
                        list.push(posting);
                    }
                }
            }
            PostingLists::Frequencies(_) => {
                let rows = decode_posting_rows::<false, _>(bytes, |row, title, body| {
                    DecodedFrequencyPosting {
                        posting: FrequencyPosting {
                            row,
                            title: title.count,
                            body: body.count,
                        },
                        title_last: title.last,
                        body_last: body.last,
                    }
                })?;
                self.add_frequency_page(term, &rows)?;
            }
        }
        Ok(())
    }

    fn add_frequency_page(
        &mut self,
        term: &str,
        rows: &[DecodedFrequencyPosting],
    ) -> Result<(), String> {
        if self.terms.word(term).is_none() {
            return Err("Unrequested posting term".into());
        }
        let PostingLists::Frequencies(lists) = &mut self.lists else {
            return Err("Frequency page requires any/all mode".into());
        };
        let list = lists.entry(term.into()).or_default();
        let previous = self.last_decoded_rows.entry(term.into()).or_default();
        for row in rows {
            validate_posting(
                &self.header,
                row.posting.row,
                row.title_last,
                row.body_last,
                *previous,
            )?;
            *previous = Some(row.posting.row);
            if self.allowed[row.posting.row as usize] {
                list.push(row.posting.clone());
            }
        }
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    fn add_validated_frequency_page(
        &mut self,
        term: &str,
        rows: &[DecodedFrequencyPosting],
    ) -> Result<(), String> {
        if self.terms.word(term).is_none() {
            return Err("Unrequested posting term".into());
        }
        let PostingLists::Frequencies(lists) = &mut self.lists else {
            return Err("Frequency page requires any/all mode".into());
        };
        let list = lists.entry(term.into()).or_default();
        let previous = self.last_decoded_rows.entry(term.into()).or_default();
        if let Some(first) = rows.first()
            && previous.is_some_and(|previous| previous >= first.posting.row)
        {
            return Err("Posting blocks out of order".into());
        }
        for row in rows {
            *previous = Some(row.posting.row);
            if self.allowed[row.posting.row as usize] {
                list.push(row.posting.clone());
            }
        }
        Ok(())
    }

    fn phrase<T: PostingRow>(postings: &[Option<&T>], order: &[usize]) -> bool {
        let Some(first) = order.first().and_then(|index| postings[*index]) else {
            return false;
        };
        for field in 0..2 {
            let starts = first.positions()[field];
            for start in starts {
                if order.iter().enumerate().all(|(offset, index)| {
                    postings[*index].is_some_and(|p| {
                        let positions = p.positions()[field];
                        u32::try_from(offset)
                            .ok()
                            .and_then(|offset| start.checked_add(offset))
                            .is_some_and(|position| positions.binary_search(&position).is_ok())
                    })
                }) {
                    return true;
                }
            }
        }
        false
    }

    fn block_bounds(&self) -> Vec<Vec<(&BlockMeta, f64)>> {
        let unrestricted = self.allowed.all();
        self.terms
            .order
            .iter()
            .enumerate()
            .map(|(index, term)| {
                self.header
                    .terms()
                    .get(self.words[*term].as_str())
                    .into_iter()
                    .flat_map(|meta| meta.blocks.iter())
                    .map(|block| {
                        let minimum = if unrestricted {
                            Some(block.min_length.into())
                        } else {
                            let rows = block.first as usize..=block.last as usize;
                            rows.filter(|row| self.allowed[*row])
                                .map(|row| self.header.documents.row(row))
                                .fold(None, |minimum, document| match minimum {
                                    Some((title, body)) => Some((
                                        u32::min(title, document.title_length),
                                        u32::min(body, document.body_length),
                                    )),
                                    None => Some((document.title_length, document.body_length)),
                                })
                        };
                        let score = minimum.map_or(0.0, |(title, body)| {
                            self.terms.scorers[index].score(
                                block.max_tf[0],
                                block.max_tf[1],
                                block.min_length[0].max(title),
                                block.min_length[1].max(body),
                            )
                        });
                        (block, score)
                    })
                    .collect()
            })
            .collect()
    }

    fn skippable_block_end<T: PostingRow>(
        lists: &[&[T]],
        cursors: &[usize],
        bounds: &[Vec<(&BlockMeta, f64)>],
        bound_cursors: &mut [usize],
        cutoff: &Hit,
        row: u32,
    ) -> Option<u32> {
        let mut end = u32::MAX;
        let mut bound = 0.0;
        for (index, list) in lists.iter().enumerate() {
            if let Some(posting) = list.get(cursors[index]) {
                if bounds[index]
                    .get(bound_cursors[index])
                    .is_some_and(|(block, _)| block.last < posting.row())
                {
                    bound_cursors[index] += bounds[index][bound_cursors[index]..]
                        .partition_point(|(block, _)| block.last < posting.row());
                }
                if let Some((block, score)) = bounds[index]
                    .get(bound_cursors[index])
                    .filter(|(block, _)| block.first <= posting.row())
                {
                    end = end.min(block.last);
                    bound += score;
                }
            }
        }
        if bound + 1e-12 < cutoff.score
            || (bound.total_cmp(&cutoff.score) == Ordering::Equal && row >= cutoff.row)
        {
            return Some(end);
        }
        None
    }

    #[doc = "# Errors\nRejects posting frequencies that cannot fit the wire format."]
    pub fn finish(&self) -> Result<Vec<Hit>, String> {
        match &self.lists {
            PostingLists::Positions(lists) => self.finish_lists(lists),
            PostingLists::Frequencies(lists) => {
                if self.mode == "phrase" {
                    return Err("Phrase search requires positional postings".into());
                }
                self.finish_lists(lists)
            }
        }
    }

    fn finish_lists<T: PostingRow>(
        &self,
        stored: &BTreeMap<String, Vec<T>>,
    ) -> Result<Vec<Hit>, String> {
        let terms = &self.terms.order;
        let lists: Vec<_> = terms
            .iter()
            .map(|term| {
                stored
                    .get(self.words[*term].as_str())
                    .map_or(&[] as &[T], Vec::as_slice)
            })
            .collect();
        if self.mode != "any" && lists.iter().any(|list| list.is_empty()) {
            return Ok(Vec::new());
        }
        let scorers = &self.terms.scorers;
        let Some(normalization) = scorers.first() else {
            return Ok(Vec::new());
        };
        let mut bounds = None;
        let mut bound_cursors = vec![0; terms.len()];
        let phrase_order = &self.terms.phrase_order;
        let mut selected = vec![None; lists.len()];
        let mut positions = PostingCursors::new(lists, &self.allowed, self.mode != "any");
        let mut heap: BinaryHeap<Hit> = BinaryHeap::with_capacity(self.top_k);
        while let Some(row) = positions.row() {
            if heap.len() == self.top_k
                && let Some(cutoff) = heap.peek()
            {
                let bounds = bounds.get_or_insert_with(|| self.block_bounds());
                if self.mode == "any"
                    && positions.required.is_none()
                    && positions.require_term(bounds, cutoff)
                {
                    continue;
                }
                if let Some(end) = Self::skippable_block_end(
                    &positions.lists,
                    &positions.cursors,
                    bounds,
                    &mut bound_cursors,
                    cutoff,
                    row,
                ) {
                    for (index, list) in positions.lists.iter().enumerate() {
                        positions.cursors[index] += list[positions.cursors[index]..]
                            .partition_point(|posting| posting.row() <= end);
                    }
                    continue;
                }
            }
            if !self.allowed[row as usize] {
                for (index, list) in positions.lists.iter().enumerate() {
                    positions.cursors[index] += usize::from(
                        list.get(positions.cursors[index])
                            .is_some_and(|posting| posting.row() == row),
                    );
                }
                continue;
            }
            selected.fill(None);
            let mut matched = 0;
            let mut score = 0.0;
            let meta = self.header.documents.row(row as usize);
            let denominators = normalization.denominators(meta.title_length, meta.body_length);
            for (index, list) in positions.lists.iter().enumerate() {
                if let Some(posting) = list
                    .get(positions.cursors[index])
                    .filter(|p| p.row() == row)
                {
                    score += scorers[index].score_normalized(
                        u32::try_from(posting.counts()[0]).map_err(|cause| cause.to_string())?,
                        u32::try_from(posting.counts()[1]).map_err(|cause| cause.to_string())?,
                        denominators,
                    );
                    selected[index] = Some(posting);
                    matched += 1;
                    positions.cursors[index] += 1;
                }
            }
            if self.mode != "any" && matched != terms.len() {
                continue;
            }
            if self.mode == "phrase" && !Self::phrase(&selected, phrase_order) {
                continue;
            }
            if score <= 0.0 {
                continue;
            }
            let hit = Hit { row, score };
            offer_hit(&mut heap, self.top_k, hit);
        }
        let mut hits = heap.into_vec();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.row.cmp(&b.row)));
        Ok(hits)
    }
}

#[doc = "# Errors\nRejects a document whose native title or text role is not text."]
pub fn document_terms(document: &Document) -> Result<Vec<String>, String> {
    let title = document.role_text(NativeRole::Title)?;
    let text = document.role_text(NativeRole::Text)?;
    Ok(normalize_text(&format!("{title} {text}"))
        .split_whitespace()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

#[cfg(test)]
fn vector_bits(document: &Document) -> Result<Option<Vec<u32>>, String> {
    match document.column(ColumnId::Role(NativeRole::Vector)) {
        Some(ColumnValue::Vector(values)) => {
            Ok(Some(values.iter().map(|value| value.to_bits()).collect()))
        }
        None => Ok(None),
        Some(ColumnValue::Text(_) | ColumnValue::Attribute(_)) => {
            Err("Native vector role is not a vector".into())
        }
    }
}

#[cfg(test)]
fn documents_from_native_value(
    value: serde_json::Value,
) -> Result<Vec<Document>, serde_json::Error> {
    serde_json::from_value::<Vec<serde_json::Value>>(value)?
        .into_iter()
        .map(Document::from_native_value)
        .collect()
}

fn bloom_hashes(text: &str) -> (u64, u64) {
    let (first, second) = text.as_bytes().iter().fold(
        (0xcbf2_9ce4_8422_2325u64, 0x8422_2325_cbf2_9ce4u64),
        |(first, second), byte| {
            let value = u64::from(*byte);
            (
                (first ^ value).wrapping_mul(0x0100_0000_01b3),
                (second ^ value).wrapping_mul(0x0100_0000_01b3),
            )
        },
    );
    (first, second | 1)
}

#[doc = "# Errors\nRejects values beyond the bloom size budget or an unrepresentable bit index."]
pub fn bloom_build(values: &[String]) -> Result<Vec<u8>, String> {
    bloom_build_hashes(values.iter().map(|value| Ok(bloom_hashes(value))))
}

fn bloom_id_hashes(value: DocumentIdRef<'_>) -> Result<(u64, u64), String> {
    match value {
        DocumentId::String(text) => Ok(bloom_hashes(text)),
        DocumentId::Uint(_) | DocumentId::Uuid(_) => serde_json::to_string(&value)
            .map(|wire| bloom_hashes(&wire))
            .map_err(|cause| cause.to_string()),
    }
}

#[doc = "# Errors\nRejects canonical ID serialization failures, bloom size budgets or unrepresentable bit indexes."]
pub fn bloom_build_ids(values: &[DocumentId]) -> Result<Vec<u8>, String> {
    bloom_build_hashes(values.iter().map(|value| bloom_id_hashes(value.borrowed())))
}

fn bloom_build_hashes(
    hashes: impl ExactSizeIterator<Item = Result<(u64, u64), String>>,
) -> Result<Vec<u8>, String> {
    if hashes.len() > MAX_BYTES / 2 {
        return Err("Bloom exceeds size budget".into());
    }
    let mut bytes = vec![0u8; (hashes.len() * 2).max(8)];
    for hashes in hashes {
        let (a, b) = hashes?;
        for index in 0u64..7 {
            let bit = usize::try_from(
                a.wrapping_add(index.wrapping_mul(b))
                    % (u64::try_from(bytes.len()).map_err(|cause| cause.to_string())? * 8),
            )
            .map_err(|cause| cause.to_string())?;
            bytes[bit / 8] |= 1 << (bit % 8);
        }
    }
    Ok(bytes)
}

#[doc = "# Errors\nRejects an oversized bloom or an unrepresentable bit index."]
pub fn bloom_contains(bytes: &[u8], value: &str) -> Result<bool, String> {
    if bytes.is_empty() {
        return Ok(false);
    }
    if bytes.len() > MAX_BYTES {
        return Err("Bloom exceeds size budget".into());
    }
    let (a, b) = bloom_hashes(value);
    bloom_contains_hashes(bytes, a, b)
}

fn bloom_contains_hashes(bytes: &[u8], a: u64, b: u64) -> Result<bool, String> {
    if bytes.is_empty() {
        return Ok(false);
    }
    for index in 0u64..7 {
        let bit = usize::try_from(
            a.wrapping_add(index.wrapping_mul(b))
                % (u64::try_from(bytes.len()).map_err(|cause| cause.to_string())? * 8),
        )
        .map_err(|cause| cause.to_string())?;
        if bytes[bit / 8] & (1 << (bit % 8)) == 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

#[doc = "# Errors\nRejects oversized batches or invalid offset framing."]
pub fn bloom_filter_many<'a>(
    bytes: &[u8],
    offsets: &[u32],
    values: &'a [String],
) -> Result<Vec<Vec<&'a str>>, String> {
    let hashes = values.iter().map(|value| {
        let (a, b) = bloom_hashes(value);
        Ok((value.as_str(), a, b))
    });
    bloom_filter_hashes(bytes, offsets, hashes)
}

#[doc = "# Errors\nRejects canonical ID serialization failures, oversized batches or invalid offset framing."]
pub fn bloom_filter_ids<'a>(
    bytes: &[u8],
    offsets: &[u32],
    values: &'a [DocumentId],
) -> Result<Vec<Vec<DocumentIdRef<'a>>>, String> {
    let hashes = values.iter().map(|value| {
        let value = value.borrowed();
        let (a, b) = bloom_id_hashes(value)?;
        Ok((value, a, b))
    });
    bloom_filter_hashes(bytes, offsets, hashes)
}

fn bloom_filter_hashes<T: Copy>(
    bytes: &[u8],
    offsets: &[u32],
    hashes: impl Iterator<Item = Result<(T, u64, u64), String>>,
) -> Result<Vec<Vec<T>>, String> {
    if bytes.len() > MAX_BYTES || offsets.len() > 65 {
        return Err("Bloom batch exceeds size budget".into());
    }
    if offsets.first() != Some(&0)
        || offsets
            .last()
            .copied()
            .map(usize::try_from)
            .transpose()
            .map_err(|cause| cause.to_string())?
            != Some(bytes.len())
    {
        return Err("Invalid bloom offsets".into());
    }
    let hashes = hashes.collect::<Result<Vec<_>, _>>()?;
    let mut cached_positions: Option<(usize, Vec<[usize; 7]>)> = None;
    offsets
        .windows(2)
        .enumerate()
        .map(|(index, span)| {
            let start = usize::try_from(span[0]).map_err(|cause| cause.to_string())?;
            let end = usize::try_from(span[1]).map_err(|cause| cause.to_string())?;
            let bloom = bytes
                .get(start..end)
                .ok_or_else(|| "Invalid bloom offsets".to_owned())?;
            let reusable = offsets
                .get(index + 2)
                .is_some_and(|next| next.checked_sub(span[1]) == span[1].checked_sub(span[0]));
            if !bloom.is_empty()
                && reusable
                && cached_positions
                    .as_ref()
                    .is_none_or(|(length, _)| *length != bloom.len())
            {
                let bits = u64::try_from(bloom.len()).map_err(|cause| cause.to_string())? * 8;
                let positions = hashes
                    .iter()
                    .map(|&(_, a, b)| {
                        let mut positions = [0; 7];
                        for (index, position) in positions.iter_mut().enumerate() {
                            let index = u64::try_from(index).map_err(|cause| cause.to_string())?;
                            *position =
                                usize::try_from(a.wrapping_add(index.wrapping_mul(b)) % bits)
                                    .map_err(|cause| cause.to_string())?;
                        }
                        Ok::<_, String>(positions)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                cached_positions = Some((bloom.len(), positions));
            }
            let mut selected = Vec::new();
            if let Some((_, positions)) = cached_positions
                .as_ref()
                .filter(|(length, _)| *length == bloom.len())
            {
                for (&(value, _, _), positions) in hashes.iter().zip(positions) {
                    if positions
                        .iter()
                        .all(|bit| bloom[bit / 8] & (1 << (bit % 8)) != 0)
                    {
                        selected.push(value);
                    }
                }
            } else {
                for &(value, a, b) in &hashes {
                    if bloom_contains_hashes(bloom, a, b)? {
                        selected.push(value);
                    }
                }
            }
            Ok(selected)
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use super::{
        Bm25Parameters, BuiltSegment, CanonicalDocumentDto, CorpusStatistics, Document,
        DocumentAttributes, DocumentColumnId, DocumentId, DocumentIdRef, DocumentMeta, FieldQuery,
        FieldStatistics, Filter, Header, MAX_BYTES, MAX_QUERY_TERMS, NamedTextField, NativeRole,
        Range, Search, SelectedAttributes, Statistics, TermDictionary, TermMeta, TermScorer,
        append, bloom_build_ids, bloom_filter_ids, build, build_text_fields, compare_document_ids,
        decode_page, document_terms, local_field_statistics, matches, parse_header,
        rank_fields_with,
    };
    use serde::{Deserialize, Serialize};
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};
    use std::rc::{Rc, Weak};
    use wasm_bindgen::prelude::*;

    const FIELD_JSON_LIMIT: usize = 16 * 1024 * 1024;
    const SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

    fn deserialize_nonnull_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: Deserialize<'de>,
    {
        T::deserialize(deserializer).map(Some)
    }

    #[derive(Deserialize)]
    #[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
    enum FieldColumnDto {
        Native { role: String },
        Attribute { name: String },
    }

    impl TryFrom<FieldColumnDto> for DocumentColumnId {
        type Error = String;

        fn try_from(value: FieldColumnDto) -> Result<Self, Self::Error> {
            match value {
                FieldColumnDto::Native { role } => match role.as_str() {
                    "title" => Ok(Self::Role(NativeRole::Title)),
                    "text" => Ok(Self::Role(NativeRole::Text)),
                    "vector" => Err("Vector is not a text field".into()),
                    _ => Err("Unknown native document role".into()),
                },
                FieldColumnDto::Attribute { name }
                    if !name.is_empty()
                        && name.encode_utf16().count() <= 128
                        && name.len() <= 128
                        && !name.starts_with('$') =>
                {
                    Ok(Self::Attribute(name))
                }
                FieldColumnDto::Attribute { .. } => Err("Invalid attribute field name".into()),
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct NamedFieldDto {
        name: String,
        #[serde(default)]
        config: crate::analysis::WordV4Config,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FieldBuildDto {
        documents: Vec<CanonicalDocumentDto>,
        text_fields: Vec<NamedFieldDto>,
        #[serde(default)]
        #[serde(deserialize_with = "deserialize_nonnull_option")]
        filterable: Option<Vec<String>>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FieldStatisticDto {
        id: FieldColumnDto,
        tokens: u64,
        frequencies: BTreeMap<String, u64>,
    }

    #[derive(Serialize)]
    #[serde(untagged)]
    enum FieldColumnOut {
        Native {
            source: &'static str,
            role: &'static str,
        },
        Attribute {
            source: &'static str,
            name: String,
        },
    }

    impl From<&DocumentColumnId> for FieldColumnOut {
        fn from(id: &DocumentColumnId) -> Self {
            match id {
                DocumentColumnId::Role(NativeRole::Title) => Self::Native {
                    source: "native",
                    role: "title",
                },
                DocumentColumnId::Role(NativeRole::Text) => Self::Native {
                    source: "native",
                    role: "text",
                },
                DocumentColumnId::Role(NativeRole::Vector) => Self::Native {
                    source: "native",
                    role: "vector",
                },
                DocumentColumnId::Attribute(name) => Self::Attribute {
                    source: "attribute",
                    name: name.clone(),
                },
            }
        }
    }

    #[derive(Serialize)]
    struct FieldStatisticsOut<'a> {
        id: FieldColumnOut,
        tokens: u64,
        frequencies: &'a BTreeMap<String, u64>,
    }

    #[derive(Serialize)]
    struct CorpusStatisticsOut<'a> {
        documents: u64,
        fields: Vec<FieldStatisticsOut<'a>>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CorpusStatisticsDto {
        documents: u64,
        fields: Vec<FieldStatisticDto>,
    }

    impl TryFrom<CorpusStatisticsDto> for CorpusStatistics {
        type Error = String;

        fn try_from(value: CorpusStatisticsDto) -> Result<Self, Self::Error> {
            if value.documents > SAFE_JSON_INTEGER {
                return Err("Document count exceeds safe JSON integer range".into());
            }
            if value.fields.len() > 66 {
                return Err("Corpus field count exceeds field budget".into());
            }
            let fields = value
                .fields
                .into_iter()
                .map(|field| {
                    if field.tokens > SAFE_JSON_INTEGER
                        || field.frequencies.len() > MAX_QUERY_TERMS
                        || field
                            .frequencies
                            .values()
                            .any(|count| *count > SAFE_JSON_INTEGER)
                    {
                        return Err("Field count exceeds safe JSON integer range".into());
                    }
                    Ok(FieldStatistics {
                        id: field.id.try_into()?,
                        tokens: field.tokens,
                        frequencies: field.frequencies,
                    })
                })
                .collect::<Result<_, String>>()?;
            Ok(Self {
                documents: value.documents,
                fields,
            })
        }
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FieldQueryDto {
        fields: Vec<FieldColumnDto>,
        text: String,
        mode: String,
        #[serde(default = "default_top_k")]
        top_k: usize,
        #[serde(default)]
        dead: Vec<u32>,
        #[serde(default)]
        filters: Vec<FieldFilterDto>,
        #[serde(default)]
        #[serde(deserialize_with = "deserialize_nonnull_option")]
        bm25: Option<Bm25Dto>,
        #[serde(default)]
        #[serde(deserialize_with = "deserialize_nonnull_option")]
        statistics: Option<CorpusStatisticsDto>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FieldStatisticsQueryDto {
        fields: Vec<FieldColumnDto>,
        text: String,
        mode: String,
        #[serde(default)]
        dead: Vec<u32>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Bm25Dto {
        k1: f64,
        b: f64,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FieldFilterDto {
        field: String,
        op: String,
        value: serde_json::Value,
    }

    struct DecodedFieldQuery {
        fields: Vec<DocumentColumnId>,
        text: String,
        mode: String,
        top_k: usize,
        dead: Vec<u32>,
        filters: Vec<Filter>,
        bm25: Bm25Parameters,
        statistics: Option<CorpusStatistics>,
    }

    impl DecodedFieldQuery {
        fn as_query(&self) -> FieldQuery<'_> {
            FieldQuery {
                fields: &self.fields,
                text: &self.text,
                mode: &self.mode,
                top_k: self.top_k,
                dead: &self.dead,
                filters: &self.filters,
                bm25: self.bm25,
                statistics: self.statistics.as_ref(),
            }
        }
    }

    impl FieldFilterDto {
        fn into_filter(self) -> Result<Filter, String> {
            if self.field.is_empty()
                || self.field.encode_utf16().count() > 128
                || self.field.len() > 128
                || self.field.starts_with('$')
            {
                return Err("Invalid filter field name".into());
            }
            let scalar = |value: &serde_json::Value| match value {
                serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::String(_) => true,
                serde_json::Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
                serde_json::Value::Array(_) | serde_json::Value::Object(_) => false,
            };
            let valid = match self.op.as_str() {
                "eq" | "ne" | "contains" | "notContains" => scalar(&self.value),
                "gt" | "gte" | "lt" | "lte" => {
                    self.value.is_string() || (self.value.is_number() && scalar(&self.value))
                }
                "exists" => self.value.is_boolean(),
                "in" => self.value.as_array().is_some_and(|items| {
                    (1..=32).contains(&items.len()) && items.iter().all(scalar)
                }),
                "notIn" | "containsAny" | "notContainsAny" => self
                    .value
                    .as_array()
                    .is_some_and(|items| items.len() <= 32 && items.iter().all(scalar)),
                _ => false,
            };
            if !valid {
                return Err("Invalid field filter".into());
            }
            Ok(Filter {
                field: self.field,
                op: self.op,
                value: self.value,
            })
        }
    }

    const fn default_top_k() -> usize {
        10
    }

    fn check_field_json(value: &str) -> Result<(), JsValue> {
        if value.len() > FIELD_JSON_LIMIT {
            Err(JsValue::from_str("Field JSON exceeds sixteen MiB"))
        } else {
            Ok(())
        }
    }

    fn decode_field_query(json: &str) -> Result<DecodedFieldQuery, JsValue> {
        check_field_json(json)?;
        let dto: FieldQueryDto =
            serde_json::from_str(json).map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        if dto.fields.is_empty()
            || dto.fields.len() > 66
            || dto.dead.len() > 100_000
            || dto.filters.len() > 64
            || !(1..=100).contains(&dto.top_k)
            || dto.text.is_empty()
            || dto.text.encode_utf16().count() > 8_192
        {
            return Err(JsValue::from_str("Field query exceeds its input budget"));
        }
        let fields = dto
            .fields
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, String>>()
            .map_err(|cause| JsValue::from_str(&cause))?;
        let bm25 = dto
            .bm25
            .map_or(Ok(Bm25Parameters::DEFAULT), |p| {
                Bm25Parameters::new(p.k1, p.b)
            })
            .map_err(|cause| JsValue::from_str(&cause))?;
        let statistics = dto
            .statistics
            .map(TryInto::try_into)
            .transpose()
            .map_err(|cause: String| JsValue::from_str(&cause))?;
        let filters = dto
            .filters
            .into_iter()
            .map(FieldFilterDto::into_filter)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|cause| JsValue::from_str(&cause))?;
        Ok(DecodedFieldQuery {
            fields,
            text: dto.text,
            mode: dto.mode,
            top_k: dto.top_k,
            dead: dto.dead,
            filters,
            bm25,
            statistics,
        })
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects malformed or oversized field build JSON, invalid canonical documents, declarations, and segments beyond engine budgets."]
    pub fn segment_build_text_fields(json: &str) -> Result<Vec<u8>, JsValue> {
        check_field_json(json)?;
        let dto: FieldBuildDto =
            serde_json::from_str(json).map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        if dto.documents.is_empty()
            || dto.documents.len() > 10_000
            || dto.text_fields.len() > 64
            || dto
                .filterable
                .as_ref()
                .is_some_and(|fields| fields.len() > 64)
        {
            return Err(JsValue::from_str("Field build exceeds its input budget"));
        }
        let documents = dto
            .documents
            .into_iter()
            .map(Document::from_canonical_dto)
            .collect();
        let fields = dto
            .text_fields
            .iter()
            .map(|field| NamedTextField {
                attribute: &field.name,
                config: field.config,
            })
            .collect::<Vec<_>>();
        build_text_fields(documents, dto.filterable.as_deref(), &fields)
            .map(|built| built.bytes)
            .map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects malformed field query JSON, invalid global statistics, corrupt segments, filters, and tombstones."]
    pub fn segment_rank_fields(bytes: &[u8], json: &str) -> Result<String, JsValue> {
        let decoded = decode_field_query(json)?;
        let query = decoded.as_query();
        let hits = rank_fields_with(bytes, &query).map_err(|cause| JsValue::from_str(&cause))?;
        serde_json::to_string(&hits).map_err(|cause| JsValue::from_str(&cause.to_string()))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects malformed field query JSON, unsafe count transport, corrupt segments, and invalid tombstones."]
    pub fn segment_local_field_statistics(bytes: &[u8], json: &str) -> Result<String, JsValue> {
        check_field_json(json)?;
        let dto: FieldStatisticsQueryDto =
            serde_json::from_str(json).map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        if dto.fields.is_empty()
            || dto.fields.len() > 66
            || dto.dead.len() > 100_000
            || dto.text.is_empty()
            || dto.text.encode_utf16().count() > 8_192
        {
            return Err(JsValue::from_str(
                "Field statistics query exceeds its input budget",
            ));
        }
        let fields = dto
            .fields
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, String>>()
            .map_err(|cause| JsValue::from_str(&cause))?;
        let statistics = local_field_statistics(bytes, &fields, &dto.text, &dto.mode, &dto.dead)
            .map_err(|cause| JsValue::from_str(&cause))?;
        if statistics.documents > SAFE_JSON_INTEGER
            || statistics.fields.iter().any(|field| {
                field.tokens > SAFE_JSON_INTEGER
                    || field
                        .frequencies
                        .values()
                        .any(|count| *count > SAFE_JSON_INTEGER)
            })
        {
            return Err(JsValue::from_str(
                "Field statistics exceed safe JSON integer range",
            ));
        }
        let output = CorpusStatisticsOut {
            documents: statistics.documents,
            fields: statistics
                .fields
                .iter()
                .map(|field| FieldStatisticsOut {
                    id: (&field.id).into(),
                    tokens: field.tokens,
                    frequencies: &field.frequencies,
                })
                .collect(),
        };
        serde_json::to_string(&output).map_err(|cause| JsValue::from_str(&cause.to_string()))
    }

    #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
    struct TermSummary {
        df: u32,
        bounds: Vec<super::TermBound>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        single: Option<TermDocument>,
    }

    impl From<&TermMeta> for TermSummary {
        fn from(meta: &TermMeta) -> Self {
            Self {
                df: meta.df,
                bounds: super::summary_bounds(&meta.blocks),
                single: None,
            }
        }
    }

    #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TermDocument {
        row: u32,
        id: DocumentId,
        data: Range,
    }

    impl TermDocument {
        fn is_bounded(&self, count: u32) -> bool {
            self.row < count
                && self.id.is_valid()
                && self.data.length >= 8
                && self
                    .data
                    .offset
                    .checked_add(self.data.length)
                    .is_some_and(|end| end as usize <= MAX_BYTES)
        }
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CommonLeader {
        field: String,
        terms: Vec<String>,
        length: u32,
        longer: bool,
        documents: Vec<TermDocument>,
    }

    impl CommonLeader {
        fn hits<'a>(
            &'a self,
            query: &super::PreparedQuery,
            dictionary: &BTreeMap<String, TermSummary>,
            count: u32,
            excluded: &BTreeSet<u32>,
        ) -> Option<Vec<Ranked<'a>>> {
            let normalization = query.terms.scorers.first()?;
            let title = self.field == "title";
            let counts = if title { (1, 0) } else { (0, 1) };
            if !query.terms.order.iter().all(|index| {
                self.terms.contains(&query.terms.words[*index])
                    && dictionary
                        .get(&query.terms.words[*index])
                        .is_some_and(|metadata| {
                            metadata.df == count
                                && metadata.bounds.len() == 1
                                && metadata.bounds.first().is_some_and(|&(a, b, x, y)| {
                                    (a, b) == counts && if title { x } else { y } == self.length
                                })
                        })
            }) {
                return None;
            }
            let score_at = |length| {
                let lengths = if title { (length, 0) } else { (0, length) };
                let denominators = normalization.denominators(lengths.0, lengths.1);
                query
                    .terms
                    .scorers
                    .iter()
                    .map(|scorer| scorer.score_normalized(counts.0, counts.1, denominators))
                    .sum::<f64>()
            };
            let score = score_at(self.length);
            if !score.is_finite() || score <= 0.0 {
                return None;
            }
            if self.longer {
                let next = self.length.checked_add(1)?;
                if score_at(next) >= score {
                    return None;
                }
            }
            let required = query
                .top_k
                .min(usize::try_from(count).ok()? - excluded.len());
            let ranked: Vec<_> = self
                .documents
                .iter()
                .filter(|document| !excluded.contains(&document.row))
                .take(required)
                .map(|document| Ranked {
                    row: document.row,
                    id: document.id.borrowed(),
                    score,
                    data: document.data.clone(),
                })
                .collect();
            if ranked.len() != required {
                return None;
            }
            Some(ranked)
        }
    }

    fn common_leaders(header: &Header) -> Result<String, String> {
        let count = u32::try_from(header.documents.len()).map_err(|cause| cause.to_string())?;
        let mut leaders = Vec::new();
        for field in ["title", "body"] {
            let title = field == "title";
            let terms: Vec<_> = header
                .terms()
                .iter()
                .filter(|(term, metadata)| count > 1 && metadata.df == count && term.len() <= 64)
                .take(16)
                .filter(|(_, metadata)| {
                    metadata
                        .blocks
                        .iter()
                        .all(|block| block.max_tf == if title { [1, 0] } else { [0, 1] })
                })
                .map(|(term, _)| term.to_owned())
                .collect();
            if terms.is_empty() {
                continue;
            }
            let length = |document: &DocumentMeta<DocumentIdRef<'_>, &DocumentAttributes>| {
                if title {
                    document.title_length
                } else {
                    document.body_length
                }
            };
            let Some(minimum) = header
                .documents
                .iter()
                .map(|document| length(&document))
                .min()
            else {
                continue;
            };
            let mut documents = Vec::new();
            let mut bytes = 0;
            for (row, document) in header.documents.iter().enumerate() {
                if length(&document) != minimum {
                    continue;
                }
                let charge = document.id.encoded_len() * 6 + 128;
                if documents.len() == 16 || bytes + charge > 4096 {
                    break;
                }
                bytes += charge;
                documents.push(TermDocument {
                    row: u32::try_from(row).map_err(|cause| cause.to_string())?,
                    id: document.id.to_owned(),
                    data: document.data.clone(),
                });
            }
            leaders.push(CommonLeader {
                field: field.to_owned(),
                terms,
                length: minimum,
                longer: header
                    .documents
                    .iter()
                    .any(|document| length(&document) > minimum),
                documents,
            });
        }
        serde_json::to_string(&leaders).map_err(|cause| cause.to_string())
    }

    fn constant_number(number: &serde_json::Number) -> bool {
        number
            .as_i64()
            .is_some_and(|value| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value))
    }

    fn constant_attributes(header: &Header) -> Result<String, String> {
        let first = header.documents.first().ok_or("Segment has no documents")?;
        let attributes: BTreeMap<String, &serde_json::value::RawValue> =
            serde_json::from_str(first.attributes.get()).map_err(|cause| cause.to_string())?;
        let mut selected = BTreeMap::new();
        for (name, value) in attributes {
            if value.get().len() > 512 || value.get().starts_with(['[', '{']) {
                continue;
            }
            if !value.get().starts_with(['"', 't', 'f', 'n']) {
                let number =
                    serde_json::from_str(value.get()).map_err(|cause| cause.to_string())?;
                if !constant_number(&number) {
                    continue;
                }
            }
            selected.insert(name.clone(), value);
            if serde_json::to_vec(&selected)
                .map_err(|cause| cause.to_string())?
                .len()
                > 512
            {
                selected.remove(&name);
            }
        }
        for document in header.documents.iter().skip(1) {
            if selected.is_empty() {
                break;
            }
            let attributes: BTreeMap<String, &serde_json::value::RawValue> =
                serde_json::from_str(document.attributes.get())
                    .map_err(|cause| cause.to_string())?;
            selected.retain(|name, value| {
                attributes
                    .get(name)
                    .is_some_and(|candidate| candidate.get() == value.get())
            });
        }
        serde_json::to_string(&selected).map_err(|cause| cause.to_string())
    }

    fn uniform_filters(filters: &[Filter], attributes: Option<String>) -> Result<bool, String> {
        if filters.is_empty() {
            return Ok(true);
        }
        let Some(attributes) = attributes
            .map(|encoded| {
                if encoded.len() > 512 {
                    return Err("Constant attributes exceed 512 bytes".to_owned());
                }
                serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&encoded)
                    .map_err(|cause| cause.to_string())
            })
            .transpose()?
        else {
            return Ok(false);
        };
        if attributes.values().any(|value| {
            value.is_array()
                || value.is_object()
                || value
                    .as_number()
                    .is_some_and(|number| !constant_number(number))
        }) {
            return Err("Constant attributes must round-trip losslessly".to_owned());
        }
        if filters
            .iter()
            .any(|filter| !attributes.contains_key(&filter.field))
        {
            return Ok(false);
        }
        matches(&attributes, filters)
    }

    fn common_terms(header: &Header) -> Result<String, String> {
        let dictionary: BTreeMap<_, _> = super::common_term_names(
            header
                .terms()
                .iter()
                .map(|(term, metadata)| (term, metadata.df as usize)),
        )
        .into_iter()
        .map(|term| {
            let metadata = header
                .terms()
                .get(term)
                .ok_or("Common term metadata disappeared")?;
            let first = metadata
                .blocks
                .first()
                .ok_or("Common term has no posting blocks")?;
            let bounds = metadata.blocks.iter().skip(1).fold(
                (
                    first.max_tf[0],
                    first.max_tf[1],
                    first.min_length[0],
                    first.min_length[1],
                ),
                |(title, body, title_length, body_length), block| {
                    (
                        title.max(block.max_tf[0]),
                        body.max(block.max_tf[1]),
                        title_length.min(block.min_length[0]),
                        body_length.min(block.min_length[1]),
                    )
                },
            );
            Ok::<_, String>((
                term,
                TermSummary {
                    df: metadata.df,
                    bounds: vec![bounds],
                    single: None,
                },
            ))
        })
        .collect::<Result<_, _>>()?;
        serde_json::to_string(&dictionary).map_err(|cause| cause.to_string())
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct EligibilityProjection {
        fields: Vec<String>,
        data: EligibilityData,
    }

    #[derive(Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum EligibilityData {
        Joint {
            groups: Vec<(Vec<Vec<String>>, u32, u32)>,
        },
        Marginal {
            columns: Vec<Vec<(Option<String>, u32, u32)>>,
        },
    }

    struct EligibilityKey<'a>(&'a [Option<&'a serde_json::Value>]);

    impl Serialize for EligibilityKey<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            use serde::ser::SerializeSeq as _;

            let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
            for value in self.0 {
                sequence.serialize_element(&EligibilityValues(*value))?;
            }
            sequence.end()
        }
    }

    struct EligibilityValues<'a>(Option<&'a serde_json::Value>);

    impl Serialize for EligibilityValues<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            use serde::ser::{Error as _, SerializeSeq as _};

            let mut sequence = serializer.serialize_seq(Some(usize::from(self.0.is_some())))?;
            if let Some(value) = self.0 {
                let value = serde_json::to_string(value).map_err(S::Error::custom)?;
                sequence.serialize_element(&value)?;
            }
            sequence.end()
        }
    }

    struct EligibilityProjectionBuilder {
        fields: Vec<String>,
        groups: Option<BTreeMap<String, (u32, u32)>>,
        columns: Option<Vec<BTreeMap<String, (u32, u32)>>>,
        scalar: Vec<u8>,
        bytes: usize,
    }

    impl EligibilityProjectionBuilder {
        fn new(fields: Vec<String>) -> Result<Self, String> {
            if fields.len() > 64 {
                return Err("Eligibility exceeds sixty-four fields".into());
            }
            let bytes = serde_json::to_vec(&fields)
                .map_err(|cause| cause.to_string())?
                .len()
                + 40;
            let groups = if fields.is_empty() {
                None
            } else {
                Some(BTreeMap::new())
            };
            Ok(Self {
                fields,
                groups,
                columns: None,
                scalar: Vec::new(),
                bytes,
            })
        }

        fn push_columns(&mut self, values: &[Vec<String>], title: u32, body: u32) {
            let Some(columns) = &mut self.columns else {
                return;
            };
            for (column, values) in columns.iter_mut().zip(values) {
                let key = values.first().map_or("", String::as_str);
                if let Some((a, b)) = column.get_mut(key) {
                    *a = (*a).min(title);
                    *b = (*b).min(body);
                } else {
                    self.bytes += key.len() + 32;
                    if self.bytes > 4096 {
                        self.columns = None;
                        return;
                    }
                    column.insert(key.to_owned(), (title, body));
                }
            }
            if columns.iter().map(BTreeMap::len).sum::<usize>() > 256 {
                self.columns = None;
            }
        }

        fn push<'a>(
            &mut self,
            attributes: impl Fn(&str) -> Option<&'a serde_json::Value>,
            title: u32,
            body: u32,
        ) -> Result<(), String> {
            if self.groups.is_none() && self.columns.is_none() {
                return Ok(());
            }
            let mut values = [None; 64];
            for (value, field) in values.iter_mut().zip(&self.fields) {
                *value = attributes(field);
            }
            self.push_values(&values[..self.fields.len()], title, body)
        }

        fn push_values(
            &mut self,
            attributes: &[Option<&serde_json::Value>],
            title: u32,
            body: u32,
        ) -> Result<(), String> {
            if attributes
                .iter()
                .flatten()
                .any(|value| value.is_array() || value.is_object())
                || attributes
                    .iter()
                    .copied()
                    .flatten()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::len)
                    .sum::<usize>()
                    > 4096
            {
                self.groups = None;
                self.columns = None;
                return Ok(());
            }
            if self.groups.is_none() {
                let Some(columns) = &mut self.columns else {
                    return Ok(());
                };
                for (value, column) in attributes.iter().zip(columns.iter_mut()) {
                    self.scalar.clear();
                    if let Some(value) = value {
                        serde_json::to_writer(&mut self.scalar, value)
                            .map_err(|cause| cause.to_string())?;
                    }
                    let key =
                        std::str::from_utf8(&self.scalar).map_err(|cause| cause.to_string())?;
                    if let Some((a, b)) = column.get_mut(key) {
                        *a = (*a).min(title);
                        *b = (*b).min(body);
                    } else {
                        self.bytes += key.len() + 32;
                        if self.bytes > 4096 {
                            self.columns = None;
                            return Ok(());
                        }
                        column.insert(key.to_owned(), (title, body));
                    }
                }
                if columns.iter().map(BTreeMap::len).sum::<usize>() > 256 {
                    self.columns = None;
                }
                return Ok(());
            }
            self.scalar.clear();
            serde_json::to_writer(&mut self.scalar, &EligibilityKey(attributes))
                .map_err(|cause| cause.to_string())?;
            let key = std::str::from_utf8(&self.scalar).map_err(|cause| cause.to_string())?;
            let Some(groups) = &mut self.groups else {
                return Ok(());
            };
            if let Some((minimum_title, minimum_body)) = groups.get_mut(key) {
                *minimum_title = (*minimum_title).min(title);
                *minimum_body = (*minimum_body).min(body);
            } else {
                self.bytes += key.len() + 32;
                if groups.len() >= 256 || self.bytes > 4096 {
                    let values: Vec<Vec<String>> =
                        serde_json::from_str(key).map_err(|cause| cause.to_string())?;
                    let previous = self.groups.take().unwrap_or_default();
                    self.columns = Some(self.fields.iter().map(|_| BTreeMap::new()).collect());
                    self.bytes = serde_json::to_vec(&self.fields)
                        .map_err(|cause| cause.to_string())?
                        .len()
                        + 64;
                    for (key, (a, b)) in previous {
                        let values: Vec<Vec<String>> =
                            serde_json::from_str(&key).map_err(|cause| cause.to_string())?;
                        self.push_columns(&values, a, b);
                    }
                    self.push_columns(&values, title, body);
                    return Ok(());
                }
                groups.insert(key.to_owned(), (title, body));
            }
            Ok(())
        }

        fn finish(self) -> Result<Option<EligibilityProjection>, String> {
            let Some(groups) = self.groups else {
                return Ok(self.columns.map(|columns| EligibilityProjection {
                    fields: self.fields,
                    data: EligibilityData::Marginal {
                        columns: columns
                            .into_iter()
                            .map(|column| {
                                column
                                    .into_iter()
                                    .map(|(key, (title, body))| {
                                        let value = if key.is_empty() { None } else { Some(key) };
                                        (value, title, body)
                                    })
                                    .collect()
                            })
                            .collect(),
                    },
                }));
            };
            let groups = groups
                .into_iter()
                .map(|(values, (title, body))| {
                    serde_json::from_str(&values)
                        .map(|values| (values, title, body))
                        .map_err(|cause| cause.to_string())
                })
                .collect::<Result<_, _>>()?;
            Ok(Some(EligibilityProjection {
                fields: self.fields,
                data: EligibilityData::Joint { groups },
            }))
        }
    }

    #[wasm_bindgen]
    pub struct EligibilityQuery {
        filters: Vec<Filter>,
        fields: Vec<String>,
        field_indices: Vec<usize>,
    }

    impl EligibilityQuery {
        fn projection_indices<'a>(
            &'a self,
            fields: &[String],
        ) -> Result<std::borrow::Cow<'a, [usize]>, String> {
            if fields == self.fields {
                return Ok(std::borrow::Cow::Borrowed(&self.field_indices));
            }
            if fields.len() > 64 || fields.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err("Eligibility projection scope mismatch".to_owned());
            }
            self.filters
                .iter()
                .map(|filter| {
                    fields.binary_search(&filter.field).map_err(|index| {
                        format!("Eligibility projection omitted filter field at {index}")
                    })
                })
                .collect::<Result<Vec<_>, _>>()
                .map(std::borrow::Cow::Owned)
        }

        fn marginal_minimum(
            &self,
            columns: Vec<Vec<(Option<String>, u32, u32)>>,
            field_count: usize,
            field_indices: &[usize],
        ) -> Result<Option<(u32, u32)>, String> {
            if columns.is_empty()
                || columns.len() != field_count
                || columns.iter().any(Vec::is_empty)
                || columns.iter().map(Vec::len).sum::<usize>() > 256
            {
                return Err("Eligibility projection omitted a field".to_owned());
            }
            let mut lower = Some((0_u32, 0_u32));
            for (index, column) in columns.into_iter().enumerate() {
                let mut minimum = None;
                for (value, title, body) in column {
                    let value = value
                        .map(|encoded| serde_json::from_str::<serde_json::Value>(&encoded))
                        .transpose()
                        .map_err(|cause| cause.to_string())?;
                    if value
                        .as_ref()
                        .is_some_and(|value| value.is_array() || value.is_object())
                    {
                        return Err("Eligibility value must be scalar".to_owned());
                    }
                    let mut matched = true;
                    for (filter, field) in self.filters.iter().zip(field_indices) {
                        if *field == index && !filter.matches(value.as_ref())? {
                            matched = false;
                            break;
                        }
                    }
                    if matched {
                        minimum = Some(match minimum {
                            Some((a, b)) => (title.min(a), body.min(b)),
                            None => (title, body),
                        });
                    }
                }
                if field_indices.contains(&index) {
                    lower = lower
                        .zip(minimum)
                        .map(|((a, b), (c, d))| (a.max(c), b.max(d)));
                }
            }
            Ok(lower)
        }
    }

    #[wasm_bindgen]
    impl EligibilityQuery {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects invalid filters or more than sixteen predicates."]
        pub fn new(filters: &str) -> Result<Self, JsValue> {
            let filters: Vec<Filter> = serde_json::from_str(filters)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            if filters.len() > 16 {
                return Err(JsValue::from_str("Eligibility exceeds sixteen filters"));
            }
            let fields = filters
                .iter()
                .map(|filter| filter.field.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let field_indices = filters
                .iter()
                .map(|filter| {
                    fields.binary_search(&filter.field).map_err(|index| {
                        JsValue::from_str(&format!("Eligibility omitted filter field at {index}"))
                    })
                })
                .collect::<Result<_, _>>()?;
            Ok(Self {
                filters,
                fields,
                field_indices,
            })
        }

        #[doc = "# Errors\nRejects invalid attributes or filter operators."]
        pub fn matches(&self, attributes: &str) -> Result<bool, JsValue> {
            let attributes: BTreeMap<String, serde_json::Value> = serde_json::from_str(attributes)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            matches(&attributes, &self.filters).map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects oversized, malformed or differently scoped eligibility projections."]
        pub fn minimum(&self, projection: &str) -> Result<String, JsValue> {
            if projection.len() > 4096 {
                return Err(JsValue::from_str("Eligibility projection exceeds four KiB"));
            }
            let projection: EligibilityProjection = serde_json::from_str(projection)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let field_indices = self
                .projection_indices(&projection.fields)
                .map_err(|cause| JsValue::from_str(&cause))?;
            let field_count = projection.fields.len();
            let groups = match projection.data {
                EligibilityData::Joint { groups } => groups,
                EligibilityData::Marginal { columns } => {
                    let minimum = self
                        .marginal_minimum(columns, field_count, &field_indices)
                        .map_err(|cause| JsValue::from_str(&cause))?;
                    return serde_json::to_string(&minimum)
                        .map_err(|cause| JsValue::from_str(&cause.to_string()));
                }
            };
            if groups.is_empty() || groups.len() > 256 {
                return Err(JsValue::from_str("Eligibility projection scope mismatch"));
            }
            let mut minimum = None;
            for (values, title, body) in groups {
                if values.len() != field_count || values.iter().any(|value| value.len() > 1) {
                    return Err(JsValue::from_str("Eligibility projection omitted a field"));
                }
                let attributes = values
                    .into_iter()
                    .map(|values| {
                        values
                            .into_iter()
                            .next()
                            .map(|value| {
                                let value: serde_json::Value = serde_json::from_str(&value)
                                    .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
                                if value.is_array() || value.is_object() {
                                    return Err(JsValue::from_str(
                                        "Eligibility value must be scalar",
                                    ));
                                }
                                Ok(value)
                            })
                            .transpose()
                    })
                    .collect::<Result<Vec<_>, JsValue>>()?;
                let mut matched = true;
                for (filter, index) in self.filters.iter().zip(field_indices.iter()) {
                    if !filter
                        .matches(attributes[*index].as_ref())
                        .map_err(|cause| JsValue::from_str(&cause))?
                    {
                        matched = false;
                        break;
                    }
                }
                if matched {
                    minimum = Some(match minimum {
                        Some((a, b)) => (title.min(a), body.min(b)),
                        None => (title, body),
                    });
                }
            }
            if self.filters.is_empty() {
                minimum = Some((0, 0));
            }
            serde_json::to_string(&minimum).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Overview {
        dictionary: BTreeMap<String, TermSummary>,
        minimum: Option<(u32, u32)>,
        eligibility: Option<EligibilityProjection>,
        partitions: Option<Vec<BTreeMap<String, TermSummary>>>,
    }

    const SUMMARY_POOL_BYTES: usize = 1024 * 1024;

    #[derive(Default)]
    struct SummaryPool {
        entries: BTreeMap<TermSummary, u32>,
        bytes: usize,
    }

    impl SummaryPool {
        fn intern(&mut self, summary: &TermSummary) -> Option<u32> {
            if let Some(index) = self.entries.get(summary) {
                return Some(*index);
            }
            let charge = size_of::<TermSummary>()
                + summary.bounds.capacity() * size_of::<super::TermBound>()
                + summary
                    .single
                    .as_ref()
                    .map_or(0, |document| document.id.heap_bytes())
                + 192;
            if charge > SUMMARY_POOL_BYTES.saturating_sub(self.bytes) {
                return None;
            }
            let index = u32::try_from(self.entries.len()).ok()?;
            self.entries.insert(summary.clone(), index);
            self.bytes += charge;
            Some(index)
        }
    }

    struct OverviewDictionary<'a> {
        terms: &'a TermDictionary,
        pool: &'a RefCell<SummaryPool>,
    }

    impl Serialize for OverviewDictionary<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeMap;
            let mut map = serializer.serialize_map(Some(self.terms.len()))?;
            for (term, metadata) in self.terms {
                let summary = TermSummary::from(metadata);
                match self.pool.borrow_mut().intern(&summary) {
                    Some(index) => map.serialize_entry(term, &index)?,
                    None => map.serialize_entry(term, &summary)?,
                }
            }
            map.end()
        }
    }

    struct OverviewPartitions<'a> {
        partitions: &'a [BTreeMap<&'a str, TermSummary>],
        pool: &'a RefCell<SummaryPool>,
    }

    struct OverviewPartition<'a> {
        terms: &'a BTreeMap<&'a str, TermSummary>,
        pool: &'a RefCell<SummaryPool>,
    }

    impl Serialize for OverviewPartitions<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_seq(self.partitions.iter().map(|terms| OverviewPartition {
                terms,
                pool: self.pool,
            }))
        }
    }

    impl Serialize for OverviewPartition<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeMap;
            let mut map = serializer.serialize_map(Some(self.terms.len()))?;
            for (term, summary) in self.terms {
                match self.pool.borrow_mut().intern(summary) {
                    Some(index) => map.serialize_entry(term, &index)?,
                    None => map.serialize_entry(term, summary)?,
                }
            }
            map.end()
        }
    }

    struct SingletonDictionary<'a>(&'a BTreeMap<&'a str, TermDocument>);

    impl Serialize for SingletonDictionary<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeMap;
            let mut map = serializer.serialize_map(Some(self.0.len()))?;
            for (term, document) in self.0 {
                map.serialize_entry(
                    term,
                    &(
                        document.row,
                        &document.id,
                        document.data.offset,
                        document.data.length,
                    ),
                )?;
            }
            map.end()
        }
    }

    struct DirectoryOverview<'a> {
        header: &'a Header,
        singletons: &'a BTreeMap<&'a str, TermDocument>,
        eligibility: OverviewEligibility<'a>,
        partitions: Option<&'a [BTreeMap<&'a str, TermSummary>]>,
    }

    impl Serialize for DirectoryOverview<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeTuple;
            let pool = RefCell::new(SummaryPool::default());
            let mut tuple = serializer.serialize_tuple(5)?;
            tuple.serialize_element(&OverviewDictionary {
                terms: self.header.terms(),
                pool: &pool,
            })?;
            tuple.serialize_element(&self.eligibility)?;
            tuple.serialize_element(&self.partitions.map(|partitions| OverviewPartitions {
                partitions,
                pool: &pool,
            }))?;
            let pool = pool.into_inner();
            let mut summaries: Vec<_> = pool
                .entries
                .into_iter()
                .map(|(summary, index)| (index, summary))
                .collect();
            summaries.sort_unstable_by_key(|(index, _)| *index);
            tuple.serialize_element(
                &summaries
                    .into_iter()
                    .map(|(_, summary)| summary)
                    .collect::<Vec<_>>(),
            )?;
            tuple.serialize_element(&SingletonDictionary(self.singletons))?;
            tuple.end()
        }
    }

    struct EligibilityGroup {
        row: usize,
        title: u32,
        body: u32,
    }

    struct OverviewEligibility<'a> {
        header: &'a Header,
        groups: &'a [EligibilityGroup],
    }

    impl Serialize for OverviewEligibility<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_seq(self.groups.iter().map(|group| {
                (
                    self.header.documents.row(group.row).attributes.as_ref(),
                    group.title,
                    group.body,
                )
            }))
        }
    }

    struct SelectedTerms<'a> {
        requested: &'a BTreeSet<String>,
    }

    struct IndexedTerms {
        selected: BTreeMap<String, SummaryReference>,
        maximum: Option<u32>,
    }

    struct SelectedTerm<'a>(&'a BTreeSet<String>);

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedTerm<'_> {
        type Value = Option<String>;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_str(self)
        }
    }

    impl serde::de::Visitor<'_> for SelectedTerm<'_> {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a term dictionary key")
        }

        fn visit_str<E: serde::de::Error>(self, term: &str) -> Result<Self::Value, E> {
            Ok(self.0.get(term).cloned())
        }
    }

    struct DiscardedBounds;

    impl<'de> serde::de::Visitor<'de> for DiscardedBounds {
        type Value = ();

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an array of four unsigned integer bounds")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
            while sequence.next_element::<super::TermBound>()?.is_some() {}
            Ok(())
        }
    }

    fn discard_bounds<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(DiscardedBounds)
    }

    #[derive(Deserialize)]
    struct DiscardedSummary {
        #[serde(rename = "df")]
        _df: u32,
        #[serde(rename = "bounds", deserialize_with = "discard_bounds")]
        _bounds: (),
    }

    enum SummaryReference {
        Index(u32),
        Inline(TermSummary),
        Discarded,
    }

    struct SelectedSummary(bool);

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedSummary {
        type Value = SummaryReference;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_any(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedSummary {
        type Value = SummaryReference;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an unsigned summary index or an inline term summary")
        }

        fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
            Ok(SummaryReference::Index(
                u32::try_from(value).map_err(E::custom)?,
            ))
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
            let deserializer = serde::de::value::MapAccessDeserializer::new(map);
            if self.0 {
                return TermSummary::deserialize(deserializer).map(SummaryReference::Inline);
            }
            DiscardedSummary::deserialize(deserializer)?;
            Ok(SummaryReference::Discarded)
        }
    }

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedTerms<'_> {
        type Value = IndexedTerms;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_map(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedTerms<'_> {
        type Value = IndexedTerms;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a term dictionary of indices or inline summaries")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut selected = BTreeMap::new();
            let mut maximum = None;
            while let Some(term) = map.next_key_seed(SelectedTerm(self.requested))? {
                let summary = map.next_value_seed(SelectedSummary(term.is_some()))?;
                if let SummaryReference::Index(index) = summary {
                    maximum = Some(maximum.map_or(index, |previous: u32| previous.max(index)));
                }
                if let Some(term) = term {
                    selected.insert(term, summary);
                }
            }
            Ok(IndexedTerms { selected, maximum })
        }
    }

    struct SelectedGroup<'a>(&'a BTreeSet<&'a str>);

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedGroup<'_> {
        type Value = (BTreeMap<String, serde_json::Value>, u32, u32);

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            if self.0.len() > 8 {
                return Self::Value::deserialize(deserializer);
            }
            deserializer.deserialize_tuple(3, self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedGroup<'_> {
        type Value = (BTreeMap<String, serde_json::Value>, u32, u32);

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("attributes and two unsigned minimum lengths")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let attributes = sequence
                .next_element_seed(SelectedAttributes(self.0))?
                .ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
            let title = sequence
                .next_element::<u32>()?
                .ok_or_else(|| serde::de::Error::invalid_length(1, &self))?;
            let body = sequence
                .next_element::<u32>()?
                .ok_or_else(|| serde::de::Error::invalid_length(2, &self))?;
            if sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(serde::de::Error::invalid_length(4, &self));
            }
            Ok((attributes, title, body))
        }
    }

    struct EligibleSelection {
        minimum: Option<(u32, u32)>,
        projection: Option<EligibilityProjection>,
    }

    struct FilteredGroup<'a, 'b> {
        fields: &'a BTreeSet<&'a str>,
        values: &'b mut BTreeMap<&'a str, Option<serde_json::Value>>,
    }

    impl<'de> serde::de::DeserializeSeed<'de> for FilteredGroup<'_, '_> {
        type Value = (u32, u32);

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_tuple(3, self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for FilteredGroup<'_, '_> {
        type Value = (u32, u32);

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("attributes and two unsigned minimum lengths")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            for value in self.values.values_mut() {
                *value = None;
            }
            sequence
                .next_element_seed(super::FilterAttributes {
                    fields: self.fields,
                    values: &mut *self.values,
                })?
                .ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
            let title = sequence
                .next_element::<u32>()?
                .ok_or_else(|| serde::de::Error::invalid_length(1, &self))?;
            let body = sequence
                .next_element::<u32>()?
                .ok_or_else(|| serde::de::Error::invalid_length(2, &self))?;
            if sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(serde::de::Error::invalid_length(4, &self));
            }
            Ok((title, body))
        }
    }

    struct EligibleGroups<'a>(&'a [Filter]);

    impl<'de> serde::de::DeserializeSeed<'de> for EligibleGroups<'_> {
        type Value = EligibleSelection;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_seq(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for EligibleGroups<'_> {
        type Value = EligibleSelection;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("attribute groups with minimum document lengths")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            if self.0.is_empty() {
                let fields = BTreeSet::new();
                if sequence
                    .next_element_seed(SelectedGroup(&fields))?
                    .is_none()
                {
                    return Err(serde::de::Error::custom("Overview eligibility is empty"));
                }
                while sequence
                    .next_element_seed(SelectedGroup(&fields))?
                    .is_some()
                {}
                return Ok(EligibleSelection {
                    minimum: Some((0, 0)),
                    projection: None,
                });
            }
            let mut minimum = None;
            let fields: BTreeSet<_> = self.0.iter().map(|filter| filter.field.as_str()).collect();
            let reusable = fields.len() <= 8;
            let mut groups = EligibilityProjectionBuilder::new(
                fields.iter().map(|field| (*field).to_owned()).collect(),
            )
            .map_err(serde::de::Error::custom)?;
            let mut present = false;
            if reusable {
                let mut values = fields.iter().map(|field| (*field, None)).collect();
                while let Some((title, body)) = sequence.next_element_seed(FilteredGroup {
                    fields: &fields,
                    values: &mut values,
                })? {
                    present = true;
                    groups
                        .push(
                            |field| values.get(field).and_then(Option::as_ref),
                            title,
                            body,
                        )
                        .map_err(serde::de::Error::custom)?;
                    let mut matched = true;
                    for filter in self.0 {
                        let actual = values.get(filter.field.as_str()).and_then(Option::as_ref);
                        if !filter.matches(actual).map_err(serde::de::Error::custom)? {
                            matched = false;
                            break;
                        }
                    }
                    if matched {
                        minimum = Some(match minimum {
                            Some((a, b)) => (title.min(a), body.min(b)),
                            None => (title, body),
                        });
                    }
                }
            } else {
                while let Some((attributes, title, body)) =
                    sequence.next_element_seed(SelectedGroup(&fields))?
                {
                    present = true;
                    groups
                        .push(|field| attributes.get(field), title, body)
                        .map_err(serde::de::Error::custom)?;
                    if matches(&attributes, self.0).map_err(serde::de::Error::custom)? {
                        minimum = Some(match minimum {
                            Some((a, b)) => (title.min(a), body.min(b)),
                            None => (title, body),
                        });
                    }
                }
            }
            if !present {
                return Err(serde::de::Error::custom("Overview eligibility is empty"));
            }
            Ok(EligibleSelection {
                minimum,
                projection: groups.finish().map_err(serde::de::Error::custom)?,
            })
        }
    }

    struct SelectedPartitions<'a>(&'a BTreeSet<String>);

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedPartitions<'_> {
        type Value = Option<Vec<IndexedTerms>>;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_option(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedPartitions<'_> {
        type Value = Option<Vec<IndexedTerms>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("null or one to 32 term summary partitions")
        }

        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_seq(self)
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut selected = Vec::new();
            while let Some(group) =
                sequence.next_element_seed(SelectedTerms { requested: self.0 })?
            {
                if selected.len() == 32 {
                    return Err(serde::de::Error::custom("Invalid overview partitions"));
                }
                selected.push(group);
            }
            if selected.is_empty() {
                return Err(serde::de::Error::custom("Invalid overview partitions"));
            }
            Ok(Some(selected))
        }
    }

    struct SelectedOverview<'a> {
        requested: &'a BTreeSet<String>,
        filters: &'a [Filter],
    }

    struct SelectedSummaries<'a>(&'a BTreeSet<u32>);

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedSummaries<'_> {
        type Value = (BTreeMap<u32, TermSummary>, u32);

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_seq(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedSummaries<'_> {
        type Value = (BTreeMap<u32, TermSummary>, u32);

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a validated summary pool")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut selected = BTreeMap::new();
            let mut index = 0u32;
            loop {
                if self.0.contains(&index) {
                    let Some(summary) = sequence.next_element::<TermSummary>()? else {
                        break;
                    };
                    selected.insert(index, summary);
                } else if sequence.next_element::<DiscardedSummary>()?.is_none() {
                    break;
                }
                index = index
                    .checked_add(1)
                    .ok_or_else(|| serde::de::Error::custom("Summary count overflow"))?;
            }
            Ok((selected, index))
        }
    }

    struct SelectedSingletons<'a>(&'a BTreeSet<String>);

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedSingletons<'_> {
        type Value = BTreeMap<String, TermDocument>;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_map(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedSingletons<'_> {
        type Value = BTreeMap<String, TermDocument>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a singleton proof dictionary")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut selected = BTreeMap::new();
            while let Some(term) = map.next_key_seed(SelectedTerm(self.0))? {
                if let Some(term) = term {
                    let (row, id, offset, length) =
                        map.next_value::<(u32, DocumentId, u32, u32)>()?;
                    let document = TermDocument {
                        row,
                        id,
                        data: Range { offset, length },
                    };
                    if !document.is_bounded(10000) {
                        return Err(serde::de::Error::custom("Invalid singleton reference"));
                    }
                    if selected.insert(term, document).is_some() {
                        return Err(serde::de::Error::custom("Duplicate singleton proof"));
                    }
                } else {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
            Ok(selected)
        }
    }

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedOverview<'_> {
        type Value = Overview;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_tuple(5, self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedOverview<'_> {
        type Value = Overview;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str(
                "term indices, eligibility, partitions, summary pool and singleton proofs",
            )
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let dictionary = sequence
                .next_element_seed(SelectedTerms {
                    requested: self.requested,
                })?
                .ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
            let eligibility = sequence
                .next_element_seed(EligibleGroups(self.filters))?
                .ok_or_else(|| serde::de::Error::invalid_length(1, &self))?;
            let partitions = sequence
                .next_element_seed(SelectedPartitions(self.requested))?
                .ok_or_else(|| serde::de::Error::invalid_length(2, &self))?;
            let requested = dictionary
                .selected
                .values()
                .chain(
                    partitions
                        .iter()
                        .flatten()
                        .flat_map(|partition| partition.selected.values()),
                )
                .filter_map(|summary| match summary {
                    SummaryReference::Index(index) => Some(*index),
                    SummaryReference::Inline(_) | SummaryReference::Discarded => None,
                })
                .collect();
            let (summaries, count) = sequence
                .next_element_seed(SelectedSummaries(&requested))?
                .ok_or_else(|| serde::de::Error::invalid_length(3, &self))?;
            let singletons = sequence
                .next_element_seed(SelectedSingletons(self.requested))?
                .ok_or_else(|| serde::de::Error::invalid_length(4, &self))?;
            if sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(serde::de::Error::invalid_length(6, &self));
            }
            let maximum = dictionary
                .maximum
                .into_iter()
                .chain(
                    partitions
                        .iter()
                        .flatten()
                        .filter_map(|partition| partition.maximum),
                )
                .max();
            if maximum.is_some_and(|index| index >= count) {
                return Err(serde::de::Error::custom("Invalid summary index"));
            }
            let resolve =
                |indexed: IndexedTerms| -> Result<BTreeMap<String, TermSummary>, A::Error> {
                    indexed
                        .selected
                        .into_iter()
                        .map(|(term, summary)| {
                            let summary = match summary {
                                SummaryReference::Index(index) => summaries.get(&index).cloned(),
                                SummaryReference::Inline(summary) => Some(summary),
                                SummaryReference::Discarded => None,
                            };
                            summary
                                .map(|summary| (term, summary))
                                .ok_or_else(|| serde::de::Error::custom("Missing selected summary"))
                        })
                        .collect()
                };
            let mut dictionary = resolve(dictionary)?;
            for (term, document) in singletons {
                let summary = dictionary
                    .get_mut(&term)
                    .ok_or_else(|| serde::de::Error::custom("Missing singleton summary"))?;
                summary.single = Some(document);
            }
            Ok(Overview {
                dictionary,
                minimum: eligibility.minimum,
                eligibility: eligibility.projection,
                partitions: partitions
                    .map(|partitions| partitions.into_iter().map(resolve).collect())
                    .transpose()?,
            })
        }
    }

    fn term_bound(bounds: &[super::TermBound], scorer: &TermScorer, minimum: (u32, u32)) -> f64 {
        bounds
            .iter()
            .map(|&(title_tf, body_tf, title_length, body_length)| {
                scorer.score(
                    title_tf,
                    body_tf,
                    title_length.max(minimum.0),
                    body_length.max(minimum.1),
                )
            })
            .fold(0.0, f64::max)
    }

    #[derive(Deserialize)]
    struct TermCatalog {
        dictionary: BTreeMap<String, TermSummary>,
        minimum: Option<(u32, u32)>,
        partitions: Option<Vec<BTreeMap<String, TermSummary>>>,
    }

    #[derive(Deserialize)]
    struct CompactMinimumCatalog(super::CommonTermProjection, Vec<u32>, Option<(u32, u32)>);

    struct CompactActiveTerm<'a> {
        index: usize,
        df: u32,
        scorer: &'a TermScorer,
        independent_score: f64,
    }

    impl CompactMinimumCatalog {
        fn active_terms<'a>(
            &self,
            scorers: &'a BTreeMap<&str, TermScorer>,
        ) -> Result<Vec<CompactActiveTerm<'a>>, String> {
            let projection = &self.0;
            let dfs = &self.1;
            let term_count = projection.terms.len();
            if !(1..=16).contains(&term_count) || dfs.len() != term_count {
                return Err("Invalid compact term projection dimensions".to_owned());
            }
            let mut order: Vec<_> = (0..term_count).collect();
            order.sort_unstable_by(|left, right| {
                projection.terms[*left].cmp(&projection.terms[*right])
            });
            if order
                .windows(2)
                .any(|pair| projection.terms[pair[0]] == projection.terms[pair[1]])
                || projection
                    .terms
                    .iter()
                    .any(|term| term.encode_utf16().count() > 64)
            {
                return Err("Invalid compact term projection terms".to_owned());
            }
            for df in dfs {
                if *df > 10_000 {
                    return Err("Invalid compact term frequency".to_owned());
                }
            }
            if projection.independent.len() != term_count
                || projection.independent.iter().any(|summary| {
                    !(1..=128).contains(&summary.len())
                        || summary
                            .iter()
                            .any(|(title_tf, body_tf, _, _)| *title_tf == 0 && *body_tf == 0)
                })
                || !(1..=32).contains(&projection.partitions.len())
                || projection.partitions.iter().any(|partition| {
                    partition.len() != term_count
                        || partition.iter().any(|bound| {
                            bound.is_some_and(|(title_tf, body_tf, _, _)| {
                                title_tf == 0 && body_tf == 0
                            })
                        })
                })
                || (0..term_count).any(|index| {
                    !projection
                        .partitions
                        .iter()
                        .any(|partition| partition[index].is_some())
                })
            {
                return Err("Invalid compact term projection bounds".to_owned());
            }
            let mut active = Vec::new();
            for index in order {
                let df = dfs[index];
                if df == 0 {
                    continue;
                }
                let term = projection.terms[index].as_str();
                let scorer = scorers
                    .get(term)
                    .ok_or_else(|| "Missing compact term scorer".to_owned())?;
                let independent_score = term_bound(
                    &projection.independent[index],
                    scorer,
                    self.2.unwrap_or((0, 0)),
                );
                active.push(CompactActiveTerm {
                    index,
                    df,
                    scorer,
                    independent_score,
                });
            }
            if active.is_empty() {
                return Err("Invalid compact term projection bounds".to_owned());
            }
            Ok(active)
        }
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid statistics, catalogs or batches beyond 64 segments."]
    pub fn segment_term_bounds(statistics: &str, catalogs: &str) -> Result<Vec<f64>, JsValue> {
        let statistics: Statistics = serde_json::from_str(statistics)
            .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        let catalogs: Vec<TermCatalog> = serde_json::from_str(catalogs)
            .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        if catalogs.len() > 64 {
            return Err(JsValue::from_str("Term bound batch exceeds segment budget"));
        }
        let scorers: BTreeMap<_, _> = statistics
            .frequencies
            .iter()
            .map(|(term, df)| (term.as_str(), TermScorer::new(&statistics, *df)))
            .collect();
        Ok(catalogs
            .iter()
            .map(|catalog| {
                let Some(minimum) = catalog.minimum else {
                    return 0.0;
                };
                let upper = |term: &str, meta: &TermSummary| {
                    scorers
                        .get(term)
                        .map_or(0.0, |scorer| term_bound(&meta.bounds, scorer, minimum))
                };
                let independent = catalog
                    .dictionary
                    .iter()
                    .map(|(term, meta)| upper(term, meta))
                    .sum::<f64>();
                if let Some(partitions) = &catalog.partitions {
                    let correlated = partitions
                        .iter()
                        .map(|partition| {
                            catalog
                                .dictionary
                                .iter()
                                .map(|(term, meta)| {
                                    if meta.df == 1 {
                                        return upper(term, meta);
                                    }
                                    partition
                                        .get(term)
                                        .map_or(0.0, |summary| upper(term, summary))
                                })
                                .sum::<f64>()
                        })
                        .fold(0.0, f64::max);
                    return independent.min(correlated);
                }
                independent
            })
            .collect())
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid statistics, compact projections or batches beyond 64 segments."]
    pub fn segment_term_bounds_compact(
        statistics: &str,
        catalogs: &str,
    ) -> Result<Vec<f64>, JsValue> {
        let statistics: Statistics = serde_json::from_str(statistics)
            .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        let catalogs: Vec<(super::CommonTermProjection, Vec<u32>)> = serde_json::from_str(catalogs)
            .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        compact_term_bounds(
            &statistics,
            catalogs
                .into_iter()
                .map(|(projection, dfs)| CompactMinimumCatalog(projection, dfs, Some((0, 0)))),
        )
        .map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid statistics, compact projections, minima or batches beyond 64 segments."]
    pub fn segment_term_bounds_compact_minimum(
        statistics: &str,
        catalogs: &str,
    ) -> Result<Vec<f64>, JsValue> {
        let statistics: Statistics = serde_json::from_str(statistics)
            .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        let catalogs: Vec<CompactMinimumCatalog> = serde_json::from_str(catalogs)
            .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        compact_term_bounds(&statistics, catalogs.into_iter())
            .map_err(|cause| JsValue::from_str(&cause))
    }

    fn compact_term_bounds(
        statistics: &Statistics,
        catalogs: impl ExactSizeIterator<Item = CompactMinimumCatalog>,
    ) -> Result<Vec<f64>, String> {
        if catalogs.len() > 64 {
            return Err("Term bound batch exceeds segment budget".to_owned());
        }
        let scorers: BTreeMap<_, _> = statistics
            .frequencies
            .iter()
            .map(|(term, df)| (term.as_str(), TermScorer::new(statistics, *df)))
            .collect();
        let mut bounds = Vec::with_capacity(catalogs.len());
        for catalog in catalogs {
            let active = catalog.active_terms(&scorers)?;
            if catalog.2.is_none() {
                bounds.push(0.0);
                continue;
            }
            let minimum = catalog.2.unwrap_or((0, 0));
            let independent = active
                .iter()
                .map(|term| term.independent_score)
                .sum::<f64>();
            let correlated = catalog
                .0
                .partitions
                .iter()
                .map(|partition| {
                    let mut score = 0.0;
                    for term in &active {
                        if term.df == 1 {
                            score += term.independent_score;
                        } else if let Some(bound) = partition[term.index] {
                            score += term_bound(std::slice::from_ref(&bound), term.scorer, minimum);
                        }
                    }
                    score
                })
                .fold(0.0, f64::max);
            bounds.push(independent.min(correlated));
        }
        Ok(bounds)
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid canonical headers or size limits."]
    pub fn directory_compress(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        super::compress_directory(bytes).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid canonical headers or common-directory size limits."]
    pub fn common_directory_compress(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        super::compress_common_directory(bytes).map_err(|cause| JsValue::from_str(&cause))
    }

    fn overview_eligibility(header: &Header) -> Box<[EligibilityGroup]> {
        let mut eligibility = BTreeMap::new();
        for (row, document) in header.documents.iter().enumerate() {
            let lengths = eligibility
                .entry(document.attributes.get())
                .or_insert_with(|| (row, document.title_length, document.body_length));
            lengths.1 = lengths.1.min(document.title_length);
            lengths.2 = lengths.2.min(document.body_length);
        }
        eligibility
            .into_values()
            .map(|(row, title, body)| EligibilityGroup { row, title, body })
            .collect()
    }

    fn encode_overview(
        header: &Header,
        partitions: Option<&[BTreeMap<&str, TermSummary>]>,
        groups: &[EligibilityGroup],
        singletons: &BTreeMap<&str, TermDocument>,
    ) -> Result<Vec<u8>, String> {
        let json = serde_json::to_vec(&DirectoryOverview {
            header,
            singletons,
            eligibility: OverviewEligibility { header, groups },
            partitions,
        })
        .map_err(|cause| cause.to_string())?;
        if json.len() > MAX_BYTES {
            return Err("Overview exceeds decoded size budget".into());
        }
        let mut bytes = Vec::new();
        append(&mut bytes, &json)?;
        Ok(bytes)
    }

    fn singleton_document(
        bytes: &[u8],
        base: usize,
        header: &Header,
        term: &str,
        metadata: &TermMeta,
        remaining: &mut usize,
    ) -> Result<Option<TermDocument>, String> {
        let [block] = metadata.blocks.as_ref() else {
            return Ok(None);
        };
        if block.count != 1 || block.first != block.last {
            return Ok(None);
        }
        let document = header.documents.row(block.first as usize);
        let charge = term.len() + document.id.encoded_len() + size_of::<TermDocument>() + 256;
        if charge > *remaining {
            return Ok(None);
        }
        let start = base
            .checked_add(block.data.offset as usize)
            .ok_or("Invalid singleton posting range")?;
        let end = start
            .checked_add(block.data.length as usize)
            .ok_or("Invalid singleton posting range")?;
        let page = bytes
            .get(start..end)
            .ok_or("Invalid singleton posting range")?;
        let rows = super::decode_posting_rows::<false, _>(page, |row, title, body| {
            super::DecodedFrequencyPosting {
                posting: super::FrequencyPosting {
                    row,
                    title: title.count,
                    body: body.count,
                },
                title_last: title.last,
                body_last: body.last,
            }
        })?;
        let [row] = rows.as_slice() else {
            return Ok(None);
        };
        super::validate_posting(header, row.posting.row, row.title_last, row.body_last, None)?;
        if row.posting.row != block.first
            || (row.posting.title, row.posting.body) != <(u32, u32)>::from(block.max_tf)
            || (document.title_length, document.body_length) != <(u32, u32)>::from(block.min_length)
        {
            return Ok(None);
        }
        *remaining -= charge;
        Ok(Some(TermDocument {
            row: block.first,
            id: document.id.to_owned(),
            data: document.data,
        }))
    }

    fn correlated_overview(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let (header, base) = parse_header(bytes)?;
        if header.documents.is_empty() {
            return Ok(None);
        }
        let lengths: BTreeSet<_> = header
            .documents
            .iter()
            .map(|document| (document.title_length, document.body_length))
            .collect();
        let groups: BTreeMap<_, _> = lengths
            .iter()
            .enumerate()
            .map(|(index, pair)| (*pair, index * lengths.len().min(32) / lengths.len()))
            .collect();
        let mut partitions: Vec<BTreeMap<&str, TermSummary>> = (0..lengths.len().min(32))
            .map(|_| BTreeMap::new())
            .collect();
        let mut entries = 0;
        let mut singletons = BTreeMap::new();
        let mut singleton_budget = 4 * 1024 * 1024;
        let entry_budget = (header.terms().len() / 4).clamp(512, 65536);
        for (term, metadata) in header.terms() {
            if metadata.df == 1 {
                if let Some(document) =
                    singleton_document(bytes, base, &header, term, metadata, &mut singleton_budget)?
                {
                    singletons.insert(term, document);
                }
                continue;
            }
            let mut previous = None;
            for block in &metadata.blocks {
                let start = base
                    .checked_add(block.data.offset as usize)
                    .ok_or("Invalid posting range")?;
                let end = start
                    .checked_add(block.data.length as usize)
                    .ok_or("Invalid posting range")?;
                let page = bytes.get(start..end).ok_or("Invalid posting range")?;
                let rows = super::decode_posting_rows::<false, _>(page, |row, title, body| {
                    super::DecodedFrequencyPosting {
                        posting: super::FrequencyPosting {
                            row,
                            title: title.count,
                            body: body.count,
                        },
                        title_last: title.last,
                        body_last: body.last,
                    }
                })?;
                for row in rows {
                    super::validate_posting(
                        &header,
                        row.posting.row,
                        row.title_last,
                        row.body_last,
                        previous,
                    )?;
                    previous = Some(row.posting.row);
                    let document = header.documents.row(row.posting.row as usize);
                    let group = groups[&(document.title_length, document.body_length)];
                    let partition = &mut partitions[group];
                    if !partition.contains_key(term) {
                        entries += 1;
                        if entries > entry_budget {
                            return Ok(None);
                        }
                    }
                    let summary = partition.entry(term).or_insert_with(|| TermSummary {
                        df: 0,
                        bounds: vec![(0, 0, document.title_length, document.body_length)],
                        single: None,
                    });
                    summary.df += 1;
                    let bound = &mut summary.bounds[0];
                    bound.0 = bound.0.max(row.posting.title);
                    bound.1 = bound.1.max(row.posting.body);
                    bound.2 = bound.2.min(document.title_length);
                    bound.3 = bound.3.min(document.body_length);
                }
            }
        }
        let encoded = encode_overview(
            &header,
            Some(&partitions),
            &overview_eligibility(&header),
            &singletons,
        )?;
        if encoded.len() > 1024 * 1024 {
            return Ok(None);
        }
        Ok(Some(encoded))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid canonical headers or malformed consumed posting pages."]
    pub fn segment_correlated_overview(bytes: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
        correlated_overview(bytes).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    pub struct Segment {
        built: BuiltSegment,
    }

    #[wasm_bindgen]
    impl Segment {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects invalid input serialization or segment framing, size, and integrity constraints."]
        pub fn new(json: &str, filterable: Option<String>) -> Result<Self, JsValue> {
            let documents = serde_json::from_str::<Vec<CanonicalDocumentDto>>(json)
                .map_err(|e| JsValue::from_str(&e.to_string()))?
                .into_iter()
                .map(Document::from_canonical_dto)
                .collect();
            let filterable = filterable
                .map(|json| serde_json::from_str::<Vec<String>>(&json))
                .transpose()
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            Ok(Self {
                built: build(documents, filterable.as_deref())
                    .map_err(|cause| JsValue::from_str(&cause))?,
            })
        }
        #[must_use]
        pub fn bytes(&self) -> Vec<u8> {
            self.built.bytes.clone()
        }
        pub fn common_projection(&self) -> Option<String> {
            self.built.common_projection.clone()
        }
        #[doc = "# Errors\nRejects malformed field lists, more than sixty-four fields, invalid attributes or model serialization."]
        pub fn eligibility(&self, fields: &str) -> Result<Option<String>, JsValue> {
            let fields = eligibility_fields(fields).map_err(|cause| JsValue::from_str(&cause))?;
            encoded_eligibility(&self.built.header, None, &fields)
                .map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects common-term metadata or serialization failures."]
        pub fn common_terms(&self) -> Result<String, JsValue> {
            common_terms(&self.built.header).map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects common-leader serialization errors."]
        pub fn common_leaders(&self) -> Result<String, JsValue> {
            common_leaders(&self.built.header).map_err(|cause| JsValue::from_str(&cause))
        }
        #[doc = "# Errors\nRejects invalid document metadata or serialization."]
        pub fn constant_attributes(&self) -> Result<String, JsValue> {
            constant_attributes(&self.built.header).map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects directory serialization errors."]
        pub fn header_json(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.built.header)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
    }

    struct CachedDirectoryFrame {
        bytes: Box<[u8]>,
        expected: usize,
        partial: bool,
        validated: std::cell::Cell<bool>,
    }

    impl CachedDirectoryFrame {
        fn new(bytes: Vec<u8>, expected: usize, partial: bool) -> Result<Self, String> {
            let maximum = MAX_BYTES
                + (if partial {
                    super::MAX_COMMON_FRAME_BYTES
                } else {
                    0
                })
                + 8192;
            if bytes.len() < 20
                || bytes.len() > maximum
                || super::directory_frame_magic(&bytes, partial).is_err()
                || !(16..=MAX_BYTES).contains(&expected)
            {
                return Err("Invalid compressed directory frame".into());
            }
            Ok(Self {
                bytes: bytes.into_boxed_slice(),
                expected,
                partial,
                validated: std::cell::Cell::new(false),
            })
        }
    }

    #[wasm_bindgen]
    pub struct CompressedDirectory {
        frame: Rc<CachedDirectoryFrame>,
    }

    #[wasm_bindgen]
    impl CompressedDirectory {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects invalid frame envelopes and expected header sizes."]
        pub fn new(bytes: Vec<u8>, expected: u32) -> Result<Self, JsValue> {
            let frame = CachedDirectoryFrame::new(bytes, expected as usize, false)
                .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                frame: Rc::new(frame),
            })
        }

        #[doc = "# Errors\nRejects invalid common frame envelopes and expected header sizes."]
        pub fn common(bytes: Vec<u8>, expected: u32) -> Result<Self, JsValue> {
            let frame = CachedDirectoryFrame::new(bytes, expected as usize, true)
                .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                frame: Rc::new(frame),
            })
        }

        #[must_use]
        pub fn retain(&self) -> Self {
            Self {
                frame: Rc::clone(&self.frame),
            }
        }

        #[must_use]
        pub fn bytes(&self) -> Vec<u8> {
            self.frame.bytes.to_vec()
        }

        #[must_use]
        pub fn heap_bytes(&self) -> usize {
            self.frame.bytes.len() + size_of::<CachedDirectoryFrame>() + 64
        }

        #[doc = "# Errors\nRejects corruption, invalid headers and decoded-memory budget violations."]
        pub fn directory(&self, max_heap_bytes: u32) -> Result<Directory, JsValue> {
            let magic = super::directory_frame_magic(&self.frame.bytes, self.frame.partial)
                .map_err(|cause| JsValue::from_str(&cause))?;
            let contents = super::decode_directory_contents(
                &self.frame.bytes,
                self.frame.expected,
                max_heap_bytes as usize,
                Some(&self.frame.validated),
                magic,
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Directory {
                header: Rc::new(contents.header),
                partial: self.frame.partial,
                hot: contents.hot,
                overview_groups: RefCell::default(),
            })
        }
    }

    #[wasm_bindgen]
    pub struct Directory {
        header: Rc<Header>,
        partial: bool,
        hot: Option<Rc<super::HotPostings>>,
        overview_groups: RefCell<Option<Box<[EligibilityGroup]>>>,
    }

    #[wasm_bindgen]
    pub struct VectorRows {
        scan: super::VectorScan,
    }

    #[wasm_bindgen]
    impl VectorRows {
        #[doc = "# Errors\nRejects inconsistent vector ranges, row overflow or page serialization failures."]
        pub fn next_page(&mut self) -> Result<String, JsValue> {
            let page = self
                .scan
                .page()
                .map_err(|cause| JsValue::from_str(&cause))?;
            serde_json::to_string(&page).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
    }

    struct EligibleCatalog {
        minimum: Option<(u32, u32)>,
        eligibility: Option<EligibilityProjection>,
    }

    fn projected_eligibility(
        header: &Header,
        retained: Option<Box<[EligibilityGroup]>>,
        fields: &BTreeSet<&str>,
        filters: &[Filter],
    ) -> Result<EligibleCatalog, String> {
        let mut groups = EligibilityProjectionBuilder::new(
            fields.iter().map(|field| (*field).to_owned()).collect(),
        )?;
        let mut minimum = None;
        if !fields.is_empty() {
            let physical = retained.unwrap_or_else(|| overview_eligibility(header));
            let mut values: BTreeMap<_, Option<serde_json::Value>> =
                fields.iter().map(|field| (*field, None)).collect();
            for group in &physical {
                let attributes = header.documents.row(group.row).attributes;
                let title = group.title;
                let body = group.body;
                for value in values.values_mut() {
                    *value = None;
                }
                let mut deserializer = serde_json::Deserializer::from_str(attributes.get());
                serde::de::DeserializeSeed::deserialize(
                    super::FilterAttributes {
                        fields,
                        values: &mut values,
                    },
                    &mut deserializer,
                )
                .map_err(|cause| cause.to_string())?;
                deserializer.end().map_err(|cause| cause.to_string())?;
                groups.push(
                    |field| values.get(field).and_then(Option::as_ref),
                    title,
                    body,
                )?;
                let mut matched = true;
                for filter in filters {
                    if !filter
                        .matches(values.get(filter.field.as_str()).and_then(Option::as_ref))?
                    {
                        matched = false;
                        break;
                    }
                }
                if matched {
                    minimum = Some(match minimum {
                        Some((minimum_title, minimum_body)) => {
                            (title.min(minimum_title), body.min(minimum_body))
                        }
                        None => (title, body),
                    });
                }
            }
        }
        if filters.is_empty() {
            minimum = Some((0, 0));
        }
        Ok(EligibleCatalog {
            minimum,
            eligibility: groups.finish()?,
        })
    }

    fn eligibility_fields(fields: &str) -> Result<Vec<String>, String> {
        let mut fields: Vec<String> =
            serde_json::from_str(fields).map_err(|cause| cause.to_string())?;
        if fields.len() > 64 {
            return Err("Eligibility exceeds sixty-four fields".to_owned());
        }
        fields.sort_unstable();
        fields.dedup();
        Ok(fields)
    }

    fn encoded_eligibility(
        header: &Header,
        retained: Option<Box<[EligibilityGroup]>>,
        fields: &[String],
    ) -> Result<Option<String>, String> {
        let fields = fields.iter().map(String::as_str).collect::<BTreeSet<_>>();
        let projection = projected_eligibility(header, retained, &fields, &[])?;
        let Some(projection) = projection.eligibility else {
            return Ok(None);
        };
        let encoded = serde_json::to_string(&projection).map_err(|cause| cause.to_string())?;
        if encoded.len() > 4096 {
            return Ok(None);
        }
        Ok(Some(encoded))
    }

    #[wasm_bindgen]
    impl Directory {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects invalid input serialization or segment framing, size, and integrity constraints."]
        pub fn new(bytes: &[u8]) -> Result<Self, JsValue> {
            let (header, _) = parse_header(bytes).map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                header: Rc::new(header),
                partial: false,
                hot: None,
                overview_groups: RefCell::default(),
            })
        }

        #[doc = "# Errors\nRejects invalid compressed frames or canonical headers and mismatched expected lengths."]
        pub fn compressed(
            bytes: &[u8],
            expected: u32,
            max_heap_bytes: u32,
        ) -> Result<Self, JsValue> {
            let header = super::parse_compressed_directory(
                bytes,
                expected as usize,
                max_heap_bytes as usize,
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                header: Rc::new(header),
                partial: false,
                hot: None,
                overview_groups: RefCell::default(),
            })
        }

        #[doc = "# Errors\nRejects invalid canonical headers, trailing bytes and mismatched expected lengths."]
        pub fn canonical(bytes: &[u8], expected: u32) -> Result<Self, JsValue> {
            let header = super::parse_directory(bytes, expected as usize)
                .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                header: Rc::new(header),
                partial: false,
                hot: None,
                overview_groups: RefCell::default(),
            })
        }

        #[doc = "# Errors\nRejects invalid common-directory frames, selected terms and allocation budgets."]
        pub fn common(bytes: &[u8], expected: u32, max_heap_bytes: u32) -> Result<Self, JsValue> {
            let directory = super::CommonDirectory::compressed(
                bytes,
                expected as usize,
                max_heap_bytes as usize,
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                header: directory.header,
                partial: true,
                hot: directory.hot,
                overview_groups: RefCell::default(),
            })
        }

        #[must_use]
        pub fn covers_query(&self, query: &PreparedQuery) -> bool {
            !self.partial
                || query
                    .query
                    .terms
                    .words
                    .iter()
                    .all(|term| self.header.terms().get(term).is_some())
        }

        #[doc = "# Errors\nRejects invalid expected lengths and compact directory size limits."]
        pub fn compressed_frame(&self, expected: u32) -> Result<Vec<u8>, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            super::compress_directory_header(&self.header, expected as usize)
                .map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects partial directories, invalid expected lengths and common-directory size limits."]
        pub fn common_frame(
            &self,
            expected: u32,
            source: Option<Vec<u8>>,
        ) -> Result<Vec<u8>, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            source
                .map_or_else(
                    || {
                        super::compress_common_directory_header(
                            &self.header,
                            expected as usize,
                            None,
                        )
                    },
                    |bytes| {
                        super::compress_common_directory_header(
                            &self.header,
                            expected as usize,
                            Some(&bytes),
                        )
                    },
                )
                .map_err(|cause| JsValue::from_str(&cause))
        }

        #[must_use]
        pub fn retain(&self) -> Self {
            Self {
                header: self.header.clone(),
                partial: self.partial,
                hot: self.hot.clone(),
                overview_groups: RefCell::default(),
            }
        }

        #[must_use]
        pub fn heap_bytes(&self) -> usize {
            self.header.heap_bytes()
                + self.hot.as_ref().map_or(0, |hot| hot.heap_bytes())
                + self
                    .overview_groups
                    .borrow()
                    .as_ref()
                    .map_or(0, |groups| size_of_val(groups.as_ref()))
        }

        #[doc = "# Errors\nRejects invalid term JSON or directory serialization errors."]
        pub fn terms(&self, terms: &str) -> Result<String, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            let terms: Vec<String> =
                serde_json::from_str(terms).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let selected: BTreeMap<_, _> = terms
                .iter()
                .filter_map(|term| self.header.terms().get(term).map(|meta| (term, meta)))
                .collect();
            serde_json::to_string(&selected).map_err(|e| JsValue::from_str(&e.to_string()))
        }

        #[doc = "# Errors\nRejects invalid term JSON or summary serialization."]
        pub fn summary(&self, terms: &str) -> Result<String, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            let terms: Vec<String> = serde_json::from_str(terms)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let selected: BTreeMap<_, _> = terms
                .iter()
                .filter_map(|term| {
                    self.header
                        .terms()
                        .get(term)
                        .map(|meta| (term, TermSummary::from(meta)))
                })
                .collect();
            serde_json::to_string(&selected).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects invalid terms, filters, attributes, or catalog serialization."]
        pub fn catalog(&self, terms: &str, filters: &str) -> Result<String, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            let terms: Vec<String> = serde_json::from_str(terms)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let filters: Vec<Filter> = serde_json::from_str(filters)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            if terms.len() > MAX_QUERY_TERMS || filters.len() > 16 {
                return Err(JsValue::from_str("Catalog projection exceeds query limits"));
            }
            let fields: BTreeSet<_> = filters.iter().map(|filter| filter.field.as_str()).collect();
            let eligible = projected_eligibility(
                &self.header,
                self.overview_groups.borrow_mut().take(),
                &fields,
                &filters,
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            let projection = Overview {
                dictionary: terms
                    .iter()
                    .filter_map(|term| {
                        self.header
                            .terms()
                            .get(term)
                            .map(|meta| (term.clone(), TermSummary::from(meta)))
                    })
                    .collect(),
                minimum: eligible.minimum,
                eligibility: eligible.eligibility,
                partitions: None,
            };
            serde_json::to_string(&projection)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects malformed field lists, more than sixty-four fields, invalid attributes or model serialization."]
        pub fn eligibility(&self, fields: &str) -> Result<Option<String>, JsValue> {
            let fields = eligibility_fields(fields).map_err(|cause| JsValue::from_str(&cause))?;
            encoded_eligibility(
                &self.header,
                self.overview_groups.borrow_mut().take(),
                &fields,
            )
            .map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects common-term metadata or serialization failures."]
        pub fn common_terms(&self) -> Result<String, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            common_terms(&self.header).map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects common-leader serialization errors."]
        pub fn common_leaders(&self) -> Result<String, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            common_leaders(&self.header).map_err(|cause| JsValue::from_str(&cause))
        }
        #[doc = "# Errors\nRejects invalid document metadata or serialization."]
        pub fn constant_attributes(&self) -> Result<String, JsValue> {
            constant_attributes(&self.header).map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects invalid filters, attributes, or minimum serialization."]
        pub fn minimum(&self, filters: &str) -> Result<String, JsValue> {
            let filters: Vec<Filter> = serde_json::from_str(filters)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let minimum = self
                .header
                .eligible_minimum(&filters)
                .map_err(|cause| JsValue::from_str(&cause))?;
            serde_json::to_string(&minimum).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects summary serialization or size budgets."]
        pub fn overview(&self) -> Result<Vec<u8>, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            let groups = self
                .overview_groups
                .borrow_mut()
                .take()
                .unwrap_or_else(|| overview_eligibility(&self.header));
            let bytes = encode_overview(&self.header, None, &groups, &BTreeMap::new())
                .map_err(|cause| JsValue::from_str(&cause))?;
            *self.overview_groups.borrow_mut() = Some(groups);
            Ok(bytes)
        }

        #[doc = "# Errors\nRejects invalid ids or tombstones, row overflow, or result serialization errors."]
        pub fn lookup(&self, ids: &str, dead: &str) -> Result<String, JsValue> {
            let header = &self.header;
            let ids: Vec<DocumentId> =
                serde_json::from_str(ids).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let dead: BTreeSet<u32> =
                serde_json::from_str(dead).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let mut found = Vec::new();
            for id in &ids {
                if let Ok(index) = header.documents.find_id(id) {
                    let row = u32::try_from(index)
                        .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
                    if !dead.contains(&row) {
                        found.push(Located {
                            row,
                            document: header.documents.row(index),
                            vector_data: header
                                .vector_range(index)
                                .map_err(|cause| JsValue::from_str(&cause))?,
                        });
                    }
                }
            }
            serde_json::to_string(&found).map_err(|e| JsValue::from_str(&e.to_string()))
        }

        #[doc = "# Errors\nRejects invalid tombstones, row overflow, or result serialization errors."]
        pub fn vectors(&self, dead: &str) -> Result<String, JsValue> {
            let dead: BTreeSet<u32> = serde_json::from_str(dead)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let mut documents = Vec::new();
            for (index, doc) in self.header.documents.iter().enumerate() {
                let row =
                    u32::try_from(index).map_err(|cause| JsValue::from_str(&cause.to_string()))?;
                if doc.vector && !dead.contains(&row) {
                    documents.push(doc);
                }
            }
            serde_json::to_string(&documents).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects invalid row JSON, missing rows, or result serialization errors."]
        pub fn rows(&self, rows: &str) -> Result<String, JsValue> {
            let header = &self.header;
            let rows: Vec<u32> =
                serde_json::from_str(rows).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let selected = rows
                .iter()
                .map(|row| {
                    let index = *row as usize;
                    Ok(Located {
                        row: *row,
                        document: header.documents.get(index).ok_or("Invalid row")?,
                        vector_data: header.vector_range(index)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()
                .map_err(|cause| JsValue::from_str(&cause))?;
            serde_json::to_string(&selected).map_err(|e| JsValue::from_str(&e.to_string()))
        }

        #[doc = "# Errors\nRejects partial directories, malformed filters/tombstones or invalid filter attributes."]
        pub fn vector_reader(&self, filters: &str, dead: &str) -> Result<VectorRows, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            let filters: Vec<Filter> = serde_json::from_str(filters)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let dead: Vec<u32> = serde_json::from_str(dead)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let scan = super::VectorScan::new(Rc::clone(&self.header), &filters, &dead)
                .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(VectorRows { scan })
        }

        #[doc = "# Errors\nRejects invalid tombstone JSON, filter attributes, or deleted rows."]
        pub fn ranker_prepared(
            &self,
            query: &PreparedQuery,
            dead: &str,
            constant_attributes: Option<String>,
        ) -> Result<Ranker, JsValue> {
            if !self.covers_query(query) {
                return Err(JsValue::from_str("Common directory does not cover query"));
            }
            let dead: Vec<u32> = serde_json::from_str(dead)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let filters = if uniform_filters(&query.query.filters, constant_attributes)
                .map_err(|cause| JsValue::from_str(&cause))?
            {
                &[]
            } else {
                query.query.filters.as_slice()
            };
            let mut search = Search::with_terms(
                self.header.clone(),
                query.query.terms.clone(),
                &query.query.mode,
                query.query.top_k,
                &dead,
                filters,
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            search.pending_hot.clone_from(&self.hot);
            Ok(Ranker { search })
        }

        #[doc = "# Errors\nRejects invalid query JSON, filters, term budgets, top-k, or match mode."]
        pub fn ranker(&self, query: &str) -> Result<Ranker, JsValue> {
            if self.partial {
                return Err(JsValue::from_str("Operation requires a complete directory"));
            }
            let input: Input =
                serde_json::from_str(query).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let search = Search::new(
                self.header.clone(),
                input.statistics,
                &input.text,
                &input.mode,
                input.top_k,
                &input.dead,
                &input.filters,
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Ranker { search })
        }
    }

    #[derive(Serialize)]
    struct Located<'a> {
        row: u32,
        document: DocumentMeta<DocumentIdRef<'a>, &'a DocumentAttributes>,
        #[serde(rename = "vectorData")]
        vector_data: Option<&'a Range>,
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects corrupt overview framing, invalid terms, or projection serialization."]
    pub fn segment_overview_project(
        bytes: &[u8],
        terms: &str,
        filters: &str,
    ) -> Result<String, JsValue> {
        use serde::de::DeserializeSeed;

        let terms: Vec<String> =
            serde_json::from_str(terms).map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        if terms.len() > MAX_QUERY_TERMS {
            return Err(JsValue::from_str("Overview projection exceeds 512 terms"));
        }
        let requested = terms.into_iter().collect();
        let filters: Vec<Filter> =
            serde_json::from_str(filters).map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        if filters.len() > 16 {
            return Err(JsValue::from_str("Overview projection exceeds 16 filters"));
        }
        let decoded = decode_page(bytes).map_err(|cause| JsValue::from_str(&cause))?;
        let mut deserializer = serde_json::Deserializer::from_slice(&decoded);
        let projected = SelectedOverview {
            requested: &requested,
            filters: &filters,
        }
        .deserialize(&mut deserializer)
        .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        deserializer
            .end()
            .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
        serde_json::to_string(&projected).map_err(|cause| JsValue::from_str(&cause.to_string()))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid v2 or v3 canonical header framing or serialization."]
    pub fn segment_header(bytes: &[u8]) -> Result<String, JsValue> {
        let (header, _) = parse_header(bytes).map_err(|cause| JsValue::from_str(&cause))?;
        serde_json::to_string(&header).map_err(|cause| JsValue::from_str(&cause.to_string()))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid v2, v3 or v4 canonical header framing or field serialization."]
    pub fn segment_fields(bytes: &[u8]) -> Result<String, JsValue> {
        let (header, _) = parse_header(bytes).map_err(|cause| JsValue::from_str(&cause))?;
        serde_json::to_string(&header.fields).map_err(|cause| JsValue::from_str(&cause.to_string()))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid v1 or v2 sources or migration output above sixteen MiB."]
    pub fn segment_migrate(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        super::migrate_segment(bytes).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects corrupt pages or invalid document serialization."]
    pub fn segment_document(bytes: &[u8], vector: &[u8]) -> Result<String, JsValue> {
        super::full_document_from_frames(bytes, vector).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects corrupt pages, invalid document serialization, or query projection errors."]
    pub fn segment_query_document(bytes: &[u8]) -> Result<String, JsValue> {
        super::query_document_from_metadata(bytes).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid metadata batches or query projections. Returns None above the decoded batch budget for scalar validation and projection."]
    pub fn segment_query_documents(
        bytes: &[u8],
        ranges: &[u32],
    ) -> Result<Option<String>, JsValue> {
        super::query_documents_from_metadata(bytes, ranges)
            .map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid document JSON or term serialization errors."]
    pub fn segment_document_terms(json: &str) -> Result<String, JsValue> {
        let document =
            Document::from_canonical_json(json).map_err(|cause| JsValue::from_str(&cause))?;
        serde_json::to_string(
            &document_terms(&document).map_err(|cause| JsValue::from_str(&cause))?,
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid attributes, filters, or operators."]
    pub fn segment_filter(attributes: &str, filters: &str) -> Result<bool, JsValue> {
        let attributes: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(attributes).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let filters: Vec<Filter> =
            serde_json::from_str(filters).map_err(|e| JsValue::from_str(&e.to_string()))?;
        matches(&attributes, &filters).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid values or bloom size/index budgets."]
    pub fn segment_bloom(values: &str) -> Result<Vec<u8>, JsValue> {
        let values: Vec<DocumentId> =
            serde_json::from_str(values).map_err(|e| JsValue::from_str(&e.to_string()))?;
        bloom_build_ids(&values).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid values, bloom budgets, or result serialization errors."]
    pub fn segment_bloom_filter_many(
        bytes: &[u8],
        offsets: &[u32],
        values: &str,
    ) -> Result<String, JsValue> {
        let values: Vec<DocumentId> =
            serde_json::from_str(values).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let selected =
            bloom_filter_ids(bytes, offsets, &values).map_err(|cause| JsValue::from_str(&cause))?;
        serde_json::to_string(&selected).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub struct BloomBatch {
        bytes: Box<[u8]>,
        offsets: Box<[u32]>,
    }

    #[wasm_bindgen]
    impl BloomBatch {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects oversized batches or invalid offset framing."]
        pub fn new(bytes: Vec<u8>, offsets: Vec<u32>) -> Result<Self, JsValue> {
            bloom_filter_ids(&bytes, &offsets, &[]).map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                bytes: bytes.into_boxed_slice(),
                offsets: offsets.into_boxed_slice(),
            })
        }

        #[must_use]
        pub fn heap_bytes(&self) -> usize {
            self.bytes.len() + self.offsets.len() * size_of::<u32>() + size_of::<Self>() + 32
        }

        #[doc = "# Errors\nRejects invalid values or result serialization errors."]
        pub fn filter(&self, values: &str) -> Result<String, JsValue> {
            let values: Vec<DocumentId> = serde_json::from_str(values)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let selected = bloom_filter_ids(&self.bytes, &self.offsets, &values)
                .map_err(|cause| JsValue::from_str(&cause))?;
            serde_json::to_string(&selected).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
    }

    #[wasm_bindgen]
    pub struct FrequencyPage {
        rows: Box<[super::DecodedFrequencyPosting]>,
        validated_header: RefCell<Weak<Header>>,
    }

    #[wasm_bindgen]
    impl FrequencyPage {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects corrupt pages, invalid varints, row/position ordering, or trailing bytes."]
        pub fn new(bytes: &[u8]) -> Result<Self, JsValue> {
            let rows = super::decode_posting_rows::<false, _>(bytes, |row, title, body| {
                super::DecodedFrequencyPosting {
                    posting: super::FrequencyPosting {
                        row,
                        title: title.count,
                        body: body.count,
                    },
                    title_last: title.last,
                    body_last: body.last,
                }
            })
            .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                rows: rows.into_boxed_slice(),
                validated_header: RefCell::default(),
            })
        }

        #[must_use]
        pub fn heap_bytes(&self) -> usize {
            let retained_header = if self.rows.len() > 1 {
                size_of::<Header>() + 2 * size_of::<usize>()
            } else {
                0
            };
            self.rows.len() * size_of::<super::DecodedFrequencyPosting>()
                + size_of::<Self>()
                + retained_header
                + 32
        }
    }

    #[wasm_bindgen]
    pub struct Ranker {
        search: Search,
    }

    #[derive(Deserialize)]
    struct Input {
        text: String,
        mode: String,
        top_k: usize,
        dead: Vec<u32>,
        filters: Vec<Filter>,
        statistics: Statistics,
    }

    #[wasm_bindgen]
    pub struct PreparedQuery {
        query: super::PreparedQuery,
    }

    #[wasm_bindgen]
    impl PreparedQuery {
        #[doc = "# Errors\nRejects malformed singleton catalogs or tombstones."]
        pub fn singleton_hits(
            &self,
            catalog: &str,
            count: u32,
            dead: &str,
            constant_attributes: Option<String>,
        ) -> Result<Option<String>, JsValue> {
            if self.query.mode == "phrase" && self.query.terms.words.len() != 1
                || !uniform_filters(&self.query.filters, constant_attributes)
                    .map_err(|cause| JsValue::from_str(&cause))?
            {
                return Ok(None);
            }
            if catalog.len() > 1024 * 1024 || dead.len() > 64 * 1024 {
                return Err(JsValue::from_str("Singleton query exceeds byte budget"));
            }
            let dictionary: BTreeMap<String, TermSummary> = serde_json::from_str(catalog)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let dead: Vec<u32> = serde_json::from_str(dead)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let excluded: BTreeSet<_> = dead.iter().copied().collect();
            if count == 0
                || count > 10000
                || dictionary.len() > MAX_QUERY_TERMS
                || excluded.len() != dead.len()
                || dead.iter().any(|row| *row >= count)
            {
                return Err(JsValue::from_str("Invalid singleton query budget"));
            }
            let mut candidates = BTreeMap::new();
            for (index, word) in self.query.terms.order.iter().enumerate() {
                let Some(metadata) = dictionary.get(&self.query.terms.words[*word]) else {
                    if self.query.mode != "any" {
                        return Ok(Some("[]".into()));
                    }
                    continue;
                };
                let Some(document) = metadata.single.as_ref() else {
                    return Ok(None);
                };
                let [bound] = metadata.bounds.as_slice() else {
                    return Ok(None);
                };
                let &(title, body, title_length, body_length) = bound;
                if metadata.df != 1
                    || !document.is_bounded(count)
                    || (title == 0 && body == 0)
                    || title > title_length
                    || body > body_length
                {
                    return Ok(None);
                }
                if excluded.contains(&document.row) {
                    continue;
                }
                let candidate = candidates.entry(document.row).or_insert((
                    document,
                    0.0,
                    0,
                    (title_length, body_length),
                ));
                if candidate.0.id != document.id
                    || candidate.0.data != document.data
                    || candidate.3 != (title_length, body_length)
                {
                    return Ok(None);
                }
                candidate.1 +=
                    self.query.terms.scorers[index].score(title, body, title_length, body_length);
                candidate.2 += 1;
            }
            let mut ranked = Vec::new();
            for (document, score, matched, _) in candidates.into_values() {
                if !score.is_finite() {
                    return Ok(None);
                }
                if score <= 0.0
                    || self.query.mode != "any" && matched != self.query.terms.order.len()
                {
                    continue;
                }
                ranked.push(Ranked {
                    row: document.row,
                    id: document.id.borrowed(),
                    score,
                    data: document.data.clone(),
                });
            }
            ranked.sort_by(|a, b| {
                b.score
                    .total_cmp(&a.score)
                    .then_with(|| compare_document_ids(a.id, b.id))
            });
            ranked.truncate(self.query.top_k);
            serde_json::to_string(&ranked)
                .map(Some)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects invalid common-leader metadata or tombstones."]
        pub fn common_hits(
            &self,
            catalog: &str,
            leaders: &str,
            count: u32,
            dead: &str,
            constant_attributes: Option<String>,
        ) -> Result<Option<String>, JsValue> {
            if self.query.mode == "phrase" && self.query.terms.words.len() != 1
                || !uniform_filters(&self.query.filters, constant_attributes)
                    .map_err(|cause| JsValue::from_str(&cause))?
            {
                return Ok(None);
            }
            if leaders.len() > 16384 {
                return Err(JsValue::from_str(
                    "Common-leader source exceeds byte budget",
                ));
            }
            let dictionary: BTreeMap<String, TermSummary> = serde_json::from_str(catalog)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let leaders: Vec<CommonLeader> = serde_json::from_str(leaders)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let dead: Vec<u32> = serde_json::from_str(dead)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let excluded: BTreeSet<_> = dead.iter().copied().collect();
            if count == 0
                || count > 10000
                || dictionary.len() > 16
                || leaders.len() > 2
                || excluded.len() != dead.len()
                || dead.iter().any(|row| *row >= count)
            {
                return Err(JsValue::from_str("Invalid common-leader budget"));
            }
            for leader in &leaders {
                if !matches!(leader.field.as_str(), "title" | "body")
                    || leader.terms.is_empty()
                    || leader.terms.len() > 16
                    || leader
                        .terms
                        .iter()
                        .any(|term| term.is_empty() || term.len() > 64)
                    || leader.documents.len() > 16
                    || leader
                        .documents
                        .iter()
                        .any(|document| document.row >= count || !document.id.is_valid())
                    || leader.documents.windows(2).any(|pair| {
                        pair[0].row >= pair[1].row
                            || compare_document_ids(&pair[0].id, &pair[1].id).is_ge()
                    })
                {
                    return Err(JsValue::from_str("Invalid common-leader rows"));
                }
            }
            let ranked = leaders
                .iter()
                .find_map(|leader| leader.hits(&self.query, &dictionary, count, &excluded));
            ranked
                .map(|ranked| serde_json::to_string(&ranked))
                .transpose()
                .map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects invalid query JSON, query budgets, match mode, or nonempty segment tombstones."]
        pub fn new(query: &str) -> Result<Self, JsValue> {
            let input: Input = serde_json::from_str(query)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            if !input.dead.is_empty() {
                return Err(JsValue::from_str(
                    "Prepared query requires empty segment tombstones",
                ));
            }
            let query = super::PreparedQuery::new(
                input.statistics,
                &input.text,
                input.mode,
                input.top_k,
                input.filters,
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self { query })
        }
    }

    #[wasm_bindgen]
    impl Ranker {
        #[doc = "# Errors\nRejects posting span serialization errors."]
        pub fn posting_spans(&mut self) -> Result<String, JsValue> {
            let spans = self.search.posting_spans();
            if !self.search.has_hot_selection(&spans) {
                return serde_json::to_string(&spans)
                    .map_err(|cause| JsValue::from_str(&cause.to_string()));
            }
            let selection = self
                .search
                .own_posting_selection(&spans)
                .map_err(|cause| JsValue::from_str(&cause))?;
            drop(spans);
            let remaining = self
                .search
                .satisfy_hot_selection(selection)
                .map_err(|cause| JsValue::from_str(&cause))?;
            self.search
                .encode_posting_selection(&remaining)
                .map_err(|cause| JsValue::from_str(&cause))
        }
        #[doc = "# Errors\nRejects invalid derived cutoffs or posting span serialization errors."]
        pub fn posting_spans_seeded(&mut self) -> Result<String, JsValue> {
            let spans = self
                .search
                .posting_spans_seeded()
                .map_err(|cause| JsValue::from_str(&cause))?;
            if !self.search.has_hot_selection(&spans) {
                return serde_json::to_string(&spans)
                    .map_err(|cause| JsValue::from_str(&cause.to_string()));
            }
            let selection = self
                .search
                .own_posting_selection(&spans)
                .map_err(|cause| JsValue::from_str(&cause))?;
            drop(spans);
            let remaining = self
                .search
                .satisfy_hot_selection(selection)
                .map_err(|cause| JsValue::from_str(&cause))?;
            self.search
                .encode_posting_selection(&remaining)
                .map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects invalid cutoffs or posting span serialization errors."]
        pub fn posting_spans_after(&mut self, score: f64, id: &str) -> Result<String, JsValue> {
            self.encode_cutoff_spans(score, DocumentId::String(id))
        }

        #[doc = "# Errors\nRejects malformed canonical IDs, invalid ID bounds, invalid cutoffs or posting span serialization errors."]
        pub fn posting_spans_after_id(
            &mut self,
            score: f64,
            encoded_id: &str,
        ) -> Result<String, JsValue> {
            let id =
                super::decode_document_id(encoded_id).map_err(|cause| JsValue::from_str(&cause))?;
            self.encode_cutoff_spans(score, id.borrowed())
        }

        #[doc = "# Errors\nRejects unrequested terms, positional mode, invalid rows/positions, or unordered blocks."]
        pub fn add_frequency(&mut self, term: &str, page: &FrequencyPage) -> Result<(), JsValue> {
            if page.rows.len() < 2 {
                return self
                    .search
                    .add_frequency_page(term, &page.rows)
                    .map_err(|cause| JsValue::from_str(&cause));
            }
            let validated = std::ptr::eq(
                page.validated_header.borrow().as_ptr(),
                Rc::as_ptr(&self.search.header),
            );
            if validated {
                return self
                    .search
                    .add_validated_frequency_page(term, &page.rows)
                    .map_err(|cause| JsValue::from_str(&cause));
            }
            self.search
                .add_frequency_page(term, &page.rows)
                .map_err(|cause| JsValue::from_str(&cause))?;
            page.validated_header
                .replace(Rc::downgrade(&self.search.header));
            Ok(())
        }

        #[doc = "# Errors\nRejects invalid requested terms, pages, rows, positions, or block ordering."]
        pub fn add(&mut self, term: &str, bytes: &[u8]) -> Result<(), JsValue> {
            self.search
                .add(term, bytes)
                .map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects serialization of exact uniform-frequency hits."]
        pub fn uniform_hits(&self) -> Result<Option<String>, JsValue> {
            self.search
                .uniform_hits()
                .map(|hits| self.encode_hits(&hits))
                .transpose()
        }

        #[doc = "# Errors\nRejects posting frequency overflow or result serialization errors."]
        pub fn finish(&self) -> Result<String, JsValue> {
            let hits = self
                .search
                .finish()
                .map_err(|cause| JsValue::from_str(&cause))?;
            self.encode_hits(&hits)
        }
    }

    impl Ranker {
        fn encode_cutoff_spans(
            &mut self,
            score: f64,
            id: DocumentIdRef<'_>,
        ) -> Result<String, JsValue> {
            let spans = self
                .search
                .posting_spans_cutoff(score, id, false)
                .map_err(|cause| JsValue::from_str(&cause))?;
            if !self.search.has_hot_selection(&spans) {
                return serde_json::to_string(&spans)
                    .map_err(|cause| JsValue::from_str(&cause.to_string()));
            }
            let selection = self
                .search
                .own_posting_selection(&spans)
                .map_err(|cause| JsValue::from_str(&cause))?;
            drop(spans);
            let remaining = self
                .search
                .satisfy_hot_selection(selection)
                .map_err(|cause| JsValue::from_str(&cause))?;
            self.search
                .encode_posting_selection(&remaining)
                .map_err(|cause| JsValue::from_str(&cause))
        }

        fn encode_hits(&self, hits: &[super::Hit]) -> Result<String, JsValue> {
            let ranked: Vec<_> = hits
                .iter()
                .map(|hit| {
                    let document = self.search.header.documents.row(hit.row as usize);
                    Ranked {
                        row: hit.row,
                        id: document.id,
                        score: hit.score,
                        data: document.data.clone(),
                    }
                })
                .collect();
            serde_json::to_string(&ranked).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
    }

    #[derive(Serialize)]
    struct Ranked<'a> {
        row: u32,
        id: DocumentIdRef<'a>,
        score: f64,
        data: Range,
    }
}

#[cfg(test)]
mod query_document_projection_tests {
    use super::{Document, serialize_query_document};
    use serde_json::{Value, json};
    use std::collections::BTreeMap;

    fn document(vector: Option<Vec<f32>>) -> Document {
        Document::native(
            "row-1",
            7,
            "title",
            "body",
            BTreeMap::from([("field".into(), json!("value"))]),
            vector,
        )
    }

    fn vector_bits(document: &Document) -> Result<Option<Vec<u32>>, Box<dyn std::error::Error>> {
        match document.column(super::ColumnId::Role(super::NativeRole::Vector)) {
            Some(super::ColumnValue::Vector(values)) => {
                Ok(Some(values.iter().map(|value| value.to_bits()).collect()))
            }
            None => Ok(None),
            Some(_) => Err("Native vector role is not a vector".into()),
        }
    }

    fn check_summary(
        vector: Option<Vec<f32>>,
        expected_summary: Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let expected_bits = vector.as_ref().map(|values| {
            values
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>()
        });
        let document = document(vector);
        let mut expected = serde_json::from_str::<Value>(&document.to_canonical_json()?)?;
        let fields = expected
            .as_object_mut()
            .ok_or("Document was not an object")?;
        fields.remove("vector");
        fields.insert("vectorSummary".into(), expected_summary);
        let actual = serde_json::from_str::<Value>(&serialize_query_document(&document)?)?;
        assert_eq!(actual, expected);
        assert!(actual.get("vector").is_none());
        assert_eq!(vector_bits(&document)?, expected_bits);
        Ok(())
    }

    #[test]
    fn vector_json_extrema_stay_in_range_and_preserve_float32_bits()
    -> Result<(), Box<dyn std::error::Error>> {
        let values = vec![f32::MAX, -f32::MAX, 0.1, -0.0, f32::from_bits(1)];
        let source = document(Some(values.clone()));
        let encoded = source.to_canonical_vec()?;
        let fields =
            serde_json::from_slice::<BTreeMap<String, Box<serde_json::value::RawValue>>>(&encoded)?;
        let vector = serde_json::from_str::<Vec<Box<serde_json::value::RawValue>>>(
            fields.get("vector").ok_or("Missing vector")?.get(),
        )?;
        assert_eq!(
            vector
                .first()
                .ok_or("Missing positive extremum")?
                .get()
                .parse::<f64>()?
                .to_bits(),
            f64::from(f32::MAX).to_bits()
        );
        assert_eq!(
            vector
                .get(1)
                .ok_or("Missing negative extremum")?
                .get()
                .parse::<f64>()?
                .to_bits(),
            f64::from(-f32::MAX).to_bits()
        );
        let decoded = Document::from_canonical_slice(&encoded)?;
        let decoded = vector_bits(&decoded)?.ok_or("Vector disappeared")?;
        assert_eq!(
            decoded,
            values
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>()
        );
        Ok(())
    }

    #[test]
    fn query_projection_preserves_fields_and_summarizes_vector_facts()
    -> Result<(), Box<dyn std::error::Error>> {
        check_summary(None, Value::Null)?;
        check_summary(Some(vec![0.5, 0.0, -0.25]), json!([3, true, true]))?;
        let mut vector_768 = vec![0.0; 768];
        vector_768[767] = 1.0;
        check_summary(Some(vector_768), json!([768, true, true]))?;
        check_summary(Some(Vec::new()), json!([0, true, false]))?;
        check_summary(Some(vec![0.0, -0.0]), json!([2, true, false]))?;
        check_summary(Some(vec![f32::INFINITY]), json!([1, false, true]))?;
        check_summary(Some(vec![0.0; 4097]), json!([4097, true, false]))?;
        Ok(())
    }
}

#[cfg(test)]
mod filter_cache_tests {
    use super::{Document, FILTER_CACHE_BYTES, Filter, SelectedAttributes, build};
    use bit_vec::BitVec;
    use serde::de::DeserializeSeed;
    use serde_json::json;
    use std::collections::BTreeSet;

    #[test]
    fn vector_pages_bound_projection_and_apply_filters_before_emission()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents = (0..200)
            .map(|index| {
                Document::from_native_value(json!({
                    "id": format!("{index:03}"), "text": "paged vectors",
                    "attributes": {"eligible": index >= 5, "padding": "x".repeat(1024)},
                    "vector": if index % 3 == 0 { None } else { Some(vec![1.0, 0.0]) }
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let header = std::rc::Rc::new(build(documents, None)?.header);
        let filters = [Filter {
            field: "eligible".into(),
            op: "eq".into(),
            value: json!(true),
        }];
        let mut scan = super::VectorScan::new(header, &filters, &[7, 128])?;
        let mut found = Vec::new();
        loop {
            let page = scan.page()?;
            assert!(page.rows.len() <= 64);
            let encoded = serde_json::to_value(&page)?;
            for row in encoded["rows"].as_array().ok_or("Missing projected rows")? {
                assert!(row.get("attributes").is_none());
                assert!(row.get("document").is_none());
            }
            found.extend(page.rows.iter().map(|row| row.row));
            if page.complete {
                break;
            }
        }
        let expected: Vec<u32> = (5..200)
            .filter(|row| row % 3 != 0 && ![7, 128].contains(row))
            .collect();
        assert_eq!(found, expected);
        let complete = scan.page()?;
        assert!(complete.complete && complete.rows.is_empty());
        Ok(())
    }

    #[test]
    fn vector_selection_excludes_tombstones_missing_vectors_and_filtered_rows()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents = (0..4)
            .map(|index| {
                Document::from_native_value(json!({
                    "id": format!("{index}"), "text": "vector",
                    "attributes": {"group": if index == 3 { "other" } else { "selected" }},
                    "vector": if index == 1 { None } else { Some(vec![1.0, 0.0]) }
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let header = build(documents, None)?.header;
        let filters = [Filter {
            field: "group".into(),
            op: "eq".into(),
            value: json!("selected"),
        }];
        assert_eq!(header.vector_rows(&filters, &[0])?, vec![2]);
        assert_eq!(header.vector_rows(&filters, &[])?, vec![0, 2]);
        assert_eq!(header.vector_rows(&[], &[])?, vec![0, 2, 3]);
        Ok(())
    }

    #[test]
    fn configured_headers_keep_selected_attributes_and_preserve_document_payloads()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents = (0..32)
            .map(|index| {
                Document::from_native_value(json!({
                    "id": format!("{index:02}"), "text": format!("rust unique{index}"),
                    "attributes": {
                        "year": 2024 + index % 2, "__proto__": index % 2 == 0,
                        "externalId": index, "padding": "x".repeat(2048)
                    }
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let original = build(documents.clone(), None)?;
        let fields = vec!["year".into(), "__proto__".into()];
        let selected = build(documents.clone(), Some(&fields))?;
        let (_, original_base) = super::parse_header(&original.bytes)?;
        let (_, selected_base) = super::parse_header(&selected.bytes)?;
        assert_eq!(
            original.bytes[original_base..],
            selected.bytes[selected_base..]
        );
        assert!(selected_base < original_base / 4);
        for (metadata, document) in selected.header.documents.iter().zip(&documents) {
            let attributes: serde_json::Value = serde_json::from_str(metadata.attributes.get())?;
            assert_eq!(
                attributes,
                json!({"year": document.columns().attributes()["year"], "__proto__": document.columns().attributes()["__proto__"]})
            );
            let start = selected_base + metadata.data.offset as usize;
            let payload =
                super::decode_page(&selected.bytes[start..start + metadata.data.length as usize])?;
            let (_, stored) = super::parse_document_metadata(&payload)?;
            assert_eq!(
                stored.columns().attributes(),
                document.columns().attributes()
            );
        }
        for op in [
            "eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "exists",
        ] {
            for value in [json!(2024), json!([2024]), json!(true)] {
                let filters = [Filter {
                    field: "year".into(),
                    op: op.into(),
                    value,
                }];
                assert_eq!(
                    selected.header.allowed(&filters, &[]),
                    original.header.allowed(&filters, &[])
                );
            }
        }
        let empty = build(documents.clone(), Some(&[]))?;
        assert!(
            empty
                .header
                .documents
                .iter()
                .all(|document| document.attributes.get() == "{}")
        );
        for fields in [
            vec!["year".into(), "year".into()],
            vec![String::new()],
            vec!["$reserved".into()],
            vec!["x".repeat(129)],
            vec![format!("{}x", "é".repeat(64))],
            vec![format!("{}x", "😀".repeat(32))],
            (0..65).map(|index| format!("field{index}")).collect(),
        ] {
            assert!(build(documents.clone(), Some(&fields)).is_err());
        }
        Ok(())
    }

    #[test]
    fn projected_attribute_keys_preserve_escapes_duplicates_and_ignored_validation()
    -> Result<(), Box<dyn std::error::Error>> {
        let fields = BTreeSet::from(["flag", "group"]);
        for (input, expected) in [
            (
                r#"{"group":1,"ignored":"text","flag":true}"#,
                json!({"group":1,"flag":true}),
            ),
            (
                r#"{"g\u0072oup":1,"group":2,"ignored":{"1e999":[{"key":"ok"}]}}"#,
                json!({"group":2}),
            ),
            (r#"{"ignored":null}"#, json!({})),
            (r#"{"group":null,"ignored":1e308}"#, json!({"group":null})),
        ] {
            let mut decoder = serde_json::Deserializer::from_str(input);
            let selected = SelectedAttributes(&fields).deserialize(&mut decoder)?;
            decoder.end()?;
            assert_eq!(serde_json::to_value(selected)?, expected);
        }
        for input in [
            r#"{"ignored":1e999,"group":1}"#,
            r#"{"ignored":{"nested":1e999},"group":1}"#,
            r#"{"ignored":{"\uD800":1},"group":1}"#,
            r#"{"ignored":{"key":"\uD800"},"group":1}"#,
            r#"{"ignored":{[1]:2},"group":1}"#,
            r#"{"ignored":NaN,"group":1}"#,
            r#"{"group":1} []"#,
        ] {
            let mut decoder = serde_json::Deserializer::from_str(input);
            assert!(
                SelectedAttributes(&fields)
                    .deserialize(&mut decoder)
                    .and_then(|_| decoder.end())
                    .is_err()
            );
        }
        Ok(())
    }

    #[test]
    fn reused_filter_values_match_complete_objects_without_cross_document_leaks()
    -> Result<(), Box<dyn std::error::Error>> {
        let inputs = [
            r#"{"group":1,"g\u0072oup":2,"flag":true,"ignored":{"nested":[1,null]}}"#,
            "{}",
            r#"{"group":null,"flag":false}"#,
            r#"{"group":[1,2],"flag":null}"#,
            r#"{"group":{"nested":1},"flag":"yes"}"#,
            r#"{"group":-0.0,"ignored":1e308}"#,
            r#"{"group":3,"flag":true}"#,
        ];
        let documents = inputs
            .iter()
            .enumerate()
            .map(|(index, _)| {
                Document::native(
                    format!("{index}"),
                    1,
                    String::new(),
                    "target",
                    std::collections::BTreeMap::new(),
                    None,
                )
            })
            .collect();
        let mut header = build(documents, None)?.header;
        for (document, input) in header
            .documents
            .attributes
            .dense_mut()
            .iter_mut()
            .zip(inputs)
        {
            *document = serde_json::value::RawValue::from_string(input.into())?.into();
        }
        for op in [
            "eq", "ne", "exists", "in", "notIn", "gt", "gte", "lt", "lte",
        ] {
            for value in [
                json!(2),
                json!(true),
                json!(false),
                json!(null),
                json!([1, 2]),
                json!({"nested":1}),
            ] {
                for fields in [["group", "flag"], ["missing", "group"], ["group", "group"]] {
                    let filters: Vec<_> = fields
                        .iter()
                        .map(|field| Filter {
                            field: (*field).into(),
                            op: op.into(),
                            value: value.clone(),
                        })
                        .collect();
                    let expected = inputs
                        .iter()
                        .map(|input| {
                            let attributes =
                                serde_json::from_str(input).map_err(|cause| cause.to_string())?;
                            super::matches(&attributes, &filters)
                        })
                        .collect::<Result<Vec<_>, String>>();
                    assert_eq!(
                        header
                            .allowed(&filters, &[])
                            .map(|mask| mask.iter().collect::<Vec<_>>()),
                        expected
                    );
                }
            }
        }
        Ok(())
    }

    #[test]
    fn repeated_attribute_values_preserve_filters_and_query_local_tombstones()
    -> Result<(), Box<dyn std::error::Error>> {
        let large = serde_json::to_string(&json!({ "group": "x".repeat(300), "flag": true }))?;
        let inputs = [
            r#"{"group":2,"flag":true}"#,
            r#"{"group":2,"flag":true}"#,
            r#"{"group":2,"flag":true}"#,
            "{}",
            "{}",
            r#"{"group":null,"flag":false}"#,
            r#"{"group":null,"flag":false}"#,
            r#"{"group":2,"flag":true}"#,
            r#"{"group":2,"flag":true}"#,
            r#"{"group":[1,2],"flag":true}"#,
            r#"{"group":[1,2],"flag":true}"#,
            r#"{"group":{"nested":1},"flag":false}"#,
            r#"{"group":{"nested":1},"flag":false}"#,
            large.as_str(),
            large.as_str(),
        ];
        let documents = inputs
            .iter()
            .enumerate()
            .map(|(index, _)| {
                Document::from_native_value(json!({
                    "id": format!("{index}"), "text": "target", "attributes": {}
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut header = build(documents, None)?.header;
        for (document, input) in header
            .documents
            .attributes
            .dense_mut()
            .iter_mut()
            .zip(inputs)
        {
            *document = serde_json::value::RawValue::from_string(input.into())?.into();
        }
        for op in [
            "eq", "ne", "exists", "in", "notIn", "gt", "gte", "lt", "lte",
        ] {
            for value in [
                json!(2),
                json!(true),
                json!(null),
                json!([1, 2]),
                json!({"nested":1}),
                json!("x".repeat(300)),
            ] {
                let filters = [Filter {
                    field: "group".into(),
                    op: op.into(),
                    value,
                }];
                let expected = inputs
                    .iter()
                    .map(|input| {
                        let attributes =
                            serde_json::from_str(input).map_err(|cause| cause.to_string())?;
                        super::matches(&attributes, &filters)
                    })
                    .collect::<Result<Vec<_>, String>>();
                assert_eq!(
                    header
                        .allowed(&filters, &[])
                        .map(|mask| mask.iter().collect::<Vec<_>>()),
                    expected
                );
                if let Ok(mask) = expected {
                    let mut deleted = mask.clone();
                    deleted[0] = false;
                    deleted[3] = false;
                    deleted[7] = false;
                    assert_eq!(
                        header
                            .allowed(&filters, &[0, 3, 7])?
                            .iter()
                            .collect::<Vec<_>>(),
                        deleted
                    );
                    assert_eq!(
                        header.allowed(&filters, &[])?.iter().collect::<Vec<_>>(),
                        mask
                    );
                }
                *header.filter_masks.borrow_mut() = super::FilterMasks::default();
            }
        }
        Ok(())
    }

    #[test]
    fn attribute_reuse_limit_keeps_uncached_rows_and_later_queries_correct()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents = (0..5000)
            .map(|index| {
                Document::from_native_value(json!({
                    "id": format!("{index:05}"), "text": "target",
                    "attributes": {"group": index % 2100}
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let header = build(documents, None)?.header;
        for filters in [
            vec![Filter {
                field: "group".into(),
                op: "gte".into(),
                value: json!(2048),
            }],
            vec![Filter {
                field: "group".into(),
                op: "eq".into(),
                value: json!(17),
            }],
            vec![Filter {
                field: "missing".into(),
                op: "exists".into(),
                value: json!(false),
            }],
            vec![Filter {
                field: "group".into(),
                op: "eq".into(),
                value: json!("x".repeat(24000)),
            }],
        ] {
            let expected = header
                .documents
                .iter()
                .map(|document| {
                    let attributes = serde_json::from_str(document.attributes.get())
                        .map_err(|cause| cause.to_string())?;
                    super::matches(&attributes, &filters)
                })
                .collect::<Result<Vec<_>, String>>()?;
            assert_eq!(
                header.allowed(&filters, &[])?.iter().collect::<Vec<_>>(),
                expected
            );
            assert!(!header.allowed(&filters, &[17, 2117])?[17]);
            assert!(!header.allowed(&filters, &[17, 2117])?[2117]);
            assert_eq!(
                header.allowed(&filters, &[])?.iter().collect::<Vec<_>>(),
                expected
            );
            let cache = header.filter_masks.borrow();
            assert!(cache.representatives.is_some());
            assert!(cache.bytes <= FILTER_CACHE_BYTES);
            assert_eq!(
                cache.bytes,
                cache
                    .entries
                    .iter()
                    .map(|(_, _, bytes)| bytes)
                    .sum::<usize>()
                    + cache
                        .representatives
                        .as_ref()
                        .map_or(0, |(scope, rows)| scope.capacity()
                            + size_of_val(rows.as_ref())
                            + 128)
            );
        }
        for index in 0..20 {
            let filter = Filter {
                field: format!("missing{index}"),
                op: "exists".into(),
                value: json!(false),
            };
            assert_eq!(
                header.allowed(&[filter], &[])?.iter().collect::<Vec<_>>(),
                vec![true; 5000]
            );
            let cache = header.filter_masks.borrow();
            assert!(cache.bytes <= FILTER_CACHE_BYTES);
            if let Some((scope, _)) = &cache.representatives {
                let fields: BTreeSet<String> = serde_json::from_str(scope)?;
                assert!(fields.len() <= 16);
            }
        }
        let filter = Filter {
            field: "group".into(),
            op: "eq".into(),
            value: json!(17),
        };
        let expected: Vec<_> = (0..5000).map(|row| row % 2100 == 17).collect();
        assert_eq!(
            header.allowed(&[filter], &[])?.iter().collect::<Vec<_>>(),
            expected
        );
        Ok(())
    }

    #[test]
    fn reused_filter_values_still_validate_unselected_attributes()
    -> Result<(), Box<dyn std::error::Error>> {
        for input in [
            r#"{"ignored":1e999,"group":1}"#,
            r#"{"ignored":{"nested":1e999},"group":1}"#,
        ] {
            let document = Document::from_native_value(json!({
                "id":"a", "text":"target", "attributes":{}
            }))?;
            let mut header = build(vec![document], None)?.header;
            header.documents.attributes.dense_mut()[0] =
                serde_json::value::RawValue::from_string(input.into())?.into();
            assert!(
                header
                    .allowed(
                        &[Filter {
                            field: "group".into(),
                            op: "eq".into(),
                            value: json!(1),
                        }],
                        &[]
                    )
                    .is_err()
            );
        }
        Ok(())
    }

    #[test]
    fn packed_mask_lengths_and_capacity_charge_are_exact() {
        for length in [0, 1, 31, 32, 33, 10_000] {
            let mut mask = BitVec::from_elem(length, true);
            assert_eq!(mask.len(), length);
            assert!(mask.iter().all(|bit| bit));
            assert_eq!(mask.capacity().div_ceil(8), length.div_ceil(32) * 4);
            if length > 0 {
                mask.set(length - 1, false);
                assert!(!mask[length - 1]);
                assert!(mask.iter().take(length - 1).all(|bit| bit));
            }
        }
    }

    #[test]
    fn packed_cache_retains_sixteen_fifo_masks_without_tombstones()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents = (0..10_000)
            .map(|index| {
                Document::from_native_value(json!({
                    "id": format!("{index}"), "text": "target", "attributes": {"group": index}
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let header = build(documents, None)?.header;
        let filters = (0..17)
            .map(|value| Filter {
                field: "group".into(),
                op: "eq".into(),
                value: json!(value),
            })
            .collect::<Vec<_>>();
        for filter in filters.iter().take(16) {
            header.allowed(std::slice::from_ref(filter), &[])?;
        }
        {
            let cache = header.filter_masks.borrow();
            assert_eq!(cache.entries.len(), 16);
            assert!(cache.bytes <= FILTER_CACHE_BYTES);
        }
        let first = filters.first().ok_or("missing first filter")?;
        assert!(!header.allowed(std::slice::from_ref(first), &[0])?[0]);
        assert!(header.allowed(std::slice::from_ref(first), &[])?[0]);
        header.allowed(&filters[16..17], &[])?;
        let cache = header.filter_masks.borrow();
        assert_eq!(cache.entries.len(), 16);
        assert!(cache.bytes <= FILTER_CACHE_BYTES);
        let first_key = serde_json::to_string(std::slice::from_ref(first))?;
        assert!(cache.entries.iter().all(|(key, _, _)| key != &first_key));
        Ok(())
    }

    #[test]
    fn masks_are_bounded_and_tombstones_remain_query_local()
    -> Result<(), Box<dyn std::error::Error>> {
        let document = Document::from_native_value(json!({
            "id": "a", "text": "target", "attributes": {"group": 0}
        }))?;
        let header = build(vec![document], None)?.header;
        for index in 0..128 {
            let filter = Filter {
                field: "group".into(),
                op: "eq".into(),
                value: json!(format!("{}{}", "x".repeat(2500), index)),
            };
            assert_eq!(
                header.allowed(&[filter], &[])?.iter().collect::<Vec<_>>(),
                vec![false]
            );
            let cache = header.filter_masks.borrow();
            assert!(cache.bytes <= FILTER_CACHE_BYTES);
            assert!(cache.entries.len() <= 16);
        }
        let filters = vec![Filter {
            field: "group".into(),
            op: "eq".into(),
            value: json!(0),
        }];
        assert_eq!(
            header.allowed(&filters, &[])?.iter().collect::<Vec<_>>(),
            vec![true]
        );
        assert_eq!(
            header.allowed(&filters, &[0])?.iter().collect::<Vec<_>>(),
            vec![false]
        );
        assert_eq!(
            header.allowed(&filters, &[])?.iter().collect::<Vec<_>>(),
            vec![true]
        );
        assert!(!serde_json::to_string(&header)?.contains("filter_masks"));
        Ok(())
    }
}

#[cfg(test)]
mod numeric_contract_tests {
    use super::{Statistics, TermScorer, bloom_build, bloom_contains, contribution, count_as_f64};

    #[test]
    fn title_weight_preserves_fused_scores_at_numeric_boundaries() {
        let totals = [
            0,
            1,
            2,
            u64::from(u32::MAX),
            9_007_199_254_740_993,
            u64::MAX,
        ];
        let counts = [0, 1, 2, 127, u32::MAX];
        for documents in totals {
            for total in totals {
                let statistics = Statistics {
                    documents,
                    title_length: total,
                    body_length: u64::MAX - total,
                    frequencies: std::collections::BTreeMap::new(),
                };
                for df in [0, 1, documents, documents.saturating_add(1)] {
                    let scorer = TermScorer::new(&statistics, df);
                    for title in counts {
                        for body in counts {
                            for title_length in counts {
                                for body_length in counts {
                                    let expected = scorer.idf.map_or(0.0, |idf| {
                                        let tf =
                                            contribution(title, title_length, scorer.title_average)
                                                .mul_add(
                                                    2.0,
                                                    contribution(
                                                        body,
                                                        body_length,
                                                        scorer.body_average,
                                                    ),
                                                );
                                        idf * tf * 2.2 / (tf + 1.2)
                                    });
                                    assert_eq!(
                                        scorer
                                            .score(title, body, title_length, body_length)
                                            .to_bits(),
                                        expected.to_bits()
                                    );
                                    assert_eq!(
                                        scorer
                                            .score_normalized(
                                                title,
                                                body,
                                                scorer.denominators(title_length, body_length),
                                            )
                                            .to_bits(),
                                        expected.to_bits()
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn statistic_conversion_rounds_full_width_counts_without_truncation() {
        let cases: [(u64, f64); 6] = [
            (0, 0.0),
            (u64::from(u32::MAX), 4_294_967_295.0),
            (u64::from(u32::MAX) + 1, 4_294_967_296.0),
            (9_007_199_254_740_993, 9_007_199_254_740_992.0),
            (9_007_199_254_740_995, 9_007_199_254_740_996.0),
            (u64::MAX, 18_446_744_073_709_551_616.0),
        ];
        for (value, expected) in cases {
            assert_eq!(count_as_f64(value).to_bits(), expected.to_bits());
        }
    }

    #[test]
    fn empty_bloom_remains_valid_and_oversized_bloom_is_rejected()
    -> Result<(), Box<dyn std::error::Error>> {
        assert!(!bloom_contains(&[], "a")?);
        assert!(!bloom_contains(&bloom_build(&[])?, "a")?);
        assert!(bloom_contains(&vec![0; super::MAX_BYTES + 1], "a").is_err());
        Ok(())
    }
}

#[cfg(test)]
mod scoring_tests {
    use super::{Statistics, TermScorer, contribution, count_as_f64};
    use std::collections::BTreeMap;

    #[test]
    fn prepared_scores_preserve_original_floating_point_results() {
        for documents in [0, 1, 10_000, 9_007_199_254_740_993] {
            for df in [0, 1, documents, documents + 1] {
                for (title_length, body_length) in [(0, 0), (1, 17), (37, 1_000_000)] {
                    let statistics = Statistics {
                        documents,
                        title_length,
                        body_length,
                        frequencies: BTreeMap::new(),
                    };
                    let scorer = TermScorer::new(&statistics, df);
                    for (a, b, x, y) in [(0, 0, 0, 0), (1, 3, 5, 17), (37, 1024, 64, 2048)] {
                        let original = if documents == 0 || df == 0 || df > documents {
                            0.0
                        } else {
                            let n = count_as_f64(documents);
                            let tf = contribution(a, x, count_as_f64(title_length) / n)
                                .mul_add(2.0, contribution(b, y, count_as_f64(body_length) / n));
                            let idf =
                                ((n - count_as_f64(df) + 0.5) / (count_as_f64(df) + 0.5)).ln_1p();
                            idf * tf * 2.2 / (tf + 1.2)
                        };
                        assert_eq!(scorer.score(a, b, x, y).to_bits(), original.to_bits());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod posting_decode_tests {
    use super::{append, decode_posting_rows, decode_postings};

    #[test]
    fn positional_fields_keep_order_and_reject_malformed_varints()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut valid = Vec::new();
        append(&mut valid, &[1, 0, 2, 0, 2, 1, 3])?;
        let rows = decode_postings(&valid)?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, [0, 2]);
        assert_eq!(rows[0].body, [3]);
        for (data, expected) in [
            (vec![1, 0, 2, 0, 0, 0], "Duplicate token position"),
            (vec![1, 0, 0, 2, 0, 0], "Duplicate token position"),
            (vec![1, 0, 0, 0], "Empty posting"),
            (vec![1, 0, 0, 3, 1], "Invalid position count"),
            (vec![1, 0, 0, 1, 128], "Truncated varint"),
            (
                vec![1, 0, 0, 1, 255, 255, 255, 255, 16],
                "Overflowing varint",
            ),
            (
                vec![1, 0, 0, 2, 255, 255, 255, 255, 15, 1],
                "Position overflow",
            ),
            (vec![1, 0, 0, 1, 0, 7], "Trailing posting bytes"),
            (vec![2, 0, 0, 1, 0, 0, 0, 1, 0], "Duplicate posting row"),
            (vec![129, 1], "Posting block exceeds 128 rows"),
        ] {
            let mut page = Vec::new();
            append(&mut page, &data)?;
            assert_eq!(decode_postings(&page).err().as_deref(), Some(expected));
            assert_eq!(
                decode_posting_rows::<false, _>(&page, |row, title, body| (
                    row,
                    title.count,
                    body.count
                ))
                .err()
                .as_deref(),
                Some(expected)
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod frequency_tests {
    use super::{Document, Filter, PostingLists, Search, Statistics, append, build};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::mem::size_of;
    use std::rc::Rc;

    #[test]
    fn frequency_lists_match_positional_scoring_and_reduce_retained_capacity()
    -> Result<(), Box<dyn std::error::Error>> {
        for (repetitions, total_body_length) in [(1, 759), (64, 48_576)] {
            let docs: Vec<Document> = (0..256)
                .map(|index| {
                    Document::native(
                        format!("{index:05}"),
                        0,
                        "beta alpha",
                        "alpha beta alpha ".repeat(repetitions),
                        BTreeMap::from([("group".into(), json!(index % 4))]),
                        None,
                    )
                })
                .collect();
            let built = build(docs, None)?;
            let base = super::parse_header(&built.bytes)?.1;
            let header = Rc::new(built.header);
            for mode in ["any", "all"] {
                let mut searches = Vec::new();
                for positional in [false, true] {
                    let stored_mode = if positional { "phrase" } else { mode };
                    let mut search = Search::new(
                        header.clone(),
                        Statistics {
                            documents: 253,
                            title_length: 506,
                            body_length: total_body_length,
                            frequencies: BTreeMap::from([
                                ("alpha".into(), 253),
                                ("beta".into(), 253),
                            ]),
                        },
                        "alpha beta",
                        stored_mode,
                        100,
                        &[1, 3, 5],
                        &[Filter {
                            field: "group".into(),
                            op: "eq".into(),
                            value: json!(3),
                        }],
                    )?;
                    search.mode = mode.into();
                    for (term, metadata) in header.terms() {
                        for block in &metadata.blocks {
                            let start = base + block.data.offset as usize;
                            search.add(
                                term,
                                &built.bytes[start..start + block.data.length as usize],
                            )?;
                        }
                    }
                    searches.push(search);
                }
                assert_eq!(searches[0].finish()?, searches[1].finish()?);
                let compact = match &searches[0].lists {
                    PostingLists::Frequencies(lists) => lists
                        .values()
                        .map(|list| list.capacity() * size_of::<super::FrequencyPosting>())
                        .sum::<usize>(),
                    PostingLists::Positions(_) => return Err("Expected frequencies".into()),
                };
                let positional = match &searches[1].lists {
                    PostingLists::Positions(lists) => lists
                        .values()
                        .map(|list| {
                            list.capacity() * size_of::<super::Posting>()
                                + list
                                    .iter()
                                    .map(|posting| {
                                        (posting.title.capacity() + posting.body.capacity())
                                            * size_of::<u32>()
                                    })
                                    .sum::<usize>()
                        })
                        .sum::<usize>(),
                    PostingLists::Frequencies(_) => return Err("Expected positions".into()),
                };
                assert!(compact * 2 < positional);
                if repetitions == 64 {
                    assert!(compact * 10 < positional);
                }
            }
        }
        Ok(())
    }

    #[test]
    fn frequency_decoding_still_checks_positions_against_document_lengths()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = build(
            super::documents_from_native_value(json!([
                {"id":"a","text":"alpha beta alpha","attributes":{}}
            ]))?,
            None,
        )?;
        let mut page = Vec::new();
        append(&mut page, &[1, 0, 0, 1, 3])?;
        for mode in ["any", "all", "phrase"] {
            let mut search = Search::new(
                built.header.clone(),
                Statistics {
                    documents: 1,
                    title_length: 0,
                    body_length: 3,
                    frequencies: BTreeMap::from([("alpha".into(), 1)]),
                },
                "alpha",
                mode,
                10,
                &[],
                &[],
            )?;
            assert_eq!(
                search.add("alpha", &page).err().as_deref(),
                Some("Invalid token position")
            );
        }
        Ok(())
    }

    #[test]
    fn excluded_rows_do_not_hide_corruption_or_disordered_blocks()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = build(
            super::documents_from_native_value(json!([
                {"id":"a","text":"alpha","attributes":{}},
                {"id":"b","text":"alpha","attributes":{}},
                {"id":"c","text":"alpha","attributes":{}}
            ]))?,
            None,
        )?;
        let mut later = Vec::new();
        append(&mut later, &[1, 2, 0, 1, 0])?;
        let mut earlier = Vec::new();
        append(&mut earlier, &[1, 1, 0, 1, 0])?;
        let mut invalid = Vec::new();
        append(&mut invalid, &[1, 2, 0, 1, 1])?;
        for mode in ["any", "all", "phrase"] {
            let mut search = Search::new(
                built.header.clone(),
                Statistics {
                    documents: 3,
                    title_length: 0,
                    body_length: 3,
                    frequencies: BTreeMap::from([("alpha".into(), 3)]),
                },
                "alpha",
                mode,
                10,
                &[0, 1, 2],
                &[],
            )?;
            search.add("alpha", &later)?;
            assert_eq!(search.finish()?, Vec::<super::Hit>::new());
            assert_eq!(search.last_decoded_rows.get("alpha"), Some(&Some(2)));
            match &search.lists {
                PostingLists::Positions(lists) => assert!(lists.values().all(Vec::is_empty)),
                PostingLists::Frequencies(lists) => assert!(lists.values().all(Vec::is_empty)),
            }
            assert_eq!(
                search.add("alpha", &earlier).err().as_deref(),
                Some("Posting blocks out of order")
            );
            assert_eq!(
                search.add("alpha", &invalid).err().as_deref(),
                Some("Invalid token position")
            );
        }
        Ok(())
    }

    #[test]
    fn retained_eligible_rows_match_a_full_list_reference_in_every_mode()
    -> Result<(), Box<dyn std::error::Error>> {
        let docs: Vec<Document> = (0..256)
            .map(|index| {
                Document::native(
                    format!("{index:05}"),
                    0,
                    String::new(),
                    "alpha beta alpha",
                    BTreeMap::from([("group".into(), json!(index % 8))]),
                    None,
                )
            })
            .collect();
        let built = build(docs, None)?;
        let base = super::parse_header(&built.bytes)?.1;
        let header = Rc::new(built.header);
        for mode in ["any", "all", "phrase"] {
            let mut searches = Vec::new();
            for full in [false, true] {
                let mut search = Search::new(
                    header.clone(),
                    Statistics {
                        documents: 253,
                        title_length: 0,
                        body_length: 759,
                        frequencies: BTreeMap::from([("alpha".into(), 253), ("beta".into(), 253)]),
                    },
                    "alpha beta",
                    mode,
                    100,
                    &[0, 8, 16],
                    &[Filter {
                        field: "group".into(),
                        op: "eq".into(),
                        value: json!(0),
                    }],
                )?;
                let allowed = search.allowed.clone();
                if full {
                    search.allowed.fill(true);
                }
                for (term, metadata) in header.terms() {
                    for block in &metadata.blocks {
                        let start = base + block.data.offset as usize;
                        search.add(
                            term,
                            &built.bytes[start..start + block.data.length as usize],
                        )?;
                    }
                }
                search.allowed = allowed;
                searches.push(search);
            }
            assert_eq!(searches[0].finish()?, searches[1].finish()?);
            let sizes: Vec<_> = searches
                .iter()
                .map(|search| match &search.lists {
                    PostingLists::Positions(lists) => lists.values().map(Vec::len).sum::<usize>(),
                    PostingLists::Frequencies(lists) => lists.values().map(Vec::len).sum::<usize>(),
                })
                .collect();
            assert_eq!(sizes, [58, 512]);
            assert_eq!(searches[0].last_decoded_rows, searches[1].last_decoded_rows);
        }
        Ok(())
    }
}

#[cfg(test)]
mod common_term_projection_tests {
    use super::{Document, build};
    use serde_json::{Value, json};

    #[test]
    fn common_term_projection_uses_complete_quantile_groups()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents: Vec<Document> = (0..40)
            .map(|index| {
                let title = std::iter::repeat_n(format!("filler{index:02}"), index)
                    .collect::<Vec<_>>()
                    .join(" ");
                json!({
                    "id": format!("doc{index:02}"),
                    "title": title,
                    "text": "alpha beta",
                    "attributes": {}
                })
            })
            .map(Document::from_native_value)
            .collect::<Result<_, _>>()?;
        let built = build(documents, None)?;
        let projection: Value = serde_json::from_str(
            built
                .common_projection
                .as_deref()
                .ok_or("Expected bounded common-term projection")?,
        )?;
        assert_eq!(projection["terms"], json!(["alpha", "beta"]));
        let partitions = projection["partitions"]
            .as_array()
            .ok_or("Missing projection partitions")?;
        assert_eq!(partitions.len(), 32);
        assert_eq!(
            projection["independent"],
            json!([[[0, 1, 0, 2]], [[0, 1, 0, 2]]])
        );
        for (group, partition) in partitions.iter().enumerate() {
            let rows: Vec<_> = (0..40).filter(|row| row * 32 / 40 == group).collect();
            let minimum_title = *rows.iter().min().ok_or("Empty projection group")?;
            assert_eq!(
                partition,
                &json!([[0, 1, minimum_title, 2], [0, 1, minimum_title, 2]])
            );
        }
        Ok(())
    }

    #[test]
    fn common_term_projection_is_omitted_when_encoded_budget_is_exceeded()
    -> Result<(), Box<dyn std::error::Error>> {
        let terms: Vec<_> = (0..16)
            .map(|index| format!("term{index:02}{}", "x".repeat(58)))
            .collect();
        let body = terms.join(" ");
        let documents: Vec<Document> = (0..32)
            .map(|index| {
                let title = std::iter::repeat_n(format!("filler{index:02}"), index)
                    .collect::<Vec<_>>()
                    .join(" ");
                json!({
                    "id": format!("doc{index:02}"),
                    "title": title,
                    "text": body,
                    "attributes": {}
                })
            })
            .map(Document::from_native_value)
            .collect::<Result<_, _>>()?;
        let built = build(documents, None)?;
        assert!(built.common_projection.is_none());
        Ok(())
    }

    #[test]
    fn common_term_projection_keeps_independent_block_bounds_when_length_groups_coarsen()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents: Vec<Document> = (0..287)
            .map(|index| {
                let (id, text) = match index {
                    0..=127 => (format!("a{index:03}"), "alpha low".to_owned()),
                    128..=255 => (
                        format!("b{:03}", index - 128),
                        format!("{}{}", "alpha ".repeat(50), "high ".repeat(50)),
                    ),
                    _ => {
                        let length = 101 + index - 256;
                        (
                            format!("c{:02}", index - 256),
                            std::iter::repeat_n(format!("pad{index}"), length)
                                .collect::<Vec<_>>()
                                .join(" "),
                        )
                    }
                };
                json!({ "id": id, "text": text, "attributes": {} })
            })
            .map(Document::from_native_value)
            .collect::<Result<_, _>>()?;
        let built = build(documents, None)?;
        let projection: Value = serde_json::from_str(
            built
                .common_projection
                .as_deref()
                .ok_or("Expected bounded common-term projection")?,
        )?;
        let terms = projection["terms"]
            .as_array()
            .ok_or("Missing projection terms")?;
        let alpha = terms
            .iter()
            .position(|term| term == "alpha")
            .ok_or("Missing alpha projection")?;
        assert_eq!(projection["partitions"][0][alpha], json!([0, 50, 0, 2]));
        assert_eq!(
            projection["independent"][alpha],
            json!([[0, 1, 0, 2], [0, 50, 0, 100]])
        );
        assert!(
            serde_json::to_vec(&projection)?.len() <= 4096,
            "projection exceeded encoded budget"
        );
        Ok(())
    }
}

#[cfg(test)]
mod candidate_tests {
    use super::{Search, Statistics, build};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::rc::Rc;

    #[test]
    fn reusable_candidates_preserve_phrase_order_and_exclusions()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents = super::documents_from_native_value(json!([
            {"id":"a","text":"beta alpha beta","attributes":{}},
            {"id":"b","text":"alpha beta alpha","attributes":{}},
            {"id":"c","text":"alpha beta","attributes":{}},
            {"id":"d","text":"beta beta alpha","attributes":{}}
        ]))?;
        let built = build(documents, None)?;
        let base = super::parse_header(&built.bytes)?.1;
        let header = Rc::new(built.header);
        for (text, dead, expected) in [
            ("alpha beta alpha", vec![], vec![1]),
            ("beta alpha beta", vec![], vec![0]),
            ("alpha alpha", vec![], vec![]),
            ("alpha beta alpha", vec![1], vec![]),
        ] {
            let statistics = Statistics {
                documents: 4,
                title_length: 0,
                body_length: 11,
                frequencies: BTreeMap::from([("alpha".into(), 4), ("beta".into(), 4)]),
            };
            let mut search =
                Search::new(header.clone(), statistics, text, "phrase", 10, &dead, &[])?;
            for (term, meta) in header.terms() {
                if !search.words.iter().any(|word| word == term) {
                    continue;
                }
                for block in &meta.blocks {
                    let start = base + block.data.offset as usize;
                    search.add(
                        term,
                        &built.bytes[start..start + block.data.length as usize],
                    )?;
                }
            }
            assert_eq!(
                search
                    .finish()?
                    .iter()
                    .map(|hit| hit.row)
                    .collect::<Vec<_>>(),
                expected
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod page_buffer_tests {
    use super::{MAX_BYTES, append, decode_page};

    #[test]
    fn declared_output_length_and_integrity_remain_strict() -> Result<(), Box<dyn std::error::Error>>
    {
        for data in [Vec::new(), vec![7; 1], vec![11; 65_537]] {
            let mut payload = Vec::new();
            append(&mut payload, &data)?;
            assert_eq!(decode_page(&payload)?, data);
            let mut wrong_crc = payload.clone();
            wrong_crc[4] ^= 1;
            assert!(decode_page(&wrong_crc).is_err());
            for length in [0, 1, 65_536, 65_538, MAX_BYTES + 1] {
                if length == data.len() {
                    continue;
                }
                let mut corrupt = payload.clone();
                corrupt[..4].copy_from_slice(&u32::try_from(length)?.to_le_bytes());
                assert!(decode_page(&corrupt).is_err());
            }
            for removed in 1..=5 {
                assert!(decode_page(&payload[..payload.len() - removed]).is_err());
            }
            let mut bad_adler = payload.clone();
            if let Some(last) = bad_adler.last_mut() {
                *last ^= 1;
            }
            assert!(decode_page(&bad_adler).is_err());
        }
        Ok(())
    }
}

#[cfg(test)]
mod attribute_projection_tests {
    use super::SelectedAttributes;
    use serde::de::DeserializeSeed;
    use std::collections::{BTreeMap, BTreeSet};

    #[test]
    fn selected_attributes_preserve_value_validation_and_duplicate_keys() {
        let fields = BTreeSet::from(["wanted", "escaped\nkey"]);
        let deep_valid = format!("{{\"unused\":{}0{}}}", "[".repeat(126), "]".repeat(126));
        let deep_invalid = format!("{{\"unused\":{}0{}}}", "[".repeat(129), "]".repeat(129));
        let fixtures = [
            "{}",
            r#"{"wanted":1,"unused":[true,false,null,-7,18446744073709551615,1.5,"ação",{"nested":[1,2]}]}"#,
            r#"{"unused":{"escaped\nkey":"\u65e5\u672c\u8a9e","value":"\ud83d\ude00"},"wanted":{"nested":[1,null]}}"#,
            r#"{"wanted":1,"wanted":2,"unused":1,"unused":2,"escaped\nkey":false}"#,
            r#"{"unused":1e400}"#,
            r#"{"unused":[{"number":-1e400}]}"#,
            r#"{"unused":"\ud800"}"#,
            r#"{"unused":{"\ud800":1}}"#,
            r#"{"wanted":"\ud800"}"#,
            r#"{"unused":[1,]}"#,
            r#"{"unused":true} trailing"#,
            "[]",
            deep_valid.as_str(),
            deep_invalid.as_str(),
        ];
        for json in fixtures {
            let reference = serde_json::from_str::<BTreeMap<String, serde_json::Value>>(json);
            let mut decoder = serde_json::Deserializer::from_str(json);
            let projected = SelectedAttributes(&fields)
                .deserialize(&mut decoder)
                .and_then(|value| {
                    decoder.end()?;
                    Ok(value)
                });
            assert_eq!(projected.is_ok(), reference.is_ok(), "{json}");
            if let (Ok(projected), Ok(reference)) = (projected, reference) {
                let expected = reference
                    .into_iter()
                    .filter(|(key, _)| fields.contains(key.as_str()))
                    .collect::<BTreeMap<_, _>>();
                assert_eq!(projected, expected, "{json}");
            }
        }
    }
}

#[cfg(test)]
mod dense_cutoff_tests {
    use super::{Document, Filter, Hit, Search, Statistics, TermScorer, build};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn minimum_term_score_bounds_every_possible_nonempty_field_assignment() {
        let statistics = Statistics {
            documents: 100,
            title_length: 300,
            body_length: 1000,
            frequencies: BTreeMap::new(),
        };
        for df in [0, 1, 50, 100] {
            let scorer = TermScorer::new(&statistics, df);
            for title in [0, 1, 32] {
                for body in [0, 1, 64] {
                    let minimum = scorer.minimum_score(title, body);
                    for title_tf in 0..=title.min(4) {
                        for body_tf in 0..=body.min(4) {
                            if title_tf + body_tf > 0 {
                                assert!(minimum <= scorer.score(title_tf, body_tf, title, body));
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn length_reuse_preserves_exhaustive_cutoffs_with_collisions_filters_and_deletions()
    -> Result<(), Box<dyn std::error::Error>> {
        for stride in [1, 8] {
            let built = build(
                (0..1024)
                    .map(|row| {
                        Document::native(
                            format!("{row:05}"),
                            0,
                            "alpha ".repeat(row / stride % 7),
                            format!("alpha beta {}", "padding ".repeat(row / stride % 257)),
                            BTreeMap::from([("group".into(), json!(row % 3))]),
                            None,
                        )
                    })
                    .collect(),
                None,
            )?;
            let header = std::rc::Rc::new(built.header);
            let statistics = Statistics {
                documents: u64::try_from(header.documents.len())?,
                title_length: header.total_title_length(),
                body_length: header.total_body_length(),
                frequencies: header
                    .terms()
                    .iter()
                    .map(|(term, meta)| (term.to_owned(), u64::from(meta.df)))
                    .collect(),
            };
            for mode in ["any", "all"] {
                for top_k in [1, 10, 100] {
                    for dead in [Vec::new(), (0..256).collect(), (0..1024).collect()] {
                        for filters in [
                            Vec::new(),
                            vec![Filter {
                                field: "group".into(),
                                op: "eq".into(),
                                value: json!(1),
                            }],
                        ] {
                            let search = Search::new(
                                header.clone(),
                                statistics.clone(),
                                "beta alpha beta",
                                mode,
                                top_k,
                                &dead,
                                &filters,
                            )?;
                            let mut exhaustive: Vec<_> = header
                                .documents
                                .iter()
                                .enumerate()
                                .filter(|(row, _)| search.allowed[*row])
                                .map(|(row, document)| {
                                    Ok::<_, Box<dyn std::error::Error>>(Hit {
                                        row: u32::try_from(row)?,
                                        score: search.terms.scorers.iter().fold(
                                            0.0,
                                            |score, scorer| {
                                                score
                                                    + scorer.minimum_score(
                                                        document.title_length,
                                                        document.body_length,
                                                    )
                                            },
                                        ),
                                    })
                                })
                                .collect::<Result<_, _>>()?;
                            exhaustive.sort_by(|a, b| {
                                b.score.total_cmp(&a.score).then_with(|| a.row.cmp(&b.row))
                            });
                            let expected = exhaustive.get(top_k - 1);
                            let cutoff = search.dense_cutoff();
                            assert_eq!(
                                cutoff.as_ref().map(|hit| (hit.row, hit.score.to_bits())),
                                expected.map(|hit| (hit.row, hit.score.to_bits()))
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod eligible_bound_tests {
    use super::{
        Document, Filter, PostingLists, Search, Statistics, TermScorer, build, parse_header,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    fn documents() -> Vec<Document> {
        (0..384)
            .map(|row| {
                Document::native(
                    format!("{row:05}"),
                    0,
                    "alpha ".repeat(row % 2 * (row % 4 + 1)),
                    format!(
                        "{} {}",
                        match row % 3 {
                            0 => "alpha beta",
                            1 => "alpha gamma",
                            _ => "beta gamma",
                        },
                        "padding ".repeat(row % 2 * (row % 17 + 20))
                    ),
                    BTreeMap::from([("group".into(), json!(row % 2))]),
                    None,
                )
            })
            .collect()
    }

    #[test]
    fn eligible_bounds_cover_actual_scores_without_loosening_physical_bounds()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = build(documents(), None)?;
        let (header, base) = parse_header(&built.bytes)?;
        let statistics = Statistics {
            documents: u64::try_from(header.documents.len())?,
            title_length: header.total_title_length(),
            body_length: header.total_body_length(),
            frequencies: header
                .terms()
                .iter()
                .map(|(term, meta)| (term.to_owned(), u64::from(meta.df)))
                .collect(),
        };
        for filters in [
            Vec::new(),
            vec![Filter {
                field: "group".into(),
                op: "eq".into(),
                value: json!(1),
            }],
        ] {
            for dead in [Vec::new(), (0..256).collect()] {
                let mut search = Search::new(
                    header.clone(),
                    statistics.clone(),
                    "alpha beta gamma",
                    "any",
                    10,
                    &dead,
                    &filters,
                )?;
                for (term, metadata) in header.terms() {
                    if search.words.iter().any(|word| word == term) {
                        for block in &metadata.blocks {
                            let start = base + block.data.offset as usize;
                            search.add(
                                term,
                                &built.bytes[start..start + block.data.length as usize],
                            )?;
                        }
                    }
                }
                let terms: Vec<_> = search.words.iter().collect();
                let scorers: Vec<_> = terms
                    .iter()
                    .map(|term| TermScorer::new(&statistics, statistics.frequencies[*term]))
                    .collect();
                let bounds = search.block_bounds();
                let PostingLists::Frequencies(lists) = &search.lists else {
                    return Err("Expected frequencies".into());
                };
                for (index, term) in terms.iter().enumerate() {
                    for (block, bound) in &bounds[index] {
                        let physical = scorers[index].score(
                            block.max_tf[0],
                            block.max_tf[1],
                            block.min_length[0],
                            block.min_length[1],
                        );
                        assert!(*bound <= physical + 1e-12);
                        if !(block.first as usize..=block.last as usize)
                            .any(|row| search.allowed[row])
                        {
                            assert_eq!(bound.to_bits(), 0.0_f64.to_bits());
                        }
                        for posting in lists[*term].iter().filter(|posting| {
                            block.first <= posting.row && posting.row <= block.last
                        }) {
                            let document = header.documents.row(posting.row as usize);
                            let actual = scorers[index].score(
                                posting.title,
                                posting.body,
                                document.title_length,
                                document.body_length,
                            );
                            assert!(actual <= bound + 1e-12);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod cutoff_certificate_tests {
    use super::{
        BuiltSegment, Document, Filter, Hit, Search, Statistics, build, compare_document_ids,
    };
    use std::{cmp::Ordering, collections::BTreeMap};

    #[test]
    fn document_id_order_preserves_utf16_for_ascii_and_unicode_pairs() {
        let ids = [
            "",
            "a",
            "a\0",
            "a-a",
            "a0",
            "a9",
            "a\u{7f}",
            "a\u{80}",
            "ação",
            "\u{80}",
            "\u{d7ff}",
            "\u{e000}",
            "\u{ffff}",
            "\u{10000}",
            "😀",
            "😀a",
        ];
        for left in ids {
            for right in ids {
                assert_eq!(
                    compare_document_ids(left, right),
                    left.encode_utf16().cmp(right.encode_utf16()),
                    "{left:?} versus {right:?}"
                );
            }
        }
    }

    fn fixture() -> Result<BuiltSegment, String> {
        let documents = (0..384)
            .map(|row| {
                let id = match row {
                    0 => String::from("\u{e000}"),
                    1 => String::from("\u{10000}"),
                    _ => format!("row-{row:03}"),
                };
                Document::native(
                    id,
                    0,
                    "alpha ".repeat(row % 4),
                    format!(
                        "{} {}",
                        match row % 3 {
                            0 => "alpha beta",
                            1 => "beta alpha",
                            _ => "alpha padding beta",
                        },
                        "padding ".repeat(row % 17)
                    ),
                    BTreeMap::from([("group".into(), serde_json::json!(row % 2))]),
                    None,
                )
            })
            .collect();
        build(documents, None)
    }

    fn assert_cutoff_certificate(
        mut search: Search,
        built: &BuiltSegment,
        best: &Hit,
        base: usize,
        score: f64,
        id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let header = &built.header;
        let best_id = header.documents.row(best.row as usize).id;
        let spans: Vec<_> = search
            .posting_spans_after(score, id)?
            .into_iter()
            .map(|span| {
                (
                    span.term.to_owned(),
                    span.blocks
                        .iter()
                        .map(|block| block.data.clone())
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        for (word, pages) in spans {
            for page in pages {
                let start = base + usize::try_from(page.offset)?;
                search.add(
                    &word,
                    &built.bytes[start..start + usize::try_from(page.length)?],
                )?;
            }
        }
        let mut upper = score;
        let mut minimum_id = header.documents.first().ok_or("Missing source minimum")?.id;
        if compare_document_ids(minimum_id, id) == Ordering::Less {
            minimum_id = super::DocumentId::String(id);
        }
        for hit in search.finish()? {
            let hit_id = header.documents.row(hit.row as usize).id;
            match hit.score.total_cmp(&upper) {
                Ordering::Greater => {
                    upper = hit.score;
                    minimum_id = hit_id;
                }
                Ordering::Equal => {
                    if compare_document_ids(hit_id, minimum_id) == Ordering::Less {
                        minimum_id = hit_id;
                    }
                }
                Ordering::Less => {}
            }
        }
        assert!(
            best.score < upper
                || (best.score.total_cmp(&upper) == Ordering::Equal
                    && compare_document_ids(best_id, minimum_id) != Ordering::Less)
        );
        Ok(())
    }

    #[test]
    fn partial_postings_certify_the_complete_score_and_utf16_tie_bound()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = fixture()?;
        let header = &built.header;
        let base = super::parse_header(&built.bytes)?.1;
        let statistics = Statistics {
            documents: u64::try_from(header.documents.len())?,
            title_length: header.total_title_length(),
            body_length: header.total_body_length(),
            frequencies: header
                .terms()
                .iter()
                .map(|(word, meta)| (word.to_owned(), u64::from(meta.df)))
                .collect(),
        };
        for mode in ["any", "all", "phrase"] {
            for filters in [
                Vec::new(),
                vec![Filter {
                    field: "group".into(),
                    op: "eq".into(),
                    value: serde_json::json!(1),
                }],
            ] {
                for dead in [Vec::new(), (0..128).collect()] {
                    let mut complete = Search::new(
                        header.clone(),
                        statistics.clone(),
                        "alpha beta",
                        mode,
                        100,
                        &dead,
                        &filters,
                    )?;
                    for (word, metadata) in header.terms() {
                        if word == "alpha" || word == "beta" {
                            for block in &metadata.blocks {
                                let start = base + usize::try_from(block.data.offset)?;
                                complete.add(
                                    word,
                                    &built.bytes
                                        [start..start + usize::try_from(block.data.length)?],
                                )?;
                            }
                        }
                    }
                    let all = complete.finish()?;
                    let best = all.first().ok_or("Missing complete hit")?;
                    let best_id = header.documents.row(best.row as usize).id;
                    for score in [best.score - 1e-13, best.score, best.score + 1e-13] {
                        for id in [
                            "",
                            "row-150",
                            "\u{10000}",
                            "\u{e000}",
                            best_id.native_str()?,
                        ] {
                            for top_k in [1, 10, 100] {
                                let partial = Search::new(
                                    header.clone(),
                                    statistics.clone(),
                                    "alpha beta",
                                    mode,
                                    top_k,
                                    &dead,
                                    &filters,
                                )?;
                                assert_cutoff_certificate(partial, &built, best, base, score, id)?;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod required_term_tests {
    use super::{
        Document, Posting, PostingRow, Search, Statistics, build, decode_postings, parse_header,
    };
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::rc::Rc;

    struct CountedPosting {
        posting: Posting,
        calls: Rc<Cell<usize>>,
    }

    impl PostingRow for CountedPosting {
        fn row(&self) -> u32 {
            self.posting.row
        }
        fn counts(&self) -> [usize; 2] {
            self.calls.set(self.calls.get() + 1);
            [self.posting.title.len(), self.posting.body.len()]
        }
        fn positions(&self) -> [&[u32]; 2] {
            [&self.posting.title, &self.posting.body]
        }
    }

    fn exhaustive(
        search: &Search,
        lists: &BTreeMap<String, Vec<CountedPosting>>,
    ) -> Result<Vec<super::Hit>, Box<dyn std::error::Error>> {
        let mut hits = Vec::new();
        for (row, document) in search.header.documents.iter().enumerate() {
            if !search.allowed[row] {
                continue;
            }
            let row = u32::try_from(row)?;
            let mut score = 0.0;
            for (index, term) in search.terms.order.iter().enumerate() {
                if let Some(postings) = lists.get(&search.words[*term])
                    && let Ok(position) = postings.binary_search_by_key(&row, |p| p.posting.row)
                {
                    let posting = &postings[position].posting;
                    score += search.terms.scorers[index].score(
                        u32::try_from(posting.title.len())?,
                        u32::try_from(posting.body.len())?,
                        document.title_length,
                        document.body_length,
                    );
                }
            }
            if score > 0.0 {
                hits.push(super::Hit { row, score });
            }
        }
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.row.cmp(&b.row)));
        hits.truncate(search.top_k);
        Ok(hits)
    }

    #[test]
    fn a_required_rare_term_avoids_scoring_common_only_rows()
    -> Result<(), Box<dyn std::error::Error>> {
        let docs = (0..4096)
            .map(|row| {
                Document::native(
                    format!("{row:05}"),
                    1,
                    String::new(),
                    format!(
                        "{} {}",
                        "alpha beta gamma ".repeat(8 + row % 8),
                        if row % 97 == 0 { "needle" } else { "filler" }
                    ),
                    BTreeMap::new(),
                    None,
                )
            })
            .collect();
        let built = build(docs, None)?;
        let (header, base) = parse_header(&built.bytes)?;
        let statistics = Statistics {
            documents: u64::try_from(header.documents.len())?,
            title_length: header.total_title_length(),
            body_length: header.total_body_length(),
            frequencies: header
                .terms()
                .iter()
                .map(|(term, meta)| (term.to_owned(), u64::from(meta.df)))
                .collect(),
        };
        let search = Search::new(
            header.clone(),
            statistics,
            "alpha beta gamma needle",
            "any",
            10,
            &[],
            &[],
        )?;
        let calls = Rc::new(Cell::new(0));
        let mut lists = BTreeMap::new();
        for term in ["alpha", "beta", "gamma", "needle"] {
            let metadata = header.terms().get(term).ok_or("Missing term")?;
            let mut postings = Vec::new();
            for block in &metadata.blocks {
                let start = base + block.data.offset as usize;
                postings.extend(
                    decode_postings(&built.bytes[start..start + block.data.length as usize])?
                        .into_iter()
                        .map(|posting| CountedPosting {
                            posting,
                            calls: calls.clone(),
                        }),
                );
            }
            lists.insert(term.into(), postings);
        }
        let hits = search.finish_lists(&lists)?;
        assert_eq!(hits, exhaustive(&search, &lists)?);
        assert_eq!(hits.len(), 10);
        assert!(hits.iter().all(|hit| hit.row % 97 == 0));
        assert!(
            calls.get() < 8000,
            "scored frequency reads: {}",
            calls.get()
        );
        Ok(())
    }

    #[test]
    fn required_terms_preserve_exhaustive_scores_with_filters_deletions_and_changed_statistics()
    -> Result<(), Box<dyn std::error::Error>> {
        let docs = (0..1024)
            .map(|row| {
                Document::native(
                    format!("{row:05}"),
                    1,
                    if row % 97 == 0 {
                        "needle alpha".into()
                    } else {
                        "gamma ".repeat(row % 3)
                    },
                    format!(
                        "{} {} {} {} {}",
                        "alpha ".repeat(row % 5),
                        "beta ".repeat(row % 7),
                        "gamma ".repeat(row % 11),
                        if row % 53 == 0 { "scarce" } else { "filler" },
                        "padding ".repeat(row % 17)
                    ),
                    BTreeMap::from([("group".into(), serde_json::json!(row % 2))]),
                    None,
                )
            })
            .collect();
        let built = build(docs, None)?;
        let (header, base) = parse_header(&built.bytes)?;
        let calls = Rc::new(Cell::new(0));
        let mut lists = BTreeMap::new();
        for term in ["alpha", "beta", "gamma", "needle", "scarce"] {
            let mut postings = Vec::new();
            for block in &header.terms().get(term).ok_or("Missing term")?.blocks {
                let start = base + block.data.offset as usize;
                postings.extend(
                    decode_postings(&built.bytes[start..start + block.data.length as usize])?
                        .into_iter()
                        .map(|posting| CountedPosting {
                            posting,
                            calls: calls.clone(),
                        }),
                );
            }
            lists.insert(term.into(), postings);
        }
        for factor in [1, 3] {
            let statistics = Statistics {
                documents: u64::try_from(header.documents.len())? * factor,
                title_length: header.total_title_length() * factor + 1000,
                body_length: header.total_body_length() * factor + 1234,
                frequencies: header
                    .terms()
                    .iter()
                    .map(|(term, meta)| (term.to_owned(), u64::from(meta.df) * factor))
                    .collect(),
            };
            for query in [
                "alpha beta gamma needle",
                "alpha beta gamma scarce",
                "alpha beta gamma needle scarce",
            ] {
                for top_k in [1, 10, 100] {
                    for dead in [Vec::new(), (0..1024).step_by(5).collect()] {
                        for filters in [
                            Vec::new(),
                            vec![super::Filter {
                                field: "group".into(),
                                op: "eq".into(),
                                value: serde_json::json!(1),
                            }],
                        ] {
                            let search = Search::new(
                                header.clone(),
                                statistics.clone(),
                                query,
                                "any",
                                top_k,
                                &dead,
                                &filters,
                            )?;
                            assert_eq!(search.finish_lists(&lists)?, exhaustive(&search, &lists)?);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod uniform_hits_tests {
    use super::{BuiltSegment, Document, Filter, Search, Statistics, build};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::rc::Rc;

    fn fixture(placement: &str) -> Result<BuiltSegment, Box<dyn std::error::Error>> {
        let documents = (0..260)
            .map(|index| {
                let id = match index {
                    258 => "\u{e000}".to_owned(),
                    259 => "😀".to_owned(),
                    _ => format!("{index:03}"),
                };
                let (title, text) = match placement {
                    "title" => (format!("alpha beta {}", "filler ".repeat(index % 5)), "noise".to_owned()),
                    "mixed" => (format!("alpha {}", "filler ".repeat(index % 5)), format!("beta {}", "noise ".repeat(index % 7))),
                    "wide" => ("filler ".repeat(index % 5), format!("alpha beta {}", "noise ".repeat(index % 67))),
                    _ => ("heading".to_owned(), format!("alpha beta {}", "noise ".repeat(index % 7))),
                };
                Document::from_native_value(json!({"id":id,"title":title,"text":text,"attributes":{"group":index%3,"empty":null}}))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(build(documents, None)?)
    }

    fn statistics(zero: bool) -> Statistics {
        if zero {
            return Statistics {
                documents: 0,
                title_length: 0,
                body_length: 0,
                frequencies: BTreeMap::from([("alpha".into(), 0), ("beta".into(), 0)]),
            };
        }
        Statistics {
            documents: 997,
            title_length: 17123,
            body_length: 28441,
            frequencies: BTreeMap::from([("alpha".into(), 421), ("beta".into(), 699)]),
        }
    }

    #[test]
    fn uniform_hits_match_full_postings_exactly() -> Result<(), Box<dyn std::error::Error>> {
        let filters: Vec<Vec<Filter>> = serde_json::from_value(json!([
            [],
            [{"field":"group","op":"eq","value":1}],
            [{"field":"group","op":"eq","value":999}],
            [{"field":"absent","op":"exists","value":false}],
            [{"field":"empty","op":"eq","value":null}]
        ]))?;
        for placement in ["body", "title", "mixed", "wide"] {
            let built = fixture(placement)?;
            let base = super::parse_header(&built.bytes)?.1;
            let header = Rc::new(built.header);
            for (text, mode) in [
                ("alpha beta", "any"),
                ("beta alpha alpha", "any"),
                ("beta alpha", "all"),
                ("alpha alpha", "all"),
                ("alpha", "phrase"),
            ] {
                for predicates in &filters {
                    for dead in [vec![], vec![0, 129, 259]] {
                        for top_k in [1, 10, 100] {
                            for zero in [false, true] {
                                let mut search = Search::new(
                                    header.clone(),
                                    statistics(zero),
                                    text,
                                    mode,
                                    top_k,
                                    &dead,
                                    predicates,
                                )?;
                                let uniform =
                                    search.uniform_hits().ok_or("Expected uniform proof")?;
                                for (term, metadata) in header.terms() {
                                    if !search.words.iter().any(|word| word == term) {
                                        continue;
                                    }
                                    for block in &metadata.blocks {
                                        let start = base + block.data.offset as usize;
                                        search.add(
                                            term,
                                            &built.bytes[start..start + block.data.length as usize],
                                        )?;
                                    }
                                }
                                assert_eq!(uniform, search.finish()?);
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    #[test]
    fn uniform_hits_reject_incomplete_or_nonuniform_metadata()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = fixture("body")?;
        for defect in [
            "empty-blocks",
            "sparse-df",
            "count",
            "first",
            "gap",
            "last",
            "zero-range",
            "overflow-range",
            "range-order",
            "body-tf",
            "both-fields",
            "mixed-field",
            "zero-body-length",
            "zero-title-length",
            "empty-documents",
        ] {
            let mut header = if defect == "zero-title-length" {
                fixture("title")?.header
            } else {
                built.header.clone()
            };
            if defect == "zero-title-length" {
                header.documents.lengths[0].set(0, 0);
            } else if defect == "zero-body-length" {
                header.documents.lengths[1].set(0, 0);
            } else if defect == "empty-documents" {
                header.documents = super::DocumentTable::from(Vec::new());
            } else {
                let term = header.terms_mut().get_mut("alpha").ok_or("Missing alpha")?;
                match defect {
                    "empty-blocks" => term.blocks = Box::new([]),
                    "sparse-df" => term.df -= 1,
                    "count" => term.blocks[0].count -= 1,
                    "first" => term.blocks[0].first = 1,
                    "gap" => term.blocks[1].first += 1,
                    "last" => term.blocks[2].last -= 1,
                    "zero-range" => term.blocks[0].data.length = 0,
                    "overflow-range" => term.blocks[0].data.offset = u32::MAX,
                    "range-order" => term.blocks[1].data.offset = 0,
                    "body-tf" => term.blocks[0].max_tf[1] = 2,
                    "both-fields" => term.blocks[0].max_tf[0] = 1,
                    "mixed-field" => {
                        term.blocks[1].max_tf[0] = 1;
                        term.blocks[1].max_tf[1] = 0;
                    }
                    _ => return Err("Unknown metadata defect".into()),
                }
            }
            let search = Search::new(
                Rc::new(header),
                statistics(false),
                "alpha beta",
                "any",
                10,
                &[],
                &[],
            )?;
            assert!(search.uniform_hits().is_none(), "accepted {defect}");
        }
        let header = Rc::new(built.header);
        for (text, mode) in [
            ("alpha unknown", "any"),
            ("alpha beta", "phrase"),
            ("alpha alpha", "phrase"),
            ("", "any"),
        ] {
            let search = Search::new(header.clone(), statistics(false), text, mode, 10, &[], &[])?;
            assert!(search.uniform_hits().is_none(), "accepted {text}/{mode}");
        }
        assert!(Search::new(header, statistics(false), "alpha", "any", 10, &[260], &[]).is_err());
        Ok(())
    }
}

#[cfg(test)]
mod dictionary_frames_tests {
    use super::{
        Document, DocumentAttributes, build, compress_directory, parse_compressed_directory,
        parse_header,
    };
    use std::collections::BTreeMap;
    use std::rc::Rc;
    #[test]
    fn dictionary_selects_reuse_and_preserves_unique_values()
    -> Result<(), Box<dyn std::error::Error>> {
        for count in [1, 128, 2048] {
            for cardinality in [1, 100, 700, 2048] {
                let built = build(
                    (0..count)
                        .map(|i| {
                            Document::native(
                                format!("ação-{i:06}😀"),
                                u64::MAX,
                                "cloudflare rust",
                                "cloudflare rust search",
                                BTreeMap::from([
                                    ("group".into(), serde_json::json!(i % cardinality)),
                                    ("nested".into(), serde_json::json!([null, true, "😀"])),
                                ]),
                                None,
                            )
                        })
                        .collect(),
                    None,
                )?;
                let (_, prefix) = parse_header(&built.bytes)?;
                let frame = compress_directory(&built.bytes[..prefix])?;
                let decoded = parse_compressed_directory(&frame, prefix, 40 * 1024 * 1024)?;
                assert_eq!(
                    serde_json::to_string(&decoded)?,
                    serde_json::to_string(&built.header)?
                );
                if count <= cardinality {
                    assert!(
                        decoded
                            .documents
                            .iter()
                            .all(|d| matches!(d.attributes, DocumentAttributes::Owned(_)))
                    );
                } else {
                    match (
                        decoded.documents.row(0).attributes,
                        decoded.documents.row(cardinality).attributes,
                    ) {
                        (DocumentAttributes::Shared(a), DocumentAttributes::Shared(b)) => {
                            assert!(Rc::ptr_eq(a, b));
                        }
                        _ => return Err("Expected shared dictionary values".into()),
                    }
                }
                let mut corrupt = frame.clone();
                corrupt[16] ^= 1;
                assert!(parse_compressed_directory(&corrupt, prefix, 40 * 1024 * 1024).is_err());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod shared_attribute_identity_tests {
    use super::{Document, DocumentAttributes, Filter, build, matches, parse_compressed_directory};
    use serde_json::json;
    use std::rc::Rc;

    #[test]
    fn dictionary_identity_preserves_filter_errors_missing_values_and_tombstones()
    -> Result<(), Box<dyn std::error::Error>> {
        let input = (0..512)
            .map(|index| {
                Document::from_native_value(json!({
                    "id": format!("{index:04}"),
                    "text": "cloudflare rust",
                    "attributes": {
                        "group": index % 17,
                        "year": 2020 + index % 4,
                        "flag": index % 2 == 0,
                        "nested": [null, "ação", true]
                    }
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let built = build(input, None)?;
        let (_, prefix) = super::parse_header(&built.bytes)?;
        let frame = super::compress_directory(&built.bytes[..prefix])?;
        let decoded = parse_compressed_directory(&frame, prefix, 40 * 1024 * 1024)?;
        assert!(
            decoded
                .documents
                .iter()
                .all(|document| matches!(document.attributes, DocumentAttributes::Shared(_)))
        );
        let mut isolated = built.header.clone();
        for document in isolated.documents.attributes.dense_mut() {
            *document = DocumentAttributes::Shared(Rc::from(
                serde_json::value::RawValue::from_string(document.get().into())?,
            ));
        }
        let mut mixed = decoded.clone();
        for (index, document) in mixed
            .documents
            .attributes
            .dense_mut()
            .iter_mut()
            .enumerate()
        {
            if index % 2 == 0 {
                *document = serde_json::value::RawValue::from_string(document.get().into())?.into();
            }
        }
        for field in ["group", "year", "flag", "missing", "nested"] {
            for op in [
                "eq", "ne", "in", "notIn", "exists", "gt", "gte", "lt", "lte", "invalid",
            ] {
                for value in [
                    json!(3),
                    json!(true),
                    json!(null),
                    json!([3, 5]),
                    json!(""),
                    json!("a"),
                    json!({"a":1}),
                ] {
                    let filters = [Filter {
                        field: field.into(),
                        op: op.into(),
                        value,
                    }];
                    let expected = built
                        .header
                        .documents
                        .iter()
                        .map(|document| {
                            let attributes = serde_json::from_str(document.attributes.get())
                                .map_err(|cause| cause.to_string())?;
                            matches(&attributes, &filters)
                        })
                        .collect::<Result<Vec<_>, String>>();
                    for header in [&built.header, &decoded, &isolated, &mixed] {
                        assert_eq!(
                            header
                                .allowed(&filters, &[])
                                .map(|mask| mask.iter().collect::<Vec<_>>()),
                            expected
                        );
                        if let Ok(mask) = &expected {
                            let mut deleted = mask.clone();
                            for row in [0, 7, 511] {
                                deleted[row] = false;
                            }
                            assert_eq!(
                                header
                                    .allowed(&filters, &[0, 7, 511])?
                                    .iter()
                                    .collect::<Vec<_>>(),
                                deleted
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod common_frame_validation_tests {
    use super::{
        COMMON_DIRECTORY_MAGIC, COMMON_DIRECTORY_MAGIC_V4, Document, build,
        compress_common_directory_segment, compress_directory, compress_directory_payload,
        decode_directory_contents, decode_directory_payload, parse_header,
    };
    use std::{cell::Cell, collections::BTreeMap};

    #[test]
    fn dictionary_expansion_respects_canonical_header_budget()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut compact = Vec::new();
        let rows = 10_000_u32;
        let attribute =
            serde_json::to_string(&BTreeMap::from([("blob", "a".repeat(1024 * 1024))]))?;
        for value in [2, rows, 1, 1, u32::try_from(attribute.len())?] {
            super::put_int(value, &mut compact);
        }
        compact.extend_from_slice(attribute.as_bytes());
        for row in 0..rows {
            let id = format!("{row:05}");
            super::put_int(u32::try_from(id.len())?, &mut compact);
            compact.extend_from_slice(id.as_bytes());
            for value in [0, 0, 0, 0, row * 8, 8, 0] {
                super::put_int(value, &mut compact);
            }
        }
        for value in [0, 0, 0, rows * 8, rows * 8, 0] {
            super::put_int(value, &mut compact);
        }
        let expected = 16 * 1024 * 1024;
        let mut common = Vec::new();
        common.extend_from_slice(&u32::try_from(compact.len())?.to_le_bytes());
        common.extend_from_slice(&compact);
        common.extend_from_slice(&[0, 0]);
        for (magic, bytes) in [
            (super::DIRECTORY_MAGIC, compact),
            (COMMON_DIRECTORY_MAGIC, common),
        ] {
            let frame = compress_directory_payload(&bytes, expected, *magic)?;
            for prior in [false, true] {
                let validated = Cell::new(prior);
                let result = decode_directory_payload(
                    &frame,
                    expected,
                    40 * 1024 * 1024,
                    Some(&validated),
                    *magic,
                );
                assert_eq!(
                    result.err().ok_or("Impossible expansion accepted")?,
                    "Directory attributes exceed canonical size budget"
                );
                assert_eq!(validated.get(), prior);
            }
        }
        Ok(())
    }

    #[test]
    fn failed_common_selection_never_becomes_an_immutable_validation_witness()
    -> Result<(), Box<dyn std::error::Error>> {
        let text = (0..17)
            .map(|value| format!("term{value}"))
            .collect::<Vec<_>>()
            .join(" ");
        let built = build(
            (0..2)
                .map(|value| {
                    Document::native(
                        value.to_string(),
                        1,
                        String::new(),
                        text.clone(),
                        BTreeMap::new(),
                        None,
                    )
                })
                .collect(),
            None,
        )?;
        let (_, length) = parse_header(&built.bytes)?;
        let frame = compress_directory(&built.bytes[..length])?;
        let header_compact = miniz_oxide::inflate::decompress_to_vec_zlib(&frame[20..])
            .map_err(|cause| cause.to_string())?;
        let mut compact = Vec::new();
        compact.extend_from_slice(&u32::try_from(header_compact.len())?.to_le_bytes());
        compact.extend_from_slice(&header_compact);
        compact.extend_from_slice(&[0, 0]);
        let frame = compress_directory_payload(&compact, length, *COMMON_DIRECTORY_MAGIC_V4)?;
        let validated = Cell::new(false);
        for _ in 0..2 {
            let result = decode_directory_payload(
                &frame,
                length,
                40 * 1024 * 1024,
                Some(&validated),
                *COMMON_DIRECTORY_MAGIC_V4,
            );
            assert_eq!(
                result.err().ok_or("Invalid selection accepted")?,
                "Invalid common-directory term selection"
            );
            assert!(!validated.get());
        }
        Ok(())
    }

    #[test]
    fn truncated_common_compact_prefix_rejects_without_validation() -> Result<(), String> {
        for length in 0..4 {
            let frame = compress_directory_payload(&vec![0; length], 64, *COMMON_DIRECTORY_MAGIC)?;
            let validated = Cell::new(false);
            assert!(
                decode_directory_contents(
                    &frame,
                    64,
                    4096,
                    Some(&validated),
                    *COMMON_DIRECTORY_MAGIC
                )
                .is_err()
            );
            assert!(!validated.get());
        }
        Ok(())
    }

    #[test]
    fn corrupt_hot_block_with_recomputed_frame_crc_is_rejected_before_validation_cache()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = build(
            (0..256)
                .map(|value| {
                    Document::native(
                        format!("row{value:04}"),
                        1,
                        "common term",
                        "common term common",
                        BTreeMap::new(),
                        None,
                    )
                })
                .collect(),
            None,
        )?;
        let (_, length) = parse_header(&built.bytes)?;
        let frame = compress_common_directory_segment(&built.bytes)?;
        let mut compact = miniz_oxide::inflate::decompress_to_vec_zlib(&frame[20..])
            .map_err(|cause| cause.to_string())?;
        let header_length = u32::from_le_bytes(compact[..4].try_into()?) as usize;
        let hot_start = 4 + header_length;
        if compact.len() <= hot_start + 2 {
            return Err("Fixture did not select a hot posting block".into());
        }
        let term_length =
            u16::from_le_bytes(compact[hot_start + 2..hot_start + 4].try_into()?) as usize;
        let inner_crc = hot_start + 18 + term_length;
        compact[inner_crc] ^= 1;
        let damaged = compress_directory_payload(&compact, length, *COMMON_DIRECTORY_MAGIC_V4)?;
        let validated = Cell::new(false);
        let error = decode_directory_contents(
            &damaged,
            length,
            40 * 1024 * 1024,
            Some(&validated),
            *COMMON_DIRECTORY_MAGIC_V4,
        )
        .err()
        .ok_or("Corrupt common posting block was accepted")?;
        assert_eq!(error, "Page integrity check failed");
        assert!(!validated.get());
        Ok(())
    }

    #[test]
    fn common_posting_budget_skips_oversized_decoded_terms_whole()
    -> Result<(), Box<dyn std::error::Error>> {
        use super::{CommonDirectory, MAX_COMMON_POSTING_BYTES};

        let text = "dense ".repeat(512);
        let built = build(
            (0..256)
                .map(|value| {
                    Document::native(
                        format!("row{value:04}"),
                        1,
                        String::new(),
                        text.clone(),
                        BTreeMap::new(),
                        None,
                    )
                })
                .collect(),
            None,
        )?;
        let (_, length) = parse_header(&built.bytes)?;
        let frame = compress_common_directory_segment(&built.bytes)?;
        let common = CommonDirectory::compressed(&frame, length, 40 * 1024 * 1024)?;
        assert!(common.hot.as_ref().is_none_or(
            |hot| hot.bytes <= MAX_COMMON_POSTING_BYTES && !hot.terms.contains_key("dense")
        ));
        Ok(())
    }
}

#[cfg(test)]
mod selected_hot_posting_tests {
    use super::{
        CommonDirectory, Document, Filter, PreparedQuery, Statistics, build,
        compress_common_directory_segment, parse_header,
    };
    use std::collections::{BTreeMap, BTreeSet};

    #[test]
    fn lower_cutoff_merges_earlier_hot_blocks_and_preserves_manual_rows()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = build(
            (0_u32..256)
                .map(|index| {
                    Document::native(
                        format!("row{index:04}"),
                        1,
                        String::new(),
                        if index < 128 {
                            format!("common {}", "padding ".repeat(300))
                        } else {
                            "common ".repeat(4)
                        },
                        BTreeMap::from([("group".into(), serde_json::json!(index % 2))]),
                        None,
                    )
                })
                .collect(),
            None,
        )?;
        let (header, header_length) = parse_header(&built.bytes)?;
        let frame = compress_common_directory_segment(&built.bytes)?;
        let common = CommonDirectory::compressed(&frame, header_length, 40 * 1024 * 1024)?;
        assert!(
            common
                .hot
                .as_ref()
                .is_some_and(|hot| hot.terms.contains_key("common"))
        );
        let metadata = header.terms().get("common").ok_or("Missing common term")?;
        for mode in ["any", "all", "phrase"] {
            let query = PreparedQuery::new(
                Statistics {
                    documents: 256,
                    title_length: header.total_title_length(),
                    body_length: header.total_body_length(),
                    frequencies: header
                        .terms()
                        .iter()
                        .map(|(term, value)| (term.to_owned(), u64::from(value.df)))
                        .collect(),
                },
                "common",
                mode.into(),
                100,
                vec![Filter {
                    field: "group".into(),
                    op: "eq".into(),
                    value: serde_json::json!(1),
                }],
            )?;
            let mut baseline = query.ranker(header.clone(), &[7, 129])?;
            for block in &metadata.blocks {
                let start = header_length + block.data.offset as usize;
                baseline.add(
                    "common",
                    &built.bytes[start..start + block.data.length as usize],
                )?;
            }
            let expected = baseline.finish()?;
            let cutoff = expected.first().ok_or("Missing expected hits")?.score * 0.9;
            let mut selected = query.ranker(header.clone(), &[7, 129])?;
            selected.pending_hot.clone_from(&common.hot);
            let last = metadata.blocks.last().ok_or("Missing last block")?;
            let start = header_length + last.data.offset as usize;
            selected.add(
                "common",
                &built.bytes[start..start + last.data.length as usize],
            )?;
            let high = selected.posting_spans_after(cutoff, "row9999")?;
            assert!(!high.is_empty());
            assert!(
                high.iter()
                    .flat_map(|span| &span.blocks)
                    .all(|block| block.first >= 128)
            );
            let high_selection = selected.own_posting_selection(&high)?;
            drop(high);
            assert!(selected.satisfy_hot_selection(high_selection)?.is_empty());
            let low = selected.posting_spans_after(f64::MIN_POSITIVE, "row9999")?;
            assert!(
                low.iter()
                    .flat_map(|span| &span.blocks)
                    .any(|block| block.first == 0)
            );
            let low_selection = selected.own_posting_selection(&low)?;
            drop(low);
            assert!(selected.satisfy_hot_selection(low_selection)?.is_empty());
            assert_eq!(selected.finish()?, expected);
            assert_eq!(
                selected.loaded_hot_blocks.get("common").map(BTreeSet::len),
                Some(metadata.blocks.len())
            );
        }
        Ok(())
    }

    #[test]
    fn sparse_cutoff_loads_only_selected_hot_blocks_and_repeats_without_duplicate_adds()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = build(
            (0_u32..512)
                .map(|index| {
                    Document::native(
                        format!("row{index:04}"),
                        1,
                        "common",
                        "dense ".repeat(512),
                        BTreeMap::new(),
                        None,
                    )
                })
                .collect(),
            None,
        )?;
        let (header, header_length) = parse_header(&built.bytes)?;
        let frame = compress_common_directory_segment(&built.bytes)?;
        let common = CommonDirectory::compressed(&frame, header_length, 40 * 1024 * 1024)?;
        let query = PreparedQuery::new(
            Statistics {
                documents: 512,
                title_length: header.total_title_length(),
                body_length: header.total_body_length(),
                frequencies: header
                    .terms()
                    .iter()
                    .map(|(term, metadata)| (term.to_owned(), u64::from(metadata.df)))
                    .collect(),
            },
            "common",
            "any".into(),
            10,
            Vec::<Filter>::new(),
        )?;
        let mut search = query.ranker(header, &[])?;
        search.pending_hot.clone_from(&common.hot);
        let cutoff = search
            .uniform_hits()
            .and_then(|hits| hits.first().map(|hit| hit.score))
            .ok_or("Expected uniform common-term score")?;
        let original = search.posting_spans_after(cutoff, "row0255")?;
        let selection = search.own_posting_selection(&original)?;
        drop(original);
        let selected_count = selection
            .iter()
            .map(|span| span.indices.len())
            .sum::<usize>();
        let cached_count = common
            .hot
            .as_ref()
            .and_then(|hot| hot.terms.get("common"))
            .map(Vec::len)
            .ok_or("Expected cached common-term blocks")?;
        assert!(selected_count > 0);
        assert!(selected_count < cached_count);
        let remaining = search.satisfy_hot_selection(selection)?;
        assert!(remaining.is_empty());
        assert_eq!(
            search.loaded_hot_blocks.get("common").map(BTreeSet::len),
            Some(selected_count)
        );
        let repeated = search.posting_spans_after(cutoff, "row0255")?;
        assert!(repeated.is_empty());
        let repeated_selection = search.own_posting_selection(&repeated)?;
        drop(repeated);
        let repeated_remaining = search.satisfy_hot_selection(repeated_selection)?;
        assert!(repeated_remaining.is_empty());
        assert_eq!(
            search.loaded_hot_blocks.get("common").map(BTreeSet::len),
            Some(selected_count)
        );
        Ok(())
    }
}

#[cfg(test)]
mod columnar_v2_tests {
    use super::{
        Document, Filter, LegacySegmentHeader, MAX_BYTES, Range, append, build, decode_page,
        full_document_from_frames, matches, migrate_segment, parse_header,
        query_document_from_metadata,
    };
    use std::collections::BTreeMap;

    fn documents() -> Vec<Document> {
        [
            None,
            Some(vec![]),
            Some(vec![f32::MAX, -f32::MAX, -0.0, f32::from_bits(1)]),
            Some(vec![0.1, 0.5]),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, vector)| {
            Document::native(
                format!("row-{index}"),
                7,
                "ação 日本語",
                "cloudflare rust cloudflare",
                BTreeMap::from([
                    ("tiny".into(), serde_json::json!(1e-307)),
                    ("max".into(), serde_json::json!(3.402_823_466_385_288_6e38)),
                    ("fraction".into(), serde_json::json!(0.1)),
                    ("nested".into(), serde_json::json!({"vector":"preserved"})),
                ]),
                vector,
            )
        })
        .collect()
    }

    fn frame<'a>(payload: &'a [u8], range: &Range) -> Result<&'a [u8], String> {
        payload
            .get(range.offset as usize..range.offset as usize + range.length as usize)
            .ok_or_else(|| "Missing test frame".into())
    }

    fn legacy_segment() -> Result<Vec<u8>, String> {
        let documents = documents();
        let built = build(documents.clone(), None)?;
        let (_, base) = parse_header(&built.bytes)?;
        let mut payload = Vec::new();
        let mut metadata = built.header.documents.clone();
        for (row, document) in metadata.rows.iter_mut().zip(&documents) {
            row.data = append(&mut payload, &document.to_native_vec()?)?;
        }
        let document_end = u32::try_from(payload.len()).map_err(|cause| cause.to_string())?;
        let mut terms = built.header.terms().clone();
        for (_, term) in &mut terms.entries {
            for block in &mut term.blocks {
                block.data.offset = document_end + block.data.offset - built.header.vector_end;
            }
        }
        payload.extend_from_slice(&built.bytes[base + built.header.vector_end as usize..]);
        let header = LegacySegmentHeader {
            version: 1,
            documents: serde_json::from_str(
                &serde_json::to_string(&metadata).map_err(|cause| cause.to_string())?,
            )
            .map_err(|cause| cause.to_string())?,
            terms,
            total_title_length: built.header.total_title_length(),
            total_body_length: built.header.total_body_length(),
        };
        let json = serde_json::to_vec(&header).map_err(|cause| cause.to_string())?;
        let mut bytes = b"RAIOSEG1".to_vec();
        bytes.extend_from_slice(
            &u32::try_from(json.len())
                .map_err(|cause| cause.to_string())?
                .to_le_bytes(),
        );
        bytes.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes.extend_from_slice(&payload);
        Ok(bytes)
    }

    #[test]
    fn native_v2_columns_preserve_presence_float_bits_and_header_only_reads() -> Result<(), String>
    {
        let original = documents();
        let built = build(original.clone(), None)?;
        let (header, base) = parse_header(&built.bytes)?;
        assert_eq!(header.version, 4);
        assert_eq!(header.vector_ranges.len(), 3);
        assert!(parse_header(&built.bytes[..base]).is_ok());
        let payload = &built.bytes[base..];
        for (index, (metadata, document)) in header.documents.iter().zip(&original).enumerate() {
            let data = frame(payload, &metadata.data)?;
            let vector = header
                .vector_range(index)?
                .map(|range| frame(payload, range))
                .transpose()?
                .unwrap_or_default();
            let reconstructed = full_document_from_frames(data, vector)?;
            let actual = Document::from_canonical_json(&reconstructed)?;
            assert_eq!(actual.id, document.id);
            assert_eq!(super::vector_bits(&actual)?, super::vector_bits(document)?);
            let query: serde_json::Value =
                serde_json::from_str(&query_document_from_metadata(data)?)
                    .map_err(|cause| cause.to_string())?;
            assert!(query.get("vector").is_none());
            assert_eq!(query["attributes"]["nested"]["vector"], "preserved");
            let vector = super::vector_bits(document)?;
            if vector.is_none() {
                assert!(query["vectorSummary"].is_null());
            } else {
                assert_eq!(
                    query["vectorSummary"][0],
                    vector.as_ref().map_or(0, Vec::len)
                );
            }
        }
        Ok(())
    }

    #[test]
    fn migration_rebases_only_postings_and_preserves_rows_and_statistics() -> Result<(), String> {
        let source = legacy_segment()?;
        assert!(parse_header(&source).is_err());
        let old_length = u32::from_le_bytes(
            source[8..12]
                .try_into()
                .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
        ) as usize;
        let old: LegacySegmentHeader = serde_json::from_slice(&source[16..16 + old_length])
            .map_err(|cause| cause.to_string())?;
        let old_payload = &source[16 + old_length..];
        let old_end = old.documents.last().ok_or("Missing row")?.data.offset
            + old.documents.last().ok_or("Missing row")?.data.length;
        let migrated = migrate_segment(&source)?;
        let (header, base) = parse_header(&migrated)?;
        assert_eq!(header.total_title_length(), old.total_title_length);
        assert_eq!(header.total_body_length(), old.total_body_length);
        assert_eq!(
            &migrated[base + header.vector_end as usize..],
            &old_payload[old_end as usize..]
        );
        for (row, (before, after)) in old
            .documents
            .iter()
            .zip(header.documents.iter())
            .enumerate()
        {
            assert_eq!(before.id.borrowed(), after.id);
            assert_eq!(before.revision, after.revision);
            assert_eq!(before.attributes.get(), after.attributes.get());
            let source_attributes: BTreeMap<String, serde_json::Value> =
                serde_json::from_str(before.attributes.get()).map_err(|cause| cause.to_string())?;
            for field in ["tiny", "max", "fraction"] {
                for op in ["eq", "lt", "lte", "gt", "gte"] {
                    let filter = Filter {
                        field: field.into(),
                        op: op.into(),
                        value: source_attributes
                            .get(field)
                            .ok_or("Missing numeric fixture")?
                            .clone(),
                    };
                    let expected = matches(&source_attributes, std::slice::from_ref(&filter))?;
                    assert_eq!(header.allowed(&[filter], &[])?.get(row), Some(expected));
                }
            }
            let source_document = decode_page(frame(old_payload, &before.data)?)?;
            let expected = Document::from_native_slice(&source_document)?;
            let data = frame(&migrated[base..], &after.data)?;
            let vector = header
                .vector_range(row)?
                .map(|range| frame(&migrated[base..], range))
                .transpose()?
                .unwrap_or_default();
            assert_eq!(
                full_document_from_frames(data, vector)?,
                expected.to_canonical_json()?
            );
        }
        for ((before_name, before), (after_name, after)) in
            old.terms.iter().zip(header.terms().iter())
        {
            assert_eq!(before_name, after_name);
            assert_eq!(before.df, after.df);
            for (before_block, after_block) in before.blocks.iter().zip(&after.blocks) {
                assert_eq!(
                    before_block.data.offset - old_end,
                    after_block.data.offset - header.vector_end
                );
                assert_eq!(before_block.data.length, after_block.data.length);
                assert_eq!(before_block.first, after_block.first);
                assert_eq!(before_block.last, after_block.last);
            }
        }
        assert_eq!(migrate_segment(&migrated)?, migrated);
        Ok(())
    }

    #[test]
    fn legacy_v1_migration_rejects_payload_and_directory_length_disagreement() -> Result<(), String>
    {
        let source = legacy_segment()?;
        let (mut header, base) = super::parse_legacy_segment(&source)?;
        let first = header
            .documents
            .first_mut()
            .ok_or("Missing legacy document")?;
        first.body_length += 1;
        header.total_body_length += 1;
        let json = serde_json::to_vec(&header).map_err(|cause| cause.to_string())?;
        let mut corrupt = b"RAIOSEG1".to_vec();
        corrupt.extend_from_slice(
            &u32::try_from(json.len())
                .map_err(|cause| cause.to_string())?
                .to_le_bytes(),
        );
        corrupt.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
        corrupt.extend_from_slice(&json);
        corrupt.extend_from_slice(source.get(base..).ok_or("Missing legacy payload")?);
        assert_eq!(
            migrate_segment(&corrupt),
            Err("Segment document token lengths do not match its directory".into()),
        );
        Ok(())
    }

    #[test]
    fn dense_vector_ranges_cross_multiple_prefix_blocks() -> Result<(), String> {
        let values = (0_u16..130)
            .map(|index| {
                Document::native(
                    format!("row-{index:03}"),
                    u64::from(index),
                    "rust",
                    "cloudflare rust",
                    BTreeMap::new(),
                    (index % 3 != 1).then_some(vec![f32::from(index), 0.5]),
                )
            })
            .collect::<Vec<_>>();
        let built = build(values.clone(), None)?;
        let (header, base) = parse_header(&built.bytes)?;
        for index in [0, 63, 64, 65, 127, 128, 129] {
            let data = frame(&built.bytes[base..], &header.documents.row(index).data)?;
            let vector = header
                .vector_range(index)?
                .map(|range| frame(&built.bytes[base..], range))
                .transpose()?
                .unwrap_or_default();
            let reconstructed =
                Document::from_canonical_json(&full_document_from_frames(data, vector)?)?;
            assert_eq!(
                super::vector_bits(&reconstructed)?,
                super::vector_bits(&values[index])?
            );
        }
        Ok(())
    }

    #[test]
    fn metadata_flags_and_conversion_size_are_bounded() -> Result<(), String> {
        let mut metadata = Vec::new();
        let range = append(&mut metadata, &[2, 128, 0, 0, 0, 0, b'{', b'}'])?;
        assert!(query_document_from_metadata(frame(&metadata, &range)?).is_err());
        assert!(migrate_segment(&vec![0; MAX_BYTES + 1]).is_err());
        Ok(())
    }

    #[test]
    fn malformed_partitions_and_vector_frames_fail_closed() -> Result<(), String> {
        let built = build(documents(), None)?;
        let (_, base) = parse_header(&built.bytes)?;
        let payload = &built.bytes[base..];
        let mut gap = built.header.clone();
        gap.documents.rows[0].data.offset = 1;
        assert!(parse_header(&gap.encode(payload)?).is_err());
        let mut missing = built.header.clone();
        missing.vector_ranges.pop();
        assert!(parse_header(&missing.encode(payload)?).is_err());
        let mut overlap = built.header.clone();
        overlap.vector_ranges[0].offset = 0;
        assert!(parse_header(&overlap.encode(payload)?).is_err());
        let mut end = built.header.clone();
        end.vector_end -= 1;
        assert!(parse_header(&end.encode(payload)?).is_err());
        let metadata = frame(payload, &built.header.documents.row(2).data)?;
        assert!(full_document_from_frames(metadata, &[]).is_err());
        let empty_vector = frame(
            payload,
            built
                .header
                .vector_range(1)?
                .ok_or("Missing empty vector")?,
        )?;
        assert!(full_document_from_frames(metadata, empty_vector).is_err());
        let mut corrupt = frame(
            payload,
            built.header.vector_range(2)?.ok_or("Missing vector")?,
        )?
        .to_vec();
        let last = corrupt.last_mut().ok_or("Missing vector byte")?;
        *last ^= 1;
        assert!(full_document_from_frames(metadata, &corrupt).is_err());
        Ok(())
    }
}

#[cfg(test)]
mod canonical_column_tests {
    use super::{
        ColumnId, ColumnValue, Document, DocumentTable, FieldTable, Filter, Header, NativeRole,
        Range, Search, Statistics, append, build, decode_page, document_terms, fields,
        full_document_from_frames, migrate_segment, owned_directory_row, parse_document_metadata,
        parse_header, query_document_from_metadata, rebase_postings, write_vector_facts,
    };
    use std::collections::BTreeMap;

    fn collision_documents() -> Vec<Document> {
        let collided = [
            ("id", serde_json::json!("attr-id")),
            ("revision", serde_json::json!(99)),
            ("title", serde_json::json!("attr-title")),
            ("text", serde_json::json!("attr-text")),
            ("vector", serde_json::json!([1, 2])),
            ("year", serde_json::json!(3)),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
        vec![
            Document::native(
                "row-a",
                7,
                "alpha unique",
                "shared beta",
                collided,
                Some(vec![f32::MAX, -0.0]),
            ),
            Document::native("row-b", 1, "", "shared", BTreeMap::new(), None),
            Document::native(
                "row-c",
                2,
                "gamma",
                "shared gamma",
                BTreeMap::from([("year".into(), serde_json::json!(4))]),
                Some(Vec::new()),
            ),
        ]
    }

    fn frame<'a>(payload: &'a [u8], range: &Range) -> Result<&'a [u8], String> {
        let offset = usize::try_from(range.offset).map_err(|cause| cause.to_string())?;
        let length = usize::try_from(range.length).map_err(|cause| cause.to_string())?;
        let end = offset.checked_add(length).ok_or("Frame range overflow")?;
        payload
            .get(offset..end)
            .ok_or_else(|| "Missing test frame".into())
    }

    fn legacy_metadata_page(
        facts: super::VectorFacts,
        document: &Document,
    ) -> Result<Vec<u8>, String> {
        let json = document.to_native_metadata_vec()?;
        if (facts.flags & 1) == 0 {
            return Ok(json);
        }
        let mut page = Vec::with_capacity(6 + json.len());
        write_vector_facts(facts, &mut page);
        page.extend_from_slice(&json);
        Ok(page)
    }

    fn encode_legacy_v2(bytes: &[u8]) -> Result<Vec<u8>, String> {
        encode_legacy_v2_with_facts(bytes, std::convert::identity)
    }

    fn encode_legacy_v2_with_facts(
        bytes: &[u8],
        change: impl Fn(super::VectorFacts) -> super::VectorFacts,
    ) -> Result<Vec<u8>, String> {
        let (header, base) = parse_header(bytes)?;
        let source = bytes.get(base..).ok_or("Truncated segment payload")?;
        let mut metadata = Vec::new();
        let mut rows = Vec::with_capacity(header.documents.len());
        for row in header.documents.iter() {
            let decoded = decode_page(frame(source, &row.data)?)?;
            let (facts, document) = parse_document_metadata(&decoded)?;
            if document.id != row.id || document.revision != row.revision {
                return Err("Legacy fixture row does not match its directory".into());
            }
            let data = append(
                &mut metadata,
                &legacy_metadata_page(change(facts), &document)?,
            )?;
            rows.push(owned_directory_row(&row, data));
        }
        let metadata_end = u32::try_from(metadata.len()).map_err(|cause| cause.to_string())?;
        let mut vector_ranges = header.vector_ranges.clone();
        for range in &mut vector_ranges {
            let relative = range
                .offset
                .checked_sub(header.metadata_end)
                .ok_or("Vector range precedes metadata")?;
            range.offset = metadata_end
                .checked_add(relative)
                .ok_or("Vector offset overflow")?;
        }
        let vectors = source
            .get(header.metadata_end as usize..header.vector_end as usize)
            .ok_or("Missing vector column")?;
        metadata.extend_from_slice(vectors);
        let vector_end = u32::try_from(metadata.len()).map_err(|cause| cause.to_string())?;
        let tail = source
            .get(header.vector_end as usize..)
            .ok_or("Missing posting tail")?;
        metadata.extend_from_slice(tail);
        let mut terms = header.terms().clone();
        rebase_postings(&mut terms, header.vector_end, vector_end)?;
        let legacy = Header::from_parts(
            2,
            DocumentTable::from(rows),
            FieldTable::native(
                header.total_title_length(),
                header.total_body_length(),
                terms,
            ),
            (metadata_end, vector_end),
            vector_ranges,
        )?;
        legacy.encode(&metadata)
    }

    fn source_for<'a>(documents: &'a [Document], id: &str) -> Result<&'a Document, String> {
        documents
            .iter()
            .find(|document| document.id == id)
            .ok_or_else(|| format!("Missing {id}"))
    }

    fn text_role(document: &Document, role: NativeRole) -> Result<&str, String> {
        match document.column(ColumnId::Role(role)) {
            Some(ColumnValue::Text(text)) => Ok(text),
            Some(ColumnValue::Vector(_) | ColumnValue::Attribute(_)) | None => {
                Err("Missing native text role".into())
            }
        }
    }

    fn ranked(
        bytes: &[u8],
        text: &str,
        mode: &str,
        filters: &[Filter],
        dead: &[u32],
    ) -> Result<Vec<(u32, u64)>, String> {
        let (header, base) = parse_header(bytes)?;
        let statistics = Statistics {
            documents: u64::try_from(header.documents.len()).map_err(|cause| cause.to_string())?,
            title_length: header.total_title_length(),
            body_length: header.total_body_length(),
            frequencies: header
                .terms()
                .iter()
                .map(|(term, metadata)| (term.to_owned(), u64::from(metadata.df)))
                .collect(),
        };
        let mut search = Search::new(header.clone(), statistics, text, mode, 10, dead, filters)?;
        let words = crate::normalize_text(text);
        for term in words.split_whitespace() {
            if let Some(metadata) = header.terms().get(term) {
                for block in &metadata.blocks {
                    let start = base
                        .checked_add(block.data.offset as usize)
                        .ok_or("Posting offset overflow")?;
                    let end = start
                        .checked_add(block.data.length as usize)
                        .ok_or("Posting length overflow")?;
                    search.add(term, bytes.get(start..end).ok_or("Missing posting page")?)?;
                }
            }
        }
        Ok(search
            .finish()?
            .into_iter()
            .map(|hit| (hit.row, hit.score.to_bits()))
            .collect())
    }

    fn projections(bytes: &[u8]) -> Result<BTreeMap<String, (String, String)>, String> {
        let (header, base) = parse_header(bytes)?;
        let payload = bytes.get(base..).ok_or("Truncated segment payload")?;
        let mut rows = BTreeMap::new();
        for (index, row) in header.documents.iter().enumerate() {
            let metadata = frame(payload, &row.data)?;
            let vector = header
                .vector_range(index)?
                .map(|range| frame(payload, range))
                .transpose()?
                .unwrap_or_default();
            let full = full_document_from_frames(metadata, vector)?;
            let query = query_document_from_metadata(metadata)?;
            if rows
                .insert(row.id.native_str()?.to_owned(), (full, query))
                .is_some()
            {
                return Err("Duplicate row id".into());
            }
        }
        Ok(rows)
    }

    type DirectoryRow = (super::DocumentId, u64, u32, u32, String, bool);

    fn directory(bytes: &[u8]) -> Result<Vec<DirectoryRow>, String> {
        let (header, _) = parse_header(bytes)?;
        Ok(header
            .documents
            .iter()
            .map(|row| {
                (
                    row.id.to_owned(),
                    row.revision,
                    row.title_length,
                    row.body_length,
                    row.attributes.get().to_owned(),
                    row.vector,
                )
            })
            .collect())
    }

    fn payload_range(bytes: &[u8], vector_column: bool) -> Result<Vec<u8>, String> {
        let (header, base) = parse_header(bytes)?;
        let payload = bytes.get(base..).ok_or("Truncated segment payload")?;
        let range = if vector_column {
            header.metadata_end as usize..header.vector_end as usize
        } else {
            header.vector_end as usize..payload.len()
        };
        payload
            .get(range)
            .ok_or_else(|| "Missing payload column".into())
            .map(<[u8]>::to_vec)
    }

    type BlockShape = (u32, u32, u32, u32, u32, u32, u32, u32, u32);

    fn term_shapes(bytes: &[u8]) -> Result<Vec<(String, u32, Vec<BlockShape>)>, String> {
        let (header, _) = parse_header(bytes)?;
        let mut shapes = Vec::new();
        for (term, metadata) in header.terms().iter() {
            let mut blocks = Vec::new();
            for block in &metadata.blocks {
                blocks.push((
                    block.first,
                    block.last,
                    block.count,
                    block.max_tf[0],
                    block.max_tf[1],
                    block.min_length[0],
                    block.min_length[1],
                    block
                        .data
                        .offset
                        .checked_sub(header.vector_end)
                        .ok_or("Posting precedes vectors")?,
                    block.data.length,
                ));
            }
            shapes.push((term.to_owned(), metadata.df, blocks));
        }
        Ok(shapes)
    }

    fn allowed_rows(
        bytes: &[u8],
        field: &str,
        value: serde_json::Value,
    ) -> Result<Vec<bool>, String> {
        let (header, _) = parse_header(bytes)?;
        let mask = header.allowed(
            &[Filter {
                field: field.into(),
                op: "eq".into(),
                value,
            }],
            &[],
        )?;
        Ok(mask.iter().collect())
    }

    fn metadata_page(raw: &[u8]) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        let range = append(&mut bytes, raw)?;
        frame(&bytes, &range).map(<[u8]>::to_vec)
    }

    fn canonical_metadata_page(json: &str) -> Result<Vec<u8>, String> {
        let mut raw = vec![super::METADATA_CODEC_CANONICAL];
        write_vector_facts(
            super::VectorFacts {
                flags: 0,
                dimensions: 0,
            },
            &mut raw,
        );
        raw.extend_from_slice(json.as_bytes());
        metadata_page(&raw)
    }

    fn rejection_eq<T>(result: Result<T, String>, expected: &str) -> Result<(), String> {
        match result {
            Err(error) if error == expected => Ok(()),
            Err(error) => Err(error),
            Ok(_) => Err(format!("Expected rejection {expected}")),
        }
    }

    fn rejection_contains<T>(result: Result<T, String>, needle: &str) -> Result<(), String> {
        match result {
            Err(error) if error.contains(needle) => Ok(()),
            Err(error) => Err(format!("Rejection {error} did not contain {needle}")),
            Ok(_) => Err(format!("Expected rejection containing {needle}")),
        }
    }

    #[test]
    fn native_roles_stay_distinct_from_same_name_attributes() -> Result<(), String> {
        let documents = collision_documents();
        let collided = &documents[0];
        assert_eq!(collided.id, "row-a");
        assert_eq!(collided.revision, 7);
        assert_eq!(text_role(collided, NativeRole::Title)?, "alpha unique");
        assert_eq!(text_role(collided, NativeRole::Text)?, "shared beta");
        assert_eq!(
            collided
                .columns()
                .attributes()
                .get("id")
                .and_then(serde_json::Value::as_str),
            Some("attr-id")
        );
        assert_eq!(
            collided.columns().attributes().get("revision"),
            Some(&serde_json::json!(99))
        );
        assert_eq!(
            collided
                .columns()
                .attributes()
                .get("title")
                .and_then(serde_json::Value::as_str),
            Some("attr-title")
        );
        assert_eq!(
            document_terms(collided)?,
            vec![
                "alpha".to_owned(),
                "beta".to_owned(),
                "shared".to_owned(),
                "unique".to_owned(),
            ]
        );
        let built = build(documents.clone(), None)?;
        let (header, _) = parse_header(&built.bytes)?;
        for (row, document) in header.documents.iter().zip(&documents) {
            assert_eq!(row.id, document.id);
            assert_eq!(row.revision, document.revision);
            let projected: BTreeMap<String, serde_json::Value> =
                serde_json::from_str(row.attributes.get()).map_err(|cause| cause.to_string())?;
            assert_eq!(&projected, document.columns().attributes());
        }
        for term in ["alpha", "beta", "gamma", "shared", "unique"] {
            assert!(header.terms().get(term).is_some(), "missing {term}");
        }
        for term in ["attr", "id", "revision", "title", "text", "vector"] {
            assert!(header.terms().get(term).is_none(), "indexed {term}");
        }
        assert_eq!(
            allowed_rows(&built.bytes, "title", serde_json::json!("attr-title"))?,
            vec![true, false, false]
        );
        assert_eq!(
            allowed_rows(&built.bytes, "id", serde_json::json!("attr-id"))?,
            vec![true, false, false]
        );
        assert_eq!(
            allowed_rows(&built.bytes, "revision", serde_json::json!(99))?,
            vec![true, false, false]
        );
        assert!(
            allowed_rows(&built.bytes, "title", serde_json::json!("alpha unique"))?
                .iter()
                .all(|bit| !bit)
        );
        assert!(
            allowed_rows(&built.bytes, "revision", serde_json::json!(7))?
                .iter()
                .all(|bit| !bit)
        );
        let hits = ranked(&built.bytes, "alpha", "any", &[], &[])?;
        let hit = hits.first().ok_or("Missing alpha hit")?;
        assert_eq!(hit.0, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(
            ranked(&built.bytes, "attr-title", "any", &[], &[])?,
            Vec::<(u32, u64)>::new()
        );
        Ok(())
    }

    #[test]
    fn legacy_v2_rows_rank_and_read_without_rewrite_then_migrate() -> Result<(), String> {
        let documents = collision_documents();
        let built = build(documents, None)?;
        let legacy = encode_legacy_v2(&built.bytes)?;
        let (legacy_header, _) = parse_header(&legacy)?;
        assert_eq!(&legacy[..8], b"RAIOSEG2");
        assert_eq!(legacy_header.version, 2);
        let checksum = crc32fast::hash(&legacy);
        for mode in ["any", "all"] {
            assert_eq!(
                ranked(&built.bytes, "shared", mode, &[], &[])?,
                ranked(&legacy, "shared", mode, &[], &[])?
            );
            assert_eq!(
                ranked(&built.bytes, "shared", mode, &[], &[0])?,
                ranked(&legacy, "shared", mode, &[], &[0])?
            );
        }
        let title_filter = [Filter {
            field: "title".into(),
            op: "eq".into(),
            value: serde_json::json!("attr-title"),
        }];
        assert_eq!(
            ranked(&built.bytes, "shared", "any", &title_filter, &[])?,
            ranked(&legacy, "shared", "any", &title_filter, &[])?
        );
        assert_eq!(
            ranked(&built.bytes, "shared gamma", "phrase", &[], &[])?,
            ranked(&legacy, "shared gamma", "phrase", &[], &[])?
        );
        assert_eq!(
            ranked(&built.bytes, "alpha", "any", &[], &[])?,
            ranked(&legacy, "alpha", "any", &[], &[])?
        );
        assert_eq!(projections(&built.bytes)?, projections(&legacy)?);
        assert_eq!(crc32fast::hash(&legacy), checksum);
        let migrated = migrate_segment(&legacy)?;
        assert_eq!(crc32fast::hash(&legacy), checksum);
        assert_eq!(&migrated[..8], b"RAIOSEG3");
        assert_eq!(directory(&built.bytes)?, directory(&legacy)?);
        assert_eq!(directory(&legacy)?, directory(&migrated)?);
        assert_eq!(
            payload_range(&built.bytes, true)?,
            payload_range(&legacy, true)?
        );
        assert_eq!(
            payload_range(&legacy, true)?,
            payload_range(&migrated, true)?
        );
        assert_eq!(
            payload_range(&built.bytes, false)?,
            payload_range(&legacy, false)?
        );
        assert_eq!(
            payload_range(&legacy, false)?,
            payload_range(&migrated, false)?
        );
        assert_eq!(term_shapes(&built.bytes)?, term_shapes(&legacy)?);
        assert_eq!(term_shapes(&legacy)?, term_shapes(&migrated)?);
        assert_eq!(projections(&built.bytes)?, projections(&migrated)?);
        for (field, value) in [
            ("title", serde_json::json!("attr-title")),
            ("id", serde_json::json!("attr-id")),
            ("revision", serde_json::json!(99)),
            ("year", serde_json::json!(4)),
        ] {
            assert_eq!(
                allowed_rows(&built.bytes, field, value.clone())?,
                allowed_rows(&migrated, field, value)?
            );
        }
        assert_eq!(
            ranked(&built.bytes, "shared", "any", &[], &[0])?,
            ranked(&migrated, "shared", "any", &[], &[0])?
        );
        assert_eq!(migrate_segment(&migrated)?, migrated);
        assert_eq!(migrate_segment(&built.bytes)?, built.bytes);
        Ok(())
    }

    #[test]
    fn migration_rejects_directory_lengths_that_disagree_with_document_roles() -> Result<(), String>
    {
        let built = build(collision_documents(), None)?;
        let legacy = encode_legacy_v2(&built.bytes)?;
        for title in [true, false] {
            let (mut header, base) = parse_header(&legacy)?;
            let mut rows = header
                .documents
                .iter()
                .map(|row| owned_directory_row(&row, row.data.clone()))
                .collect::<Vec<_>>();
            let first = rows.first_mut().ok_or("Missing migration fixture row")?;
            if title {
                first.title_length += 1;
                header
                    .fields
                    .set_total(fields::NATIVE_TITLE, header.total_title_length() + 1);
            } else {
                first.body_length += 1;
                header
                    .fields
                    .set_total(fields::NATIVE_TEXT, header.total_body_length() + 1);
            }
            header.documents = DocumentTable::from(rows);
            let changed = header.encode(legacy.get(base..).ok_or("Missing migration payload")?)?;
            parse_header(&changed)?;
            rejection_eq(
                migrate_segment(&changed),
                "Segment document token lengths do not match its directory",
            )?;
        }
        Ok(())
    }

    #[test]
    fn migration_validates_legacy_vector_frames_before_copying_them() -> Result<(), String> {
        let built = build(collision_documents(), None)?;
        let mut legacy = encode_legacy_v2(&built.bytes)?;
        let (header, base) = parse_header(&legacy)?;
        let vector = header.vector_range(0)?.ok_or("Missing migration vector")?;
        let checksum = base + vector.offset as usize + 4;
        let byte = legacy.get_mut(checksum).ok_or("Missing vector checksum")?;
        *byte ^= 1;
        parse_header(&legacy)?;
        rejection_contains(migrate_segment(&legacy), "integrity")?;
        Ok(())
    }

    #[test]
    fn migration_rejects_valid_frames_with_a_conflicting_vector_summary() -> Result<(), String> {
        let built = build(collision_documents(), None)?;
        let legacy = encode_legacy_v2_with_facts(&built.bytes, |mut facts| {
            if facts.flags & 1 != 0 {
                facts.dimensions += 1;
            }
            facts
        })?;
        parse_header(&legacy)?;
        rejection_eq(
            migrate_segment(&legacy),
            "Vector frame does not match metadata vector summary",
        )?;
        Ok(())
    }

    #[test]
    fn document_attribute_numbers_keep_binary64_bits_across_codecs() -> Result<(), String> {
        for value in [
            1e-307,
            f64::from(f32::MAX),
            0.1,
            -0.0,
            f64::MIN_POSITIVE,
            f64::from_bits(1),
            f64::MAX,
        ] {
            let source = Document::native(
                "numeric-attribute",
                1,
                "",
                "",
                BTreeMap::from([("number".into(), serde_json::json!(value))]),
                None,
            );
            let mut native = source.to_native_vec()?;
            for _ in 0..3 {
                let document = Document::from_native_slice(&native)?;
                let canonical = document.to_canonical_vec()?;
                let document = Document::from_canonical_slice(&canonical)?;
                let actual = document
                    .columns()
                    .attributes()
                    .get("number")
                    .and_then(serde_json::Value::as_f64)
                    .ok_or("Missing numeric attribute")?;
                assert_eq!(actual.to_bits(), value.to_bits());
                native = document.to_native_vec()?;
            }
        }
        Ok(())
    }

    #[test]
    fn query_metadata_keeps_vector_bytes_in_a_separate_frame() -> Result<(), String> {
        let documents = collision_documents();
        let built = build(documents.clone(), None)?;
        assert_eq!(&built.bytes[..8], b"RAIOSEG4");
        let (header, base) = parse_header(&built.bytes)?;
        assert_eq!(header.version, 4);
        let payload = built.bytes.get(base..).ok_or("Truncated segment payload")?;
        for (index, row) in header.documents.iter().enumerate() {
            let metadata = frame(payload, &row.data)?;
            let metadata_end = row
                .data
                .offset
                .checked_add(row.data.length)
                .ok_or("Metadata range overflow")?;
            assert!(metadata_end <= header.metadata_end);
            let decoded = decode_page(metadata)?;
            assert_eq!(
                decoded.first().copied(),
                Some(super::METADATA_CODEC_CANONICAL)
            );
            assert_eq!(decoded.get(1).copied(), Some(super::METADATA_CODEC_FACTS));
            let flags = decoded.get(2).copied().ok_or("Missing vector flags")?;
            assert_eq!((flags & 1) != 0, row.vector);
            let stored: serde_json::Value =
                serde_json::from_slice(decoded.get(7..).ok_or("Truncated canonical metadata")?)
                    .map_err(|cause| cause.to_string())?;
            assert!(stored.get("vector").is_none());
            let vector = header
                .vector_range(index)?
                .map(|range| frame(payload, range))
                .transpose()?
                .unwrap_or_default();
            if let Some(range) = header.vector_range(index)? {
                assert!(range.offset >= header.metadata_end);
            }
            let source = source_for(&documents, row.id.native_str()?)?;
            assert_eq!(
                full_document_from_frames(metadata, vector)?,
                source.to_canonical_json()?
            );
            let query = query_document_from_metadata(metadata)?;
            assert_eq!(query, super::serialize_query_document(source)?);
            let query_value: serde_json::Value =
                serde_json::from_str(&query).map_err(|cause| cause.to_string())?;
            assert!(query_value.get("vector").is_none());
            assert!(query_value.get("vectorSummary").is_some());
            assert_eq!(
                query_value["roles"]["title"],
                text_role(source, NativeRole::Title)?
            );
            assert_eq!(
                query_value["attributes"]
                    .get("title")
                    .and_then(serde_json::Value::as_str),
                source
                    .columns()
                    .attributes()
                    .get("title")
                    .and_then(serde_json::Value::as_str)
            );
        }
        Ok(())
    }

    #[test]
    fn magic_codec_and_unknown_fields_fail_closed() -> Result<(), String> {
        let built = build(collision_documents(), None)?;
        assert_eq!(migrate_segment(&built.bytes)?, built.bytes);
        let mut mismatched = built.bytes;
        mismatched[..8].copy_from_slice(b"RAIOSEG2");
        rejection_eq(
            parse_header(&mismatched).map(|_| ()),
            "Segment magic does not match its version",
        )?;
        let unknown = metadata_page(&[9, b'{', b'}'])?;
        rejection_eq(
            query_document_from_metadata(&unknown).map(|_| ()),
            "Unknown document metadata codec",
        )?;
        let mut vector_in_metadata = vec![super::METADATA_CODEC_CANONICAL];
        write_vector_facts(
            super::VectorFacts {
                flags: 1,
                dimensions: 1,
            },
            &mut vector_in_metadata,
        );
        vector_in_metadata.extend_from_slice(
            br#"{"id":"row-a","revision":1,"roles":{"title":"","text":"shared"},"attributes":{},"vector":[1.0]}"#,
        );
        let vector_page = metadata_page(&vector_in_metadata)?;
        rejection_contains(query_document_from_metadata(&vector_page), "vector")?;
        let unknown_role = r#"{"id":"row-a","revision":1,"roles":{"title":"","text":"shared","weight":1},"attributes":{}}"#;
        rejection_contains(Document::from_canonical_json(unknown_role), "weight")?;
        let mut stored_role = vec![super::METADATA_CODEC_CANONICAL];
        write_vector_facts(
            super::VectorFacts {
                flags: 0,
                dimensions: 0,
            },
            &mut stored_role,
        );
        stored_role.extend_from_slice(unknown_role.as_bytes());
        let role_page = metadata_page(&stored_role)?;
        rejection_contains(query_document_from_metadata(&role_page), "weight")?;
        assert!(
            Document::from_canonical_json(r#"{"id":"row-a","text":"shared","attributes":{}}"#)
                .is_err()
        );
        rejection_contains(
            Document::from_canonical_json(
                r#"{"id":"row-a","revision":4,"roles":{"text":"shared"},"attributes":{}}"#,
            ),
            "missing field `title`",
        )?;
        rejection_contains(
            Document::from_canonical_json(
                r#"{"id":"row-a","roles":{"title":"","text":"shared"},"attributes":{}}"#,
            ),
            "missing field `revision`",
        )?;
        rejection_contains(
            Document::from_canonical_json(
                r#"{"revision":1,"roles":{"title":"","text":"shared"},"attributes":{}}"#,
            ),
            "missing field `id`",
        )?;
        rejection_contains(
            Document::from_canonical_json(
                r#"{"id":"row-a","revision":1,"roles":{"title":null,"text":"shared"},"attributes":{}}"#,
            ),
            "null",
        )?;
        rejection_contains(
            Document::from_canonical_json(
                r#"{"id":"row-a","revision":null,"roles":{"title":"","text":"shared"},"attributes":{}}"#,
            ),
            "null",
        )?;
        rejection_contains(
            query_document_from_metadata(&canonical_metadata_page(
                r#"{"id":"row-a","revision":4,"roles":{"text":"shared"},"attributes":{}}"#,
            )?),
            "missing field `title`",
        )?;
        rejection_contains(
            query_document_from_metadata(&canonical_metadata_page(
                r#"{"id":"row-a","roles":{"title":"","text":"shared"},"attributes":{}}"#,
            )?),
            "missing field `revision`",
        )?;
        let native =
            Document::from_native_json(r#"{"id":"row-a","text":"shared","attributes":{}}"#)?;
        assert_eq!(native.revision, 0);
        assert_eq!(text_role(&native, NativeRole::Title)?, "");
        Ok(())
    }
}

#[cfg(test)]
mod metadata_batch_tests {
    use super::{append, query_document_from_metadata, query_documents_from_metadata};

    #[test]
    fn metadata_batch_reuses_scratch_at_exact_decoded_budget() -> Result<(), String> {
        let prefix = b"{\"id\":\"edge\",\"revision\":1,\"text\":\"";
        let suffix = b"\",\"attributes\":{}}";
        let mut document = prefix.to_vec();
        document.resize(32768 - suffix.len(), b'x');
        document.extend_from_slice(suffix);
        let mut bytes = Vec::new();
        let first = append(&mut bytes, &document)?;
        let second = append(&mut bytes, &document)?;
        let scalar = query_document_from_metadata(&bytes[..first.length as usize])?;
        assert_eq!(
            query_documents_from_metadata(
                &bytes,
                &[first.offset, first.length, second.offset, second.length]
            )?,
            Some(format!("[{scalar},{scalar}]"))
        );
        document.insert(prefix.len(), b'x');
        bytes.truncate(first.length as usize);
        let over = append(&mut bytes, &document)?;
        assert!(
            query_documents_from_metadata(
                &bytes,
                &[first.offset, first.length, over.offset, over.length]
            )?
            .is_none()
        );
        Ok(())
    }

    #[test]
    fn reused_metadata_inflater_preserves_scalar_validation() -> Result<(), String> {
        let mut valid = Vec::new();
        append(&mut valid, br#"{"id":"row","revision":1,"text":"rust rust","attributes":{"a":true,"b":null,"c":1.5}}"#)?;
        let mut cases = vec![valid.clone()];
        for index in [0, 4, 8, valid.len() - 1] {
            let mut corrupt = valid.clone();
            corrupt[index] ^= 1;
            cases.push(corrupt);
        }
        for length in [0, 1, 7, 8, 9, valid.len() - 1, valid.len() - 4] {
            cases.push(valid[..length].to_vec());
        }
        let mut padded = valid.clone();
        padded.extend_from_slice(b"extra compressed bytes");
        cases.push(padded);
        let mut dictionary = valid[..8].to_vec();
        dictionary.extend_from_slice(&[0x78, 0x20, 0, 0, 0, 1]);
        dictionary.extend_from_slice(&valid[10..]);
        cases.push(dictionary);
        let mut empty = Vec::new();
        append(&mut empty, b"")?;
        cases.push(empty);
        for bytes in cases {
            let length = u32::try_from(bytes.len()).map_err(|cause| cause.to_string())?;
            let scalar = query_document_from_metadata(&bytes);
            let batch = query_documents_from_metadata(&bytes, &[0, length]);
            match (scalar, batch) {
                (Ok(scalar), Ok(Some(batch))) => assert_eq!(batch, format!("[{scalar}]")),
                (Err(_), Err(_)) => {}
                _ => return Err("Scalar and batch validation diverged".into()),
            }
        }
        let mut mixed = Vec::new();
        let mut ranges = Vec::new();
        let mut expected = Vec::new();
        for length in [
            1, 900, 10, 2000, 2, 400, 1, 1000, 60, 500, 3, 2000, 1, 700, 30, 300,
        ] {
            let text = format!(
                r#"{{"id":"row-{length}","revision":1,"text":"{}","attributes":{{}}}}"#,
                "α".repeat(length)
            );
            let page = append(&mut mixed, text.as_bytes())?;
            ranges.extend_from_slice(&[page.offset, page.length]);
            expected.push(query_document_from_metadata(
                &mixed[page.offset as usize..(page.offset + page.length) as usize],
            )?);
        }
        assert_eq!(
            query_documents_from_metadata(&mixed, &ranges)?,
            Some(format!("[{}]", expected.join(",")))
        );
        mixed[4] ^= 1;
        assert!(query_documents_from_metadata(&mixed, &ranges).is_err());
        assert!(query_documents_from_metadata(&mixed, &ranges[2..])?.is_some());
        Ok(())
    }

    #[test]
    fn ordered_repeated_metadata_batch_preserves_projection() -> Result<(), String> {
        let mut bytes = Vec::new();
        let mut ranges = Vec::new();
        for index in 0..16 {
            let mut metadata = vec![2, 7, 0, 3, 0, 0];
            metadata.extend_from_slice(format!(r#"{{"id":"row-{index}","revision":1,"title":"á 字","text":"rust search","attributes":{{"n":9007199254740991}}}}"#).as_bytes());
            let range = append(&mut bytes, &metadata)?;
            ranges.push(range.offset);
            ranges.push(range.length);
        }
        let requested: Vec<_> = ranges
            .as_chunks::<2>()
            .0
            .iter()
            .rev()
            .flatten()
            .copied()
            .collect();
        let expected: Vec<serde_json::Value> = requested
            .as_chunks::<2>()
            .0
            .iter()
            .map(|range| {
                let start = range[0] as usize;
                let end = start + range[1] as usize;
                serde_json::from_str(&query_document_from_metadata(&bytes[start..end])?)
                    .map_err(|cause| cause.to_string())
            })
            .collect::<Result<_, String>>()?;
        let actual: Vec<serde_json::Value> = serde_json::from_str(
            &query_documents_from_metadata(&bytes, &requested)?.ok_or("Unexpected batch limit")?,
        )
        .map_err(|cause| cause.to_string())?;
        assert_eq!(actual, expected);
        let repeated = [ranges[0], ranges[1], ranges[0], ranges[1]];
        let duplicate: Vec<serde_json::Value> = serde_json::from_str(
            &query_documents_from_metadata(&bytes, &repeated)?.ok_or("Unexpected batch limit")?,
        )
        .map_err(|cause| cause.to_string())?;
        assert_eq!(duplicate[0], duplicate[1]);
        let mut large = Vec::new();
        let data = format!(
            r#"{{"id":"large","revision":1,"title":"","text":"{}","attributes":{{}}}}"#,
            "x".repeat(70_000)
        );
        let range = append(&mut large, data.as_bytes())?;
        assert!(query_documents_from_metadata(&large, &[range.offset, range.length])?.is_none());
        assert!(query_document_from_metadata(&large).is_ok());
        bytes[4] ^= 1;
        assert!(query_documents_from_metadata(&bytes, &ranges[..2]).is_err());
        assert!(query_documents_from_metadata(&bytes, &ranges[2..4]).is_ok());
        for invalid in [
            &[][..],
            &[0][..],
            &[u32::MAX, u32::MAX][..],
            &[0, 0][..],
            &[0; 34][..],
        ] {
            assert!(query_documents_from_metadata(&bytes, invalid).is_err());
        }
        Ok(())
    }
}

#[cfg(test)]
mod scalar_column_tests {
    use super::*;

    #[test]
    fn constant_columns_preserve_late_dense_transitions_and_reverse_order() {
        for length in [1, 2, 10000] {
            let mut column = ScalarColumn::new();
            for _ in 0..length {
                column.push(7_u32, length);
            }
            assert_eq!(column.heap_bytes(), 0);
            assert_eq!(column.iter().collect::<Vec<_>>(), vec![7; length]);
            column.push(9, length + 1);
            assert_eq!(column.len(), length + 1);
            assert_eq!(column.get(length), 9);
            assert!(column.iter().take(length).all(|value| value == 7));
            assert_eq!(column.iter().next_back(), Some(9));
            assert_eq!(column.heap_bytes(), (length + 1) * size_of::<u32>());
        }
    }

    #[test]
    fn scalar_columns_preserve_document_serialization_and_mixed_flags()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents = (0..20)
            .map(|row| {
                Ok(DocumentMeta {
                    id: format!("id-{row:02}").into(),
                    revision: u64::MAX - row,
                    title_length: 7,
                    body_length: u32::try_from(row % 3)?,
                    attributes: DocumentAttributes::Owned(
                        serde_json::value::RawValue::from_string("{}".into())?,
                    ),
                    data: Range {
                        offset: u32::try_from(row * 8)?,
                        length: 8,
                    },
                    vector: row % 2 == 1,
                })
            })
            .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
        let expected = serde_json::to_vec(&documents)?;
        let table = DocumentTable::from(documents);
        assert_eq!(table.lengths[0].heap_bytes(), 0);
        assert_eq!(table.lengths[1].heap_bytes(), 20 * size_of::<u32>());
        assert_eq!(table.vectors.heap_bytes(), 20 * size_of::<bool>());
        assert_eq!(serde_json::to_vec(&table)?, expected);
        let restored: DocumentTable = serde_json::from_slice(&expected)?;
        assert_eq!(serde_json::to_vec(&restored)?, expected);
        assert_eq!(vector_prefix(&table)?, [0]);
        assert_eq!(table.vectors.iter().filter(|value| *value).count(), 10);
        Ok(())
    }
}

#[cfg(test)]
mod attribute_name_tests {
    use super::filterable_fields;

    #[test]
    fn names_use_utf8_byte_bounds_and_binary_field_order() -> Result<(), String> {
        for name in [
            "1year".to_owned(),
            "a-b".to_owned(),
            "ação".to_owned(),
            "a/b".to_owned(),
            "x".repeat(128),
            "é".repeat(64),
            "😀".repeat(32),
        ] {
            let names = [name.clone()];
            assert!(filterable_fields(&names)?.contains(name.as_str()));
        }
        for name in [
            String::new(),
            "$reserved".to_owned(),
            "x".repeat(129),
            format!("{}x", "é".repeat(64)),
            format!("{}x", "😀".repeat(32)),
        ] {
            assert!(filterable_fields(&[name]).is_err());
        }
        let names = ["😀".to_owned(), "\u{e000}".to_owned()];
        assert_eq!(
            filterable_fields(&names)?.into_iter().collect::<Vec<_>>(),
            ["\u{e000}", "😀"]
        );
        Ok(())
    }
}

#[cfg(test)]
mod array_filter_tests {
    use super::{Filter, matches};
    use std::collections::BTreeMap;

    #[test]
    fn scalar_ranges_preserve_binary_string_order_and_reject_cross_type_coercion()
    -> Result<(), String> {
        for (actual, value, expected) in [
            (
                serde_json::json!(""),
                serde_json::json!("a"),
                [false, false, true, true],
            ),
            (
                serde_json::json!("a"),
                serde_json::json!("aa"),
                [false, false, true, true],
            ),
            (
                serde_json::json!("A"),
                serde_json::json!("a"),
                [false, false, true, true],
            ),
            (
                serde_json::json!("é"),
                serde_json::json!("e\u{301}"),
                [true, true, false, false],
            ),
            (
                serde_json::json!("\u{e000}"),
                serde_json::json!("😀"),
                [false, false, true, true],
            ),
            (
                serde_json::json!("😀"),
                serde_json::json!("😀"),
                [false, true, false, true],
            ),
            (serde_json::json!(1), serde_json::json!("1"), [false; 4]),
            (serde_json::json!("1"), serde_json::json!(1), [false; 4]),
            (serde_json::json!(null), serde_json::json!("a"), [false; 4]),
            (serde_json::json!(true), serde_json::json!(1), [false; 4]),
            (serde_json::json!(["a"]), serde_json::json!("b"), [false; 4]),
            (
                serde_json::json!(0),
                serde_json::json!(-0.0),
                [false, true, false, true],
            ),
            (
                serde_json::json!(1.5),
                serde_json::json!(1),
                [true, true, false, false],
            ),
        ] {
            for (op, expected) in ["gt", "gte", "lt", "lte"].into_iter().zip(expected) {
                let filter = Filter {
                    field: "value".to_owned(),
                    op: op.to_owned(),
                    value: value.clone(),
                };
                assert_eq!(filter.matches(Some(&actual))?, expected);
                assert!(!filter.matches(None)?);
            }
        }
        Ok(())
    }

    #[test]
    fn scalar_exclusion_is_exact_and_preserves_missing_values() -> Result<(), String> {
        let attributes: BTreeMap<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({
                "string": "ação",
                "number": 1,
                "boolean": true,
                "null": null
            }))
            .map_err(|cause| cause.to_string())?;
        for (field, value, expected) in [
            ("string", serde_json::json!(["ação"]), false),
            ("string", serde_json::json!(["AÇÃO"]), true),
            ("number", serde_json::json!([1]), false),
            ("number", serde_json::json!(["1"]), true),
            ("boolean", serde_json::json!([true]), false),
            ("boolean", serde_json::json!([1]), true),
            ("null", serde_json::json!([null]), false),
            ("missing", serde_json::json!([null]), true),
            ("null", serde_json::json!([]), true),
            ("missing", serde_json::json!([]), true),
        ] {
            let filter = Filter {
                field: field.to_owned(),
                op: "notIn".to_owned(),
                value,
            };
            assert_eq!(matches(&attributes, &[filter])?, expected);
        }
        let invalid = Filter {
            field: "missing".to_owned(),
            op: "notIn".to_owned(),
            value: serde_json::Value::Null,
        };
        assert_eq!(
            matches(&attributes, &[invalid]),
            Err("Invalid notIn filter".into())
        );
        Ok(())
    }

    #[test]
    fn membership_preserves_types_empty_intersections_and_negation() -> Result<(), String> {
        let attributes: BTreeMap<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({
                "tags": ["ação", "😀", 1, true, null],
                "empty": [],
                "null": null,
                "scalar": "ação"
            }))
            .map_err(|cause| cause.to_string())?;
        for (field, op, value, expected) in [
            ("tags", "contains", serde_json::json!("ação"), true),
            ("tags", "contains", serde_json::json!("AÇÃO"), false),
            ("tags", "contains", serde_json::json!(1), true),
            ("tags", "contains", serde_json::json!("1"), false),
            ("tags", "contains", serde_json::json!(null), true),
            ("null", "contains", serde_json::json!(null), false),
            ("missing", "contains", serde_json::json!("ação"), false),
            ("missing", "notContains", serde_json::json!("ação"), true),
            ("scalar", "contains", serde_json::json!("ação"), false),
            (
                "tags",
                "containsAny",
                serde_json::json!([false, "😀"]),
                true,
            ),
            (
                "tags",
                "containsAny",
                serde_json::json!([false, "1"]),
                false,
            ),
            ("tags", "containsAny", serde_json::json!([]), false),
            ("tags", "notContainsAny", serde_json::json!([]), true),
            ("empty", "notContainsAny", serde_json::json!([1]), true),
            ("null", "notContainsAny", serde_json::json!([null]), true),
            ("scalar", "notContains", serde_json::json!("ação"), true),
        ] {
            let filter = Filter {
                field: field.to_owned(),
                op: op.to_owned(),
                value,
            };
            assert_eq!(matches(&attributes, &[filter])?, expected);
        }
        Ok(())
    }
}

#[cfg(test)]
mod typed_id_tests {
    use super::*;
    use serde_json::{Value, json};

    fn document(id: Value) -> Result<Document, String> {
        Document::from_canonical_json(
            &json!({
                "id":id,"revision":1,"roles":{"title":"","text":"shared"},
                "attributes":{"keep":true},"vector":[1.0,0.0]
            })
            .to_string(),
        )
    }

    #[test]
    fn typed_id_columns_roundtrip_frames_directories_and_rebuild()
    -> Result<(), Box<dyn std::error::Error>> {
        let ids = [
            json!("1"),
            json!("00112233-4455-6677-8899-aabbccddeeff"),
            json!({"kind":"uint","value":"2"}),
            json!({"kind":"uint","value":"10"}),
            json!({"kind":"uint","value":"18446744073709551615"}),
            json!({"kind":"uuid","value":"00112233-4455-6677-8899-aabbccddeeff"}),
        ];
        let documents = ids
            .iter()
            .cloned()
            .map(document)
            .collect::<Result<Vec<_>, _>>()?;
        let built = build(documents.clone(), None)?;
        assert_eq!(&built.bytes[..8], b"RAIOSEG5");
        let (header, base) = parse_header(&built.bytes)?;
        assert_eq!(header.version, 5);
        assert_eq!(header.documents.typed_ids.len(), 4);
        assert_eq!(
            header.documents.ids,
            "00112233-4455-6677-8899-aabbccddeeff1"
        );
        let mut restored = Vec::new();
        for (index, row) in header.documents.iter().enumerate() {
            assert_eq!(header.documents.find_id(row.id), Ok(index));
            let metadata = &built.bytes[base + row.data.offset as usize
                ..base + row.data.offset as usize + row.data.length as usize];
            let vector = header.vector_range(index)?.ok_or("Missing typed vector")?;
            let vector = &built.bytes[base + vector.offset as usize
                ..base + vector.offset as usize + vector.length as usize];
            let full = full_document_from_frames(metadata, vector)?;
            let query: Value = serde_json::from_str(&query_document_from_metadata(metadata)?)?;
            let full_value: Value = serde_json::from_str(&full)?;
            assert_eq!(query["id"], full_value["id"]);
            assert_eq!(serde_json::to_value(row.id)?, full_value["id"]);
            restored.push(Document::from_canonical_json(&full)?);
        }
        assert_eq!(build(restored, None)?.bytes, built.bytes);
        assert_eq!(migrate_segment(&built.bytes)?, built.bytes);
        let frame = compress_directory(&built.bytes[..base])?;
        assert_eq!(&frame[..8], b"RAIODIR7");
        let decoded = parse_compressed_directory(&frame, base, MAX_BYTES)?;
        assert_eq!(decoded.compact_json()?, header.compact_json()?);
        let common = compress_common_directory_segment(&built.bytes)?;
        assert_eq!(&common[..8], b"RAIOCOM5");
        let decoded_common =
            decode_directory_contents(&common, base, MAX_BYTES, None, *COMMON_DIRECTORY_MAGIC_V5)?;
        assert_eq!(
            serde_json::to_value(&decoded_common.header.documents)?,
            serde_json::to_value(&header.documents)?
        );
        let mut bad = built.bytes.clone();
        bad[..8].copy_from_slice(MAGIC_V4);
        assert!(parse_header(&bad).is_err());
        let mut bad = frame;
        bad[..8].copy_from_slice(DIRECTORY_MAGIC_V6);
        assert!(parse_compressed_directory(&bad, base, MAX_BYTES).is_err());
        for version in [2, 3, 4] {
            let mut bad = header.clone();
            bad.version = version;
            assert!(validate_header(&bad).is_err());
            let forged = bad.encode(&built.bytes[base..])?;
            assert!(parse_header(&forged).is_err());
        }
        let mut compact = binary_directory::encode(&header)?;
        compact[0] = 4;
        let forged = compress_directory_payload(&compact, base, *DIRECTORY_MAGIC_V6)?;
        assert!(parse_compressed_directory(&forged, base, MAX_BYTES).is_err());
        for document in documents
            .iter()
            .filter(|document| !matches!(document.id, DocumentId::String(_)))
        {
            assert!(document.to_native_json().is_err());
            assert!(document.to_native_vec().is_err());
        }
        Ok(())
    }

    #[test]
    fn native_string_identity_keeps_version_four_bytes_and_packed_storage()
    -> Result<(), Box<dyn std::error::Error>> {
        let native = Document::native(
            "row",
            1,
            "",
            "shared",
            BTreeMap::from([("keep".into(), json!(true))]),
            Some(vec![1.0, 0.0]),
        );
        let canonical = document(json!("row"))?;
        let built = build(vec![native], None)?;
        assert_eq!(build(vec![canonical], None)?.bytes, built.bytes);
        assert_eq!(&built.bytes[..8], b"RAIOSEG4");
        assert!(built.header.documents.typed_ids.is_empty());
        assert_eq!(built.header.documents.ids, "row");
        let (_, base) = parse_header(&built.bytes)?;
        let mut compact = binary_directory::encode(&built.header)?;
        compact[0] = 5;
        let forged = compress_directory_payload(&compact, base, *DIRECTORY_MAGIC_V7)?;
        assert!(parse_compressed_directory(&forged, base, MAX_BYTES).is_err());
        assert_eq!(migrate_segment(&built.bytes)?, built.bytes);
        Ok(())
    }
}

#[cfg(test)]
mod typed_id_filter_tests {
    use super::*;

    #[test]
    fn typed_ids_keep_filters_and_tombstones_before_text_and_vector_limits()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut documents = Vec::new();
        for value in [2, 10, 20, 30] {
            let mut document = Document::native(
                "placeholder",
                1,
                "",
                "shared",
                BTreeMap::new(),
                Some(vec![1.0]),
            );
            document.id = DocumentId::Uint(value);
            document
                .columns_mut()
                .attributes_mut()
                .insert("keep".into(), serde_json::json!(value != 2));
            documents.push(document);
        }
        let built = build(documents, None)?;
        let (header, base) = parse_header(&built.bytes)?;
        assert_eq!(header.documents.row(0).id, DocumentId::<String>::Uint(2));
        assert_eq!(header.documents.row(1).id, DocumentId::<String>::Uint(10));
        let filters = [Filter {
            field: "keep".into(),
            op: "eq".into(),
            value: serde_json::json!(true),
        }];
        let dead = [1];
        assert_eq!(header.vector_rows(&filters, &dead)?, vec![2, 3]);
        let statistics = Statistics {
            documents: 4,
            title_length: 0,
            body_length: 4,
            frequencies: BTreeMap::from([("shared".into(), 4)]),
        };
        let mut search = Search::new(
            header.clone(),
            statistics,
            "shared",
            "any",
            1,
            &dead,
            &filters,
        )?;
        for block in &header
            .terms()
            .get("shared")
            .ok_or("Missing shared posting")?
            .blocks
        {
            let start = base + usize::try_from(block.data.offset)?;
            search.add(
                "shared",
                &built.bytes[start..start + usize::try_from(block.data.length)?],
            )?;
        }
        let hits = search.finish()?;
        assert_eq!(hits.len(), 1);
        assert_eq!(
            header.documents.row(usize::try_from(hits[0].row)?).id,
            DocumentId::<String>::Uint(20)
        );
        Ok(())
    }
}

#[cfg(test)]
mod typed_id_bloom_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_blooms_preserve_legacy_string_hashes_and_bytes()
    -> Result<(), Box<dyn std::error::Error>> {
        let strings = [
            "",
            "1",
            "ação",
            "😀",
            "00112233-4455-6677-8899-aabbccddeeff",
            "{\"kind\":\"uint\",\"value\":\"1\"}",
        ]
        .map(str::to_owned);
        let ids = strings
            .iter()
            .cloned()
            .map(DocumentId::String)
            .collect::<Vec<_>>();
        assert_eq!(bloom_build_ids(&ids)?, bloom_build(&strings)?);
        assert_eq!(bloom_build_ids(&[])?, bloom_build(&[])?);
        for (id, string) in ids.iter().zip(&strings) {
            assert_eq!(bloom_id_hashes(id.borrowed())?, bloom_hashes(string));
        }
        let bytes = bloom_build(&strings)?;
        let offsets = [0, u32::try_from(bytes.len())?];
        let selected = bloom_filter_ids(&bytes, &offsets, &ids)?;
        let strings_selected = bloom_filter_many(&bytes, &offsets, &strings)?;
        assert_eq!(
            serde_json::to_value(selected)?,
            serde_json::to_value(strings_selected)?
        );
        Ok(())
    }

    #[test]
    fn canonical_bloom_membership_retains_tags_and_exact_lookup_does_not_alias()
    -> Result<(), Box<dyn std::error::Error>> {
        let uuid = "00112233-4455-6677-8899-aabbccddeeff";
        let ids = [
            json!("1"),
            json!({"kind":"uint","value":"1"}),
            json!({"kind":"uint","value":"18446744073709551615"}),
            json!(uuid),
            json!({"kind":"uuid","value":uuid}),
            json!("{\"kind\":\"uint\",\"value\":\"1\"}"),
        ]
        .into_iter()
        .map(serde_json::from_value::<DocumentId>)
        .collect::<Result<Vec<_>, _>>()?;
        let bytes = bloom_build_ids(&ids)?;
        let mut batch = bytes.clone();
        batch.extend_from_slice(&bytes);
        let offsets = [0, u32::try_from(bytes.len())?, u32::try_from(batch.len())?];
        let selected = bloom_filter_ids(&batch, &offsets, &ids)?;
        for selected in selected {
            assert_eq!(serde_json::to_value(selected)?, serde_json::to_value(&ids)?);
        }
        let documents = ids
            .iter()
            .cloned()
            .map(|id| {
                let mut document =
                    Document::native("placeholder", 1, "", "shared", BTreeMap::new(), None);
                document.id = id;
                document
            })
            .collect();
        let built = build(documents, None)?;
        let strings = [
            DocumentId::<String>::String("1".into()),
            DocumentId::String(uuid.into()),
        ];
        let numbers = [DocumentId::<String>::Uint(1), DocumentId::Uint(u64::MAX)];
        for id in strings.iter().chain(&numbers).chain(&ids) {
            let index = built
                .header
                .documents
                .find_id(id)
                .map_err(|_| "Missing canonical ID after bloom")?;
            assert_eq!(built.header.documents.row(index).id, id.borrowed());
        }
        assert_ne!(
            built.header.documents.find_id(&strings[0]),
            built.header.documents.find_id(&numbers[0])
        );
        let tagged_wire = DocumentId::<String>::String(serde_json::to_string(&numbers[0])?);
        assert_eq!(
            bloom_id_hashes(tagged_wire.borrowed())?,
            bloom_id_hashes(numbers[0].borrowed())?
        );
        assert_ne!(
            built.header.documents.find_id(&tagged_wire),
            built.header.documents.find_id(&numbers[0])
        );
        Ok(())
    }
}

#[cfg(test)]
mod typed_cutoff_tests {
    use super::*;

    #[test]
    fn canonical_cutoffs_share_exhaustive_ranking_and_never_alias_raw_json_strings()
    -> Result<(), Box<dyn std::error::Error>> {
        let cutoff = serde_json::json!({"kind":"uint","value":"10"}).to_string();
        let ids = [
            DocumentId::<String>::String(cutoff.clone()),
            DocumentId::Uint(2),
            DocumentId::Uint(10),
        ];
        let documents = ids
            .into_iter()
            .map(|id| {
                let mut document =
                    Document::native("placeholder", 1, "", "shared", BTreeMap::new(), None);
                document.id = id;
                document
            })
            .collect();
        let built = build(documents, None)?;
        let (header, base) = parse_header(&built.bytes)?;
        let statistics = Statistics {
            documents: 3,
            title_length: 0,
            body_length: 3,
            frequencies: BTreeMap::from([("shared".into(), 3)]),
        };
        let mut exhaustive = Search::new(
            header.clone(),
            statistics.clone(),
            "shared",
            "any",
            1,
            &[],
            &[],
        )?;
        let metadata = header
            .terms()
            .get("shared")
            .ok_or("Missing cutoff posting")?;
        for block in &metadata.blocks {
            let start = base + usize::try_from(block.data.offset)?;
            exhaustive.add(
                "shared",
                &built.bytes[start..start + usize::try_from(block.data.length)?],
            )?;
        }
        let score = exhaustive
            .block_bounds()
            .first()
            .and_then(|bounds| bounds.first())
            .ok_or("Missing cutoff bound")?
            .1;
        let mut selected = Search::new(header, statistics, "shared", "any", 1, &[], &[])?;
        assert!(selected.posting_spans_after(score, &cutoff)?.is_empty());
        let spans = selected.posting_spans_after_id(score, &cutoff)?;
        assert!(!spans.is_empty());
        let ranges = spans
            .iter()
            .flat_map(|span| span.blocks.iter().map(|block| block.data.clone()))
            .collect::<Vec<_>>();
        drop(spans);
        for range in ranges {
            let start = base + usize::try_from(range.offset)?;
            selected.add(
                "shared",
                &built.bytes[start..start + usize::try_from(range.length)?],
            )?;
        }
        let expected = exhaustive.finish()?;
        let actual = selected.finish()?;
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(&expected) {
            assert_eq!(actual.row, expected.row);
            assert_eq!(actual.score.to_bits(), expected.score.to_bits());
        }
        for invalid in [
            "10",
            r#"{"kind":"uint","value":"01"}"#,
            r#"{"kind":"uint","value":10}"#,
            r#"{"kind":"uuid","value":"INVALID"}"#,
            "\"\"",
        ] {
            assert!(selected.posting_spans_after_id(score, invalid).is_err());
        }
        assert!(selected.posting_spans_after_id(f64::NAN, &cutoff).is_err());
        Ok(())
    }
}
