use super::super::{DocumentColumnId, Header, NativeRole};
use super::prepare::Prepared;
use super::scan::{BlockRow, Scan};
use super::source::{FieldBudget, Measured, PagePlan, PostingPages, SlicePages, Workspace};
use super::{
    CorpusStatistics, FIELD_LIMIT, FieldStatistics, NATIVE_FIELDS, STATISTICS_MISMATCH,
    STATISTICS_TERMS,
};
use std::collections::BTreeMap;

// Upper-bound estimate for one `BTreeMap<String, u64>` entry beyond the key's
// heap bytes: the key header, the value and node slack.
const STATISTIC_ENTRY_BYTES: usize = size_of::<String>() + size_of::<u64>() + 16;

fn field_statistics(
    prepared: &Prepared<'_>,
    pages: &mut dyn PostingPages,
    index: usize,
    workspace: &mut Workspace,
) -> Result<FieldStatistics, String> {
    let field = &prepared.fields[index];
    let meta = prepared
        .header
        .fields
        .get(field.ordinal)
        .ok_or("Missing text field")?;
    if let DocumentColumnId::Attribute(name) = meta.id() {
        workspace.reserve(name.len())?;
    }
    let mut frequencies = BTreeMap::new();
    for term in &field.unique {
        workspace.reserve(term.len() + STATISTIC_ENTRY_BYTES)?;
        let mut scan = Scan {
            header: prepared.header,
            pages: &mut *pages,
            workspace: &mut *workspace,
            allowed: &prepared.allowed,
            live: prepared.live_mask(),
        };
        let frequency = scan.term(
            field.ordinal,
            term,
            false,
            &mut |_: &mut Workspace, _: &mut BlockRow| Ok(()),
        )?;
        frequencies.insert(term.clone(), u64::from(frequency));
    }
    Ok(FieldStatistics {
        id: meta.id().clone(),
        tokens: prepared.tokens[index],
        frequencies,
    })
}

#[doc = "Computes this segment's live corpus statistics from posting pages."]
#[doc = ""]
#[doc = "Statistics take no filters. Every live row counts: tombstones remove rows,"]
#[doc = "filters never do. Fully live single-lane blocks contribute their directory"]
#[doc = "count without a read; tombstone-touched blocks and native joint-lane"]
#[doc = "blocks are read."]
#[doc = ""]
#[doc = "# Errors"]
#[doc = "Rejects everything `local_field_statistics` rejects, plus planned pages above"]
#[doc = "`budget.page_bytes`, workspace use above `budget.workspace_bytes`, and"]
#[doc = "unavailable, wrong-length or mismatching pages."]
pub fn statistics_from_pages(
    header: &Header,
    pages: &mut dyn PostingPages,
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    dead: &[u32],
    budget: &FieldBudget,
) -> Result<CorpusStatistics, String> {
    statistics_from_pages_measured(header, pages, fields, text, mode, dead, budget)
        .map(|measured| measured.value)
}

#[doc = "As `statistics_from_pages`, also reporting the accounted workspace peak and"]
#[doc = "the planned page bytes."]
#[doc = ""]
#[doc = "# Errors"]
#[doc = "Same as `statistics_from_pages`."]
pub fn statistics_from_pages_measured(
    header: &Header,
    pages: &mut dyn PostingPages,
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    dead: &[u32],
    budget: &FieldBudget,
) -> Result<Measured<CorpusStatistics>, String> {
    let mut workspace = Workspace::new(budget.workspace_bytes);
    let prepared = Prepared::for_statistics(header, fields, (text, mode, dead), &mut workspace)?;
    let planned = prepared.reserve_pages(budget.page_bytes, &mut workspace)?;
    workspace.reserve_items::<FieldStatistics>(prepared.fields.len())?;
    let mut statistics = Vec::with_capacity(prepared.fields.len());
    for index in 0..prepared.fields.len() {
        statistics.push(field_statistics(
            &prepared,
            &mut *pages,
            index,
            &mut workspace,
        )?);
    }
    Ok(Measured {
        value: CorpusStatistics {
            documents: prepared.live.rows,
            fields: statistics,
        },
        peak_workspace_bytes: workspace.peak(),
        planned_page_bytes: planned,
    })
}

#[doc = "The ascending, de-duplicated posting ranges `statistics_from_pages` will read."]
#[doc = ""]
#[doc = "# Errors"]
#[doc = "Rejects what `statistics_from_pages` rejects before reading pages."]
pub fn plan_statistics_pages(
    header: &Header,
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    dead: &[u32],
    budget: &FieldBudget,
) -> Result<PagePlan, String> {
    let mut workspace = Workspace::new(budget.workspace_bytes);
    let prepared = Prepared::for_statistics(header, fields, (text, mode, dead), &mut workspace)?;
    let plan = prepared.plan(&mut workspace)?;
    plan.within(budget.page_bytes)?;
    Ok(plan)
}

// Adapter over complete segment bytes with `FieldBudget::UNBOUNDED`.
pub(in crate::segment) fn local_statistics(
    header: &Header,
    bytes: &[u8],
    base: usize,
    fields: &[DocumentColumnId],
    text: &str,
    mode: &str,
    dead: &[u32],
) -> Result<CorpusStatistics, String> {
    statistics_from_pages(
        header,
        &mut SlicePages::new(bytes, base),
        fields,
        text,
        mode,
        dead,
        &FieldBudget::UNBOUNDED,
    )
}

fn column_key(id: &DocumentColumnId) -> (u8, &str) {
    match id {
        DocumentColumnId::Role(NativeRole::Title) => (0, ""),
        DocumentColumnId::Role(NativeRole::Text) => (1, ""),
        DocumentColumnId::Attribute(name) => (2, name.as_str()),
        DocumentColumnId::Role(NativeRole::Vector) => (3, ""),
    }
}

fn check_part(part: &CorpusStatistics) -> Result<(), String> {
    if part.fields.len() > FIELD_LIMIT + NATIVE_FIELDS {
        return Err("Named text fields exceed 64".into());
    }
    for (index, field) in part.fields.iter().enumerate() {
        if part.fields[..index]
            .iter()
            .any(|earlier| earlier.id == field.id)
        {
            return Err("Duplicate statistics field".into());
        }
        if field
            .frequencies
            .values()
            .any(|frequency| *frequency > part.documents)
        {
            return Err("Term document frequency exceeds the document count".into());
        }
    }
    Ok(())
}

fn add_part(total: &mut CorpusStatistics, part: &CorpusStatistics) -> Result<(), String> {
    if total.fields.len() != part.fields.len() {
        return Err(STATISTICS_MISMATCH.into());
    }
    total.documents = total
        .documents
        .checked_add(part.documents)
        .ok_or("Statistics document count overflow")?;
    for field in &part.fields {
        let target = total
            .fields
            .iter_mut()
            .find(|candidate| candidate.id == field.id)
            .ok_or(STATISTICS_MISMATCH)?;
        if target.frequencies.len() != field.frequencies.len()
            || field
                .frequencies
                .keys()
                .any(|term| !target.frequencies.contains_key(term))
        {
            return Err(STATISTICS_TERMS.into());
        }
        target.tokens = target
            .tokens
            .checked_add(field.tokens)
            .ok_or("Statistics token count overflow")?;
        for (term, frequency) in &field.frequencies {
            let slot = target.frequencies.get_mut(term).ok_or(STATISTICS_TERMS)?;
            *slot = slot
                .checked_add(*frequency)
                .ok_or("Statistics frequency overflow")?;
        }
    }
    Ok(())
}

#[doc = "Sums per-segment live statistics into the corpus statistics of their union."]
#[doc = ""]
#[doc = "Each part must come from disjoint live rows, computed for the same fields and"]
#[doc = "the same analyzed query terms, and unfiltered. Fields are matched by exact"]
#[doc = "identity, so the order of fields inside a part is irrelevant, and all sums"]
#[doc = "are checked `u64` additions. The result lists fields in a canonical order"]
#[doc = "(title, text, then attributes by name), so it is independent of part order."]
#[doc = "Native `u64` bounds are retained; any narrower transport bound belongs to the"]
#[doc = "caller."]
#[doc = ""]
#[doc = "# Errors"]
#[doc = "Rejects an empty list, duplicate field identities, mismatching field sets or"]
#[doc = "term sets, document frequencies above the document count, and overflow."]
pub fn aggregate_statistics(parts: &[CorpusStatistics]) -> Result<CorpusStatistics, String> {
    let (first, rest) = parts.split_first().ok_or("Statistics parts are required")?;
    check_part(first)?;
    let mut total = first.clone();
    for part in rest {
        check_part(part)?;
        add_part(&mut total, part)?;
    }
    check_part(&total)?;
    total
        .fields
        .sort_by(|left, right| column_key(&left.id).cmp(&column_key(&right.id)));
    Ok(total)
}
