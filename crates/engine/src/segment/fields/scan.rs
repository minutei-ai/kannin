use super::super::{
    BLOCK_SIZE, BlockMeta, DecodedPositions, Header, MAX_BYTES, PostingShape, Range,
    decode_shaped_rows,
};
use super::query::FieldPlan;
use super::source::{BUDGET_EXCEEDED, PostingPages, Workspace};
use bit_vec::BitVec;

// A decoded position costs at most one byte of page, because every delta takes
// at least one byte. Each one is then held by the decoder (`u32`), by the
// decoder's input vector at worst amortised doubling (`2 * u32`), and by the
// mapped `(position, input)` pair.
const POSITION_TRANSIENT_BYTES: usize =
    size_of::<u32>() + 2 * size_of::<u32>() + size_of::<(u32, u32)>();

pub(super) struct BlockRow {
    pub(super) row: u32,
    pub(super) count: u32,
    pub(super) positions: Vec<(u32, u32)>,
}

pub(super) type Visitor<'v> = dyn FnMut(&mut Workspace, &mut BlockRow) -> Result<(), String> + 'v;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum BlockAction {
    Skip,
    CountOnly,
    Read,
}

fn block_is_masked(block: &BlockMeta, allowed: &BitVec) -> bool {
    !(block.first as usize..=block.last as usize).any(|row| allowed.get(row).unwrap_or(false))
}

fn block_is_live(block: &BlockMeta, live: &BitVec) -> bool {
    (block.first as usize..=block.last as usize).all(|row| live.get(row).unwrap_or(false))
}

#[doc = "The single decision shared by execution and page planning."]
#[doc = ""]
#[doc = "A block without an eligible row never needs its rows. When live document"]
#[doc = "frequencies are counted, a fully live single-lane block contributes its"]
#[doc = "directory count without a read; every other masked block is read so the"]
#[doc = "tombstoned and per-lane rows can be counted exactly."]
pub(super) fn block_action(
    block: &BlockMeta,
    shape: PostingShape,
    allowed: &BitVec,
    live: Option<&BitVec>,
) -> BlockAction {
    if !block_is_masked(block, allowed) {
        return BlockAction::Read;
    }
    match live {
        None => BlockAction::Skip,
        Some(live) if shape.lanes == 1 && block_is_live(block, live) => BlockAction::CountOnly,
        Some(_) => BlockAction::Read,
    }
}

pub(super) fn plan_ranges(
    header: &Header,
    fields: &[FieldPlan],
    allowed: &BitVec,
    live: Option<&BitVec>,
    workspace: &mut Workspace,
) -> Result<Vec<Range>, String> {
    let mut ranges = Vec::new();
    for field in fields {
        let (dictionary, _) = header
            .fields
            .dictionary(field.ordinal)
            .ok_or("Missing text field")?;
        let shape = header.fields.shape(field.ordinal);
        for term in &field.unique {
            let Some(metadata) = dictionary.get(term) else {
                continue;
            };
            for block in &metadata.blocks {
                if block_action(block, shape, allowed, live) == BlockAction::Read {
                    workspace.grow(&mut ranges)?;
                    ranges.push(block.data.clone());
                }
            }
        }
    }
    Ok(ranges)
}

struct TermCursor {
    frequency: u32,
    previous: Option<u32>,
}

impl TermCursor {
    fn count_block(&mut self, block: &BlockMeta) -> Result<(), String> {
        self.frequency = self
            .frequency
            .checked_add(block.count)
            .ok_or("Document frequency overflow")?;
        self.previous = Some(block.last);
        Ok(())
    }

    // Validates one posting row and reports whether it is eligible.
    fn accept(
        &mut self,
        row: &BlockRow,
        block: &BlockMeta,
        lane: usize,
        masks: (&BitVec, Option<&BitVec>),
    ) -> Result<bool, String> {
        let (allowed, live) = masks;
        if self.previous.is_some_and(|previous| previous >= row.row) {
            return Err("Posting blocks out of order".into());
        }
        self.previous = Some(row.row);
        if row.count == 0 {
            return Ok(false);
        }
        let index = row.row as usize;
        if index >= allowed.len() {
            return Err("Invalid posting row".into());
        }
        if row.count > block.max_tf[lane] {
            return Err("Posting frequency exceeds its block".into());
        }
        if live.is_some_and(|live| live.get(index).unwrap_or(false)) {
            self.frequency = self
                .frequency
                .checked_add(1)
                .ok_or("Document frequency overflow")?;
        }
        Ok(allowed[index])
    }
}

pub(super) struct Scan<'a> {
    pub(super) header: &'a Header,
    pub(super) pages: &'a mut dyn PostingPages,
    pub(super) workspace: &'a mut Workspace,
    pub(super) allowed: &'a BitVec,
    pub(super) live: Option<&'a BitVec>,
}

impl Scan<'_> {
    #[doc = "Streams one term's posting blocks in row order. Eligible rows are handed"]
    #[doc = "to `visit`; the returned value is the live document frequency when live"]
    #[doc = "rows are being counted."]
    pub(super) fn term(
        &mut self,
        ordinal: usize,
        term: &str,
        positional: bool,
        visit: &mut Visitor<'_>,
    ) -> Result<u32, String> {
        let header = self.header;
        let (dictionary, lane) = header
            .fields
            .dictionary(ordinal)
            .ok_or("Missing text field")?;
        let Some(metadata) = dictionary.get(term) else {
            return Ok(0);
        };
        let shape = header.fields.shape(ordinal);
        let mut cursor = TermCursor {
            frequency: 0,
            previous: None,
        };
        for block in &metadata.blocks {
            match block_action(block, shape, self.allowed, self.live) {
                BlockAction::Skip => cursor.previous = Some(block.last),
                BlockAction::CountOnly => cursor.count_block(block)?,
                BlockAction::Read => {
                    self.read(block, (shape, lane, positional), &mut cursor, visit)?;
                }
            }
        }
        Ok(cursor.frequency)
    }

    fn read(
        &mut self,
        block: &BlockMeta,
        decoding: (PostingShape, usize, bool),
        cursor: &mut TermCursor,
        visit: &mut Visitor<'_>,
    ) -> Result<(), String> {
        let (shape, lane, positional) = decoding;
        let page = self.pages.page(&block.data)?;
        if page.len() != block.data.length as usize {
            return Err("Posting page length mismatch".into());
        }
        let charge = transient_bytes(page, positional)?;
        self.workspace.reserve(charge)?;
        let mut rows = decode_block(page, shape, lane, block, positional)?;
        for row in &mut rows {
            if cursor.accept(row, block, lane, (self.allowed, self.live))? {
                visit(&mut *self.workspace, row)?;
            }
        }
        self.workspace.release(charge);
        Ok(())
    }
}

// Mirrors what `decode_page` allocates before it can reject a page, so the
// charge precedes the decoder's allocation. Short pages and oversized claims
// are rejected by the decoder before it allocates anything.
fn transient_bytes(page: &[u8], positional: bool) -> Result<usize, String> {
    let Some(prefix) = page.first_chunk::<4>() else {
        return Ok(0);
    };
    let claimed = u32::from_le_bytes(*prefix) as usize;
    if page.len() < 8 || claimed > MAX_BYTES {
        return Ok(0);
    }
    let rows = BLOCK_SIZE * size_of::<BlockRow>();
    let positions = if positional {
        claimed
            .checked_mul(POSITION_TRANSIENT_BYTES)
            .ok_or(BUDGET_EXCEEDED)?
    } else {
        0
    };
    claimed
        .checked_add(rows)
        .and_then(|bytes| bytes.checked_add(positions))
        .ok_or_else(|| BUDGET_EXCEEDED.to_owned())
}

fn decode_block(
    page: &[u8],
    shape: PostingShape,
    lane: usize,
    block: &BlockMeta,
    positional: bool,
) -> Result<Vec<BlockRow>, String> {
    let make = |row, first: DecodedPositions, second: DecodedPositions| {
        let selected = if lane == 0 { first } else { second };
        let positions = selected
            .values
            .iter()
            .enumerate()
            .map(|(index, position)| (*position, selected.inputs.get(index).copied().unwrap_or(0)))
            .collect();
        BlockRow {
            row,
            count: selected.count,
            positions,
        }
    };
    let rows = if positional {
        decode_shaped_rows::<true, _>(page, shape, make)?
    } else {
        decode_shaped_rows::<false, _>(page, shape, make)?
    };
    let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
        return Err("Empty posting block".into());
    };
    if rows.len() != block.count as usize || first.row != block.first || last.row != block.last {
        return Err("Posting block does not match its directory".into());
    }
    Ok(rows)
}
