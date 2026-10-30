use super::super::{Header, Hit, offer_hit};
use super::FieldQuery;
use super::matching::Matching;
use super::prepare::{Prepared, Scoring};
use super::scan::{BlockRow, Scan};
use super::source::{FieldBudget, Measured, PagePlan, PostingPages, SlicePages, Workspace};
use std::collections::BinaryHeap;

// Scores accumulate term at a time, in field order and then unique query term
// order, so every row receives its additions in the same order as the
// original per-row scorer and its scores stay bit-identical.
struct Run<'a, 'h> {
    prepared: &'a Prepared<'h>,
    scoring: &'a Scoring,
    pages: &'a mut dyn PostingPages,
    workspace: &'a mut Workspace,
    matching: Matching,
    scores: Vec<f64>,
    entries: Vec<(u32, u32)>,
}

impl Run<'_, '_> {
    fn field(&mut self, index: usize) -> Result<(), String> {
        let terms = self.prepared.fields[index].unique.len();
        for term in 0..terms {
            self.term(index, term)?;
        }
        self.matching.end_field(self.workspace);
        Ok(())
    }

    fn term(&mut self, field_index: usize, term_index: usize) -> Result<(), String> {
        let prepared = self.prepared;
        let field = &prepared.fields[field_index];
        let term = field.unique[term_index].as_str();
        self.entries.clear();
        let positional = self.matching.positional();
        let live_frequency = {
            let mut scan = Scan {
                header: prepared.header,
                pages: &mut *self.pages,
                workspace: &mut *self.workspace,
                allowed: &prepared.allowed,
                live: prepared.live_mask(),
            };
            let entries = &mut self.entries;
            let matching = &mut self.matching;
            scan.term(
                field.ordinal,
                term,
                positional,
                &mut |workspace: &mut Workspace, row: &mut BlockRow| {
                    workspace.grow(entries)?;
                    entries.push((row.row, row.count));
                    matching.observe(workspace, field, term_index, row)
                },
            )?
        };
        let frequency = self.frequency(field_index, term_index, live_frequency)?;
        self.accumulate(field_index, frequency);
        self.matching
            .settle(self.workspace, (field_index, term_index), &self.entries);
        Ok(())
    }

    fn frequency(&self, field: usize, term: usize, live: u32) -> Result<u64, String> {
        let Some(given) = &self.scoring.explicit else {
            return Ok(u64::from(live));
        };
        let frequency = given[field][term];
        let eligible = u64::try_from(self.entries.len()).map_err(|cause| cause.to_string())?;
        if frequency < eligible {
            return Err("Term frequency is below local postings".into());
        }
        Ok(frequency)
    }

    fn accumulate(&mut self, field: usize, frequency: u64) {
        let ordinal = self.prepared.fields[field].ordinal;
        let average = self.scoring.averages[field];
        for (row, tf) in &self.entries {
            let index = *row as usize;
            let length = self.prepared.header.documents.field_length(ordinal, index);
            self.scores[index] += self.scoring.term(*tf, length, average, frequency);
        }
    }

    fn hits(&self, top_k: usize) -> Result<Vec<Hit>, String> {
        let mut heap = BinaryHeap::with_capacity(top_k);
        for (index, score) in self.scores.iter().enumerate() {
            if !self.matching.is_candidate(index) {
                continue;
            }
            if !score.is_finite() {
                return Err("Text score is not finite".into());
            }
            if *score > 0.0 {
                let row = u32::try_from(index).map_err(|cause| cause.to_string())?;
                offer_hit(&mut heap, top_k, Hit { row, score: *score });
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
}

fn execute(
    prepared: &Prepared<'_>,
    scoring: &Scoring,
    query: &FieldQuery<'_>,
    pages: &mut dyn PostingPages,
    workspace: &mut Workspace,
) -> Result<Vec<Hit>, String> {
    if prepared.fields.iter().all(|field| field.unique.is_empty()) {
        return Ok(Vec::new());
    }
    let rows = prepared.header.documents.len();
    workspace.reserve_items::<f64>(rows)?;
    workspace.reserve_items::<Hit>(query.top_k)?;
    let matching = Matching::new(query.mode, &prepared.fields, rows, workspace)?;
    let mut run = Run {
        prepared,
        scoring,
        pages,
        workspace,
        matching,
        scores: vec![0.0; rows],
        entries: Vec::new(),
    };
    for index in 0..prepared.fields.len() {
        run.field(index)?;
    }
    run.hits(query.top_k)
}

#[doc = "Ranks from posting pages supplied by `pages`, under caller budgets."]
#[doc = ""]
#[doc = "This is the one production field scorer; the full-bytes adapters call it."]
#[doc = "Document frequencies are counted over live rows, never only eligible ones,"]
#[doc = "unless `query.statistics` supplies them."]
#[doc = ""]
#[doc = "# Errors"]
#[doc = "Rejects everything `rank_fields_with` rejects, plus planned pages above"]
#[doc = "`budget.page_bytes` (before any page is requested), engine allocations above"]
#[doc = "the accounted `budget.workspace_bytes` estimates (before allocation), unavailable or wrong-length"]
#[doc = "pages, and pages that do not match their block directory."]
pub fn rank_from_pages(
    header: &Header,
    pages: &mut dyn PostingPages,
    query: &FieldQuery<'_>,
    budget: &FieldBudget,
) -> Result<Vec<Hit>, String> {
    rank_from_pages_measured(header, pages, query, budget).map(|measured| measured.value)
}

#[doc = "As `rank_from_pages`, also reporting the accounted workspace peak and the"]
#[doc = "planned page bytes."]
#[doc = ""]
#[doc = "# Errors"]
#[doc = "Same as `rank_from_pages`."]
pub fn rank_from_pages_measured(
    header: &Header,
    pages: &mut dyn PostingPages,
    query: &FieldQuery<'_>,
    budget: &FieldBudget,
) -> Result<Measured<Vec<Hit>>, String> {
    let mut workspace = Workspace::new(budget.workspace_bytes);
    let prepared = Prepared::for_rank(header, query, &mut workspace)?;
    let scoring = Scoring::build(&prepared, query, &mut workspace)?;
    let planned = prepared.reserve_pages(budget.page_bytes, &mut workspace)?;
    let hits = execute(&prepared, &scoring, query, pages, &mut workspace)?;
    Ok(Measured {
        value: hits,
        peak_workspace_bytes: workspace.peak(),
        planned_page_bytes: planned,
    })
}

#[doc = "The ascending, de-duplicated posting ranges `rank_from_pages` will read."]
#[doc = ""]
#[doc = "Uses the same masks and the same skip, count-only or read decision as"]
#[doc = "execution, and validates the query and statistics identically. Only"]
#[doc = "posting pages of the analyzed query terms are planned; documents and"]
#[doc = "vectors are never read."]
#[doc = ""]
#[doc = "# Errors"]
#[doc = "Rejects what `rank_from_pages` rejects before reading pages."]
pub fn plan_rank_pages(
    header: &Header,
    query: &FieldQuery<'_>,
    budget: &FieldBudget,
) -> Result<PagePlan, String> {
    let mut workspace = Workspace::new(budget.workspace_bytes);
    let prepared = Prepared::for_rank(header, query, &mut workspace)?;
    Scoring::build(&prepared, query, &mut workspace)?;
    let plan = prepared.plan(&mut workspace)?;
    plan.within(budget.page_bytes)?;
    Ok(plan)
}

// Adapter over complete segment bytes. It passes `FieldBudget::UNBOUNDED`, so
// it keeps the original unbounded behavior; budgets apply to the page entry
// points only.
pub(super) fn rank(
    header: &Header,
    bytes: &[u8],
    base: usize,
    query: &FieldQuery<'_>,
) -> Result<Vec<Hit>, String> {
    rank_from_pages(
        header,
        &mut SlicePages::new(bytes, base),
        query,
        &FieldBudget::UNBOUNDED,
    )
}
