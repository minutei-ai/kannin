use crate::normalize_text;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};
use std::rc::Rc;

const MAGIC: &[u8; 8] = b"RAIOSEG1";
const MAX_BYTES: usize = 16 * 1024 * 1024;
const BLOCK_SIZE: usize = 128;

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

pub struct BuiltSegment {
    pub header: Header,
    pub bytes: Vec<u8>,
}

fn append(payload: &mut Vec<u8>, data: &[u8]) -> Result<Range, String> {
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(data, 3);
    let range = Range {
        offset: payload.len() as u32,
        length: (compressed.len() + 8) as u32,
    };
    payload.extend_from_slice(&(data.len() as u32).to_le_bytes());
    payload.extend_from_slice(&crc32fast::hash(data).to_le_bytes());
    payload.extend_from_slice(&compressed);
    if payload.len() > MAX_BYTES {
        return Err("Segment exceeds 16 MiB".into());
    }
    Ok(range)
}

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
        bytes.push((value as u8) | 128);
        value >>= 7;
    }
    bytes.push(value as u8);
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

fn encode_postings(postings: &[Posting]) -> Vec<u8> {
    let mut bytes = Vec::new();
    put_int(postings.len() as u32, &mut bytes);
    let mut previous = 0;
    for posting in postings {
        put_int(posting.row - previous, &mut bytes);
        previous = posting.row;
        for positions in [&posting.title, &posting.body] {
            put_int(positions.len() as u32, &mut bytes);
            let mut prior = 0;
            for position in positions {
                put_int(position - prior, &mut bytes);
                prior = *position;
            }
        }
    }
    bytes
}

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
    for (row, document) in documents.iter().enumerate() {
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
                    row: row as u32,
                    title: Vec::new(),
                    body: Vec::new(),
                });
                if field == 0 {
                    posting.title.push(position as u32);
                } else {
                    posting.body.push(position as u32);
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
            title_length: title_tokens.len() as u32,
            body_length: body_tokens.len() as u32,
            attributes: serde_json::value::RawValue::from_string(
                serde_json::to_string(&document.attributes).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?,
            data,
            vector: document.vector.is_some(),
        });
    }
    let mut terms = BTreeMap::new();
    for (term, postings) in lists {
        let mut blocks = Vec::with_capacity(postings.len().div_ceil(BLOCK_SIZE));
        for chunk in postings.chunks(BLOCK_SIZE) {
            let data = append(&mut payload, &encode_postings(chunk))?;
            blocks.push(BlockMeta {
                first: chunk[0].row,
                last: chunk[chunk.len() - 1].row,
                count: chunk.len() as u32,
                max_title_tf: chunk
                    .iter()
                    .map(|p| p.title.len() as u32)
                    .max()
                    .ok_or("Empty posting block")?,
                max_body_tf: chunk
                    .iter()
                    .map(|p| p.body.len() as u32)
                    .max()
                    .ok_or("Empty posting block")?,
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
                df: postings.len() as u32,
                blocks: blocks.into_boxed_slice(),
            },
        );
    }
    let header = Header {
        version: 1,
        documents: metadata,
        terms,
        total_title_length,
        total_body_length,
    };
    let json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    if json.len() + payload.len() + 16 > MAX_BYTES {
        return Err("Segment exceeds 16 MiB".into());
    }
    let mut bytes = Vec::with_capacity(json.len() + payload.len() + 16);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&crc32fast::hash(&json).to_le_bytes());
    bytes.extend_from_slice(&json);
    bytes.extend_from_slice(&payload);
    Ok(BuiltSegment { header, bytes })
}

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
        if term.df > header.documents.len() as u32 {
            return Err("Invalid term document frequency".into());
        }
        for block in &term.blocks {
            if block.last >= header.documents.len() as u32
                || block.first > block.last
                || block.count > BLOCK_SIZE as u32
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

fn contribution(tf: u32, length: u32, average: f64) -> f64 {
    if tf == 0 {
        return 0.0;
    }
    let mean = if average > 0.0 { average } else { 1.0 };
    f64::from(tf) / (0.25 + 0.75 * f64::from(length) / mean)
}

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
    let n = statistics.documents as f64;
    let tf = 2.0 * contribution(tf_title, len_title, statistics.title_length as f64 / n)
        + contribution(tf_body, len_body, statistics.body_length as f64 / n);
    let idf = ((n - df as f64 + 0.5) / (df as f64 + 0.5) + 1.0).ln();
    idf * tf * 2.2 / (tf + 1.2)
}

#[derive(Deserialize)]
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
        self.row == other.row && self.score == other.score
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
        let mut allowed = vec![true; header.documents.len()];
        if !filters.is_empty() {
            for (index, doc) in header.documents.iter().enumerate() {
                let attributes: BTreeMap<String, serde_json::Value> =
                    serde_json::from_str(doc.attributes.get()).map_err(|e| e.to_string())?;
                allowed[index] = matches(&attributes, filters)?;
            }
        }
        for row in dead {
            *allowed
                .get_mut(*row as usize)
                .ok_or("Invalid deleted row")? = false;
        }
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

    fn phrase(&self, postings: &[Option<&Posting>]) -> bool {
        let Some(first) = postings.first().copied().flatten() else {
            return false;
        };
        for title in [true, false] {
            let starts = if title { &first.title } else { &first.body };
            for start in starts {
                if postings.iter().enumerate().all(|(offset, p)| {
                    p.is_some_and(|p| {
                        let positions = if title { &p.title } else { &p.body };
                        positions.binary_search(&(start + offset as u32)).is_ok()
                    })
                }) {
                    return true;
                }
            }
        }
        false
    }

    pub fn finish(&self) -> Vec<Hit> {
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
                    .map(Vec::as_slice)
                    .unwrap_or(&[])
            })
            .collect();
        if self.mode != "any" && lists.iter().any(|list| list.is_empty()) {
            return Vec::new();
        }
        let mut cursors = vec![0usize; lists.len()];
        let mut heap: BinaryHeap<Hit> = BinaryHeap::new();
        while let Some(row) = lists
            .iter()
            .enumerate()
            .filter_map(|(i, list)| list.get(cursors[i]).map(|p| p.row))
            .min()
        {
            if heap.len() == self.top_k {
                let mut end = u32::MAX;
                let mut bound = 0.0;
                for (index, list) in lists.iter().enumerate() {
                    if let Some(posting) = list.get(cursors[index])
                        && let Some(block) =
                            self.header
                                .terms
                                .get(terms[index].as_str())
                                .and_then(|term| {
                                    term.blocks.iter().find(|block| {
                                        block.first <= posting.row && block.last >= posting.row
                                    })
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
                if let Some(cutoff) = heap.peek()
                    && (bound + 1e-12 < cutoff.score
                        || (bound == cutoff.score && row >= cutoff.row))
                {
                    for (index, list) in lists.iter().enumerate() {
                        cursors[index] +=
                            list[cursors[index]..].partition_point(|posting| posting.row <= end);
                    }
                    continue;
                }
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
                        posting.title.len() as u32,
                        posting.body.len() as u32,
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
                && !self.phrase(
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
        hits
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
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

pub fn bloom_build(values: &[String]) -> Vec<u8> {
    let mut bytes = vec![0u8; (values.len() * 2).max(8)];
    for value in values {
        let a = bloom_hash(value, 0xcbf29ce484222325);
        let b = bloom_hash(value, 0x84222325cbf29ce4) | 1;
        for index in 0u64..7 {
            let bit = (a.wrapping_add(index.wrapping_mul(b)) % (bytes.len() as u64 * 8)) as usize;
            bytes[bit / 8] |= 1 << (bit % 8);
        }
    }
    bytes
}

pub fn bloom_contains(bytes: &[u8], value: &str) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let a = bloom_hash(value, 0xcbf29ce484222325);
    let b = bloom_hash(value, 0x84222325cbf29ce4) | 1;
    (0u64..7).all(|index| {
        let bit = (a.wrapping_add(index.wrapping_mul(b)) % (bytes.len() as u64 * 8)) as usize;
        bytes[bit / 8] & (1 << (bit % 8)) != 0
    })
}

#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    fn error(error: String) -> JsValue {
        JsValue::from_str(&error)
    }

    #[wasm_bindgen]
    pub struct Segment {
        built: BuiltSegment,
    }

    #[wasm_bindgen]
    impl Segment {
        #[wasm_bindgen(constructor)]
        pub fn new(json: &str) -> Result<Segment, JsValue> {
            let documents: Vec<Document> =
                serde_json::from_str(json).map_err(|e| error(e.to_string()))?;
            Ok(Self {
                built: build(documents).map_err(error)?,
            })
        }
        pub fn bytes(&self) -> Vec<u8> {
            self.built.bytes.clone()
        }
        pub fn header_json(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.built.header).map_err(|cause| error(cause.to_string()))
        }
    }

    #[wasm_bindgen]
    pub struct Directory {
        header: Rc<Header>,
    }

    #[wasm_bindgen]
    impl Directory {
        #[wasm_bindgen(constructor)]
        pub fn new(bytes: &[u8]) -> Result<Directory, JsValue> {
            let (header, _) = parse_header(bytes).map_err(error)?;
            Ok(Self {
                header: Rc::new(header),
            })
        }

        pub fn retain(&self) -> Directory {
            Self {
                header: self.header.clone(),
            }
        }

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
            documents + terms + size_of::<Header>() + 32
        }

        pub fn terms(&self, terms: &str) -> Result<String, JsValue> {
            let terms: Vec<String> =
                serde_json::from_str(terms).map_err(|e| error(e.to_string()))?;
            let selected: BTreeMap<_, _> = terms
                .iter()
                .filter_map(|term| self.header.terms.get(term).map(|meta| (term, meta)))
                .collect();
            serde_json::to_string(&selected).map_err(|e| error(e.to_string()))
        }

        pub fn upper_bound(&self, statistics: &str, terms: &str) -> Result<f64, JsValue> {
            let statistics: Statistics =
                serde_json::from_str(statistics).map_err(|e| error(e.to_string()))?;
            let terms: Vec<String> =
                serde_json::from_str(terms).map_err(|e| error(e.to_string()))?;
            let bound = terms
                .iter()
                .map(|term| {
                    let df = statistics.frequencies.get(term).copied().unwrap_or(0);
                    self.header
                        .terms
                        .get(term)
                        .map(|meta| {
                            meta.blocks
                                .iter()
                                .map(|block| {
                                    bm25(
                                        block.max_title_tf,
                                        block.max_body_tf,
                                        block.min_title_length,
                                        block.min_body_length,
                                        &statistics,
                                        df,
                                    )
                                })
                                .fold(0.0, f64::max)
                        })
                        .unwrap_or(0.0)
                })
                .sum();
            Ok(bound)
        }

        pub fn lookup(&self, ids: &str, dead: &str) -> Result<String, JsValue> {
            let header = &self.header;
            let ids: Vec<String> = serde_json::from_str(ids).map_err(|e| error(e.to_string()))?;
            let dead: BTreeSet<u32> =
                serde_json::from_str(dead).map_err(|e| error(e.to_string()))?;
            let found: Vec<_> = ids
                .iter()
                .filter_map(|id| {
                    header
                        .documents
                        .binary_search_by(|doc| doc.id.encode_utf16().cmp(id.encode_utf16()))
                        .ok()
                })
                .filter(|row| !dead.contains(&(*row as u32)))
                .map(|row| Located {
                    row: row as u32,
                    document: &header.documents[row],
                })
                .collect();
            serde_json::to_string(&found).map_err(|e| error(e.to_string()))
        }

        pub fn rows(&self, rows: &str) -> Result<String, JsValue> {
            let header = &self.header;
            let rows: Vec<u32> = serde_json::from_str(rows).map_err(|e| error(e.to_string()))?;
            let selected = rows
                .iter()
                .map(|row| header.documents.get(*row as usize).ok_or("Invalid row"))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| error(e.into()))?;
            serde_json::to_string(&selected).map_err(|e| error(e.to_string()))
        }

        pub fn ranker(&self, query: &str) -> Result<Ranker, JsValue> {
            let input: Input = serde_json::from_str(query).map_err(|e| error(e.to_string()))?;
            let search = Search::new(
                self.header.clone(),
                input.statistics,
                &input.text,
                &input.mode,
                input.top_k,
                &input.dead,
                &input.filters,
            )
            .map_err(error)?;
            Ok(Ranker { search })
        }
    }

    #[derive(Serialize)]
    struct Located<'a> {
        row: u32,
        document: &'a DocumentMeta,
    }

    #[wasm_bindgen]
    pub fn segment_document(bytes: &[u8]) -> Result<String, JsValue> {
        let decoded = decode_page(bytes).map_err(error)?;
        let document: Document =
            serde_json::from_slice(&decoded).map_err(|e| error(e.to_string()))?;
        serde_json::to_string(&document).map_err(|e| error(e.to_string()))
    }

    #[wasm_bindgen]
    pub fn segment_document_terms(json: &str) -> Result<String, JsValue> {
        let document: Document = serde_json::from_str(json).map_err(|e| error(e.to_string()))?;
        serde_json::to_string(&document_terms(&document)).map_err(|e| error(e.to_string()))
    }

    #[wasm_bindgen]
    pub fn segment_filter(attributes: &str, filters: &str) -> Result<bool, JsValue> {
        let attributes: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(attributes).map_err(|e| error(e.to_string()))?;
        let filters: Vec<Filter> =
            serde_json::from_str(filters).map_err(|e| error(e.to_string()))?;
        matches(&attributes, &filters).map_err(error)
    }

    #[wasm_bindgen]
    pub fn segment_bloom(values: &str) -> Result<Vec<u8>, JsValue> {
        let values: Vec<String> = serde_json::from_str(values).map_err(|e| error(e.to_string()))?;
        Ok(bloom_build(&values))
    }

    #[wasm_bindgen]
    pub fn segment_bloom_filter(bytes: &[u8], values: &str) -> Result<String, JsValue> {
        let values: Vec<String> = serde_json::from_str(values).map_err(|e| error(e.to_string()))?;
        let selected: Vec<_> = values
            .iter()
            .filter(|value| bloom_contains(bytes, value))
            .collect();
        serde_json::to_string(&selected).map_err(|e| error(e.to_string()))
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
        pub fn add(&mut self, term: &str, bytes: &[u8]) -> Result<(), JsValue> {
            self.search.add(term, bytes).map_err(error)
        }
        pub fn finish(&self) -> Result<String, JsValue> {
            let hits = self.search.finish();
            let ranked: Vec<_> = hits
                .iter()
                .map(|hit| Ranked {
                    row: hit.row,
                    id: &self.search.header.documents[hit.row as usize].id,
                    score: hit.score,
                })
                .collect();
            serde_json::to_string(&ranked).map_err(|cause| error(cause.to_string()))
        }
    }

    #[derive(Serialize)]
    struct Ranked<'a> {
        row: u32,
        id: &'a str,
        score: f64,
    }
}
