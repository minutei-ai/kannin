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

#[derive(Clone, Default)]
struct FilterMasks {
    entries: VecDeque<(String, Vec<bool>, usize)>,
    bytes: usize,
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

#[derive(Clone, Serialize, Deserialize)]
pub struct Header {
    #[serde(skip)]
    filter_masks: RefCell<FilterMasks>,
    pub version: u32,
    pub documents: Vec<DocumentMeta>,
    pub terms: BTreeMap<String, TermMeta>,
    pub total_title_length: u64,
    pub total_body_length: u64,
}

#[derive(Clone, Debug)]
pub struct Posting {
    pub row: u32,
    pub title: Vec<u32>,
    pub body: Vec<u32>,
}

impl Header {
    fn encode(&self, payload: &[u8]) -> Result<Vec<u8>, String> {
        let json = serde_json::to_vec(self).map_err(|e| e.to_string())?;
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
            for (index, doc) in self.documents.iter().enumerate() {
                let attributes: BTreeMap<String, serde_json::Value> =
                    serde_json::from_str(doc.attributes.get())
                        .map_err(|cause| cause.to_string())?;
                allowed[index] = matches(&attributes, filters)?;
            }
            let bytes = key.capacity() + allowed.capacity() + 128;
            if bytes <= FILTER_CACHE_BYTES {
                let mut cache = self.filter_masks.borrow_mut();
                while cache.bytes + bytes > FILTER_CACHE_BYTES || cache.entries.len() >= 16 {
                    let Some((_, _, removed)) = cache.entries.pop_front() else {
                        break;
                    };
                    cache.bytes -= removed;
                }
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

#[doc = "# Errors\nRejects invalid pages, overflowing or truncated varints, excessive rows, duplicate positions, and trailing bytes."]
pub fn decode_postings(bytes: &[u8]) -> Result<Vec<Posting>, String> {
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
        let mut fields = Vec::new();
        for _ in 0..2 {
            let length = get_int(&data, &mut offset)? as usize;
            if length > data.len() - offset {
                return Err("Invalid position count".into());
            }
            let mut positions = Vec::with_capacity(length);
            let mut position = 0u32;
            for index in 0..length {
                let delta = get_int(&data, &mut offset)?;
                if index > 0 && delta == 0 {
                    return Err("Duplicate token position".into());
                }
                position = position.checked_add(delta).ok_or("Position overflow")?;
                positions.push(position);
            }
            fields.push(positions);
        }
        let body = fields.pop().ok_or("Missing positional field")?;
        let title = fields.pop().ok_or("Missing positional field")?;
        if body.is_empty() && title.is_empty() {
            return Err("Empty posting".into());
        }
        rows.push(Posting { row, title, body });
    }
    if offset != data.len() {
        return Err("Trailing posting bytes".into());
    }
    Ok(rows)
}

fn encode_terms(
    payload: &mut Vec<u8>,
    metadata: &[DocumentMeta],
    lists: BTreeMap<String, Vec<Posting>>,
) -> Result<BTreeMap<String, TermMeta>, String> {
    let mut terms = BTreeMap::new();
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
        terms.insert(
            term,
            TermMeta {
                df: u32::try_from(postings.len()).map_err(|cause| cause.to_string())?,
                blocks: blocks.into_boxed_slice(),
            },
        );
    }
    Ok(terms)
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
    let mut metadata = Vec::new();
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
    let header: Header = serde_json::from_slice(json).map_err(|e| e.to_string())?;
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
    Ok((header, 16 + length))
}

#[derive(Deserialize)]
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
    if statistics.documents == 0 || df == 0 || df > statistics.documents {
        return 0.0;
    }
    let n = count_as_f64(statistics.documents);
    let tf = contribution(
        tf_title,
        len_title,
        count_as_f64(statistics.title_length) / n,
    )
    .mul_add(
        2.0,
        contribution(tf_body, len_body, count_as_f64(statistics.body_length) / n),
    );
    let idf = ((n - count_as_f64(df) + 0.5) / (count_as_f64(df) + 0.5)).ln_1p();
    idf * tf * 2.2 / (tf + 1.2)
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
        let actual = attributes.get(&filter.field);
        let equal = actual == Some(&filter.value);
        let matched = match filter.op.as_str() {
            "eq" => equal,
            "ne" => !equal,
            "exists" => {
                actual.is_some() == filter.value.as_bool().ok_or("Invalid exists filter")?
            }
            "in" => actual.is_some_and(|value| {
                filter
                    .value
                    .as_array()
                    .is_some_and(|items| items.contains(value))
            }),
            "gt" | "gte" | "lt" | "lte" => {
                actual.is_some_and(|value| compare_number(value, &filter.value, &filter.op))
            }
            _ => return Err("Unknown filter operation".into()),
        };
        if !matched {
            return Ok(false);
        }
    }
    Ok(true)
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

pub struct Search {
    pub header: Rc<Header>,
    pub statistics: Statistics,
    pub words: Vec<String>,
    pub mode: String,
    pub top_k: usize,
    pub allowed: Vec<bool>,
    pub lists: BTreeMap<String, Vec<Posting>>,
}

impl Search {
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
        let words: Vec<String> = normalize_text(text)
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        if top_k == 0 || top_k > 100 || words.iter().collect::<BTreeSet<_>>().len() > 64 {
            return Err("Invalid search budget".into());
        }
        if mode != "any" && mode != "all" && mode != "phrase" {
            return Err("Unknown match mode".into());
        }
        if mode == "phrase" && words.len() > 64 {
            return Err("Phrase exceeds budget".into());
        }
        let allowed = header.allowed(filters, dead)?;
        Ok(Self {
            header,
            statistics,
            words,
            mode: mode.into(),
            top_k,
            allowed,
            lists: BTreeMap::new(),
        })
    }

    #[doc = "# Errors\nRejects unrequested terms, corrupt pages, invalid rows or positions, and unordered posting blocks."]
    pub fn add(&mut self, term: &str, bytes: &[u8]) -> Result<(), String> {
        if !self.words.iter().any(|word| word == term) {
            return Err("Unrequested posting term".into());
        }
        let postings = decode_postings(bytes)?;
        let list = self.lists.entry(term.into()).or_default();
        for posting in postings {
            let doc = self
                .header
                .documents
                .get(posting.row as usize)
                .ok_or("Invalid posting row")?;
            if posting.title.last().is_some_and(|p| *p >= doc.title_length)
                || posting.body.last().is_some_and(|p| *p >= doc.body_length)
            {
                return Err("Invalid token position".into());
            }
            if list
                .last()
                .is_some_and(|previous| previous.row >= posting.row)
            {
                return Err("Posting blocks out of order".into());
            }
            list.push(posting);
        }
        Ok(())
    }

    fn phrase(postings: &[Option<&Posting>]) -> bool {
        let Some(first) = postings.first().copied().flatten() else {
            return false;
        };
        for title in [true, false] {
            let starts = if title { &first.title } else { &first.body };
            for start in starts {
                if postings.iter().enumerate().all(|(offset, p)| {
                    p.is_some_and(|p| {
                        let positions = if title { &p.title } else { &p.body };
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

    fn skippable_block_end(
        &self,
        terms: &[&String],
        lists: &[&[Posting]],
        cursors: &[usize],
        cutoff: &Hit,
        row: u32,
    ) -> Option<u32> {
        let mut end = u32::MAX;
        let mut bound = 0.0;
        for (index, list) in lists.iter().enumerate() {
            if let Some(posting) = list.get(cursors[index])
                && let Some(block) = self
                    .header
                    .terms
                    .get(terms[index].as_str())
                    .and_then(|term| {
                        term.blocks
                            .iter()
                            .find(|block| block.first <= posting.row && block.last >= posting.row)
                    })
            {
                end = end.min(block.last);
                let df = self
                    .statistics
                    .frequencies
                    .get(terms[index].as_str())
                    .copied()
                    .unwrap_or(0);
                bound += bm25(
                    block.max_title_tf,
                    block.max_body_tf,
                    block.min_title_length,
                    block.min_body_length,
                    &self.statistics,
                    df,
                );
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
        let terms: Vec<_> = self
            .words
            .iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let lists: Vec<_> = terms
            .iter()
            .map(|term| {
                self.lists
                    .get(term.as_str())
                    .map_or(&[] as &[Posting], Vec::as_slice)
            })
            .collect();
        if self.mode != "any" && lists.iter().any(|list| list.is_empty()) {
            return Ok(Vec::new());
        }
        let mut cursors = vec![0usize; lists.len()];
        let mut heap: BinaryHeap<Hit> = BinaryHeap::new();
        while let Some(row) = lists
            .iter()
            .enumerate()
            .filter_map(|(i, list)| list.get(cursors[i]).map(|p| p.row))
            .min()
        {
            if heap.len() == self.top_k
                && let Some(cutoff) = heap.peek()
                && let Some(end) = self.skippable_block_end(&terms, &lists, &cursors, cutoff, row)
            {
                for (index, list) in lists.iter().enumerate() {
                    cursors[index] +=
                        list[cursors[index]..].partition_point(|posting| posting.row <= end);
                }
                continue;
            }
            let mut selected = BTreeMap::new();
            let mut score = 0.0;
            for (index, list) in lists.iter().enumerate() {
                if let Some(posting) = list.get(cursors[index]).filter(|p| p.row == row) {
                    let meta = &self.header.documents[row as usize];
                    let df = self
                        .statistics
                        .frequencies
                        .get(terms[index].as_str())
                        .copied()
                        .unwrap_or(0);
                    score += bm25(
                        u32::try_from(posting.title.len()).map_err(|cause| cause.to_string())?,
                        u32::try_from(posting.body.len()).map_err(|cause| cause.to_string())?,
                        meta.title_length,
                        meta.body_length,
                        &self.statistics,
                        df,
                    );
                    selected.insert(terms[index].as_str(), posting);
                    cursors[index] += 1;
                }
            }
            if !self.allowed[row as usize] || (self.mode != "any" && selected.len() != terms.len())
            {
                continue;
            }
            if self.mode == "phrase"
                && !Self::phrase(
                    &self
                        .words
                        .iter()
                        .map(|word| selected.get(word.as_str()).copied())
                        .collect::<Vec<_>>(),
                )
            {
                continue;
            }
            if score <= 0.0 {
                continue;
            }
            heap.push(Hit { row, score });
            if heap.len() > self.top_k {
                heap.pop();
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

fn bloom_hash(text: &str, seed: u64) -> u64 {
    text.as_bytes().iter().fold(seed, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[doc = "# Errors\nRejects values beyond the bloom size budget or an unrepresentable bit index."]
pub fn bloom_build(values: &[String]) -> Result<Vec<u8>, String> {
    if values.len() > MAX_BYTES / 2 {
        return Err("Bloom exceeds size budget".into());
    }
    let mut bytes = vec![0u8; (values.len() * 2).max(8)];
    for value in values {
        let a = bloom_hash(value, 0xcbf2_9ce4_8422_2325);
        let b = bloom_hash(value, 0x8422_2325_cbf2_9ce4) | 1;
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
    bloom_contains_hashes(
        bytes,
        bloom_hash(value, 0xcbf2_9ce4_8422_2325),
        bloom_hash(value, 0x8422_2325_cbf2_9ce4) | 1,
    )
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
            (
                value.as_str(),
                bloom_hash(value, 0xcbf2_9ce4_8422_2325),
                bloom_hash(value, 0x8422_2325_cbf2_9ce4) | 1,
            )
        })
        .collect();
    offsets
        .windows(2)
        .map(|span| {
            let start = usize::try_from(span[0]).map_err(|cause| cause.to_string())?;
            let end = usize::try_from(span[1]).map_err(|cause| cause.to_string())?;
            let bloom = bytes
                .get(start..end)
                .ok_or_else(|| "Invalid bloom offsets".to_owned())?;
            let mut selected = Vec::new();
            for &(value, a, b) in &hashes {
                if bloom_contains_hashes(bloom, a, b)? {
                    selected.push(value);
                }
            }
            Ok(selected)
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use super::{
        BlockMeta, BuiltSegment, Document, DocumentMeta, FILTER_CACHE_BYTES, Filter, Header,
        MAX_BYTES, Search, Statistics, TermMeta, append, bloom_build, bloom_filter_many, bm25,
        build, decode_page, document_terms, matches, parse_header,
    };
    use serde::{Deserialize, Serialize};
    use std::collections::{BTreeMap, BTreeSet};
    use std::rc::Rc;
    use wasm_bindgen::prelude::*;

    #[derive(Serialize, Deserialize)]
    struct TermSummary {
        df: u32,
        bounds: Vec<(u32, u32, u32, u32)>,
    }

    impl From<&TermMeta> for TermSummary {
        fn from(meta: &TermMeta) -> Self {
            Self {
                df: meta.df,
                bounds: meta
                    .blocks
                    .iter()
                    .map(|block| {
                        (
                            block.max_title_tf,
                            block.max_body_tf,
                            block.min_title_length,
                            block.min_body_length,
                        )
                    })
                    .collect(),
            }
        }
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Overview {
        dictionary: BTreeMap<String, TermSummary>,
        minimum: Option<(u32, u32)>,
    }

    struct OverviewBounds<'a>(&'a [BlockMeta]);

    impl Serialize for OverviewBounds<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_seq(self.0.iter().map(|block| {
                (
                    block.max_title_tf,
                    block.max_body_tf,
                    block.min_title_length,
                    block.min_body_length,
                )
            }))
        }
    }

    #[derive(Serialize)]
    struct OverviewSummary<'a> {
        df: u32,
        bounds: OverviewBounds<'a>,
    }

    struct OverviewDictionary<'a>(&'a BTreeMap<String, TermMeta>);

    impl Serialize for OverviewDictionary<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_map(self.0.iter().map(|(term, meta)| {
                (
                    term,
                    OverviewSummary {
                        df: meta.df,
                        bounds: OverviewBounds(&meta.blocks),
                    },
                )
            }))
        }
    }

    #[derive(Serialize)]
    struct DirectoryOverview<'a> {
        dictionary: OverviewDictionary<'a>,
        eligibility: OverviewEligibility<'a>,
    }

    struct OverviewEligibility<'a>(BTreeMap<&'a str, (&'a serde_json::value::RawValue, u32, u32)>);

    impl Serialize for OverviewEligibility<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_seq(self.0.values())
        }
    }

    struct SelectedTerms<'a> {
        requested: &'a BTreeSet<String>,
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

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedTerms<'_> {
        type Value = BTreeMap<String, TermSummary>;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_map(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedTerms<'_> {
        type Value = BTreeMap<String, TermSummary>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a term summary dictionary")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut selected = BTreeMap::new();
            while let Some(term) = map.next_key::<String>()? {
                if self.requested.contains(&term) {
                    let summary = map.next_value::<TermSummary>()?;
                    selected.insert(term, summary);
                } else {
                    map.next_value::<DiscardedSummary>()?;
                }
            }
            Ok(selected)
        }
    }

    #[derive(Deserialize)]
    #[serde(field_identifier, rename_all = "lowercase")]
    enum OverviewField {
        Dictionary,
        Eligibility,
    }

    struct EligibleGroups<'a>(&'a [Filter]);

    impl<'de> serde::de::DeserializeSeed<'de> for EligibleGroups<'_> {
        type Value = Option<(u32, u32)>;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_seq(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for EligibleGroups<'_> {
        type Value = Option<(u32, u32)>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("attribute groups with minimum document lengths")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut minimum = None;
            let mut present = false;
            while let Some((attributes, title, body)) =
                sequence.next_element::<(BTreeMap<String, serde_json::Value>, u32, u32)>()?
            {
                present = true;
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
                return Ok(Some((0, 0)));
            }
            Ok(minimum)
        }
    }

    struct SelectedOverview<'a> {
        requested: &'a BTreeSet<String>,
        filters: &'a [Filter],
    }

    impl<'de> serde::de::DeserializeSeed<'de> for SelectedOverview<'_> {
        type Value = Overview;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_map(self)
        }
    }

    impl<'de> serde::de::Visitor<'de> for SelectedOverview<'_> {
        type Value = Overview;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a segment overview")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut dictionary = None;
            let mut minimum = None;
            while let Some(field) = map.next_key::<OverviewField>()? {
                match field {
                    OverviewField::Dictionary => {
                        if dictionary.is_some() {
                            return Err(serde::de::Error::duplicate_field("dictionary"));
                        }
                        dictionary = Some(map.next_value_seed(SelectedTerms {
                            requested: self.requested,
                        })?);
                    }
                    OverviewField::Eligibility => {
                        if minimum.is_some() {
                            return Err(serde::de::Error::duplicate_field("eligibility"));
                        }
                        minimum = Some(map.next_value_seed(EligibleGroups(self.filters))?);
                    }
                }
            }
            Ok(Overview {
                dictionary: dictionary
                    .ok_or_else(|| serde::de::Error::missing_field("dictionary"))?,
                minimum: minimum.ok_or_else(|| serde::de::Error::missing_field("eligibility"))?,
            })
        }
    }

    fn term_bound(
        meta: &TermSummary,
        statistics: &Statistics,
        df: u64,
        minimum: (u32, u32),
    ) -> f64 {
        meta.bounds
            .iter()
            .map(|&(title_tf, body_tf, title_length, body_length)| {
                bm25(
                    title_tf,
                    body_tf,
                    title_length.max(minimum.0),
                    body_length.max(minimum.1),
                    statistics,
                    df,
                )
            })
            .fold(0.0, f64::max)
    }

    #[derive(Deserialize)]
    struct TermCatalog {
        dictionary: BTreeMap<String, TermSummary>,
        minimum: Option<(u32, u32)>,
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
        Ok(catalogs
            .iter()
            .map(|catalog| {
                let Some(minimum) = catalog.minimum else {
                    return 0.0;
                };
                catalog
                    .dictionary
                    .iter()
                    .map(|(term, meta)| {
                        term_bound(
                            meta,
                            &statistics,
                            statistics.frequencies.get(term).copied().unwrap_or(0),
                            minimum,
                        )
                    })
                    .sum()
            })
            .collect())
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
        #[doc = "# Errors\nRejects directory serialization errors."]
        pub fn header_json(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.built.header)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))
        }
    }

    #[wasm_bindgen]
    pub struct Directory {
        header: Rc<Header>,
    }

    #[wasm_bindgen]
    impl Directory {
        #[wasm_bindgen(constructor)]
        #[doc = "# Errors\nRejects invalid input serialization or segment framing, size, and integrity constraints."]
        pub fn new(bytes: &[u8]) -> Result<Self, JsValue> {
            let (header, _) = parse_header(bytes).map_err(|cause| JsValue::from_str(&cause))?;
            Ok(Self {
                header: Rc::new(header),
            })
        }

        #[must_use]
        pub fn retain(&self) -> Self {
            Self {
                header: self.header.clone(),
            }
        }

        #[must_use]
        pub fn heap_bytes(&self) -> usize {
            let header = &self.header;
            let documents = header.documents.capacity() * size_of::<DocumentMeta>()
                + header
                    .documents
                    .iter()
                    .map(|doc| doc.id.capacity() + doc.attributes.get().len() + 32)
                    .sum::<usize>();
            let terms = (header.terms.len() / 4 + 1)
                * (11 * (size_of::<String>() + size_of::<TermMeta>())
                    + 12 * size_of::<usize>()
                    + 32)
                + header
                    .terms
                    .iter()
                    .map(|(term, meta)| {
                        term.capacity() + 16 + meta.blocks.len() * size_of::<BlockMeta>()
                    })
                    .sum::<usize>();
            documents + terms + size_of::<Header>() + 32 + FILTER_CACHE_BYTES
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
            let mut eligibility = BTreeMap::new();
            for document in &self.header.documents {
                let lengths = eligibility
                    .entry(document.attributes.get())
                    .or_insert_with(|| {
                        (
                            document.attributes.as_ref(),
                            document.title_length,
                            document.body_length,
                        )
                    });
                lengths.1 = lengths.1.min(document.title_length);
                lengths.2 = lengths.2.min(document.body_length);
            }
            let overview = DirectoryOverview {
                dictionary: OverviewDictionary(&self.header.terms),
                eligibility: OverviewEligibility(eligibility),
            };
            let json = serde_json::to_vec(&overview)
                .map_err(|cause| JsValue::from_str(&cause.to_string()))?;
            if json.len() > MAX_BYTES {
                return Err(JsValue::from_str("Overview exceeds decoded size budget"));
            }
            let mut bytes = Vec::new();
            append(&mut bytes, &json).map_err(|cause| JsValue::from_str(&cause))?;
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
        if terms.len() > 64 {
            return Err(JsValue::from_str("Overview projection exceeds 64 terms"));
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
    impl Ranker {
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
                .map(|hit| Ranked {
                    row: hit.row,
                    id: &self.search.header.documents[hit.row as usize].id,
                    score: hit.score,
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
    }
}

#[cfg(test)]
mod filter_cache_tests {
    use super::{Document, FILTER_CACHE_BYTES, Filter, build};
    use serde_json::json;

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
    use super::{bloom_build, bloom_contains, count_as_f64};

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
