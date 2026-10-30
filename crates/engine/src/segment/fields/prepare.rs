use super::super::{DocumentColumnId, Header, NativeRole, count_as_f64};
use super::query::{FieldPlan, plan_field};
use super::scan::plan_ranges;
use super::source::{PagePlan, Workspace};
use super::{
    Bm25Parameters, CorpusStatistics, FIELD_LIMIT, FieldQuery, FieldStatistics, FieldTable,
    NATIVE_FIELDS, STATISTICS_MISMATCH, STATISTICS_TERMS,
};
use bit_vec::BitVec;
use std::collections::BTreeSet;

pub(super) struct Live {
    pub(super) mask: BitVec,
    tombstoned: bool,
    pub(super) rows: u64,
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

pub(super) fn check_budget(mode: &str, top_k: usize) -> Result<(), String> {
    if top_k == 0 || top_k > 100 {
        return Err("Invalid search budget".into());
    }
    if mode != "any" && mode != "all" && mode != "phrase" {
        return Err("Unknown match mode".into());
    }
    Ok(())
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

fn plan_fields(
    header: &Header,
    ordinals: &[usize],
    text: &str,
    mode: &str,
    workspace: &mut Workspace,
) -> Result<Vec<FieldPlan>, String> {
    workspace.reserve_items::<FieldPlan>(ordinals.len())?;
    ordinals
        .iter()
        .map(|ordinal| plan_field(header, *ordinal, text, mode, workspace))
        .collect()
}

#[doc = "Everything an operation derives from the header and query before any"]
#[doc = "posting page is read: selected fields, analyzed terms, eligibility and live"]
#[doc = "masks, and per-field live token totals."]
pub(super) struct Prepared<'h> {
    pub(super) header: &'h Header,
    pub(super) fields: Vec<FieldPlan>,
    pub(super) allowed: BitVec,
    pub(super) live: Live,
    count_live: bool,
    pub(super) tokens: Vec<u64>,
}

impl<'h> Prepared<'h> {
    pub(super) fn for_rank(
        header: &'h Header,
        query: &FieldQuery<'_>,
        workspace: &mut Workspace,
    ) -> Result<Self, String> {
        let ordinals = select_ordinals(&header.fields, query.fields)?;
        let rows = header.documents.len();
        workspace.reserve_bits(rows)?;
        workspace.reserve_bits(rows)?;
        let allowed = header.allowed(query.filters, query.dead)?;
        check_budget(query.mode, query.top_k)?;
        let mask = if query.filters.is_empty() {
            allowed.clone()
        } else {
            header.allowed(&[], query.dead)?
        };
        let fields = plan_fields(header, &ordinals, query.text, query.mode, workspace)?;
        Self::assemble(
            header,
            fields,
            (allowed, mask),
            (!query.dead.is_empty(), query.statistics.is_none()),
            workspace,
        )
    }

    pub(super) fn for_statistics(
        header: &'h Header,
        fields: &[DocumentColumnId],
        query: (&str, &str, &[u32]),
        workspace: &mut Workspace,
    ) -> Result<Self, String> {
        let (text, mode, dead) = query;
        let ordinals = select_ordinals(&header.fields, fields)?;
        let rows = header.documents.len();
        workspace.reserve_bits(rows)?;
        workspace.reserve_bits(rows)?;
        let mask = header.allowed(&[], dead)?;
        check_budget(mode, 1)?;
        let nothing = BitVec::from_elem(mask.len(), false);
        let planned = plan_fields(header, &ordinals, text, mode, workspace)?;
        Self::assemble(
            header,
            planned,
            (nothing, mask),
            (!dead.is_empty(), true),
            workspace,
        )
    }

    fn assemble(
        header: &'h Header,
        fields: Vec<FieldPlan>,
        masks: (BitVec, BitVec),
        flags: (bool, bool),
        workspace: &mut Workspace,
    ) -> Result<Self, String> {
        let (allowed, mask) = masks;
        let (tombstoned, count_live) = flags;
        let live = Live::new(mask, tombstoned)?;
        workspace.reserve_items::<u64>(fields.len())?;
        let tokens = fields
            .iter()
            .map(|field| live.tokens(header, field.ordinal))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            header,
            fields,
            allowed,
            live,
            count_live,
            tokens,
        })
    }

    // Live rows are counted for document frequency only when no statistics
    // were supplied, or when the operation is itself the statistics pass.
    pub(super) fn live_mask(&self) -> Option<&BitVec> {
        self.count_live.then_some(&self.live.mask)
    }

    pub(super) fn plan(&self, workspace: &mut Workspace) -> Result<PagePlan, String> {
        let ranges = plan_ranges(
            self.header,
            &self.fields,
            &self.allowed,
            self.live_mask(),
            workspace,
        )?;
        PagePlan::from_ranges(ranges)
    }

    // Plans the reads and rejects them against the page budget. The plan's
    // ranges stay charged to the workspace, which keeps the peak conservative.
    pub(super) fn reserve_pages(
        &self,
        page_bytes: u64,
        workspace: &mut Workspace,
    ) -> Result<u64, String> {
        let plan = self.plan(workspace)?;
        plan.within(page_bytes)?;
        Ok(plan.bytes())
    }
}

fn average_length(tokens: u64, documents: u64) -> f64 {
    if documents == 0 {
        0.0
    } else {
        count_as_f64(tokens) / count_as_f64(documents)
    }
}

pub(super) struct Scoring {
    documents: u64,
    count: f64,
    parameters: Bm25Parameters,
    pub(super) averages: Vec<f64>,
    // Given document frequencies per field and unique term, in term order.
    pub(super) explicit: Option<Vec<Vec<u64>>>,
}

impl Scoring {
    fn new(
        documents: u64,
        parameters: Bm25Parameters,
        averages: Vec<f64>,
        explicit: Option<Vec<Vec<u64>>>,
    ) -> Self {
        Self {
            documents,
            count: count_as_f64(documents),
            parameters,
            averages,
            explicit,
        }
    }

    pub(super) fn term(&self, tf: u32, length: u32, average: f64, df: u64) -> f64 {
        if tf == 0 || self.documents == 0 || df == 0 || df > self.documents {
            return 0.0;
        }
        let df = count_as_f64(df);
        let idf = ((self.count - df + 0.5) / (df + 0.5)).ln_1p();
        let saturated = self.parameters.saturate(tf, length, average);
        let k1 = self.parameters.k1;
        idf * saturated * (k1 + 1.0) / (saturated + k1)
    }

    pub(super) fn build(
        prepared: &Prepared<'_>,
        query: &FieldQuery<'_>,
        workspace: &mut Workspace,
    ) -> Result<Self, String> {
        let given = query
            .statistics
            .map(|statistics| match_statistics(statistics, prepared.header, &prepared.fields))
            .transpose()?;
        workspace.reserve_items::<f64>(prepared.fields.len())?;
        if let (Some(statistics), Some(matched)) = (query.statistics, given.as_deref()) {
            return Self::from_statistics(prepared, (statistics, matched), query.bm25, workspace);
        }
        let averages = prepared
            .tokens
            .iter()
            .map(|tokens| average_length(*tokens, prepared.live.rows))
            .collect();
        Ok(Self::new(prepared.live.rows, query.bm25, averages, None))
    }

    fn from_statistics(
        prepared: &Prepared<'_>,
        supplied: (&CorpusStatistics, &[&FieldStatistics]),
        parameters: Bm25Parameters,
        workspace: &mut Workspace,
    ) -> Result<Self, String> {
        let (statistics, matched) = supplied;
        if statistics.documents < prepared.live.rows {
            return Err("Document total is below the live local rows".into());
        }
        workspace.reserve_items::<Vec<u64>>(prepared.fields.len())?;
        let mut averages = Vec::with_capacity(prepared.fields.len());
        let mut frequencies = Vec::with_capacity(prepared.fields.len());
        for ((field, given), live_tokens) in
            prepared.fields.iter().zip(matched).zip(&prepared.tokens)
        {
            if given.tokens < *live_tokens {
                return Err("Field token total is below local rows".into());
            }
            workspace.reserve_items::<u64>(field.unique.len())?;
            let mut terms = Vec::with_capacity(field.unique.len());
            for term in &field.unique {
                terms.push(
                    given
                        .frequencies
                        .get(term)
                        .copied()
                        .ok_or(STATISTICS_TERMS)?,
                );
            }
            averages.push(average_length(given.tokens, statistics.documents));
            frequencies.push(terms);
        }
        Ok(Self::new(
            statistics.documents,
            parameters,
            averages,
            Some(frequencies),
        ))
    }
}

fn match_statistics<'s>(
    statistics: &'s CorpusStatistics,
    header: &Header,
    fields: &[FieldPlan],
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
    if statistics.fields.len() != fields.len() {
        return Err(STATISTICS_MISMATCH.into());
    }
    let mut matched = Vec::with_capacity(fields.len());
    for field in fields {
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
