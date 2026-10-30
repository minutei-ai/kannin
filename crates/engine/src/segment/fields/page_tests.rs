use super::super::{
    Document, DocumentColumnId, Filter, Header, NativeRole, Range, build_text_fields, count_as_f64,
    decode_shaped_rows, local_field_statistics, parse_header,
};
use super::source::Workspace;
use super::{
    Bm25Parameters, CorpusStatistics, FieldAnalysis, FieldBudget, FieldQuery, FieldStatistics,
    Measured, NamedTextField, PageCollector, PagePlan, PostingPages, aggregate_statistics,
    plan_rank_pages, plan_statistics_pages, rank_from_pages, rank_from_pages_measured,
    statistics_from_pages, statistics_from_pages_measured,
};
use crate::analysis::WordV4Analyzer;
use crate::normalize_text;
use std::collections::{BTreeMap, BTreeSet};

type Scored = Vec<(u32, u64)>;
type Rows = BTreeMap<u32, Vec<(u32, u32)>>;

fn rejection<T>(result: Result<T, String>) -> Result<String, String> {
    result.err().ok_or_else(|| "Unexpected success".to_owned())
}

fn tags() -> DocumentColumnId {
    DocumentColumnId::attribute("tags")
}

fn title_attribute() -> DocumentColumnId {
    DocumentColumnId::attribute("title")
}

fn role(role: NativeRole) -> DocumentColumnId {
    DocumentColumnId::Role(role)
}

fn corpus(count: u32) -> Vec<Document> {
    (0..count)
        .map(|index| {
            let repeats = usize::from(u8::try_from(index % 5).unwrap_or(0));
            let order = if index % 2 == 0 { "red dog" } else { "dog red" };
            let gap = if index % 11 == 0 { " red the fox" } else { "" };
            let tags = format!("{}{order}{gap}", "fox ".repeat(repeats));
            let title = if index % 3 == 0 { "red fox" } else { "red" };
            let echoes = usize::from(u8::try_from(index % 4).unwrap_or(0));
            let tail = if index % 7 == 0 {
                "quick red fox"
            } else {
                "body"
            };
            Document::native(
                format!("row{index:04}"),
                1,
                title,
                format!("{}{tail}", "fox ".repeat(echoes)),
                BTreeMap::from([
                    ("early".into(), serde_json::json!(index < 128)),
                    ("tags".into(), serde_json::json!(tags)),
                    (
                        "title".into(),
                        serde_json::json!(if index % 2 == 0 { "fox" } else { "dog" }),
                    ),
                ]),
                None,
            )
        })
        .collect()
}

fn segment(count: u32) -> Result<Vec<u8>, String> {
    Ok(build_text_fields(
        corpus(count),
        None,
        &[NamedTextField::new("tags"), NamedTextField::new("title")],
    )?
    .bytes)
}

fn early() -> [Filter; 1] {
    [Filter {
        field: "early".into(),
        op: "eq".into(),
        value: serde_json::json!(true),
    }]
}

fn field_sets() -> Vec<Vec<DocumentColumnId>> {
    vec![
        vec![role(NativeRole::Title), role(NativeRole::Text)],
        vec![role(NativeRole::Title), role(NativeRole::Text), tags()],
        vec![tags()],
        vec![role(NativeRole::Title)],
        vec![title_attribute()],
        vec![tags(), title_attribute()],
    ]
}

struct Case<'a> {
    fields: &'a [DocumentColumnId],
    text: &'a str,
    mode: &'a str,
    top_k: usize,
}

impl<'a> Case<'a> {
    const fn query(
        &self,
        filters: &'a [Filter],
        statistics: Option<&'a CorpusStatistics>,
    ) -> FieldQuery<'a> {
        FieldQuery {
            fields: self.fields,
            text: self.text,
            mode: self.mode,
            top_k: self.top_k,
            dead: &[],
            filters,
            bm25: Bm25Parameters::DEFAULT,
            statistics,
        }
    }
}

struct Counting<'a> {
    bytes: &'a [u8],
    base: usize,
    reads: Vec<(u32, u32)>,
}

impl<'a> Counting<'a> {
    const fn new(bytes: &'a [u8], base: usize) -> Self {
        Self {
            bytes,
            base,
            reads: Vec::new(),
        }
    }

    fn distinct(&self) -> Vec<(u32, u32)> {
        self.reads
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

impl PostingPages for Counting<'_> {
    fn page(&mut self, range: &Range) -> Result<&[u8], String> {
        self.reads.push((range.offset, range.length));
        let start = self.base + range.offset as usize;
        self.bytes
            .get(start..start + range.length as usize)
            .ok_or_else(|| "Missing page".to_owned())
    }
}

fn scored<T: IntoIterator<Item = super::super::Hit>>(hits: T) -> Scored {
    hits.into_iter()
        .map(|hit| (hit.row, hit.score.to_bits()))
        .collect()
}

fn direct(
    bytes: &[u8],
    case: &Case<'_>,
    filters: &[Filter],
    statistics: Option<&CorpusStatistics>,
) -> Result<Scored, String> {
    let (header, base) = parse_header(bytes)?;
    let mut pages = Counting::new(bytes, base);
    let hits = rank_from_pages(
        &header,
        &mut pages,
        &case.query(filters, statistics),
        &FieldBudget::UNBOUNDED,
    )?;
    Ok(scored(hits))
}

fn plan_for(
    header: &Header,
    case: &Case<'_>,
    filters: &[Filter],
    statistics: Option<&CorpusStatistics>,
) -> Result<PagePlan, String> {
    plan_rank_pages(
        header,
        &case.query(filters, statistics),
        &FieldBudget::UNBOUNDED,
    )
}

fn ranges(plan: &PagePlan) -> Vec<(u32, u32)> {
    plan.ranges()
        .iter()
        .map(|range| (range.offset, range.length))
        .collect()
}

// Pages arrive newest first, and rank runs only from the collected pages.
fn collected(
    bytes: &[u8],
    case: &Case<'_>,
    filters: &[Filter],
    statistics: Option<&CorpusStatistics>,
) -> Result<Scored, String> {
    let (header, base) = parse_header(bytes)?;
    let plan = plan_for(&header, case, filters, statistics)?;
    let mut collector = PageCollector::new(&plan, plan.bytes())?;
    let mut source = Counting::new(bytes, base);
    for range in plan.ranges().iter().rev() {
        let page = source.page(range)?;
        collector.accept(range, page)?;
    }
    let mut pages = collector.finish()?;
    let hits = rank_from_pages(
        &header,
        &mut pages,
        &case.query(filters, statistics),
        &FieldBudget::UNBOUNDED,
    )?;
    Ok(scored(hits))
}

fn global(bytes: &[u8], case: &Case<'_>) -> Result<CorpusStatistics, String> {
    local_field_statistics(bytes, case.fields, case.text, "any", &[])
}

// A transcription of the previous per-row scorer, kept independent of the
// term-at-a-time implementation: full posting maps, set based candidates and
// row-at-a-time summation in field then unique term order.
struct Reference {
    ordinal: usize,
    tokens: Vec<(String, u32)>,
    unique: Vec<String>,
    all: Vec<Rows>,
}

fn analyze(header: &Header, ordinal: usize, text: &str) -> Result<Vec<(String, u32)>, String> {
    let field = header.fields.get(ordinal).ok_or("Missing field")?;
    match field.analysis() {
        FieldAnalysis::Native => Ok(normalize_text(text)
            .split_whitespace()
            .enumerate()
            .map(|(position, term)| (term.to_owned(), u32::try_from(position).unwrap_or(u32::MAX)))
            .collect()),
        FieldAnalysis::WordV4(config) => {
            let mut analyzer = WordV4Analyzer::new(config)?;
            let mut found = Vec::new();
            analyzer.analyze_inputs(std::iter::once(text), |token| {
                found.push((
                    token.text.to_owned(),
                    u32::try_from(token.position).unwrap_or(u32::MAX),
                ));
                true
            });
            Ok(found)
        }
    }
}

fn postings(
    bytes: &[u8],
    base: usize,
    header: &Header,
    ordinal: usize,
    term: &str,
) -> Result<Rows, String> {
    let (dictionary, lane) = header.fields.dictionary(ordinal).ok_or("Missing field")?;
    let shape = header.fields.shape(ordinal);
    let mut rows = BTreeMap::new();
    let Some(metadata) = dictionary.get(term) else {
        return Ok(rows);
    };
    for block in &metadata.blocks {
        let start = base + block.data.offset as usize;
        let page = bytes
            .get(start..start + block.data.length as usize)
            .ok_or("Missing page")?;
        let decoded = decode_shaped_rows::<true, _>(page, shape, |row, first, second| {
            let selected = if lane == 0 { first } else { second };
            let entries = selected
                .values
                .iter()
                .enumerate()
                .map(|(index, position)| {
                    (*position, selected.inputs.get(index).copied().unwrap_or(0))
                })
                .collect::<Vec<_>>();
            (row, entries)
        })?;
        for (row, entries) in decoded {
            if !entries.is_empty() {
                rows.insert(row, entries);
            }
        }
    }
    Ok(rows)
}

fn bm25(tf: usize, length: u32, average: f64, df: u64, documents: u64) -> Result<f64, String> {
    let tf = u32::try_from(tf).map_err(|cause| cause.to_string())?;
    if tf == 0 || documents == 0 || df == 0 || df > documents {
        return Ok(0.0);
    }
    let (count, df) = (count_as_f64(documents), count_as_f64(df));
    let idf = ((count - df + 0.5) / (df + 0.5)).ln_1p();
    let mean = if average > 0.0 { average } else { 1.0 };
    let saturated = f64::from(tf) / ((1.0 - 0.75) + 0.75 * f64::from(length) / mean);
    Ok(idf * saturated * (1.2 + 1.0) / (saturated + 1.2))
}

fn phrase_matches(field: &Reference, eligible: &[Rows], row: u32) -> bool {
    let Some((origin_term, origin)) = field.tokens.first() else {
        return false;
    };
    let lookup = |term: &str| {
        field
            .unique
            .iter()
            .position(|candidate| candidate == term)
            .and_then(|index| eligible[index].get(&row))
    };
    let Some(starts) = lookup(origin_term) else {
        return false;
    };
    starts.iter().any(|(start, input)| {
        field.tokens.iter().all(|(term, position)| {
            let wanted = start + (position - origin);
            lookup(term).is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.0 == wanted && entry.1 == *input)
            })
        })
    })
}

fn candidates(mode: &str, fields: &[Reference], eligible: &[Vec<Rows>]) -> BTreeSet<u32> {
    let union = |term: &str| -> BTreeSet<u32> {
        fields
            .iter()
            .zip(eligible)
            .filter_map(|(field, rows)| {
                field
                    .unique
                    .iter()
                    .position(|candidate| candidate == term)
                    .map(|index| &rows[index])
            })
            .flat_map(|rows| rows.keys().copied())
            .collect()
    };
    match mode {
        "phrase" => fields
            .iter()
            .zip(eligible)
            .flat_map(|(field, rows)| {
                let starts = field
                    .tokens
                    .first()
                    .and_then(|(term, _)| field.unique.iter().position(|c| c == term))
                    .map(|index| rows[index].keys().copied().collect::<Vec<_>>())
                    .unwrap_or_default();
                starts
                    .into_iter()
                    .filter(|row| phrase_matches(field, rows, *row))
                    .collect::<Vec<_>>()
            })
            .collect(),
        "all" => {
            let terms = fields
                .iter()
                .flat_map(|field| field.unique.iter().map(String::as_str))
                .collect::<BTreeSet<_>>();
            let mut required: Option<BTreeSet<u32>> = None;
            for term in terms {
                let present = union(term);
                required = Some(match required {
                    Some(current) => current.intersection(&present).copied().collect(),
                    None => present,
                });
            }
            required.unwrap_or_default()
        }
        _ => eligible
            .iter()
            .flat_map(|terms| terms.iter().flat_map(|rows| rows.keys().copied()))
            .collect(),
    }
}

fn load_reference(
    bytes: &[u8],
    base: usize,
    header: &Header,
    case: &Case<'_>,
) -> Result<Vec<Reference>, String> {
    let mut fields = Vec::new();
    for id in case.fields {
        let ordinal = header.fields.ordinal(id).ok_or("Unknown field")?;
        let tokens = analyze(header, ordinal, case.text)?;
        let mut unique: Vec<String> = Vec::new();
        for (term, _) in &tokens {
            if !unique.contains(term) {
                unique.push(term.clone());
            }
        }
        let all = unique
            .iter()
            .map(|term| postings(bytes, base, header, ordinal, term))
            .collect::<Result<Vec<_>, _>>()?;
        fields.push(Reference {
            ordinal,
            tokens,
            unique,
            all,
        });
    }
    Ok(fields)
}

fn eligible_postings(fields: &[Reference], eligible_row: &dyn Fn(u32) -> bool) -> Vec<Vec<Rows>> {
    fields
        .iter()
        .map(|field| {
            field
                .all
                .iter()
                .map(|rows| {
                    rows.iter()
                        .filter(|(row, _)| eligible_row(**row))
                        .map(|(row, entries)| (*row, entries.clone()))
                        .collect::<Rows>()
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

struct Corpus<'a> {
    header: &'a Header,
    documents: u64,
    given: Option<&'a CorpusStatistics>,
}

fn reference_score(
    corpus: &Corpus<'_>,
    case: &Case<'_>,
    fields: &[Reference],
    eligible: &[Vec<Rows>],
    row: u32,
) -> Result<f64, String> {
    let mut score = 0.0;
    for (index, field) in fields.iter().enumerate() {
        let id = &case.fields[index];
        let given = corpus
            .given
            .and_then(|statistics| statistics.fields.iter().find(|stat| &stat.id == id));
        let tokens_total = given.map_or_else(
            || corpus.header.fields.total(field.ordinal),
            |stat| stat.tokens,
        );
        let average = count_as_f64(tokens_total) / count_as_f64(corpus.documents);
        let length = corpus
            .header
            .documents
            .field_length(field.ordinal, row as usize);
        for (term_index, (term, rows_for_term)) in field.unique.iter().zip(&field.all).enumerate() {
            let local = u64::try_from(rows_for_term.len()).map_err(|cause| cause.to_string())?;
            let df = given
                .and_then(|stat| stat.frequencies.get(term).copied())
                .unwrap_or(local);
            let tf = eligible[index][term_index].get(&row).map_or(0, Vec::len);
            score += bm25(tf, length, average, df, corpus.documents)?;
        }
    }
    Ok(score)
}

fn reference(
    bytes: &[u8],
    case: &Case<'_>,
    eligible_row: &dyn Fn(u32) -> bool,
    given: Option<&CorpusStatistics>,
) -> Result<Scored, String> {
    let (header, base) = parse_header(bytes)?;
    let rows = u64::try_from(header.documents.len()).map_err(|cause| cause.to_string())?;
    let fields = load_reference(bytes, base, &header, case)?;
    if fields.iter().all(|field| field.tokens.is_empty()) {
        return Ok(Vec::new());
    }
    let eligible = eligible_postings(&fields, eligible_row);
    let corpus = Corpus {
        header: &header,
        documents: given.map_or(rows, |statistics| statistics.documents),
        given,
    };
    let mut hits = Vec::new();
    for row in candidates(case.mode, &fields, &eligible) {
        let score = reference_score(&corpus, case, &fields, &eligible, row)?;
        if score > 0.0 {
            hits.push((row, score));
        }
    }
    hits.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    hits.truncate(case.top_k);
    Ok(hits
        .into_iter()
        .map(|(row, score)| (row, score.to_bits()))
        .collect())
}

const QUERIES: [&str; 6] = [
    "fox",
    "red fox",
    "dog red quick",
    "red the fox",
    "fox fox red",
    "absent fox",
];

#[test]
fn page_scorer_matches_the_reference_scorer_bit_for_bit_across_block_boundaries()
-> Result<(), String> {
    for count in [127_u32, 128, 129, 300] {
        let bytes = segment(count)?;
        for fields in field_sets() {
            for text in QUERIES {
                for mode in ["any", "all", "phrase"] {
                    for top_k in [3, 100] {
                        let case = Case {
                            fields: &fields,
                            text,
                            mode,
                            top_k,
                        };
                        let expected = reference(&bytes, &case, &|_| true, None)?;
                        assert_eq!(
                            direct(&bytes, &case, &[], None)?,
                            expected,
                            "{count} {fields:?} {text} {mode} {top_k}"
                        );
                        assert_eq!(collected(&bytes, &case, &[], None)?, expected);
                        let statistics = global(&bytes, &case)?;
                        assert_eq!(direct(&bytes, &case, &[], Some(&statistics))?, expected);
                    }
                }
            }
        }
    }
    Ok(())
}

#[test]
fn filters_limit_eligibility_but_keep_live_statistics_and_read_fewer_pages() -> Result<(), String> {
    let bytes = segment(300)?;
    let (header, _) = parse_header(&bytes)?;
    let fields = [tags()];
    let filters = early();
    for mode in ["any", "all", "phrase"] {
        let case = Case {
            fields: &fields,
            text: "fox red",
            mode,
            top_k: 100,
        };
        let expected = reference(&bytes, &case, &|row| row < 128, None)?;
        assert!(!expected.is_empty());
        assert_eq!(direct(&bytes, &case, &filters, None)?, expected);
        assert_eq!(collected(&bytes, &case, &filters, None)?, expected);
        let statistics = global(&bytes, &case)?;
        assert_eq!(
            direct(&bytes, &case, &filters, Some(&statistics))?,
            expected
        );
        for given in [None, Some(&statistics)] {
            let filtered = plan_for(&header, &case, &filters, given)?;
            let unfiltered = plan_for(&header, &case, &[], given)?;
            assert!(filtered.ranges().len() < unfiltered.ranges().len());
            assert!(
                ranges(&filtered)
                    .iter()
                    .all(|range| ranges(&unfiltered).contains(range))
            );
        }
    }
    Ok(())
}

#[test]
fn plans_are_exactly_the_posting_pages_execution_reads() -> Result<(), String> {
    let bytes = segment(300)?;
    let (header, base) = parse_header(&bytes)?;
    let known = header
        .fields
        .dictionaries()
        .flat_map(|dictionary| dictionary.values())
        .flat_map(|metadata| metadata.blocks.iter())
        .map(|block| (block.data.offset, block.data.length))
        .collect::<BTreeSet<_>>();
    let fields = field_sets();
    for set in &fields {
        for mode in ["any", "all", "phrase"] {
            for filters in [&[][..], &early()[..]] {
                let case = Case {
                    fields: set,
                    text: "red fox",
                    mode,
                    top_k: 10,
                };
                for given in [None, Some(&global(&bytes, &case)?)] {
                    let plan = plan_for(&header, &case, filters, given)?;
                    let mut pages = Counting::new(&bytes, base);
                    rank_from_pages(
                        &header,
                        &mut pages,
                        &case.query(filters, given),
                        &FieldBudget::UNBOUNDED,
                    )?;
                    assert_eq!(ranges(&plan), pages.distinct());
                    assert!(ranges(&plan).windows(2).all(|pair| pair[0] < pair[1]));
                    assert!(ranges(&plan).iter().all(|range| known.contains(range)));
                    let vectors = header
                        .vector_ranges
                        .iter()
                        .map(|range| (range.offset, range.length))
                        .collect::<BTreeSet<_>>();
                    assert!(ranges(&plan).iter().all(|range| !vectors.contains(range)));
                }
            }
        }
    }
    Ok(())
}

#[test]
fn statistics_read_no_pages_for_fully_live_named_blocks_and_read_dead_straddlers()
-> Result<(), String> {
    let bytes = segment(300)?;
    let (header, base) = parse_header(&bytes)?;
    let named = [tags()];
    let stats = |fields: &[DocumentColumnId], dead: &[u32]| -> Result<_, String> {
        let mut pages = Counting::new(&bytes, base);
        let value = statistics_from_pages(
            &header,
            &mut pages,
            fields,
            "fox red",
            "any",
            dead,
            &FieldBudget::UNBOUNDED,
        )?;
        let plan = plan_statistics_pages(
            &header,
            fields,
            "fox red",
            "any",
            dead,
            &FieldBudget::UNBOUNDED,
        )?;
        assert_eq!(ranges(&plan), pages.distinct());
        Ok((value, plan, pages.reads.len()))
    };

    let (live, plan, reads) = stats(&named, &[])?;
    assert_eq!((plan.ranges().len(), reads), (0, 0));
    assert_eq!(
        live,
        local_field_statistics(&bytes, &named, "fox red", "any", &[])?
    );
    assert_eq!(live.documents, 300);
    let (dictionary, _) = header.fields.dictionary(2).ok_or("Missing field")?;
    for (term, frequency) in &live.fields[0].frequencies {
        let metadata = dictionary.get(term).ok_or("Missing term")?;
        assert_eq!(*frequency, u64::from(metadata.df));
    }
    assert_eq!(live.fields[0].tokens, header.fields.total(2));

    let dead = [5_u32, 200];
    let (derived, plan, _) = stats(&named, &dead)?;
    let expected = ["fox", "red"]
        .into_iter()
        .filter_map(|term| dictionary.get(term))
        .flat_map(|metadata| metadata.blocks.iter())
        .filter(|block| {
            dead.iter()
                .any(|row| (block.first..=block.last).contains(row))
        })
        .map(|block| (block.data.offset, block.data.length))
        .collect::<BTreeSet<_>>();
    assert!(!expected.is_empty());
    assert_eq!(ranges(&plan), expected.into_iter().collect::<Vec<_>>());
    assert_eq!(derived.documents, 298);
    assert_eq!(
        derived,
        local_field_statistics(&bytes, &named, "fox red", "any", &dead)?
    );

    let native = [role(NativeRole::Title), role(NativeRole::Text)];
    let (joint, plan, _) = stats(&native, &[])?;
    assert!(!plan.ranges().is_empty());
    let expected_text = (0..300_u32)
        .filter(|row| row % 4 != 0 || row % 7 == 0)
        .count();
    assert_eq!(
        joint.fields[1].frequencies.get("fox").copied(),
        Some(u64::try_from(expected_text).map_err(|cause| cause.to_string())?)
    );
    let expected_title = (0..300_u32).filter(|row| row % 3 == 0).count();
    assert_eq!(
        joint.fields[0].frequencies.get("fox").copied(),
        Some(u64::try_from(expected_title).map_err(|cause| cause.to_string())?)
    );
    Ok(())
}

#[test]
fn role_title_and_attribute_title_stay_distinct_fields() -> Result<(), String> {
    let bytes = segment(129)?;
    let role_fields = [role(NativeRole::Title)];
    let attribute_fields = [title_attribute()];
    let by_role = Case {
        fields: &role_fields,
        text: "fox",
        mode: "any",
        top_k: 100,
    };
    let by_attribute = Case {
        fields: &attribute_fields,
        ..by_role
    };
    let first = direct(&bytes, &by_role, &[], None)?;
    let second = direct(&bytes, &by_attribute, &[], None)?;
    assert_ne!(first, second);
    assert_eq!(first, reference(&bytes, &by_role, &|_| true, None)?);
    assert_eq!(second, reference(&bytes, &by_attribute, &|_| true, None)?);
    Ok(())
}

struct Failing<'a> {
    inner: Counting<'a>,
    fault: &'static str,
    scratch: Vec<u8>,
}

impl PostingPages for Failing<'_> {
    fn page(&mut self, range: &Range) -> Result<&[u8], String> {
        let start = self.inner.base + range.offset as usize;
        let length = range.length as usize;
        let bytes = self.inner.bytes;
        match self.fault {
            "missing" => Err("Provider has no such page".into()),
            "short" => bytes
                .get(start..start + length - 1)
                .ok_or_else(|| "Missing page".to_owned()),
            "shifted" => bytes
                .get(start + 1..start + 1 + length)
                .ok_or_else(|| "Missing page".to_owned()),
            _ => {
                self.scratch = bytes
                    .get(start..start + length)
                    .ok_or("Missing page")?
                    .to_vec();
                let middle = self.scratch.len() / 2;
                self.scratch[middle] ^= 0x55;
                Ok(&self.scratch)
            }
        }
    }
}

#[test]
fn unavailable_wrong_length_shifted_and_corrupt_pages_fail_closed() -> Result<(), String> {
    let bytes = segment(300)?;
    let (header, base) = parse_header(&bytes)?;
    let fields = [tags()];
    let case = Case {
        fields: &fields,
        text: "fox",
        mode: "any",
        top_k: 10,
    };
    for fault in ["missing", "short", "shifted", "flipped"] {
        let mut pages = Failing {
            inner: Counting::new(&bytes, base),
            fault,
            scratch: Vec::new(),
        };
        let result = rank_from_pages(
            &header,
            &mut pages,
            &case.query(&[], None),
            &FieldBudget::UNBOUNDED,
        );
        assert!(result.is_err(), "{fault}");
        let stats = statistics_from_pages(
            &header,
            &mut pages,
            &[role(NativeRole::Text)],
            "fox",
            "any",
            &[],
            &FieldBudget::UNBOUNDED,
        );
        assert!(stats.is_err(), "{fault}");
    }
    let mut pages = Failing {
        inner: Counting::new(&bytes, base),
        fault: "short",
        scratch: Vec::new(),
    };
    assert_eq!(
        rejection(rank_from_pages(
            &header,
            &mut pages,
            &case.query(&[], None),
            &FieldBudget::UNBOUNDED,
        ))?,
        "Posting page length mismatch"
    );
    Ok(())
}

#[test]
fn pages_must_match_their_block_directory_and_frequency_bound() -> Result<(), String> {
    let bytes = segment(300)?;
    let (mut header, base) = parse_header(&bytes)?;
    let fields = [role(NativeRole::Text)];
    let case = Case {
        fields: &fields,
        text: "fox",
        mode: "any",
        top_k: 10,
    };
    let mut broken = header.clone();
    let metadata = broken
        .fields
        .terms_mut()
        .get_mut("fox")
        .ok_or("Missing term")?;
    metadata.blocks[0].count += 1;
    let mut pages = Counting::new(&bytes, base);
    assert_eq!(
        rejection(rank_from_pages(
            &broken,
            &mut pages,
            &case.query(&[], None),
            &FieldBudget::UNBOUNDED,
        ))?,
        "Posting block does not match its directory"
    );
    let metadata = header
        .fields
        .terms_mut()
        .get_mut("fox")
        .ok_or("Missing term")?;
    metadata.blocks[0].max_tf[1] = 0;
    let mut pages = Counting::new(&bytes, base);
    assert_eq!(
        rejection(rank_from_pages(
            &header,
            &mut pages,
            &case.query(&[], None),
            &FieldBudget::UNBOUNDED,
        ))?,
        "Posting frequency exceeds its block"
    );
    Ok(())
}

#[test]
fn collectors_accept_only_planned_exact_unique_pages_within_budget() -> Result<(), String> {
    let bytes = segment(300)?;
    let (header, base) = parse_header(&bytes)?;
    let fields = [tags()];
    let case = Case {
        fields: &fields,
        text: "fox red",
        mode: "any",
        top_k: 10,
    };
    let plan = plan_for(&header, &case, &[], None)?;
    assert!(plan.ranges().len() > 1);
    assert_eq!(
        rejection(PageCollector::new(&plan, plan.bytes() - 1))?,
        "Planned pages exceed the page budget"
    );
    let mut source = Counting::new(&bytes, base);
    let mut collector = PageCollector::new(&plan, plan.bytes())?;
    let first = plan.ranges()[0].clone();
    let page = source.page(&first)?.to_vec();
    assert_eq!(
        rejection(collector.accept(
            &Range {
                offset: first.offset,
                length: first.length + 1
            },
            &page
        ))?,
        "Unplanned posting page"
    );
    assert_eq!(
        rejection(collector.accept(&first, &page[1..]))?,
        "Posting page length mismatch"
    );
    collector.accept(&first, &page)?;
    assert_eq!(
        rejection(collector.accept(&first, &page))?,
        "Duplicate posting page"
    );
    assert_eq!(
        rejection(collector.finish().map(|_| ()))?,
        "Missing posting page"
    );
    Ok(())
}

#[test]
fn budgets_reject_before_provider_reads_and_accounting_is_exact() -> Result<(), String> {
    let bytes = segment(300)?;
    let (header, base) = parse_header(&bytes)?;
    let fields = [role(NativeRole::Title), role(NativeRole::Text), tags()];
    for mode in ["any", "all", "phrase"] {
        let case = Case {
            fields: &fields,
            text: "red fox",
            mode,
            top_k: 10,
        };
        let query = case.query(&[], None);
        let mut pages = Counting::new(&bytes, base);
        let planned = plan_for(&header, &case, &[], None)?.bytes();
        assert!(planned > 1);
        let tight = FieldBudget {
            workspace_bytes: usize::MAX,
            page_bytes: planned - 1,
        };
        assert_eq!(
            rejection(rank_from_pages(&header, &mut pages, &query, &tight))?,
            "Planned pages exceed the page budget"
        );
        let tiny = FieldBudget {
            workspace_bytes: 16,
            page_bytes: u64::MAX,
        };
        assert_eq!(
            rejection(rank_from_pages(&header, &mut pages, &query, &tiny))?,
            "Workspace budget exceeded"
        );
        assert!(pages.reads.is_empty());
        let Measured {
            value,
            peak_workspace_bytes: peak,
            planned_page_bytes,
        } = rank_from_pages_measured(&header, &mut pages, &query, &FieldBudget::UNBOUNDED)?;
        assert_eq!(planned_page_bytes, planned);
        let exact = FieldBudget {
            workspace_bytes: peak,
            page_bytes: planned,
        };
        let mut pages = Counting::new(&bytes, base);
        assert_eq!(
            scored(rank_from_pages(&header, &mut pages, &query, &exact)?),
            scored(value)
        );
        let under = FieldBudget {
            workspace_bytes: peak - 1,
            page_bytes: planned,
        };
        assert_eq!(
            rejection(rank_from_pages(&header, &mut pages, &query, &under))?,
            "Workspace budget exceeded"
        );
    }
    Ok(())
}

#[test]
fn statistics_budgets_reject_before_provider_reads() -> Result<(), String> {
    let bytes = segment(300)?;
    let (header, base) = parse_header(&bytes)?;
    let fields = [role(NativeRole::Title), role(NativeRole::Text), tags()];
    let mut pages = Counting::new(&bytes, base);
    let tight = FieldBudget {
        workspace_bytes: 16,
        page_bytes: u64::MAX,
    };
    assert_eq!(
        rejection(statistics_from_pages(
            &header,
            &mut pages,
            &fields,
            "red fox",
            "any",
            &[],
            &tight
        ))?,
        "Workspace budget exceeded"
    );
    let none = FieldBudget {
        workspace_bytes: usize::MAX,
        page_bytes: 0,
    };
    assert_eq!(
        rejection(statistics_from_pages(
            &header,
            &mut pages,
            &fields,
            "red fox",
            "any",
            &[],
            &none
        ))?,
        "Planned pages exceed the page budget"
    );
    assert!(pages.reads.is_empty());
    let measured = statistics_from_pages_measured(
        &header,
        &mut pages,
        &fields,
        "red fox",
        "any",
        &[],
        &FieldBudget::UNBOUNDED,
    )?;
    assert!(measured.peak_workspace_bytes > 0);
    Ok(())
}

fn wide_segment(rows: u32, words: u32) -> Result<Vec<u8>, String> {
    let body = (0..words)
        .map(|word| format!("w{word}"))
        .collect::<Vec<_>>()
        .join(" ");
    let documents = (0..rows)
        .map(|index| {
            Document::native(
                format!("row{index:04}"),
                1,
                "title",
                body.clone(),
                BTreeMap::new(),
                None,
            )
        })
        .collect();
    Ok(build_text_fields(documents, None, &[])?.bytes)
}

#[test]
fn workspace_does_not_scale_with_rows_by_terms_postings() -> Result<(), String> {
    let bytes = wide_segment(300, 40)?;
    let (header, base) = parse_header(&bytes)?;
    let fields = [role(NativeRole::Title), role(NativeRole::Text)];
    let words = |count: u32| {
        (0..count)
            .map(|word| format!("w{word}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    for mode in ["any", "all"] {
        let peak = |count: u32| -> Result<usize, String> {
            let text = words(count);
            let case = Case {
                fields: &fields,
                text: &text,
                mode,
                top_k: 10,
            };
            let mut pages = Counting::new(&bytes, base);
            let measured = rank_from_pages_measured(
                &header,
                &mut pages,
                &case.query(&[], None),
                &FieldBudget::UNBOUNDED,
            )?;
            assert_eq!(measured.value.len(), 10);
            Ok(measured.peak_workspace_bytes)
        };
        let (few, many) = (peak(5)?, peak(40)?);
        let matrix = 300 * 35 * size_of::<(u32, u32)>();
        assert!(many - few < matrix / 4, "{mode}: {few} -> {many}");
    }
    Ok(())
}

#[test]
fn workspace_accounting_is_checked_and_growth_is_charged_before_allocation() -> Result<(), String> {
    let mut workspace = Workspace::new(100);
    workspace.reserve(60)?;
    assert_eq!(
        rejection(workspace.reserve(41))?,
        "Workspace budget exceeded"
    );
    workspace.release(30);
    workspace.reserve(70)?;
    assert_eq!(workspace.peak(), 100);
    let mut vector: Vec<u64> = Vec::new();
    let mut small = Workspace::new(63);
    assert_eq!(
        rejection(small.grow(&mut vector))?,
        "Workspace budget exceeded"
    );
    assert_eq!(vector.capacity(), 0);
    let mut roomy = Workspace::new(1024);
    roomy.grow(&mut vector)?;
    assert!(vector.capacity() >= 8);
    let charged = roomy.peak();
    for value in 0..8_u64 {
        roomy.grow(&mut vector)?;
        vector.push(value);
    }
    assert_eq!(roomy.peak(), charged);
    Ok(())
}

#[test]
fn aggregated_statistics_are_exact_checked_and_order_independent() -> Result<(), String> {
    let documents = corpus(90);
    let build = |range: std::ops::Range<usize>| -> Result<Vec<u8>, String> {
        Ok(build_text_fields(
            documents[range].to_vec(),
            None,
            &[NamedTextField::new("tags"), NamedTextField::new("title")],
        )?
        .bytes)
    };
    let whole = build(0..90)?;
    let fields = [tags(), role(NativeRole::Text), role(NativeRole::Title)];
    let expected = local_field_statistics(&whole, &fields, "red fox absent", "any", &[])?;
    let parts = [0..13, 13..60, 60..90]
        .into_iter()
        .map(|range| {
            let bytes = build(range)?;
            local_field_statistics(&bytes, &fields, "red fox absent", "any", &[])
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut canonical = expected.clone();
    canonical.fields.sort_by_key(|field| match &field.id {
        DocumentColumnId::Role(NativeRole::Title) => (0, String::new()),
        DocumentColumnId::Role(NativeRole::Text) => (1, String::new()),
        DocumentColumnId::Role(NativeRole::Vector) => (3, String::new()),
        DocumentColumnId::Attribute(name) => (2, name.clone()),
    });
    assert_eq!(aggregate_statistics(&parts)?, canonical);
    let mut reordered = parts.clone();
    reordered.reverse();
    reordered[0].fields.reverse();
    assert_eq!(aggregate_statistics(&reordered)?, canonical);
    assert_eq!(aggregate_statistics(&parts[..1])?.documents, 13);

    assert_eq!(
        rejection(aggregate_statistics(&[]))?,
        "Statistics parts are required"
    );
    let mut duplicate = parts.clone();
    duplicate[1].fields.push(duplicate[1].fields[0].clone());
    assert_eq!(
        rejection(aggregate_statistics(&duplicate))?,
        "Duplicate statistics field"
    );
    let mut missing = parts.clone();
    missing[1].fields.pop();
    assert_eq!(
        rejection(aggregate_statistics(&missing))?,
        "Statistics do not match the selected text fields"
    );
    let mut terms = parts.clone();
    terms[2].fields[0].frequencies.insert("extra".into(), 0);
    assert_eq!(
        rejection(aggregate_statistics(&terms))?,
        "Statistics terms do not match the query"
    );
    let mut renamed = parts.clone();
    renamed[1].fields[0].id = DocumentColumnId::attribute("other");
    assert_eq!(
        rejection(aggregate_statistics(&renamed))?,
        "Statistics do not match the selected text fields"
    );
    let huge = |documents: u64, tokens: u64, frequency: u64| CorpusStatistics {
        documents,
        fields: vec![FieldStatistics {
            id: tags(),
            tokens,
            frequencies: BTreeMap::from([("fox".to_owned(), frequency)]),
        }],
    };
    assert_eq!(
        rejection(aggregate_statistics(&[huge(u64::MAX, 0, 0), huge(1, 0, 0)]))?,
        "Statistics document count overflow"
    );
    assert_eq!(
        rejection(aggregate_statistics(&[huge(1, u64::MAX, 0), huge(1, 1, 0)]))?,
        "Statistics token count overflow"
    );
    assert_eq!(
        aggregate_statistics(&[huge(5, 0, 5), huge(5, 0, 5)])?.fields[0]
            .frequencies
            .get("fox"),
        Some(&10)
    );
    assert_eq!(
        rejection(aggregate_statistics(&[huge(3, 0, 4)]))?,
        "Term document frequency exceeds the document count"
    );
    Ok(())
}

#[test]
fn planning_rejects_dense_ranking_state_before_collecting_pages() -> Result<(), String> {
    let bytes = segment(1_000)?;
    let (header, _) = parse_header(&bytes)?;
    let fields = [tags()];
    for mode in ["any", "all", "phrase"] {
        let case = Case {
            fields: &fields,
            text: "red fox",
            mode,
            top_k: 10,
        };
        let budget = FieldBudget {
            workspace_bytes: 4_096,
            page_bytes: u64::MAX,
        };
        assert_eq!(
            rejection(plan_rank_pages(&header, &case.query(&[], None), &budget))?,
            "Workspace budget exceeded"
        );
        assert!(
            !plan_rank_pages(&header, &case.query(&[], None), &FieldBudget::UNBOUNDED)?
                .ranges()
                .is_empty()
        );
    }
    Ok(())
}
