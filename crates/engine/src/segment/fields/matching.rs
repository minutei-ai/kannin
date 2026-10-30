use super::query::FieldPlan;
use super::scan::BlockRow;
use super::source::{BUDGET_EXCEEDED, Workspace};
use bit_vec::BitVec;
use std::collections::BTreeMap;

// Upper-bound estimate for one `BTreeMap<&str, _>` entry: key, value and node slack.
const MAP_ENTRY_BYTES: usize = size_of::<&str>() + size_of::<(u32, Option<usize>)>() + 16;
const START_BYTES: usize = size_of::<(u32, u32)>();

#[doc = "Which rows are eligible results, accumulated one term at a time."]
#[doc = ""]
#[doc = "`any` marks every row that has a posting, `all` counts the distinct query"]
#[doc = "terms each row satisfies, and `phrase` keeps only the candidate start"]
#[doc = "positions of the field being scanned. None of them holds a rows by terms"]
#[doc = "matrix of frequencies or positions."]
pub(super) enum Matching {
    Any(BitVec),
    All(AllState),
    Phrase(PhraseState),
}

impl Matching {
    pub(super) fn new(
        mode: &str,
        fields: &[FieldPlan],
        rows: usize,
        workspace: &mut Workspace,
    ) -> Result<Self, String> {
        match mode {
            "phrase" => PhraseState::new(rows, workspace).map(Self::Phrase),
            "all" => AllState::new(fields, rows, workspace).map(Self::All),
            _ => {
                workspace.reserve_bits(rows)?;
                Ok(Self::Any(BitVec::from_elem(rows, false)))
            }
        }
    }

    pub(super) const fn positional(&self) -> bool {
        matches!(self, Self::Phrase(_))
    }

    pub(super) fn observe(
        &mut self,
        workspace: &mut Workspace,
        field: &FieldPlan,
        term: usize,
        row: &mut BlockRow,
    ) -> Result<(), String> {
        match self {
            Self::Phrase(state) => state.observe(workspace, &field.deltas[term], term, row),
            Self::Any(_) | Self::All(_) => Ok(()),
        }
    }

    // Called once a term's eligible rows are known, before the next term.
    pub(super) fn settle(
        &mut self,
        workspace: &mut Workspace,
        position: (usize, usize),
        entries: &[(u32, u32)],
    ) {
        let (field, term) = position;
        match self {
            Self::Any(touched) => {
                for (row, _) in entries {
                    touched.set(*row as usize, true);
                }
            }
            Self::All(state) => state.settle(field, term, entries),
            Self::Phrase(state) => state.end_term(workspace, term),
        }
    }

    pub(super) fn end_field(&mut self, workspace: &mut Workspace) {
        if let Self::Phrase(state) = self {
            state.end_field(workspace);
        }
    }

    pub(super) fn is_candidate(&self, row: usize) -> bool {
        match self {
            Self::Any(touched) => touched.get(row).unwrap_or(false),
            Self::All(state) => state
                .satisfied
                .get(row)
                .is_some_and(|count| *count == state.required),
            Self::Phrase(state) => state.matched.get(row).unwrap_or(false),
        }
    }
}

pub(super) struct AllState {
    required: u32,
    satisfied: Vec<u32>,
    presence: Vec<BitVec>,
    slots: Vec<Vec<Option<usize>>>,
}

impl AllState {
    // A term shared by several selected fields needs a presence bitset so a
    // row is counted once for it; a term of one field is counted directly.
    fn new(fields: &[FieldPlan], rows: usize, workspace: &mut Workspace) -> Result<Self, String> {
        let terms = fields.iter().map(|field| field.unique.len()).sum::<usize>();
        let mapped = terms.checked_mul(MAP_ENTRY_BYTES).ok_or(BUDGET_EXCEEDED)?;
        workspace.reserve(mapped)?;
        let mut counts: BTreeMap<&str, (u32, Option<usize>)> = BTreeMap::new();
        for field in fields {
            for term in &field.unique {
                counts.entry(term.as_str()).or_insert((0, None)).0 += 1;
            }
        }
        let required = u32::try_from(counts.len()).map_err(|cause| cause.to_string())?;
        let mut shared = 0_usize;
        for entry in counts.values_mut() {
            if entry.0 > 1 {
                entry.1 = Some(shared);
                shared += 1;
            }
        }
        workspace.reserve_items::<Vec<Option<usize>>>(fields.len())?;
        workspace.reserve_items::<Option<usize>>(terms)?;
        let slots: Vec<Vec<Option<usize>>> = fields
            .iter()
            .map(|field| {
                field
                    .unique
                    .iter()
                    .map(|term| counts.get(term.as_str()).and_then(|entry| entry.1))
                    .collect()
            })
            .collect();
        drop(counts);
        workspace.release(mapped);
        workspace.reserve_items::<BitVec>(shared)?;
        let mut presence = Vec::with_capacity(shared);
        for _ in 0..shared {
            workspace.reserve_bits(rows)?;
            presence.push(BitVec::from_elem(rows, false));
        }
        workspace.reserve_items::<u32>(rows)?;
        Ok(Self {
            required,
            satisfied: vec![0; rows],
            presence,
            slots,
        })
    }

    fn settle(&mut self, field: usize, term: usize, entries: &[(u32, u32)]) {
        let slot = self.slots[field][term];
        for (row, _) in entries {
            let index = *row as usize;
            let fresh = match slot {
                Some(slot) => {
                    let seen = &mut self.presence[slot];
                    let fresh = !seen[index];
                    seen.set(index, true);
                    fresh
                }
                None => true,
            };
            if fresh {
                self.satisfied[index] += 1;
            }
        }
    }
}

struct Survivor {
    row: u32,
    starts: Vec<(u32, u32)>,
}

#[doc = "Phrase matching for the field being scanned."]
#[doc = ""]
#[doc = "The first token's postings seed the candidate starts of each row. Every"]
#[doc = "later unique term streams past them once and strikes the starts it does"]
#[doc = "not support, so only candidate starts are retained, charged before they"]
#[doc = "are kept, and never the later terms' positions."]
pub(super) struct PhraseState {
    matched: BitVec,
    survivors: Vec<Survivor>,
    cursor: usize,
}

fn supports(
    positions: &[(u32, u32)],
    start: u32,
    input: u32,
    deltas: &[u32],
) -> Result<bool, String> {
    for delta in deltas {
        let wanted = start
            .checked_add(*delta)
            .ok_or("Phrase position overflow")?;
        let found = positions
            .binary_search_by_key(&wanted, |entry| entry.0)
            .is_ok_and(|index| positions[index].1 == input);
        if !found {
            return Ok(false);
        }
    }
    Ok(true)
}

impl PhraseState {
    fn new(rows: usize, workspace: &mut Workspace) -> Result<Self, String> {
        workspace.reserve_bits(rows)?;
        Ok(Self {
            matched: BitVec::from_elem(rows, false),
            survivors: Vec::new(),
            cursor: 0,
        })
    }

    fn observe(
        &mut self,
        workspace: &mut Workspace,
        deltas: &[u32],
        term: usize,
        row: &mut BlockRow,
    ) -> Result<(), String> {
        if term == 0 {
            self.seed(workspace, deltas, row)
        } else {
            self.strike(workspace, deltas, row)
        }
    }

    // Keeps the starts of the row whose own repeats of the first term fit.
    fn seed(
        &mut self,
        workspace: &mut Workspace,
        deltas: &[u32],
        row: &mut BlockRow,
    ) -> Result<(), String> {
        let mut starts = std::mem::take(&mut row.positions);
        let mut kept = 0;
        let mut index = 0;
        while index < starts.len() {
            let (start, input) = starts[index];
            if supports(&starts[index..], start, input, deltas)? {
                starts[kept] = (start, input);
                kept += 1;
            }
            index += 1;
        }
        starts.truncate(kept);
        if starts.is_empty() {
            return Ok(());
        }
        starts.shrink_to_fit();
        workspace.reserve(starts.capacity() * START_BYTES)?;
        workspace.grow(&mut self.survivors)?;
        self.survivors.push(Survivor {
            row: row.row,
            starts,
        });
        Ok(())
    }

    fn strike(
        &mut self,
        workspace: &mut Workspace,
        deltas: &[u32],
        row: &BlockRow,
    ) -> Result<(), String> {
        while self
            .survivors
            .get(self.cursor)
            .is_some_and(|survivor| survivor.row < row.row)
        {
            self.discard(workspace, self.cursor);
            self.cursor += 1;
        }
        let Some(survivor) = self
            .survivors
            .get_mut(self.cursor)
            .filter(|survivor| survivor.row == row.row)
        else {
            return Ok(());
        };
        let mut kept = 0;
        let mut index = 0;
        while index < survivor.starts.len() {
            let (start, input) = survivor.starts[index];
            if supports(&row.positions, start, input, deltas)? {
                survivor.starts[kept] = (start, input);
                kept += 1;
            }
            index += 1;
        }
        survivor.starts.truncate(kept);
        if survivor.starts.is_empty() {
            self.discard(workspace, self.cursor);
        }
        self.cursor += 1;
        Ok(())
    }

    fn discard(&mut self, workspace: &mut Workspace, index: usize) {
        let starts = std::mem::take(&mut self.survivors[index].starts);
        workspace.release(starts.capacity() * START_BYTES);
    }

    // Rows the term did not reach cannot complete the phrase.
    fn end_term(&mut self, workspace: &mut Workspace, term: usize) {
        if term == 0 {
            return;
        }
        while self.cursor < self.survivors.len() {
            self.discard(workspace, self.cursor);
            self.cursor += 1;
        }
        self.survivors
            .retain(|survivor| !survivor.starts.is_empty());
        self.cursor = 0;
    }

    fn end_field(&mut self, workspace: &mut Workspace) {
        for survivor in &self.survivors {
            self.matched.set(survivor.row as usize, true);
            workspace.release(survivor.starts.capacity() * START_BYTES);
        }
        workspace.release(self.survivors.capacity() * size_of::<Survivor>());
        self.survivors = Vec::new();
        self.cursor = 0;
    }
}
