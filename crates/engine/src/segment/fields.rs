use super::{
    BLOCK_SIZE, Document, DocumentColumnId, DocumentTable, FieldPosting, Filter, Header, Hit,
    MAX_QUERY_TERMS, NativeRole, PostingShape, TermDictionary, count_as_f64, decode_shaped_rows,
    encode_group, offer_hit,
};
use crate::analysis::{WordV4Analyzer, WordV4Config};
use crate::normalize_text;
use bit_vec::BitVec;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

pub(super) const NATIVE_TITLE: usize = 0;
pub(super) const NATIVE_TEXT: usize = 1;
pub(super) const NATIVE_FIELDS: usize = 2;
const FIELD_LIMIT: usize = 64;
const TOKEN_BUDGET: usize = 65_536;

#[derive(Clone, Copy, Debug)]
pub enum FieldAnalysis {
    Native,
    WordV4(WordV4Config),
}

impl FieldAnalysis {
    #[must_use]
    pub const fn config(self) -> Option<WordV4Config> {
        match self {
            Self::Native => None,
            Self::WordV4(config) => Some(config),
        }
    }

    #[must_use]
    pub const fn preserves_inputs(self) -> bool {
        matches!(self, Self::WordV4(_))
    }
}

#[derive(Clone, Debug)]
pub struct FieldMeta {
    id: DocumentColumnId,
    analysis: FieldAnalysis,
    total: u64,
}

impl FieldMeta {
    #[must_use]
    pub const fn id(&self) -> &DocumentColumnId {
        &self.id
    }

    #[must_use]
    pub const fn analysis(&self) -> FieldAnalysis {
        self.analysis
    }

    #[must_use]
    pub const fn total(&self) -> u64 {
        self.total
    }

    pub(super) fn wire_id(&self) -> (u8, &str) {
        match &self.id {
            DocumentColumnId::Role(NativeRole::Title) => (0, ""),
            DocumentColumnId::Role(NativeRole::Text) => (1, ""),
            DocumentColumnId::Attribute(name) => (2, name),
            DocumentColumnId::Role(NativeRole::Vector) => (3, ""),
        }
    }

    pub(super) fn from_wire(
        kind: u8,
        name: String,
        analysis: Option<WordV4Config>,
        total: u64,
    ) -> Result<Self, String> {
        let (id, analysis) = match (kind, analysis) {
            (0, None) if name.is_empty() => (
                DocumentColumnId::Role(NativeRole::Title),
                FieldAnalysis::Native,
            ),
            (1, None) if name.is_empty() => (
                DocumentColumnId::Role(NativeRole::Text),
                FieldAnalysis::Native,
            ),
            (2, Some(config)) => (
                DocumentColumnId::Attribute(name),
                FieldAnalysis::WordV4(config),
            ),
            _ => return Err("Invalid text field declaration".into()),
        };
        Ok(Self {
            id,
            analysis,
            total,
        })
    }

    const fn native(role: NativeRole, total: u64) -> Self {
        Self {
            id: DocumentColumnId::Role(role),
            analysis: FieldAnalysis::Native,
            total,
        }
    }
}

#[derive(Clone)]
pub struct FieldTable {
    fields: Vec<FieldMeta>,
    native: TermDictionary,
    named: Vec<TermDictionary>,
}

#[derive(Serialize)]
struct FieldSummary<'a> {
    kind: &'static str,
    name: Option<&'a str>,
    analysis: Option<WordV4Config>,
    total: u64,
    terms: usize,
}

impl Serialize for FieldTable {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.fields.iter().enumerate().map(|(ordinal, field)| {
            let (kind, name) = match &field.id {
                DocumentColumnId::Role(NativeRole::Title) => ("title", None),
                DocumentColumnId::Role(NativeRole::Text) => ("text", None),
                DocumentColumnId::Role(NativeRole::Vector) => ("vector", None),
                DocumentColumnId::Attribute(name) => ("attribute", Some(name.as_str())),
            };
            FieldSummary {
                kind,
                name,
                analysis: field.analysis.config(),
                total: field.total,
                terms: self.dictionary(ordinal).map_or(0, |(terms, _)| terms.len()),
            }
        }))
    }
}

impl FieldTable {
    pub(super) fn native(title_total: u64, text_total: u64, terms: TermDictionary) -> Self {
        Self {
            fields: vec![
                FieldMeta::native(NativeRole::Title, title_total),
                FieldMeta::native(NativeRole::Text, text_total),
            ],
            native: terms,
            named: Vec::new(),
        }
    }

    pub(super) fn from_wire(
        fields: Vec<FieldMeta>,
        groups: Vec<TermDictionary>,
    ) -> Result<Self, String> {
        if fields.len() < NATIVE_FIELDS || groups.len() + 1 != fields.len() {
            return Err("Invalid text field table".into());
        }
        let mut groups = groups.into_iter();
        let native = groups.next().ok_or("Invalid text field table")?;
        Ok(Self {
            fields,
            native,
            named: groups.collect(),
        })
    }

    pub(super) fn push_named(&mut self, field: FieldMeta, terms: TermDictionary) {
        self.fields.push(field);
        self.named.push(terms);
    }

    #[must_use]
    pub const fn len(&self) -> usize {
        self.fields.len()
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    #[must_use]
    pub fn get(&self, ordinal: usize) -> Option<&FieldMeta> {
        self.fields.get(ordinal)
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = &FieldMeta> {
        self.fields.iter()
    }

    #[must_use]
    pub fn ordinal(&self, id: &DocumentColumnId) -> Option<usize> {
        self.fields.iter().position(|field| &field.id == id)
    }

    #[must_use]
    pub const fn terms(&self) -> &TermDictionary {
        &self.native
    }

    pub const fn terms_mut(&mut self) -> &mut TermDictionary {
        &mut self.native
    }

    #[must_use]
    pub fn total(&self, ordinal: usize) -> u64 {
        self.fields.get(ordinal).map_or(0, FieldMeta::total)
    }

    pub fn set_total(&mut self, ordinal: usize, total: u64) {
        if let Some(field) = self.fields.get_mut(ordinal) {
            field.total = total;
        }
    }

    pub fn dictionaries(&self) -> impl Iterator<Item = &TermDictionary> {
        std::iter::once(&self.native).chain(&self.named)
    }

    #[must_use]
    pub fn dictionary(&self, ordinal: usize) -> Option<(&TermDictionary, usize)> {
        if ordinal < NATIVE_FIELDS {
            self.fields.get(ordinal).map(|_| (&self.native, ordinal))
        } else {
            self.named
                .get(ordinal - NATIVE_FIELDS)
                .map(|terms| (terms, 0))
        }
    }

    fn shape(&self, ordinal: usize) -> PostingShape {
        if ordinal < NATIVE_FIELDS {
            PostingShape::NATIVE
        } else {
            PostingShape::single(
                self.fields
                    .get(ordinal)
                    .is_some_and(|field| field.analysis.preserves_inputs()),
            )
        }
    }

    pub(super) fn has_named_terms(&self) -> bool {
        self.named.iter().any(|terms| !terms.is_empty())
    }

    pub(super) fn heap_bytes(&self) -> usize {
        self.fields.capacity() * size_of::<FieldMeta>()
            + self
                .fields
                .iter()
                .map(|field| match &field.id {
                    DocumentColumnId::Attribute(name) => name.capacity() + 16,
                    DocumentColumnId::Role(_) => 16,
                })
                .sum::<usize>()
            + self.named.capacity() * size_of::<TermDictionary>()
            + self
                .dictionaries()
                .map(TermDictionary::heap_bytes)
                .sum::<usize>()
    }

    pub(super) fn validate(&self, documents: &DocumentTable, version: u32) -> Result<(), String> {
        let count = self.fields.len();
        if !(NATIVE_FIELDS..=NATIVE_FIELDS + FIELD_LIMIT).contains(&count)
            || self.named.len() + NATIVE_FIELDS != count
        {
            return Err("Named text fields exceed 64".into());
        }
        if version < 4 && count != NATIVE_FIELDS {
            return Err("Named text requires segment version 4".into());
        }
        if documents.lengths.len() != count
            || documents
                .lengths
                .iter()
                .any(|column| column.len() != documents.len())
        {
            return Err("Field lengths do not match the document count".into());
        }
        self.validate_declarations()?;
        if version == 4 {
            for (ordinal, field) in self.fields.iter().take(NATIVE_FIELDS).enumerate() {
                validate_total(documents, ordinal, field.total)?;
            }
        }
        let rows = u32::try_from(documents.len()).map_err(|cause| cause.to_string())?;
        validate_dictionary(&self.native, rows, false)?;
        for (index, (terms, field)) in self
            .named
            .iter()
            .zip(&self.fields[NATIVE_FIELDS..])
            .enumerate()
        {
            validate_dictionary(terms, rows, true)?;
            validate_total(documents, NATIVE_FIELDS + index, field.total)?;
        }
        Ok(())
    }

    fn validate_declarations(&self) -> Result<(), String> {
        let native = self
            .fields
            .iter()
            .take(NATIVE_FIELDS)
            .map(|field| (&field.id, field.analysis.config().is_none()))
            .collect::<Vec<_>>();
        if native
            != [
                (&DocumentColumnId::Role(NativeRole::Title), true),
                (&DocumentColumnId::Role(NativeRole::Text), true),
            ]
        {
            return Err("Native text fields must lead the field table".into());
        }
        let mut previous: Option<&str> = None;
        for field in self.fields.iter().skip(NATIVE_FIELDS) {
            let (DocumentColumnId::Attribute(name), FieldAnalysis::WordV4(config)) =
                (&field.id, field.analysis)
            else {
                return Err("Invalid named text field".into());
            };
            validate_name(name)?;
            if previous.is_some_and(|previous| previous >= name.as_str()) {
                return Err("Named text fields are not strictly sorted".into());
            }
            previous = Some(name);
            WordV4Analyzer::new(config)?;
        }
        Ok(())
    }
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 || name.starts_with('$') {
        return Err("Invalid named text field".into());
    }
    Ok(())
}

fn validate_total(documents: &DocumentTable, ordinal: usize, total: u64) -> Result<(), String> {
    let mut sum = 0_u64;
    for row in 0..documents.len() {
        sum = sum
            .checked_add(u64::from(documents.field_length(ordinal, row)))
            .ok_or("Text field length overflow")?;
    }
    if sum == total {
        Ok(())
    } else {
        Err("Text field totals do not match lengths".into())
    }
}

fn validate_dictionary(terms: &TermDictionary, rows: u32, strict: bool) -> Result<(), String> {
    for (term, metadata) in terms {
        if metadata.df > rows {
            return Err("Invalid term document frequency".into());
        }
        if metadata
            .blocks
            .windows(2)
            .any(|pair| pair[0].last >= pair[1].first)
        {
            return Err("Posting block rows are not strictly ordered".into());
        }
        let mut counted = 0_u32;
        for block in &metadata.blocks {
            if block.last >= rows || block.first > block.last || block.count as usize > BLOCK_SIZE {
                return Err("Invalid posting block directory".into());
            }
            if strict
                && (block.count == 0
                    || block.max_tf[0] == 0
                    || block.max_tf[1] != 0
                    || block.min_length[1] != 0)
            {
                return Err("Invalid named posting block directory".into());
            }
            counted = counted.saturating_add(block.count);
        }
        if strict
            && (term.is_empty()
                || metadata.df == 0
                || metadata.blocks.is_empty()
                || counted != metadata.df)
        {
            return Err("Invalid named text document frequency".into());
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub struct NamedTextField<'a> {
    pub attribute: &'a str,
    pub config: WordV4Config,
}

impl<'a> NamedTextField<'a> {
    #[must_use]
    pub fn new(attribute: &'a str) -> Self {
        Self {
            attribute,
            config: WordV4Config::default(),
        }
    }
}

struct FieldToken {
    term: String,
    position: u32,
    input: u32,
}

struct NamedField {
    name: String,
    config: WordV4Config,
    analyzer: WordV4Analyzer,
    lengths: Vec<u32>,
    total: u64,
    lists: BTreeMap<String, Vec<FieldPosting>>,
}

impl NamedField {
    fn observe(&mut self, document: &Document, row: u32) -> Result<(), String> {
        let tokens = collect_attribute(&mut self.analyzer, &self.name, document)?;
        let length = u32::try_from(tokens.len()).map_err(|cause| cause.to_string())?;
        self.total = self
            .total
            .checked_add(u64::from(length))
            .ok_or("Named text length overflow")?;
        self.lengths.push(length);
        let mut grouped: BTreeMap<String, FieldPosting> = BTreeMap::new();
        for token in tokens {
            let posting = grouped.entry(token.term).or_insert_with(|| FieldPosting {
                row,
                positions: Vec::new(),
                inputs: Vec::new(),
            });
            posting.positions.push(token.position);
            posting.inputs.push(token.input);
        }
        for (term, posting) in grouped {
            self.lists.entry(term).or_default().push(posting);
        }
        Ok(())
    }
}

pub(super) struct NamedBuilder {
    fields: Vec<NamedField>,
}

impl NamedBuilder {
    pub(super) fn prepare(requests: &[NamedTextField<'_>]) -> Result<Self, String> {
        if requests.len() > FIELD_LIMIT {
            return Err("Named text fields exceed 64".into());
        }
        let mut previous: Option<&str> = None;
        let mut fields = Vec::with_capacity(requests.len());
        for request in requests {
            validate_name(request.attribute)?;
            if previous.is_some_and(|previous| previous >= request.attribute) {
                return Err("Named text fields are not strictly sorted".into());
            }
            previous = Some(request.attribute);
            fields.push(NamedField {
                name: request.attribute.to_owned(),
                config: request.config,
                analyzer: WordV4Analyzer::new(request.config)?,
                lengths: Vec::new(),
                total: 0,
                lists: BTreeMap::new(),
            });
        }
        Ok(Self { fields })
    }

    pub(super) fn observe(&mut self, document: &Document, row: u32) -> Result<(), String> {
        for field in &mut self.fields {
            field.observe(document, row)?;
        }
        Ok(())
    }

    pub(super) fn finish(
        self,
        payload: &mut Vec<u8>,
        documents: &mut DocumentTable,
        table: &mut FieldTable,
    ) -> Result<(), String> {
        for field in self.fields {
            let shape = PostingShape::single(true);
            let terms = {
                let lengths = &field.lengths;
                encode_group(
                    payload,
                    shape,
                    |_, row| lengths.get(row as usize).copied().unwrap_or(0),
                    field.lists,
                )?
            };
            table.push_named(
                FieldMeta {
                    id: DocumentColumnId::Attribute(field.name),
                    analysis: FieldAnalysis::WordV4(field.config),
                    total: field.total,
                },
                terms,
            );
            documents.push_field_lengths(field.lengths);
        }
        Ok(())
    }
}

fn collect_attribute(
    analyzer: &mut WordV4Analyzer,
    name: &str,
    document: &Document,
) -> Result<Vec<FieldToken>, String> {
    let mut tokens = Vec::new();
    let mut failure = None;
    analyzer.analyze_attribute(document, name, |token| {
        if tokens.len() == TOKEN_BUDGET {
            failure = Some("Text analysis output exceeds its token budget");
            return false;
        }
        let (Ok(position), Ok(input)) = (
            u32::try_from(token.position),
            u32::try_from(token.input_index),
        ) else {
            failure = Some("Token position exceeds u32");
            return false;
        };
        tokens.push(FieldToken {
            term: token.text.to_owned(),
            position,
            input,
        });
        true
    })?;
    if let Some(failure) = failure {
        return Err(failure.into());
    }
    let monotonic = tokens
        .windows(2)
        .all(|pair| pair[0].position < pair[1].position && pair[0].input <= pair[1].input);
    if !monotonic {
        return Err("Named token positions are not monotonic".into());
    }
    Ok(tokens)
}

const STATISTICS_MISMATCH: &str = "Statistics do not match the selected text fields";
const STATISTICS_TERMS: &str = "Statistics terms do not match the query";

#[doc = "Okapi BM25 saturation and length-normalization parameters."]
#[doc = ""]
#[doc = "Internal validation only requires the mathematically valid domain"]
#[doc = "(`k1 > 0`, `0 <= b <= 1`); public API bounds are not asserted here."]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bm25Parameters {
    k1: f64,
    b: f64,
}

impl Bm25Parameters {
    #[doc = "Parameters used by native segment scoring (`k1 = 1.2`, `b = 0.75`)."]
    pub const DEFAULT: Self = Self { k1: 1.2, b: 0.75 };

    #[doc = "# Errors\nRejects non-finite or non-positive `k1`, and `b` that is non-finite or outside zero through one."]
    pub fn new(k1: f64, b: f64) -> Result<Self, String> {
        if !k1.is_finite() || k1 <= 0.0 {
            return Err("BM25 k1 must be finite and positive".into());
        }
        if !(0.0..=1.0).contains(&b) {
            return Err("BM25 b must be finite and within zero through one".into());
        }
        Ok(Self { k1, b })
    }

    #[must_use]
    pub const fn k1(self) -> f64 {
        self.k1
    }

    #[must_use]
    pub const fn b(self) -> f64 {
        self.b
    }

    fn saturate(self, tf: u32, length: u32, average: f64) -> f64 {
        let mean = if average > 0.0 { average } else { 1.0 };
        f64::from(tf) / ((1.0 - self.b) + self.b * f64::from(length) / mean)
    }
}

impl Default for Bm25Parameters {
    fn default() -> Self {
        Self::DEFAULT
    }
}

#[doc = "Corpus-wide statistics for one text field, keyed by its exact identity."]
#[doc = ""]
#[doc = "`frequencies` holds the document frequency of every analyzed query term of"]
#[doc = "that field, including explicit zeros for absent terms."]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldStatistics {
    pub id: DocumentColumnId,
    pub tokens: u64,
    pub frequencies: BTreeMap<String, u64>,
}

#[doc = "Caller-owned live corpus statistics: the global document count plus"]
#[doc = "per-field token totals and query-term document frequencies."]
#[doc = ""]
#[doc = "Aggregate statistics over disjoint live segments before applying query filters."]
#[doc = "Callers own corpus consistency: ranking checks field identities, term sets and"]
#[doc = "numeric bounds, but does not scan filtered-out postings to prove global counts."]
#[doc = "Segments sharing correct statistics score bit-identically to a single segment"]
#[doc = "that holds the same documents."]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorpusStatistics {
    pub documents: u64,
    pub fields: Vec<FieldStatistics>,
}

#[doc = "Query context for field ranking."]
#[doc = ""]
#[doc = "With `statistics: None` the corpus is the segment itself minus tombstones."]
#[doc = "Filters only limit eligibility and never change either kind of statistics."]
#[derive(Clone, Copy)]
pub struct FieldQuery<'a> {
    pub fields: &'a [DocumentColumnId],
    pub text: &'a str,
    pub mode: &'a str,
    pub top_k: usize,
    pub dead: &'a [u32],
    pub filters: &'a [Filter],
    pub bm25: Bm25Parameters,
    pub statistics: Option<&'a CorpusStatistics>,
}

struct QueryToken {
    term: String,
    position: u32,
}

type TermPostings = BTreeMap<u32, Vec<(u32, u32)>>;

struct LoadedField {
    ordinal: usize,
    tokens: Vec<QueryToken>,
    unique: Vec<String>,
    postings: Vec<TermPostings>,
    local: Vec<u32>,
}

impl LoadedField {
    fn index(&self, term: &str) -> Option<usize> {
        self.unique.iter().position(|candidate| candidate == term)
    }
}

struct Live {
    mask: BitVec,
    tombstoned: bool,
    rows: u64,
}

impl Live {
    fn new(mask: BitVec, tombstoned: bool) -> Result<Self, String> {
        let rows = if tombstoned {
            mask.iter().filter(|alive| *alive).count()
        } else {
            mask.len()
        };
        Ok(Self {
            rows: u64::try_from(rows).map_err(|cause| cause.to_string())?,
            mask,
            tombstoned,
        })
    }

    fn tokens(&self, header: &Header, ordinal: usize) -> Result<u64, String> {
        if !self.tombstoned {
            return Ok(header.fields.total(ordinal));
        }
        let mut sum = 0_u64;
        for row in (0..self.mask.len()).filter(|row| self.mask[*row]) {
            sum = sum
                .checked_add(u64::from(header.documents.field_length(ordinal, row)))
                .ok_or("Text field length overflow")?;
        }
        Ok(sum)
    }
}

struct FieldScale {
    average: f64,
    frequencies: Vec<u64>,
}

struct Scoring {
    documents: u64,
    count: f64,
    parameters: Bm25Parameters,
    fields: Vec<FieldScale>,
}

impl Scoring {
    fn new(documents: u64, parameters: Bm25Parameters, fields: Vec<FieldScale>) -> Self {
        Self {
            documents,
            count: count_as_f64(documents),
            parameters,
            fields,
        }
    }

    fn term(&self, tf: u32, length: u32, average: f64, df: u64) -> f64 {
        if tf == 0 || self.documents == 0 || df == 0 || df > self.documents {
            return 0.0;
        }
        let df = count_as_f64(df);
        let idf = ((self.count - df + 0.5) / (df + 0.5)).ln_1p();
        let saturated = self.parameters.saturate(tf, length, average);
        let k1 = self.parameters.k1;
        idf * saturated * (k1 + 1.0) / (saturated + k1)
    }
}

fn average_length(tokens: u64, documents: u64) -> f64 {
    if documents == 0 {
        0.0
    } else {
        count_as_f64(tokens) / count_as_f64(documents)
    }
}

pub(super) fn rank(
    header: &Header,
    bytes: &[u8],
    base: usize,
    query: &FieldQuery<'_>,
) -> Result<Vec<Hit>, String> {
    let ordinals = select_ordinals(&header.fields, query.fields)?;
    let allowed = header.allowed(query.filters, query.dead)?;
    check_budget(query.mode, query.top_k)?;
    let mask = if query.filters.is_empty() {
        allowed.clone()
    } else {
        header.allowed(&[], query.dead)?
    };
    let live = Live::new(mask, !query.dead.is_empty())?;
    let mut loaded = ordinals
        .into_iter()
        .map(|ordinal| plan_field(header, ordinal, query.text, query.mode))
        .collect::<Result<Vec<_>, _>>()?;
    let given = query
        .statistics
        .map(|statistics| match_statistics(statistics, header, &loaded))
        .transpose()?;
    let counted = given.is_none().then_some(&live.mask);
    for field in &mut loaded {
        load_field(header, bytes, base, field, &allowed, counted)?;
    }
    let scoring = if let (Some(statistics), Some(matched)) = (query.statistics, given.as_deref()) {
        explicit_scoring(statistics, matched, header, &loaded, &live, query.bm25)?
    } else {
        local_scoring(header, &loaded, &live, query.bm25)?
    };
    if loaded.iter().all(|field| field.tokens.is_empty()) {
        return Ok(Vec::new());
    }
    let rows = candidate_rows(query.mode, &loaded)?;
    score_rows(header, &loaded, &scoring, &rows, query.top_k)
}

pub(super) fn local_statistics(
    header: &Header,
    bytes: &[u8],
    base: usize,
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    dead: &[u32],
) -> Result<CorpusStatistics, String> {
    let ordinals = select_ordinals(&header.fields, fields)?;
    let mask = header.allowed(&[], dead)?;
    check_budget(mode, 1)?;
    let nothing = BitVec::from_elem(mask.len(), false);
    let live = Live::new(mask, !dead.is_empty())?;
    let mut statistics = Vec::with_capacity(ordinals.len());
    for ordinal in ordinals {
        let mut field = plan_field(header, ordinal, text, mode)?;
        load_field(header, bytes, base, &mut field, &nothing, Some(&live.mask))?;
        let id = header
            .fields
            .get(ordinal)
            .ok_or("Missing text field")?
            .id()
            .clone();
        statistics.push(FieldStatistics {
            id,
            tokens: live.tokens(header, ordinal)?,
            frequencies: field
                .unique
                .iter()
                .cloned()
                .zip(field.local.iter().map(|df| u64::from(*df)))
                .collect(),
        });
    }
    Ok(CorpusStatistics {
        documents: live.rows,
        fields: statistics,
    })
}

fn match_statistics<'s>(
    statistics: &'s CorpusStatistics,
    header: &Header,
    loaded: &[LoadedField],
) -> Result<Vec<&'s FieldStatistics>, String> {
    if statistics.fields.len() > FIELD_LIMIT + NATIVE_FIELDS {
        return Err("Named text fields exceed 64".into());
    }
    for (index, field) in statistics.fields.iter().enumerate() {
        if statistics.fields[..index]
            .iter()
            .any(|earlier| earlier.id == field.id)
        {
            return Err("Duplicate statistics field".into());
        }
    }
    if statistics.fields.len() != loaded.len() {
        return Err(STATISTICS_MISMATCH.into());
    }
    let mut matched = Vec::with_capacity(loaded.len());
    for field in loaded {
        let id = header
            .fields
            .get(field.ordinal)
            .ok_or("Missing text field")?
            .id();
        let given = statistics
            .fields
            .iter()
            .find(|candidate| &candidate.id == id)
            .ok_or(STATISTICS_MISMATCH)?;
        if given.frequencies.len() != field.unique.len()
            || field
                .unique
                .iter()
                .any(|term| !given.frequencies.contains_key(term))
        {
            return Err(STATISTICS_TERMS.into());
        }
        if given
            .frequencies
            .values()
            .any(|df| *df > statistics.documents)
        {
            return Err("Term document frequency exceeds the document count".into());
        }
        matched.push(given);
    }
    Ok(matched)
}

fn explicit_scoring(
    statistics: &CorpusStatistics,
    matched: &[&FieldStatistics],
    header: &Header,
    loaded: &[LoadedField],
    live: &Live,
    parameters: Bm25Parameters,
) -> Result<Scoring, String> {
    if statistics.documents < live.rows {
        return Err("Document total is below the live local rows".into());
    }
    let mut fields = Vec::with_capacity(loaded.len());
    for (field, given) in loaded.iter().zip(matched) {
        if given.tokens < live.tokens(header, field.ordinal)? {
            return Err("Field token total is below local rows".into());
        }
        let mut frequencies = Vec::with_capacity(field.unique.len());
        for (term, rows) in field.unique.iter().zip(&field.postings) {
            let df = given
                .frequencies
                .get(term)
                .copied()
                .ok_or(STATISTICS_TERMS)?;
            if df < u64::try_from(rows.len()).map_err(|cause| cause.to_string())? {
                return Err("Term frequency is below local postings".into());
            }
            frequencies.push(df);
        }
        fields.push(FieldScale {
            average: average_length(given.tokens, statistics.documents),
            frequencies,
        });
    }
    Ok(Scoring::new(statistics.documents, parameters, fields))
}

fn local_scoring(
    header: &Header,
    loaded: &[LoadedField],
    live: &Live,
    parameters: Bm25Parameters,
) -> Result<Scoring, String> {
    let mut fields = Vec::with_capacity(loaded.len());
    for field in loaded {
        fields.push(FieldScale {
            average: average_length(live.tokens(header, field.ordinal)?, live.rows),
            frequencies: field.local.iter().map(|df| u64::from(*df)).collect(),
        });
    }
    Ok(Scoring::new(live.rows, parameters, fields))
}

fn select_ordinals(table: &FieldTable, ids: &[DocumentColumnId]) -> Result<Vec<usize>, String> {
    if ids.is_empty() {
        return Err("Text fields are required".into());
    }
    if ids.len() > FIELD_LIMIT + NATIVE_FIELDS {
        return Err("Named text fields exceed 64".into());
    }
    let mut seen = BTreeSet::new();
    let mut ordinals = Vec::with_capacity(ids.len());
    for id in ids {
        let key = match id {
            DocumentColumnId::Role(NativeRole::Vector) => {
                return Err("Native vector role is not text".into());
            }
            DocumentColumnId::Role(role) => format!("{role:?}"),
            DocumentColumnId::Attribute(name) => format!("attribute:{name}"),
        };
        if !seen.insert(key) {
            return Err("Duplicate text field".into());
        }
        ordinals.push(table.ordinal(id).ok_or_else(|| match id {
            DocumentColumnId::Attribute(name) => format!("Unknown text field {name}"),
            DocumentColumnId::Role(role) => format!("Unknown text field {role:?}"),
        })?);
    }
    Ok(ordinals)
}

fn check_budget(mode: &str, top_k: usize) -> Result<(), String> {
    if top_k == 0 || top_k > 100 {
        return Err("Invalid search budget".into());
    }
    if mode != "any" && mode != "all" && mode != "phrase" {
        return Err("Unknown match mode".into());
    }
    Ok(())
}

fn query_tokens(
    analysis: FieldAnalysis,
    text: &str,
    mode: &str,
) -> Result<Vec<QueryToken>, String> {
    let tokens = match analysis {
        FieldAnalysis::Native => native_query_tokens(text)?,
        FieldAnalysis::WordV4(config) => word_query_tokens(config, text)?,
    };
    if mode == "phrase" && tokens.len() > 64 {
        return Err("Phrase exceeds budget".into());
    }
    Ok(tokens)
}

fn native_query_tokens(text: &str) -> Result<Vec<QueryToken>, String> {
    let normalized = normalize_text(text);
    let mut tokens = Vec::new();
    for (position, term) in normalized.split_whitespace().enumerate() {
        if tokens.len() == TOKEN_BUDGET {
            return Err("Text analysis output exceeds its token budget".into());
        }
        tokens.push(QueryToken {
            term: term.to_owned(),
            position: u32::try_from(position).map_err(|cause| cause.to_string())?,
        });
    }
    Ok(tokens)
}

fn word_query_tokens(config: WordV4Config, text: &str) -> Result<Vec<QueryToken>, String> {
    let mut analyzer = WordV4Analyzer::new(config)?;
    let mut tokens = Vec::new();
    let mut failure = None;
    analyzer.analyze_inputs(std::iter::once(text), |token| {
        if tokens.len() == TOKEN_BUDGET {
            failure = Some("Text analysis output exceeds its token budget");
            return false;
        }
        let Ok(position) = u32::try_from(token.position) else {
            failure = Some("Token position exceeds u32");
            return false;
        };
        tokens.push(QueryToken {
            term: token.text.to_owned(),
            position,
        });
        true
    });
    if let Some(failure) = failure {
        return Err(failure.into());
    }
    Ok(tokens)
}

fn unique_terms(tokens: &[QueryToken]) -> Result<Vec<String>, String> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::new();
    for token in tokens {
        if seen.insert(token.term.as_str()) {
            unique.push(token.term.clone());
        }
    }
    if unique.len() > MAX_QUERY_TERMS {
        return Err("Invalid search budget".into());
    }
    Ok(unique)
}

fn plan_field(
    header: &Header,
    ordinal: usize,
    text: &str,
    mode: &str,
) -> Result<LoadedField, String> {
    let field = header.fields.get(ordinal).ok_or("Missing text field")?;
    let tokens = query_tokens(field.analysis(), text, mode)?;
    let unique = unique_terms(&tokens)?;
    Ok(LoadedField {
        ordinal,
        tokens,
        unique,
        postings: Vec::new(),
        local: Vec::new(),
    })
}

#[doc = "Reads each unique query term's postings for rows in `allowed`. When `live`"]
#[doc = "is given, also counts the term's document frequency over its live rows."]
fn load_field(
    header: &Header,
    bytes: &[u8],
    base: usize,
    field: &mut LoadedField,
    allowed: &BitVec,
    live: Option<&BitVec>,
) -> Result<(), String> {
    let mut postings = Vec::with_capacity(field.unique.len());
    let mut local = Vec::with_capacity(field.unique.len());
    for term in &field.unique {
        let (rows, frequency) = load_term(header, bytes, base, field.ordinal, term, allowed, live)?;
        postings.push(rows);
        local.push(frequency);
    }
    field.postings = postings;
    field.local = local;
    Ok(())
}

fn block_is_masked(block: &super::BlockMeta, allowed: &BitVec) -> bool {
    !(block.first as usize..=block.last as usize).any(|row| allowed.get(row).unwrap_or(false))
}

fn block_is_live(block: &super::BlockMeta, live: &BitVec) -> bool {
    (block.first as usize..=block.last as usize).all(|row| live.get(row).unwrap_or(false))
}

fn load_term(
    header: &Header,
    bytes: &[u8],
    base: usize,
    ordinal: usize,
    term: &str,
    allowed: &BitVec,
    live: Option<&BitVec>,
) -> Result<(TermPostings, u32), String> {
    let (dictionary, lane) = header
        .fields
        .dictionary(ordinal)
        .ok_or("Missing text field")?;
    let Some(metadata) = dictionary.get(term) else {
        return Ok((BTreeMap::new(), 0));
    };
    let shape = header.fields.shape(ordinal);
    let mut rows = BTreeMap::new();
    let mut frequency = 0_u32;
    let mut previous = None;
    for block in &metadata.blocks {
        if shape.lanes == 1 && block_is_masked(block, allowed) {
            match live {
                None => {
                    previous = Some(block.last);
                    continue;
                }
                Some(live) if block_is_live(block, live) => {
                    frequency = frequency
                        .checked_add(block.count)
                        .ok_or("Document frequency overflow")?;
                    previous = Some(block.last);
                    continue;
                }
                Some(_) => {}
            }
        }
        for (row, tokens) in read_block(bytes, base, block, shape, lane)? {
            if previous.is_some_and(|previous| previous >= row) {
                return Err("Posting blocks out of order".into());
            }
            previous = Some(row);
            if tokens.is_empty() {
                continue;
            }
            if row as usize >= allowed.len() {
                return Err("Invalid posting row".into());
            }
            if tokens.len() > block.max_tf[lane] as usize {
                return Err("Posting frequency exceeds its block".into());
            }
            if live.is_some_and(|live| live.get(row as usize).unwrap_or(false)) {
                frequency += 1;
            }
            if allowed[row as usize] {
                rows.insert(row, tokens);
            }
        }
    }
    Ok((rows, frequency))
}

type BlockRows = Vec<(u32, Vec<(u32, u32)>)>;

fn read_block(
    bytes: &[u8],
    base: usize,
    block: &super::BlockMeta,
    shape: PostingShape,
    lane: usize,
) -> Result<BlockRows, String> {
    let start = base
        .checked_add(usize::try_from(block.data.offset).map_err(|cause| cause.to_string())?)
        .ok_or("Invalid posting range")?;
    let end = start
        .checked_add(usize::try_from(block.data.length).map_err(|cause| cause.to_string())?)
        .ok_or("Invalid posting range")?;
    let page = bytes.get(start..end).ok_or("Invalid posting range")?;
    let rows = decode_shaped_rows::<true, _>(page, shape, |row, first, second| {
        let selected = if lane == 0 { first } else { second };
        let tokens = selected
            .values
            .iter()
            .enumerate()
            .map(|(index, position)| (*position, selected.inputs.get(index).copied().unwrap_or(0)))
            .collect();
        (row, tokens)
    })?;
    let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
        return Err("Empty posting block".into());
    };
    if rows.len() != block.count as usize || first.0 != block.first || last.0 != block.last {
        return Err("Posting block does not match its directory".into());
    }
    Ok(rows)
}

fn candidate_rows(mode: &str, loaded: &[LoadedField]) -> Result<Vec<u32>, String> {
    match mode {
        "phrase" => phrase_rows(loaded),
        "all" => Ok(all_rows(loaded)),
        _ => Ok(loaded
            .iter()
            .flat_map(|field| field.postings.iter().flat_map(|rows| rows.keys().copied()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()),
    }
}

fn all_rows(loaded: &[LoadedField]) -> Vec<u32> {
    let terms: BTreeSet<&str> = loaded
        .iter()
        .flat_map(|field| field.unique.iter().map(String::as_str))
        .collect();
    let mut required: Option<BTreeSet<u32>> = None;
    for term in terms {
        let present: BTreeSet<u32> = loaded
            .iter()
            .filter_map(|field| field.index(term).map(|index| &field.postings[index]))
            .flat_map(|rows| rows.keys().copied())
            .collect();
        required = Some(match required {
            Some(current) => current.intersection(&present).copied().collect(),
            None => present,
        });
    }
    required
        .map(|rows| rows.into_iter().collect())
        .unwrap_or_default()
}

fn phrase_rows(loaded: &[LoadedField]) -> Result<Vec<u32>, String> {
    let mut rows = BTreeSet::new();
    for field in loaded {
        let Some(first) = field.tokens.first() else {
            continue;
        };
        let Some(starts) = field.index(&first.term).map(|index| &field.postings[index]) else {
            continue;
        };
        for row in starts.keys() {
            if phrase_in_field(field, *row)? {
                rows.insert(*row);
            }
        }
    }
    Ok(rows.into_iter().collect())
}

fn phrase_in_field(field: &LoadedField, row: u32) -> Result<bool, String> {
    let Some(origin) = field.tokens.first() else {
        return Ok(false);
    };
    let Some(starts) = field
        .index(&origin.term)
        .and_then(|index| field.postings[index].get(&row))
    else {
        return Ok(false);
    };
    for (start, input) in starts {
        if phrase_from(field, row, *start, origin.position, *input)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn phrase_from(
    field: &LoadedField,
    row: u32,
    start: u32,
    origin: u32,
    input: u32,
) -> Result<bool, String> {
    for token in &field.tokens {
        let delta = token
            .position
            .checked_sub(origin)
            .ok_or("Phrase position underflow")?;
        let position = start.checked_add(delta).ok_or("Phrase position overflow")?;
        let matched = field
            .index(&token.term)
            .and_then(|index| field.postings[index].get(&row))
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.0 == position && entry.1 == input)
            });
        if !matched {
            return Ok(false);
        }
    }
    Ok(true)
}

fn score_rows(
    header: &Header,
    loaded: &[LoadedField],
    scoring: &Scoring,
    rows: &[u32],
    top_k: usize,
) -> Result<Vec<Hit>, String> {
    let mut heap = BinaryHeap::with_capacity(top_k);
    for row in rows {
        let score = score_row(header, loaded, scoring, *row)?;
        if score > 0.0 {
            offer_hit(&mut heap, top_k, Hit { row: *row, score });
        }
    }
    let mut hits = heap.into_vec();
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.row.cmp(&right.row))
    });
    Ok(hits)
}

fn score_row(
    header: &Header,
    loaded: &[LoadedField],
    scoring: &Scoring,
    row: u32,
) -> Result<f64, String> {
    let mut score = 0.0;
    for (field, scale) in loaded.iter().zip(&scoring.fields) {
        let length = header.documents.field_length(field.ordinal, row as usize);
        for (rows, frequency) in field.postings.iter().zip(&scale.frequencies) {
            let tf = rows.get(&row).map_or(0, Vec::len);
            score += scoring.term(
                u32::try_from(tf).map_err(|cause| cause.to_string())?,
                length,
                scale.average,
                *frequency,
            );
        }
    }
    if score.is_finite() {
        Ok(score)
    } else {
        Err("Text score is not finite".into())
    }
}

#[cfg(test)]
mod tests;
