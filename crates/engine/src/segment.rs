mod binary_directory;

use crate::normalize_text;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, VecDeque};
use std::rc::Rc;

const MAGIC: &[u8; 8] = b"RAIOSEG1";
const MAX_BYTES: usize = 16 * 1024 * 1024;
const BLOCK_SIZE: usize = 128;
const FILTER_CACHE_BYTES: usize = 32 * 1024;
const MAX_QUERY_TERMS: usize = 512;

#[derive(Clone, Default)]
struct FilterMasks {
    representatives: Option<(String, Box<[u16]>)>,
    entries: VecDeque<(String, Vec<bool>, usize)>,
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
        documents: &[DocumentMeta],
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
                .insert(documents[row].attributes.get(), row)
                .is_some_and(|previous| previous != row)
        });
        if repeated {
            let mut raw_groups = std::collections::HashMap::new();
            let mut groups = std::collections::HashMap::new();
            let mut group_bytes = 0;
            let mut values: BTreeMap<_, Option<serde_json::Value>> =
                fields.iter().map(|field| (*field, None)).collect();
            let representatives = documents
                .iter()
                .enumerate()
                .map(|(index, doc)| {
                    let row = u16::try_from(index).map_err(|cause| cause.to_string())?;
                    if let Some(previous) = raw_groups.get(doc.attributes.get()) {
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
                    if raw_groups.len() < 2048 {
                        raw_groups.insert(doc.attributes.get(), representative);
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub id: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub title: String,
    pub text: String,
    pub attributes: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector: Option<Vec<f32>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Range {
    pub offset: u32,
    pub length: u32,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DocumentMeta {
    pub id: String,
    pub revision: u64,
    pub title_length: u32,
    pub body_length: u32,
    pub attributes: Box<serde_json::value::RawValue>,
    pub data: Range,
    pub vector: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct BlockMeta {
    pub first: u32,
    pub last: u32,
    pub count: u32,
    pub max_title_tf: u32,
    pub max_body_tf: u32,
    pub min_title_length: u32,
    pub min_body_length: u32,
    pub data: Range,
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

    #[must_use]
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&str, &TermMeta)> {
        self.entries
            .iter()
            .map(|(term, metadata)| (&self.text[term.clone()], metadata))
    }

    #[must_use]
    pub fn keys(&self) -> impl ExactSizeIterator<Item = &str> {
        self.entries
            .iter()
            .map(|(term, _)| &self.text[term.clone()])
    }

    #[must_use]
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

#[derive(Clone, Serialize, Deserialize)]
pub struct Header {
    #[serde(skip)]
    filter_masks: RefCell<FilterMasks>,
    pub version: u32,
    pub documents: Vec<DocumentMeta>,
    pub terms: TermDictionary,
    pub total_title_length: u64,
    pub total_body_length: u64,
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

impl Header {
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        let documents = self.documents.capacity() * size_of::<DocumentMeta>()
            + self
                .documents
                .iter()
                .map(|doc| doc.id.capacity() + doc.attributes.get().len() + 32)
                .sum::<usize>();
        let terms = self.terms.entries.len() * size_of::<(std::ops::Range<usize>, TermMeta)>()
            + self.terms.text.len()
            + 16
            + self
                .terms
                .values()
                .map(|meta| meta.blocks.len() * size_of::<BlockMeta>())
                .sum::<usize>();
        documents + terms + size_of::<Self>() + 32 + FILTER_CACHE_BYTES
    }

    fn compact_json(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&(
            self.version,
            DirectoryDocuments(&self.documents),
            DirectoryTerms(&self.terms),
            self.total_title_length,
            self.total_body_length,
        ))
        .map_err(|cause| cause.to_string())
    }

    fn encode(&self, payload: &[u8]) -> Result<Vec<u8>, String> {
        let json = self.compact_json()?;
        if json.len() + payload.len() + 16 > MAX_BYTES {
            return Err("Segment exceeds 16 MiB".into());
        }
        let mut bytes = Vec::with_capacity(json.len() + payload.len() + 16);
        bytes.extend_from_slice(MAGIC);
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
            .iter()
            .zip(&allowed)
            .filter(|(_, allowed)| **allowed)
            .fold(None, |minimum, (document, _)| match minimum {
                Some((title, body)) => Some((
                    u32::min(title, document.title_length),
                    u32::min(body, document.body_length),
                )),
                None => Some((document.title_length, document.body_length)),
            }))
    }

    fn allowed(&self, filters: &[Filter], dead: &[u32]) -> Result<Vec<bool>, String> {
        let key = serde_json::to_string(filters).map_err(|cause| cause.to_string())?;
        let cached = self
            .filter_masks
            .borrow()
            .entries
            .iter()
            .find(|(existing, _, _)| existing == &key)
            .map(|(_, mask, _)| mask.clone());
        let mut allowed = vec![true; self.documents.len()];
        if let Some(mask) = cached {
            allowed = mask;
        } else if !filters.is_empty() {
            let fields: BTreeSet<_> = filters.iter().map(|filter| filter.field.as_str()).collect();
            let mut values: BTreeMap<_, Option<serde_json::Value>> =
                fields.iter().map(|field| (*field, None)).collect();
            self.filter_masks
                .borrow_mut()
                .prepare_representatives(&self.documents, &fields)?;
            let cache = self.filter_masks.borrow();
            for (index, doc) in self.documents.iter().enumerate() {
                if let Some((_, representatives)) = &cache.representatives {
                    let representative = usize::from(representatives[index]);
                    if representative != index {
                        allowed[index] = allowed[representative];
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
                        allowed[index] = false;
                        break;
                    }
                }
            }
            drop(cache);
            let bytes = key.capacity() + allowed.capacity() + 128;
            let mut cache = self.filter_masks.borrow_mut();
            if cache.reserve(bytes) {
                cache.bytes += bytes;
                cache.entries.push_back((key, allowed.clone(), bytes));
            }
        }
        for row in dead {
            *allowed
                .get_mut(*row as usize)
                .ok_or("Invalid deleted row")? = false;
        }
        Ok(allowed)
    }
}

pub struct BuiltSegment {
    pub header: Header,
    pub bytes: Vec<u8>,
}

fn append(payload: &mut Vec<u8>, data: &[u8]) -> Result<Range, String> {
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
    let decoded = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&bytes[8..], MAX_BYTES)
        .map_err(|cause| format!("Invalid compressed page: {cause}"))?;
    if decoded.len() != length || crc32fast::hash(&decoded) != crc {
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

fn encode_postings(postings: &[Posting]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    put_int(
        u32::try_from(postings.len()).map_err(|cause| cause.to_string())?,
        &mut bytes,
    );
    let mut previous = 0;
    for posting in postings {
        put_int(posting.row - previous, &mut bytes);
        previous = posting.row;
        for positions in [&posting.title, &posting.body] {
            put_int(
                u32::try_from(positions.len()).map_err(|cause| cause.to_string())?,
                &mut bytes,
            );
            let mut prior = 0;
            for position in positions {
                put_int(position - prior, &mut bytes);
                prior = *position;
            }
        }
    }
    Ok(bytes)
}

struct DecodedPositions {
    count: u32,
    last: Option<u32>,
    values: Vec<u32>,
}

fn decode_positions<const POSITIONAL: bool>(
    data: &[u8],
    offset: &mut usize,
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
    let mut position = 0u32;
    for index in 0..length {
        let delta = get_int(data, offset)?;
        if index > 0 && delta == 0 {
            return Err("Duplicate token position".into());
        }
        position = position.checked_add(delta).ok_or("Position overflow")?;
        if POSITIONAL {
            values.push(position);
        }
    }
    let last = if count == 0 { None } else { Some(position) };
    Ok(DecodedPositions {
        count,
        last,
        values,
    })
}

fn decode_posting_rows<const POSITIONAL: bool, T>(
    bytes: &[u8],
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
        let title = decode_positions::<POSITIONAL>(&data, &mut offset)?;
        let body = decode_positions::<POSITIONAL>(&data, &mut offset)?;
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

fn encode_terms(
    payload: &mut Vec<u8>,
    metadata: &[DocumentMeta],
    lists: BTreeMap<String, Vec<Posting>>,
) -> Result<TermDictionary, String> {
    let mut terms = Vec::with_capacity(lists.len());
    for (term, postings) in lists {
        let mut blocks = Vec::with_capacity(postings.len().div_ceil(BLOCK_SIZE));
        for chunk in postings.chunks(BLOCK_SIZE) {
            let data = append(payload, &encode_postings(chunk)?)?;
            blocks.push(BlockMeta {
                first: chunk[0].row,
                last: chunk[chunk.len() - 1].row,
                count: u32::try_from(chunk.len()).map_err(|cause| cause.to_string())?,
                max_title_tf: u32::try_from(
                    chunk
                        .iter()
                        .map(|posting| posting.title.len())
                        .max()
                        .ok_or("Empty posting block")?,
                )
                .map_err(|cause| cause.to_string())?,
                max_body_tf: u32::try_from(
                    chunk
                        .iter()
                        .map(|posting| posting.body.len())
                        .max()
                        .ok_or("Empty posting block")?,
                )
                .map_err(|cause| cause.to_string())?,
                min_title_length: chunk
                    .iter()
                    .map(|p| metadata[p.row as usize].title_length)
                    .min()
                    .ok_or("Empty posting block")?,
                min_body_length: chunk
                    .iter()
                    .map(|p| metadata[p.row as usize].body_length)
                    .min()
                    .ok_or("Empty posting block")?,
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

#[doc = "# Errors\nRejects empty or duplicate documents, wire-size overflow, serialization errors, and segments beyond the size budget."]
pub fn build(mut documents: Vec<Document>) -> Result<BuiltSegment, String> {
    if documents.is_empty() {
        return Err("Segment must contain at least one document".into());
    }
    if documents.len() > 10000 {
        return Err("Segment exceeds 10000 documents".into());
    }
    documents.sort_by(|a, b| a.id.encode_utf16().cmp(b.id.encode_utf16()));
    if documents.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err("Duplicate segment ids".into());
    }
    let mut payload = Vec::new();
    let mut metadata = Vec::with_capacity(documents.len());
    let mut lists: BTreeMap<String, Vec<Posting>> = BTreeMap::new();
    let mut total_title_length = 0;
    let mut total_body_length = 0;
    for (index, document) in documents.iter().enumerate() {
        let row = u32::try_from(index).map_err(|cause| cause.to_string())?;
        let title = normalize_text(&document.title);
        let body = normalize_text(&document.text);
        let title_tokens: Vec<_> = title.split_whitespace().collect();
        let body_tokens: Vec<_> = body.split_whitespace().collect();
        total_title_length += title_tokens.len() as u64;
        total_body_length += body_tokens.len() as u64;
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
        let json = serde_json::to_vec(document).map_err(|e| e.to_string())?;
        let data = append(&mut payload, &json)?;
        metadata.push(DocumentMeta {
            id: document.id.clone(),
            revision: document.revision,
            title_length: u32::try_from(title_tokens.len()).map_err(|cause| cause.to_string())?,
            body_length: u32::try_from(body_tokens.len()).map_err(|cause| cause.to_string())?,
            attributes: serde_json::value::RawValue::from_string(
                serde_json::to_string(&document.attributes).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?,
            data,
            vector: document.vector.is_some(),
        });
    }
    let terms = encode_terms(&mut payload, &metadata, lists)?;
    let header = Header {
        filter_masks: RefCell::default(),
        version: 1,
        documents: metadata,
        terms,
        total_title_length,
        total_body_length,
    };
    let bytes = header.encode(&payload)?;
    Ok(BuiltSegment { header, bytes })
}

#[doc = "# Errors\nRejects invalid framing, checksums, versions, ordering, frequencies, and posting directories."]
pub fn parse_header(bytes: &[u8]) -> Result<(Header, usize), String> {
    if bytes.len() < 16 || &bytes[..8] != MAGIC {
        return Err("Invalid segment header".into());
    }
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
    let mut header: Header = serde_json::from_str(text).map_err(|e| e.to_string())?;
    validate_header(&header)?;
    header.documents.shrink_to_fit();
    Ok((header, 16 + length))
}

fn validate_header(header: &Header) -> Result<(), String> {
    if header.version != 1 || header.documents.len() > 10000 {
        return Err("Invalid segment version or document count".into());
    }
    if header
        .documents
        .windows(2)
        .any(|p| p[0].id.encode_utf16().cmp(p[1].id.encode_utf16()) != Ordering::Less)
    {
        return Err("Segment ids are not strictly sorted".into());
    }
    for term in header.terms.values() {
        if term.df > u32::try_from(header.documents.len()).map_err(|cause| cause.to_string())? {
            return Err("Invalid term document frequency".into());
        }
        if term
            .blocks
            .windows(2)
            .any(|pair| pair[0].last >= pair[1].first)
        {
            return Err("Posting block rows are not strictly ordered".into());
        }
        for block in &term.blocks {
            if block.last
                >= u32::try_from(header.documents.len()).map_err(|cause| cause.to_string())?
                || block.first > block.last
                || block.count as usize > BLOCK_SIZE
            {
                return Err("Invalid posting block directory".into());
            }
        }
    }
    Ok(())
}

const DIRECTORY_MAGIC: &[u8; 8] = b"RAIODIR3";

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

struct DirectoryDocuments<'a>(&'a [DocumentMeta]);

impl Serialize for DirectoryDocuments<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|document| {
            (
                &document.id,
                document.revision,
                document.title_length,
                document.body_length,
                &document.attributes,
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
                block.max_title_tf,
                block.max_body_tf,
                block.min_title_length,
                block.min_body_length,
                (block.data.offset, block.data.length),
            )
        }))
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
    let length = bytes.len();
    let compact = binary_directory::encode(&header)?;
    if compact.len() > MAX_BYTES || compact.len() > length {
        return Err("Compact directory exceeds size budget".into());
    }
    let mut encoded = Vec::with_capacity(20);
    encoded.extend_from_slice(DIRECTORY_MAGIC);
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
    checksum.update(&compact);
    encoded.extend_from_slice(&checksum.finalize().to_le_bytes());
    let flags = miniz_oxide::deflate::core::create_comp_flags_from_zip_params(3, 1, 0);
    let mut compressor = miniz_oxide::deflate::core::CompressorOxide::new(flags);
    let (status, consumed) = miniz_oxide::deflate::core::compress_to_output(
        &mut compressor,
        &compact,
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
    decode_directory_frame(bytes, expected, max_heap_bytes, None)
}

fn decode_directory_frame(
    bytes: &[u8],
    expected: usize,
    max_heap_bytes: usize,
    checksum_verified: Option<&std::cell::Cell<bool>>,
) -> Result<Header, String> {
    if bytes.len() < 20 || &bytes[..8] != DIRECTORY_MAGIC || bytes.len() > MAX_BYTES + 8192 {
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
    if compact_length > MAX_BYTES || compact_length > expected {
        return Err("Compact directory exceeds size budget".into());
    }
    let checksum = u32::from_le_bytes(
        bytes[16..20]
            .try_into()
            .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
    );
    let mut decoded = vec![0; compact_length];
    let length = miniz_oxide::inflate::decompress_slice_iter_to_slice(
        &mut decoded,
        std::iter::once(&bytes[20..]),
        true,
        false,
    )
    .map_err(|cause| format!("{cause:?}"))?;
    if length != compact_length {
        return Err("Compressed directory integrity check failed".into());
    }
    if !checksum_verified.is_some_and(std::cell::Cell::get) {
        let mut verified = crc32fast::Hasher::new();
        verified.update(&bytes[..16]);
        verified.update(&decoded);
        if verified.finalize() != checksum {
            return Err("Compressed directory integrity check failed".into());
        }
    }
    let header = binary_directory::decode(&decoded, max_heap_bytes)?;
    validate_header(&header)?;
    if let Some(verified) = checksum_verified {
        verified.set(true);
    }
    Ok(header)
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

fn compare_number(value: &serde_json::Value, expected: &serde_json::Value, op: &str) -> bool {
    if let (Some(a), Some(b)) = (value.as_f64(), expected.as_f64()) {
        return match op {
            "gt" => a > b,
            "gte" => a >= b,
            "lt" => a < b,
            "lte" => a <= b,
            _ => false,
        };
    }
    false
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
            "gt" | "gte" | "lt" | "lte" => {
                actual.is_some_and(|value| compare_number(value, &self.value, &self.op))
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

struct PostingCursors<'a, T: PostingRow> {
    lists: Vec<&'a [T]>,
    cursors: Vec<usize>,
    allowed: &'a [bool],
    driver: Option<usize>,
    required: Option<usize>,
    requirement: Option<(usize, f64)>,
    dense: bool,
}

impl<'a, T: PostingRow> PostingCursors<'a, T> {
    fn new(lists: Vec<&'a [T]>, allowed: &'a [bool], intersect: bool) -> Self {
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
    pub allowed: Vec<bool>,
    terms: Rc<QueryTerms>,
    lists: PostingLists,
    last_decoded_rows: BTreeMap<String, Option<u32>>,
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
    pub fn posting_spans(&self) -> Vec<PostingSpan<'_>> {
        self.posting_spans_matching(|_| true)
    }

    #[doc = "# Errors\nRejects non-positive or non-finite cutoff scores."]
    pub fn posting_spans_after(
        &self,
        score: f64,
        id: &str,
    ) -> Result<Vec<PostingSpan<'_>>, String> {
        self.posting_spans_cutoff(score, id, false)
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
                    .terms
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
        for document in self.header.documents.iter().take(lengths.len()) {
            let pair = (document.title_length, document.body_length);
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
        for (row, document) in self.header.documents.iter().enumerate() {
            if !self.allowed[row] {
                continue;
            }
            let compute = || {
                dense.iter().fold(0.0, |score, scorer| {
                    score + scorer.minimum_score(document.title_length, document.body_length)
                })
            };
            let score = if REUSE_LENGTHS {
                let identity =
                    (u64::from(document.title_length) << 32) | u64::from(document.body_length);
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
                    &self.header.documents[cutoff.row as usize].id,
                    true,
                )
            },
        )
    }

    fn posting_spans_cutoff(
        &self,
        score: f64,
        id: &str,
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
            self.allowed[candidate.first as usize..=candidate.last as usize]
                .iter()
                .position(|allowed| *allowed)
                .is_some_and(|offset| {
                    let order = self.header.documents[candidate.first as usize + offset]
                        .id
                        .encode_utf16()
                        .cmp(id.encode_utf16());
                    order == Ordering::Less || (inclusive && order == Ordering::Equal)
                })
        }))
    }

    fn posting_spans_matching(
        &self,
        competitive: impl Fn(&BlockMeta) -> bool,
    ) -> Vec<PostingSpan<'_>> {
        let unrestricted = self.allowed.iter().all(|allowed| *allowed);
        let mut spans: Vec<PostingSpan<'_>> = Vec::new();
        for index in &self.terms.order {
            let term = &self.words[*index];
            let Some(metadata) = self.header.terms.get(term) else {
                continue;
            };
            let mut blocks: Vec<&BlockMeta> = Vec::new();
            for block in &metadata.blocks {
                if (unrestricted
                    || self.allowed[block.first as usize..=block.last as usize]
                        .iter()
                        .any(|allowed| *allowed))
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
        })
    }

    #[doc = "# Errors\nRejects unrequested terms, corrupt pages, invalid rows or positions, and unordered posting blocks."]
    pub fn add(&mut self, term: &str, bytes: &[u8]) -> Result<(), String> {
        if !self.words.iter().any(|word| word == term) {
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
        if !self.words.iter().any(|word| word == term) {
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
        if !self.words.iter().any(|word| word == term) {
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
        let unrestricted = self.allowed.iter().all(|allowed| *allowed);
        self.terms
            .order
            .iter()
            .enumerate()
            .map(|(index, term)| {
                self.header
                    .terms
                    .get(self.words[*term].as_str())
                    .into_iter()
                    .flat_map(|meta| meta.blocks.iter())
                    .map(|block| {
                        let minimum = if unrestricted {
                            Some((block.min_title_length, block.min_body_length))
                        } else {
                            let rows = block.first as usize..=block.last as usize;
                            self.header.documents[rows.clone()]
                                .iter()
                                .zip(&self.allowed[rows])
                                .filter(|(_, allowed)| **allowed)
                                .fold(None, |minimum, (document, _)| match minimum {
                                    Some((title, body)) => Some((
                                        u32::min(title, document.title_length),
                                        u32::min(body, document.body_length),
                                    )),
                                    None => Some((document.title_length, document.body_length)),
                                })
                        };
                        let score = minimum.map_or(0.0, |(title, body)| {
                            self.terms.scorers[index].score(
                                block.max_title_tf,
                                block.max_body_tf,
                                block.min_title_length.max(title),
                                block.min_body_length.max(body),
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
            let meta = &self.header.documents[row as usize];
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
            if heap.len() < self.top_k {
                heap.push(hit);
            } else if let Some(mut cutoff) = heap.peek_mut()
                && hit < *cutoff
            {
                *cutoff = hit;
            }
        }
        let mut hits = heap.into_vec();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.row.cmp(&b.row)));
        Ok(hits)
    }
}

pub fn document_terms(document: &Document) -> Vec<String> {
    normalize_text(&format!("{} {}", document.title, document.text))
        .split_whitespace()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
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
    if values.len() > MAX_BYTES / 2 {
        return Err("Bloom exceeds size budget".into());
    }
    let mut bytes = vec![0u8; (values.len() * 2).max(8)];
    for value in values {
        let (a, b) = bloom_hashes(value);
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
    let hashes: Vec<_> = values
        .iter()
        .map(|value| {
            let (a, b) = bloom_hashes(value);
            (value.as_str(), a, b)
        })
        .collect();
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
        BlockMeta, BuiltSegment, Document, DocumentMeta, Filter, Header, MAX_BYTES,
        MAX_QUERY_TERMS, Range, Search, SelectedAttributes, Statistics, TermDictionary, TermMeta,
        TermScorer, append, bloom_build, bloom_filter_many, build, decode_page, document_terms,
        matches, parse_header,
    };
    use serde::{Deserialize, Serialize};
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};
    use std::rc::{Rc, Weak};
    use wasm_bindgen::prelude::*;

    fn summary_bounds(blocks: &[BlockMeta]) -> Vec<(u32, u32, u32, u32)> {
        let mut bounds: Vec<_> = blocks
            .iter()
            .map(|block| {
                (
                    block.max_title_tf,
                    block.max_body_tf,
                    block.min_title_length,
                    block.min_body_length,
                )
            })
            .collect();
        bounds.sort_unstable();
        bounds.dedup();
        bounds
    }

    #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
    struct TermSummary {
        df: u32,
        bounds: Vec<(u32, u32, u32, u32)>,
    }

    impl From<&TermMeta> for TermSummary {
        fn from(meta: &TermMeta) -> Self {
            Self {
                df: meta.df,
                bounds: summary_bounds(&meta.blocks),
            }
        }
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LeaderDocument {
        row: u32,
        id: String,
        data: Range,
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CommonLeader {
        field: String,
        terms: Vec<String>,
        length: u32,
        longer: bool,
        documents: Vec<LeaderDocument>,
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
                    id: &document.id,
                    score,
                    data: &document.data,
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
                .terms
                .iter()
                .filter(|(term, metadata)| count > 1 && metadata.df == count && term.len() <= 64)
                .take(16)
                .filter(|(_, metadata)| {
                    metadata.blocks.iter().all(|block| {
                        (block.max_title_tf, block.max_body_tf)
                            == if title { (1, 0) } else { (0, 1) }
                    })
                })
                .map(|(term, _)| term.to_owned())
                .collect();
            if terms.is_empty() {
                continue;
            }
            let length = |document: &DocumentMeta| {
                if title {
                    document.title_length
                } else {
                    document.body_length
                }
            };
            let Some(minimum) = header.documents.iter().map(length).min() else {
                continue;
            };
            let mut documents = Vec::new();
            let mut bytes = 0;
            for (row, document) in header.documents.iter().enumerate() {
                if length(document) != minimum {
                    continue;
                }
                let charge = document.id.len() * 6 + 128;
                if documents.len() == 16 || bytes + charge > 4096 {
                    break;
                }
                bytes += charge;
                documents.push(LeaderDocument {
                    row: u32::try_from(row).map_err(|cause| cause.to_string())?,
                    id: document.id.clone(),
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
                    .any(|document| length(document) > minimum),
                documents,
            });
        }
        serde_json::to_string(&leaders).map_err(|cause| cause.to_string())
    }

    fn common_terms(header: &Header) -> Result<String, String> {
        let mut entries: Vec<_> = header
            .terms
            .iter()
            .filter(|(term, metadata)| metadata.df > 1 && term.len() <= 64)
            .collect();
        if entries.len() > 16 {
            entries.select_nth_unstable_by(16, |left, right| {
                right.1.df.cmp(&left.1.df).then_with(|| left.0.cmp(right.0))
            });
            entries.truncate(16);
        }
        let dictionary: BTreeMap<_, _> = entries
            .into_iter()
            .map(|(term, metadata)| {
                let first = metadata
                    .blocks
                    .first()
                    .ok_or("Common term has no posting blocks")?;
                let bounds = metadata.blocks.iter().skip(1).fold(
                    (
                        first.max_title_tf,
                        first.max_body_tf,
                        first.min_title_length,
                        first.min_body_length,
                    ),
                    |(title, body, title_length, body_length), block| {
                        (
                            title.max(block.max_title_tf),
                            body.max(block.max_body_tf),
                            title_length.min(block.min_title_length),
                            body_length.min(block.min_body_length),
                        )
                    },
                );
                Ok::<_, String>((
                    term,
                    TermSummary {
                        df: metadata.df,
                        bounds: vec![bounds],
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

    struct EligibilityProjectionBuilder {
        fields: Vec<String>,
        groups: Option<BTreeMap<String, (u32, u32)>>,
        columns: Option<Vec<BTreeMap<String, (u32, u32)>>>,
        scalar: Vec<u8>,
        bytes: usize,
    }

    impl EligibilityProjectionBuilder {
        fn new(fields: Vec<String>) -> Result<Self, String> {
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

        fn push(
            &mut self,
            attributes: &BTreeMap<String, serde_json::Value>,
            title: u32,
            body: u32,
        ) -> Result<(), String> {
            if self.groups.is_none() && self.columns.is_none() {
                return Ok(());
            }
            if self
                .fields
                .iter()
                .filter_map(|field| attributes.get(field))
                .any(|value| value.is_array() || value.is_object())
                || self
                    .fields
                    .iter()
                    .filter_map(|field| attributes.get(field))
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
                for (field, column) in self.fields.iter().zip(columns.iter_mut()) {
                    self.scalar.clear();
                    if let Some(value) = attributes.get(field) {
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
            let values: Vec<Vec<_>> = self
                .fields
                .iter()
                .map(|field| {
                    attributes
                        .get(field)
                        .map(serde_json::to_string)
                        .transpose()
                        .map(|value| value.into_iter().collect())
                })
                .collect::<Result<_, _>>()
                .map_err(|cause| cause.to_string())?;
            let Some(groups) = &mut self.groups else {
                self.push_columns(&values, title, body);
                return Ok(());
            };
            let key = serde_json::to_string(&values).map_err(|cause| cause.to_string())?;
            if let Some((minimum_title, minimum_body)) = groups.get_mut(&key) {
                *minimum_title = (*minimum_title).min(title);
                *minimum_body = (*minimum_body).min(body);
            } else {
                self.bytes += key.len() + 32;
                if groups.len() >= 256 || self.bytes > 4096 {
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
                groups.insert(key, (title, body));
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
        fn marginal_minimum(
            &self,
            columns: Vec<Vec<(Option<String>, u32, u32)>>,
        ) -> Result<Option<(u32, u32)>, String> {
            if columns.is_empty()
                || columns.len() != self.fields.len()
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
                    for (filter, field) in self.filters.iter().zip(&self.field_indices) {
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
                lower = lower
                    .zip(minimum)
                    .map(|((a, b), (c, d))| (a.max(c), b.max(d)));
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

        #[doc = "# Errors\nRejects oversized, malformed or differently scoped eligibility projections."]
        pub fn minimum(&self, projection: &str) -> Result<String, JsValue> {
            if projection.len() > 4096 {
                return Err(JsValue::from_str("Eligibility projection exceeds four KiB"));
            }
            let projection: EligibilityProjection = serde_json::from_str(projection)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            if projection.fields != self.fields {
                return Err(JsValue::from_str("Eligibility projection scope mismatch"));
            }
            let groups = match projection.data {
                EligibilityData::Joint { groups } => groups,
                EligibilityData::Marginal { columns } => {
                    let minimum = self
                        .marginal_minimum(columns)
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
                if values.len() != self.fields.len() || values.iter().any(|value| value.len() > 1) {
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
                for (filter, index) in self.filters.iter().zip(&self.field_indices) {
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
                + summary.bounds.capacity() * size_of::<(u32, u32, u32, u32)>()
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
        partitions: &'a [BTreeMap<String, TermSummary>],
        pool: &'a RefCell<SummaryPool>,
    }

    struct OverviewPartition<'a> {
        terms: &'a BTreeMap<String, TermSummary>,
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

    struct DirectoryOverview<'a> {
        header: &'a Header,
        eligibility: OverviewEligibility<'a>,
        partitions: Option<&'a [BTreeMap<String, TermSummary>]>,
    }

    impl Serialize for DirectoryOverview<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeTuple;
            let pool = RefCell::new(SummaryPool::default());
            let mut tuple = serializer.serialize_tuple(4)?;
            tuple.serialize_element(&OverviewDictionary {
                terms: &self.header.terms,
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
                    self.header.documents[group.row].attributes.as_ref(),
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
            while sequence.next_element::<(u32, u32, u32, u32)>()?.is_some() {}
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
            let mut minimum = None;
            let fields: BTreeSet<_> = self.0.iter().map(|filter| filter.field.as_str()).collect();
            let mut groups = EligibilityProjectionBuilder::new(
                fields.iter().map(|field| (*field).to_owned()).collect(),
            )
            .map_err(serde::de::Error::custom)?;
            let mut present = false;
            while let Some((attributes, title, body)) =
                sequence.next_element_seed(SelectedGroup(&fields))?
            {
                present = true;
                groups
                    .push(&attributes, title, body)
                    .map_err(serde::de::Error::custom)?;
                if matches(&attributes, self.0).map_err(serde::de::Error::custom)? {
                    minimum = Some(match minimum {
                        Some((minimum_title, minimum_body)) => {
                            (title.min(minimum_title), body.min(minimum_body))
                        }
                        None => (title, body),
                    });
                }
            }
            if !present {
                return Err(serde::de::Error::custom("Overview eligibility is empty"));
            }
            if self.0.is_empty() {
                return Ok(EligibleSelection {
                    minimum: Some((0, 0)),
                    projection: None,
                });
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

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedOverview<'_> {
        type Value = Overview;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_tuple(4, self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedOverview<'_> {
        type Value = Overview;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("term indices, eligibility, partitions and summary pool")
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
            if sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(serde::de::Error::invalid_length(5, &self));
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
            Ok(Overview {
                dictionary: resolve(dictionary)?,
                minimum: eligibility.minimum,
                eligibility: eligibility.projection,
                partitions: partitions
                    .map(|partitions| partitions.into_iter().map(resolve).collect())
                    .transpose()?,
            })
        }
    }

    fn term_bound(meta: &TermSummary, scorer: &TermScorer, minimum: (u32, u32)) -> f64 {
        meta.bounds
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
                        .map_or(0.0, |scorer| term_bound(meta, scorer, minimum))
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
    #[doc = "# Errors\nRejects invalid canonical headers or size limits."]
    pub fn directory_compress(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        super::compress_directory(bytes).map_err(|cause| JsValue::from_str(&cause))
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
        partitions: Option<&[BTreeMap<String, TermSummary>]>,
        groups: &[EligibilityGroup],
    ) -> Result<Vec<u8>, String> {
        let json = serde_json::to_vec(&DirectoryOverview {
            header,
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
        let mut partitions: Vec<BTreeMap<String, TermSummary>> = (0..lengths.len().min(32))
            .map(|_| BTreeMap::new())
            .collect();
        let mut entries = 0;
        let entry_budget = (header.terms.len() / 4).clamp(512, 65536);
        for (term, metadata) in &header.terms {
            if metadata.df == 1 {
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
                    let document = &header.documents[row.posting.row as usize];
                    let group = groups[&(document.title_length, document.body_length)];
                    let partition = &mut partitions[group];
                    if !partition.contains_key(term) {
                        entries += 1;
                        if entries > entry_budget {
                            return Ok(None);
                        }
                    }
                    let summary = partition
                        .entry(term.to_owned())
                        .or_insert_with(|| TermSummary {
                            df: 0,
                            bounds: vec![(0, 0, document.title_length, document.body_length)],
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
        let encoded = encode_overview(&header, Some(&partitions), &overview_eligibility(&header))?;
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
        pub fn new(json: &str) -> Result<Self, JsValue> {
            let documents: Vec<Document> =
                serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            Ok(Self {
                built: build(documents).map_err(|cause| JsValue::from_str(&cause))?,
            })
        }
        #[must_use]
        pub fn bytes(&self) -> Vec<u8> {
            self.built.bytes.clone()
        }
        #[doc = "# Errors\nRejects common-term metadata or serialization failures."]
        pub fn common_terms(&self) -> Result<String, JsValue> {
            common_terms(&self.built.header).map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects common-leader serialization errors."]
        pub fn common_leaders(&self) -> Result<String, JsValue> {
            common_leaders(&self.built.header).map_err(|cause| JsValue::from_str(&cause))
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
        checksum_verified: std::cell::Cell<bool>,
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
            let expected = expected as usize;
            if bytes.len() < 20
                || bytes.len() > MAX_BYTES + 8192
                || &bytes[..8] != super::DIRECTORY_MAGIC
                || !(16..=MAX_BYTES).contains(&expected)
            {
                return Err(JsValue::from_str("Invalid compressed directory frame"));
            }
            Ok(Self {
                frame: Rc::new(CachedDirectoryFrame {
                    bytes: bytes.into_boxed_slice(),
                    expected,
                    checksum_verified: std::cell::Cell::new(false),
                }),
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
            let header = super::decode_directory_frame(
                &self.frame.bytes,
                self.frame.expected,
                max_heap_bytes as usize,
                Some(&self.frame.checksum_verified),
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Directory {
                header: Rc::new(header),
                overview_groups: RefCell::default(),
            })
        }
    }

    #[wasm_bindgen]
    pub struct Directory {
        header: Rc<Header>,
        overview_groups: RefCell<Option<Box<[EligibilityGroup]>>>,
    }

    #[wasm_bindgen]
    impl Directory {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects invalid input serialization or segment framing, size, and integrity constraints."]
        pub fn new(bytes: &[u8]) -> Result<Self, JsValue> {
            let (header, _) = parse_header(bytes).map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                header: Rc::new(header),
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
                overview_groups: RefCell::default(),
            })
        }

        #[doc = "# Errors\nRejects invalid canonical headers, trailing bytes and mismatched expected lengths."]
        pub fn canonical(bytes: &[u8], expected: u32) -> Result<Self, JsValue> {
            let header = super::parse_directory(bytes, expected as usize)
                .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                header: Rc::new(header),
                overview_groups: RefCell::default(),
            })
        }

        #[must_use]
        pub fn retain(&self) -> Self {
            Self {
                header: self.header.clone(),
                overview_groups: RefCell::default(),
            }
        }

        #[must_use]
        pub fn heap_bytes(&self) -> usize {
            self.header.heap_bytes()
                + self
                    .overview_groups
                    .borrow()
                    .as_ref()
                    .map_or(0, |groups| size_of_val(groups.as_ref()))
        }

        #[doc = "# Errors\nRejects invalid term JSON or directory serialization errors."]
        pub fn terms(&self, terms: &str) -> Result<String, JsValue> {
            let terms: Vec<String> =
                serde_json::from_str(terms).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let selected: BTreeMap<_, _> = terms
                .iter()
                .filter_map(|term| self.header.terms.get(term).map(|meta| (term, meta)))
                .collect();
            serde_json::to_string(&selected).map_err(|e| JsValue::from_str(&e.to_string()))
        }

        #[doc = "# Errors\nRejects invalid term JSON or summary serialization."]
        pub fn summary(&self, terms: &str) -> Result<String, JsValue> {
            let terms: Vec<String> = serde_json::from_str(terms)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let selected: BTreeMap<_, _> = terms
                .iter()
                .filter_map(|term| {
                    self.header
                        .terms
                        .get(term)
                        .map(|meta| (term, TermSummary::from(meta)))
                })
                .collect();
            serde_json::to_string(&selected).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects invalid terms, filters, attributes, or catalog serialization."]
        pub fn catalog(&self, terms: &str, filters: &str) -> Result<String, JsValue> {
            use serde::de::DeserializeSeed;

            let terms: Vec<String> = serde_json::from_str(terms)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let filters: Vec<Filter> = serde_json::from_str(filters)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            if terms.len() > MAX_QUERY_TERMS || filters.len() > 16 {
                return Err(JsValue::from_str("Catalog projection exceeds query limits"));
            }
            let fields: BTreeSet<_> = filters.iter().map(|filter| filter.field.as_str()).collect();
            let mut groups = EligibilityProjectionBuilder::new(
                fields.iter().map(|field| (*field).to_owned()).collect(),
            )
            .map_err(|cause| JsValue::from_str(&cause))?;
            let mut minimum = None;
            let retained = self.overview_groups.borrow_mut().take();
            if !filters.is_empty() {
                let physical = retained.unwrap_or_else(|| overview_eligibility(&self.header));
                for group in &physical {
                    let attributes = &self.header.documents[group.row].attributes;
                    let title = group.title;
                    let body = group.body;
                    let mut deserializer = serde_json::Deserializer::from_str(attributes.get());
                    let attributes = SelectedAttributes(&fields)
                        .deserialize(&mut deserializer)
                        .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
                    deserializer
                        .end()
                        .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
                    groups
                        .push(&attributes, title, body)
                        .map_err(|cause| JsValue::from_str(&cause))?;
                    if matches(&attributes, &filters).map_err(|cause| JsValue::from_str(&cause))? {
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
            let projection = Overview {
                dictionary: terms
                    .iter()
                    .filter_map(|term| {
                        self.header
                            .terms
                            .get(term)
                            .map(|meta| (term.clone(), TermSummary::from(meta)))
                    })
                    .collect(),
                minimum,
                eligibility: groups.finish().map_err(|cause| JsValue::from_str(&cause))?,
                partitions: None,
            };
            serde_json::to_string(&projection)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects common-term metadata or serialization failures."]
        pub fn common_terms(&self) -> Result<String, JsValue> {
            common_terms(&self.header).map_err(|cause| JsValue::from_str(&cause))
        }

        #[doc = "# Errors\nRejects common-leader serialization errors."]
        pub fn common_leaders(&self) -> Result<String, JsValue> {
            common_leaders(&self.header).map_err(|cause| JsValue::from_str(&cause))
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
            let groups = self
                .overview_groups
                .borrow_mut()
                .take()
                .unwrap_or_else(|| overview_eligibility(&self.header));
            let bytes = encode_overview(&self.header, None, &groups)
                .map_err(|cause| JsValue::from_str(&cause))?;
            *self.overview_groups.borrow_mut() = Some(groups);
            Ok(bytes)
        }

        #[doc = "# Errors\nRejects invalid ids or tombstones, row overflow, or result serialization errors."]
        pub fn lookup(&self, ids: &str, dead: &str) -> Result<String, JsValue> {
            let header = &self.header;
            let ids: Vec<String> =
                serde_json::from_str(ids).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let dead: BTreeSet<u32> =
                serde_json::from_str(dead).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let mut found = Vec::new();
            for id in &ids {
                if let Ok(index) = header
                    .documents
                    .binary_search_by(|doc| doc.id.encode_utf16().cmp(id.encode_utf16()))
                {
                    let row = u32::try_from(index)
                        .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
                    if !dead.contains(&row) {
                        found.push(Located {
                            row,
                            document: &header.documents[index],
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
                .map(|row| header.documents.get(*row as usize).ok_or("Invalid row"))
                .collect::<Result<Vec<_>, _>>()
                .map_err(JsValue::from_str)?;
            serde_json::to_string(&selected).map_err(|e| JsValue::from_str(&e.to_string()))
        }

        #[doc = "# Errors\nRejects invalid tombstone JSON, filter attributes, or deleted rows."]
        pub fn ranker_prepared(
            &self,
            query: &PreparedQuery,
            dead: &str,
        ) -> Result<Ranker, JsValue> {
            let dead: Vec<u32> = serde_json::from_str(dead)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let search = query
                .query
                .ranker(self.header.clone(), &dead)
                .map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Ranker { search })
        }

        #[doc = "# Errors\nRejects invalid query JSON, filters, term budgets, top-k, or match mode."]
        pub fn ranker(&self, query: &str) -> Result<Ranker, JsValue> {
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
        document: &'a DocumentMeta,
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
    #[doc = "# Errors\nRejects corrupt pages or invalid document serialization."]
    pub fn segment_document(bytes: &[u8]) -> Result<String, JsValue> {
        let decoded = decode_page(bytes).map_err(|cause| JsValue::from_str(&cause))?;
        let document: Document =
            serde_json::from_slice(&decoded).map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_json::to_string(&document).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid document JSON or term serialization errors."]
    pub fn segment_document_terms(json: &str) -> Result<String, JsValue> {
        let document: Document =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_json::to_string(&document_terms(&document))
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
        let values: Vec<String> =
            serde_json::from_str(values).map_err(|e| JsValue::from_str(&e.to_string()))?;
        bloom_build(&values).map_err(|cause| JsValue::from_str(&cause))
    }

    #[wasm_bindgen]
    #[doc = "# Errors\nRejects invalid values, bloom budgets, or result serialization errors."]
    pub fn segment_bloom_filter_many(
        bytes: &[u8],
        offsets: &[u32],
        values: &str,
    ) -> Result<String, JsValue> {
        let values: Vec<String> =
            serde_json::from_str(values).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let selected = bloom_filter_many(bytes, offsets, &values)
            .map_err(|cause| JsValue::from_str(&cause))?;
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
            bloom_filter_many(&bytes, &offsets, &[]).map_err(|cause| JsValue::from_str(&cause))?;
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
            let values: Vec<String> = serde_json::from_str(values)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            let selected = bloom_filter_many(&self.bytes, &self.offsets, &values)
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
        #[doc = "# Errors\nRejects invalid common-leader metadata or tombstones."]
        pub fn common_hits(
            &self,
            catalog: &str,
            leaders: &str,
            count: u32,
            dead: &str,
        ) -> Result<Option<String>, JsValue> {
            if !self.query.filters.is_empty() || self.query.mode == "phrase" {
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
                    || leader.documents.iter().any(|document| {
                        document.row >= count
                            || document.id.is_empty()
                            || document.id.encode_utf16().count() > 128
                    })
                    || leader.documents.windows(2).any(|pair| {
                        pair[0].row >= pair[1].row
                            || pair[0]
                                .id
                                .encode_utf16()
                                .cmp(pair[1].id.encode_utf16())
                                .is_ge()
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
        pub fn posting_spans(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.search.posting_spans())
                .map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
        #[doc = "# Errors\nRejects invalid derived cutoffs or posting span serialization errors."]
        pub fn posting_spans_seeded(&self) -> Result<String, JsValue> {
            let spans = self
                .search
                .posting_spans_seeded()
                .map_err(|cause| JsValue::from_str(&cause))?;
            serde_json::to_string(&spans).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }

        #[doc = "# Errors\nRejects invalid cutoffs or posting span serialization errors."]
        pub fn posting_spans_after(&self, score: f64, id: &str) -> Result<String, JsValue> {
            let spans = self
                .search
                .posting_spans_after(score, id)
                .map_err(|cause| JsValue::from_str(&cause))?;
            serde_json::to_string(&spans).map_err(|cause| JsValue::from_str(&cause.to_string()))
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
        #[doc = "# Errors\nRejects posting frequency overflow or result serialization errors."]
        pub fn finish(&self) -> Result<String, JsValue> {
            let hits = self
                .search
                .finish()
                .map_err(|cause| JsValue::from_str(&cause))?;
            let ranked: Vec<_> = hits
                .iter()
                .map(|hit| {
                    let document = &self.search.header.documents[hit.row as usize];
                    Ranked {
                        row: hit.row,
                        id: &document.id,
                        score: hit.score,
                        data: &document.data,
                    }
                })
                .collect();
            serde_json::to_string(&ranked).map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
    }

    #[derive(Serialize)]
    struct Ranked<'a> {
        row: u32,
        id: &'a str,
        score: f64,
        data: &'a Range,
    }
}

#[cfg(test)]
mod filter_cache_tests {
    use super::{Document, FILTER_CACHE_BYTES, Filter, SelectedAttributes, build};
    use serde::de::DeserializeSeed;
    use serde_json::json;
    use std::collections::BTreeSet;

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
            .map(|(index, _)| Document {
                id: format!("{index}"),
                revision: 1,
                title: String::new(),
                text: "target".into(),
                attributes: std::collections::BTreeMap::new(),
                vector: None,
            })
            .collect();
        let mut header = build(documents)?.header;
        for (document, input) in header.documents.iter_mut().zip(inputs) {
            document.attributes = serde_json::value::RawValue::from_string(input.into())?;
        }
        for op in ["eq", "ne", "exists", "in", "gt", "gte", "lt", "lte"] {
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
                    assert_eq!(header.allowed(&filters, &[]), expected);
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
                serde_json::from_value::<Document>(json!({
                    "id": format!("{index}"), "text": "target", "attributes": {}
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut header = build(documents)?.header;
        for (document, input) in header.documents.iter_mut().zip(inputs) {
            document.attributes = serde_json::value::RawValue::from_string(input.into())?;
        }
        for op in ["eq", "ne", "exists", "in", "gt", "gte", "lt", "lte"] {
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
                assert_eq!(header.allowed(&filters, &[]), expected);
                if let Ok(mask) = expected {
                    let mut deleted = mask.clone();
                    deleted[0] = false;
                    deleted[3] = false;
                    deleted[7] = false;
                    assert_eq!(header.allowed(&filters, &[0, 3, 7])?, deleted);
                    assert_eq!(header.allowed(&filters, &[])?, mask);
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
                serde_json::from_value::<Document>(json!({
                    "id": format!("{index:05}"), "text": "target",
                    "attributes": {"group": index % 2100}
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let header = build(documents)?.header;
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
            assert_eq!(header.allowed(&filters, &[])?, expected);
            assert!(!header.allowed(&filters, &[17, 2117])?[17]);
            assert!(!header.allowed(&filters, &[17, 2117])?[2117]);
            assert_eq!(header.allowed(&filters, &[])?, expected);
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
            assert_eq!(header.allowed(&[filter], &[])?, vec![true; 5000]);
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
        assert_eq!(header.allowed(&[filter], &[])?, expected);
        Ok(())
    }

    #[test]
    fn reused_filter_values_still_validate_unselected_attributes()
    -> Result<(), Box<dyn std::error::Error>> {
        for input in [
            r#"{"ignored":1e999,"group":1}"#,
            r#"{"ignored":{"nested":1e999},"group":1}"#,
        ] {
            let document: Document = serde_json::from_value(json!({
                "id":"a", "text":"target", "attributes":{}
            }))?;
            let mut header = build(vec![document])?.header;
            header.documents[0].attributes =
                serde_json::value::RawValue::from_string(input.into())?;
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
    fn masks_are_bounded_and_tombstones_remain_query_local()
    -> Result<(), Box<dyn std::error::Error>> {
        let document: Document = serde_json::from_value(json!({
            "id": "a", "text": "target", "attributes": {"group": 0}
        }))?;
        let header = build(vec![document])?.header;
        for index in 0..128 {
            let filter = Filter {
                field: "group".into(),
                op: "eq".into(),
                value: json!(format!("{}{}", "x".repeat(2500), index)),
            };
            assert_eq!(header.allowed(&[filter], &[])?, vec![false]);
            let cache = header.filter_masks.borrow();
            assert!(cache.bytes <= FILTER_CACHE_BYTES);
            assert!(cache.entries.len() <= 16);
        }
        let filters = vec![Filter {
            field: "group".into(),
            op: "eq".into(),
            value: json!(0),
        }];
        assert_eq!(header.allowed(&filters, &[])?, vec![true]);
        assert_eq!(header.allowed(&filters, &[0])?, vec![false]);
        assert_eq!(header.allowed(&filters, &[])?, vec![true]);
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
                .map(|index| Document {
                    id: format!("{index:05}"),
                    revision: 0,
                    title: "beta alpha".into(),
                    text: "alpha beta alpha ".repeat(repetitions),
                    attributes: BTreeMap::from([("group".into(), json!(index % 4))]),
                    vector: None,
                })
                .collect();
            let built = build(docs)?;
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
                    for (term, metadata) in &header.terms {
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
        let built = build(serde_json::from_value(json!([
            {"id":"a","text":"alpha beta alpha","attributes":{}}
        ]))?)?;
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
        let built = build(serde_json::from_value(json!([
            {"id":"a","text":"alpha","attributes":{}},
            {"id":"b","text":"alpha","attributes":{}},
            {"id":"c","text":"alpha","attributes":{}}
        ]))?)?;
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
            assert!(search.finish()?.is_empty());
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
            .map(|index| Document {
                id: format!("{index:05}"),
                revision: 0,
                title: String::new(),
                text: "alpha beta alpha".into(),
                attributes: BTreeMap::from([("group".into(), json!(index % 8))]),
                vector: None,
            })
            .collect();
        let built = build(docs)?;
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
                for (term, metadata) in &header.terms {
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
mod candidate_tests {
    use super::{Document, Search, Statistics, build};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::rc::Rc;

    #[test]
    fn reusable_candidates_preserve_phrase_order_and_exclusions()
    -> Result<(), Box<dyn std::error::Error>> {
        let documents: Vec<Document> = serde_json::from_value(json!([
            {"id":"a","text":"beta alpha beta","attributes":{}},
            {"id":"b","text":"alpha beta alpha","attributes":{}},
            {"id":"c","text":"alpha beta","attributes":{}},
            {"id":"d","text":"beta beta alpha","attributes":{}}
        ]))?;
        let built = build(documents)?;
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
            for (term, meta) in &header.terms {
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
                    .map(|row| Document {
                        id: format!("{row:05}"),
                        revision: 0,
                        title: "alpha ".repeat(row / stride % 7),
                        text: format!("alpha beta {}", "padding ".repeat(row / stride % 257)),
                        attributes: BTreeMap::from([("group".into(), json!(row % 3))]),
                        vector: None,
                    })
                    .collect(),
            )?;
            let header = std::rc::Rc::new(built.header);
            let statistics = Statistics {
                documents: u64::try_from(header.documents.len())?,
                title_length: header.total_title_length,
                body_length: header.total_body_length,
                frequencies: header
                    .terms
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

    #[test]
    fn eligible_bounds_cover_actual_scores_without_loosening_physical_bounds()
    -> Result<(), Box<dyn std::error::Error>> {
        let docs = (0..384)
            .map(|row| Document {
                id: format!("{row:05}"),
                revision: 0,
                title: "alpha ".repeat(row % 2 * (row % 4 + 1)),
                text: format!(
                    "{} {}",
                    match row % 3 {
                        0 => "alpha beta",
                        1 => "alpha gamma",
                        _ => "beta gamma",
                    },
                    "padding ".repeat(row % 2 * (row % 17 + 20))
                ),
                attributes: BTreeMap::from([("group".into(), json!(row % 2))]),
                vector: None,
            })
            .collect();
        let built = build(docs)?;
        let (header, base) = parse_header(&built.bytes)?;
        let statistics = Statistics {
            documents: u64::try_from(header.documents.len())?,
            title_length: header.total_title_length,
            body_length: header.total_body_length,
            frequencies: header
                .terms
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
                for (term, metadata) in &header.terms {
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
                            block.max_title_tf,
                            block.max_body_tf,
                            block.min_title_length,
                            block.min_body_length,
                        );
                        assert!(*bound <= physical + 1e-12);
                        if !search.allowed[block.first as usize..=block.last as usize]
                            .iter()
                            .any(|allowed| *allowed)
                        {
                            assert_eq!(bound.to_bits(), 0.0_f64.to_bits());
                        }
                        for posting in lists[*term].iter().filter(|posting| {
                            block.first <= posting.row && posting.row <= block.last
                        }) {
                            let document = &header.documents[posting.row as usize];
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
    use super::{BuiltSegment, Document, Filter, Hit, Search, Statistics, build};
    use std::{cmp::Ordering, collections::BTreeMap};

    fn fixture() -> Result<BuiltSegment, String> {
        let documents = (0..384)
            .map(|row| {
                let id = match row {
                    0 => String::from("\u{e000}"),
                    1 => String::from("\u{10000}"),
                    _ => format!("row-{row:03}"),
                };
                Document {
                    id,
                    revision: 0,
                    title: "alpha ".repeat(row % 4),
                    text: format!(
                        "{} {}",
                        match row % 3 {
                            0 => "alpha beta",
                            1 => "beta alpha",
                            _ => "alpha padding beta",
                        },
                        "padding ".repeat(row % 17)
                    ),
                    attributes: BTreeMap::from([("group".into(), serde_json::json!(row % 2))]),
                    vector: None,
                }
            })
            .collect();
        build(documents)
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
        let best_id = &header.documents[best.row as usize].id;
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
        let mut minimum_id = header
            .documents
            .first()
            .ok_or("Missing source minimum")?
            .id
            .clone();
        if minimum_id.encode_utf16().cmp(id.encode_utf16()) == Ordering::Less {
            minimum_id = id.to_owned();
        }
        for hit in search.finish()? {
            let hit_id = &header.documents[hit.row as usize].id;
            match hit.score.total_cmp(&upper) {
                Ordering::Greater => {
                    upper = hit.score;
                    minimum_id.clone_from(hit_id);
                }
                Ordering::Equal => {
                    if hit_id.encode_utf16().cmp(minimum_id.encode_utf16()) == Ordering::Less {
                        minimum_id.clone_from(hit_id);
                    }
                }
                Ordering::Less => {}
            }
        }
        assert!(
            best.score < upper
                || (best.score.total_cmp(&upper) == Ordering::Equal
                    && best_id.encode_utf16().cmp(minimum_id.encode_utf16()) != Ordering::Less)
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
            title_length: header.total_title_length,
            body_length: header.total_body_length,
            frequencies: header
                .terms
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
                    for (word, metadata) in &header.terms {
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
                    let best_id = &header.documents[best.row as usize].id;
                    for score in [best.score - 1e-13, best.score, best.score + 1e-13] {
                        for id in ["", "row-150", "\u{10000}", "\u{e000}", best_id.as_str()] {
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
            .map(|row| Document {
                id: format!("{row:05}"),
                revision: 1,
                title: String::new(),
                text: format!(
                    "{} {}",
                    "alpha beta gamma ".repeat(8 + row % 8),
                    if row % 97 == 0 { "needle" } else { "filler" }
                ),
                attributes: BTreeMap::new(),
                vector: None,
            })
            .collect();
        let built = build(docs)?;
        let (header, base) = parse_header(&built.bytes)?;
        let statistics = Statistics {
            documents: u64::try_from(header.documents.len())?,
            title_length: header.total_title_length,
            body_length: header.total_body_length,
            frequencies: header
                .terms
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
            let metadata = header.terms.get(term).ok_or("Missing term")?;
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
            .map(|row| Document {
                id: format!("{row:05}"),
                revision: 1,
                title: if row % 97 == 0 {
                    "needle alpha".into()
                } else {
                    "gamma ".repeat(row % 3)
                },
                text: format!(
                    "{} {} {} {} {}",
                    "alpha ".repeat(row % 5),
                    "beta ".repeat(row % 7),
                    "gamma ".repeat(row % 11),
                    if row % 53 == 0 { "scarce" } else { "filler" },
                    "padding ".repeat(row % 17)
                ),
                attributes: BTreeMap::from([("group".into(), serde_json::json!(row % 2))]),
                vector: None,
            })
            .collect();
        let built = build(docs)?;
        let (header, base) = parse_header(&built.bytes)?;
        let calls = Rc::new(Cell::new(0));
        let mut lists = BTreeMap::new();
        for term in ["alpha", "beta", "gamma", "needle", "scarce"] {
            let mut postings = Vec::new();
            for block in &header.terms.get(term).ok_or("Missing term")?.blocks {
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
                title_length: header.total_title_length * factor + 1000,
                body_length: header.total_body_length * factor + 1234,
                frequencies: header
                    .terms
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
