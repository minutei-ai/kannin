use super::super::Range;

pub(super) const BUDGET_EXCEEDED: &str = "Workspace budget exceeded";
const PAGE_BUDGET_EXCEEDED: &str = "Planned pages exceed the page budget";
const MIN_GROWTH: usize = 8;
const BITSET_BLOCK_BITS: usize = 32;

#[doc = "Caller-owned limits for one field operation."]
#[doc = ""]
#[doc = "`workspace_bytes` limits the accounted workspace estimates that scale with rows,"]
#[doc = "query terms or phrase positions, and is checked before the corresponding allocation or"]
#[doc = "retention happens. `page_bytes` bounds the compressed posting bytes the"]
#[doc = "operation may read; it is checked against the planned ranges before any"]
#[doc = "page is requested. Allocations owned by header parsing, filter evaluation"]
#[doc = "and the text analyzers are outside this accounting. Collection node overhead is"]
#[doc = "estimated; this limit is not a bound on total allocator usage or process RSS."]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldBudget {
    pub workspace_bytes: usize,
    pub page_bytes: u64,
}

impl FieldBudget {
    #[doc = "No caller limit. Only the full-bytes adapters use it."]
    pub const UNBOUNDED: Self = Self {
        workspace_bytes: usize::MAX,
        page_bytes: u64::MAX,
    };
}

#[doc = "A result together with the accounted peak of the operation."]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Measured<T> {
    pub value: T,
    pub peak_workspace_bytes: usize,
    pub planned_page_bytes: u64,
}

pub(super) struct Workspace {
    limit: usize,
    used: usize,
    peak: usize,
}

impl Workspace {
    pub(super) const fn new(limit: usize) -> Self {
        Self {
            limit,
            used: 0,
            peak: 0,
        }
    }

    pub(super) fn reserve(&mut self, bytes: usize) -> Result<(), String> {
        let total = self
            .used
            .checked_add(bytes)
            .filter(|total| *total <= self.limit)
            .ok_or(BUDGET_EXCEEDED)?;
        self.used = total;
        self.peak = self.peak.max(total);
        Ok(())
    }

    pub(super) const fn release(&mut self, bytes: usize) {
        self.used = self.used.saturating_sub(bytes);
    }

    pub(super) const fn peak(&self) -> usize {
        self.peak
    }

    pub(super) fn reserve_items<T>(&mut self, count: usize) -> Result<usize, String> {
        let bytes = count.checked_mul(size_of::<T>()).ok_or(BUDGET_EXCEEDED)?;
        self.reserve(bytes)?;
        Ok(bytes)
    }

    pub(super) fn reserve_bits(&mut self, bits: usize) -> Result<usize, String> {
        let bytes = bits
            .div_ceil(BITSET_BLOCK_BITS)
            .checked_mul(size_of::<u32>())
            .ok_or(BUDGET_EXCEEDED)?;
        self.reserve(bytes)?;
        Ok(bytes)
    }

    #[doc = "Charges the next capacity step of a full vector, then reserves exactly"]
    #[doc = "that step, so every growth is accounted before it is allocated."]
    pub(super) fn grow<T>(&mut self, vector: &mut Vec<T>) -> Result<(), String> {
        if vector.len() < vector.capacity() {
            return Ok(());
        }
        let extra = vector.capacity().max(MIN_GROWTH);
        self.reserve(extra.checked_mul(size_of::<T>()).ok_or(BUDGET_EXCEEDED)?)?;
        vector
            .try_reserve_exact(extra)
            .map_err(|cause| cause.to_string())
    }
}

#[doc = "Byte access to posting pages by directory range."]
#[doc = ""]
#[doc = "Implementations return exactly the bytes of `range`. The engine rejects a"]
#[doc = "page whose length differs from the range, and validates every page against"]
#[doc = "its block directory, checksum and posting codec. Binding pages to the right"]
#[doc = "object version is the implementor's responsibility."]
pub trait PostingPages {
    #[doc = "# Errors\nFails when the page is unavailable."]
    fn page(&mut self, range: &Range) -> Result<&[u8], String>;
}

#[doc = "Pages addressed as `base + offset` inside one complete segment slice."]
pub struct SlicePages<'a> {
    bytes: &'a [u8],
    base: usize,
}

impl<'a> SlicePages<'a> {
    #[must_use]
    pub const fn new(bytes: &'a [u8], base: usize) -> Self {
        Self { bytes, base }
    }
}

impl PostingPages for SlicePages<'_> {
    fn page(&mut self, range: &Range) -> Result<&[u8], String> {
        let start = self
            .base
            .checked_add(usize::try_from(range.offset).map_err(|cause| cause.to_string())?)
            .ok_or("Invalid posting range")?;
        let end = start
            .checked_add(usize::try_from(range.length).map_err(|cause| cause.to_string())?)
            .ok_or("Invalid posting range")?;
        self.bytes
            .get(start..end)
            .ok_or_else(|| "Invalid posting range".to_owned())
    }
}

#[doc = "Ascending, de-duplicated directory ranges an operation will read."]
#[derive(Clone, Default, PartialEq, Eq)]
pub struct PagePlan {
    ranges: Vec<Range>,
    bytes: u64,
}

impl PagePlan {
    #[must_use]
    pub fn ranges(&self) -> &[Range] {
        &self.ranges
    }

    #[must_use]
    pub const fn bytes(&self) -> u64 {
        self.bytes
    }

    pub(super) fn from_ranges(mut ranges: Vec<Range>) -> Result<Self, String> {
        ranges.sort_unstable();
        ranges.dedup();
        let mut bytes = 0_u64;
        for range in &ranges {
            bytes = bytes
                .checked_add(u64::from(range.length))
                .ok_or("Planned page bytes overflow")?;
        }
        Ok(Self { ranges, bytes })
    }

    pub(super) fn within(&self, page_bytes: u64) -> Result<(), String> {
        if self.bytes > page_bytes {
            return Err(PAGE_BUDGET_EXCEEDED.into());
        }
        Ok(())
    }
}

#[doc = "Owns the compressed pages of one plan until the operation runs."]
#[doc = ""]
#[doc = "Pages may arrive in any order. Only planned ranges with their exact length"]
#[doc = "are accepted, once each, so retention never exceeds the planned bytes and"]
#[doc = "never exceeds the caller's page budget."]
pub struct PageCollector {
    ranges: Vec<Range>,
    pages: Vec<Option<Box<[u8]>>>,
}

impl PageCollector {
    #[doc = "# Errors\nRejects a plan larger than `page_bytes` before retaining anything."]
    pub fn new(plan: &PagePlan, page_bytes: u64) -> Result<Self, String> {
        plan.within(page_bytes)?;
        Ok(Self {
            ranges: plan.ranges.clone(),
            pages: vec![None; plan.ranges.len()],
        })
    }

    #[doc = "# Errors\nRejects unplanned ranges, duplicates, and pages whose length differs from their range."]
    pub fn accept(&mut self, range: &Range, bytes: &[u8]) -> Result<(), String> {
        let Ok(index) = self.ranges.binary_search(range) else {
            return Err("Unplanned posting page".into());
        };
        if bytes.len() != range.length as usize {
            return Err("Posting page length mismatch".into());
        }
        let slot = &mut self.pages[index];
        if slot.is_some() {
            return Err("Duplicate posting page".into());
        }
        *slot = Some(bytes.into());
        Ok(())
    }

    #[doc = "# Errors\nRejects a collection that is missing any planned page."]
    pub fn finish(self) -> Result<CollectedPages, String> {
        let pages = self
            .pages
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or("Missing posting page")?;
        Ok(CollectedPages {
            ranges: self.ranges,
            pages,
        })
    }
}

#[doc = "Complete planned pages; serves only the planned ranges."]
pub struct CollectedPages {
    ranges: Vec<Range>,
    pages: Vec<Box<[u8]>>,
}

impl PostingPages for CollectedPages {
    fn page(&mut self, range: &Range) -> Result<&[u8], String> {
        let Ok(index) = self.ranges.binary_search(range) else {
            return Err("Unplanned posting page".into());
        };
        Ok(&self.pages[index])
    }
}
