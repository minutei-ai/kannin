use super::{
    BLOCK_SIZE, Document, DocumentColumnId, DocumentTable, FieldPosting, Filter, NativeRole,
    PostingShape, TermDictionary, encode_group,
};
use crate::analysis::{WordV4Analyzer, WordV4Config};
use serde::Serialize;
use std::collections::BTreeMap;

mod corpus;
mod matching;
mod prepare;
mod query;
mod scan;
mod scorer;
mod source;

pub(super) use corpus::local_statistics;
pub use corpus::{
    aggregate_statistics, plan_statistics_pages, statistics_from_pages,
    statistics_from_pages_measured,
};
pub(super) use scorer::rank;
pub use scorer::{plan_rank_pages, rank_from_pages, rank_from_pages_measured};
pub use source::{
    CollectedPages, FieldBudget, Measured, PageCollector, PagePlan, PostingPages, SlicePages,
};

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
        if version >= 4 {
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

#[cfg(test)]
mod page_tests;
#[cfg(test)]
mod tests;
