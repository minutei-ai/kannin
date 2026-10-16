use raio_engine::segment::{Filter, Range, Statistics};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub(crate) text: String,
    pub(crate) mode: String,
    pub(crate) top_k: usize,
    pub(crate) filters: Vec<Filter>,
    pub(crate) statistics: Statistics,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    pub(crate) key: String,
    #[serde(rename = "headerBytes")]
    pub(crate) header_bytes: u32,
    pub(crate) bytes: u32,
    pub(crate) dead: Vec<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cutoff {
    pub(crate) id: String,
    pub(crate) score: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub(crate) bucket: String,
    pub(crate) query: Query,
    pub(crate) segments: Vec<Segment>,
    pub(crate) cutoff: Option<Cutoff>,
}

#[derive(Serialize)]
pub struct Hit {
    pub(crate) row: u32,
    pub(crate) id: String,
    pub(crate) score: f64,
    pub(crate) data: Range,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub(crate) header_hits: u64,
    pub(crate) range_hits: u64,
    pub(crate) source_reads: u64,
    pub(crate) source_bytes: u64,
    pub(crate) header_cache_bytes: usize,
    pub(crate) range_cache_bytes: usize,
    pub(crate) prepare_ms: f64,
    pub(crate) acquire_ms: f64,
    pub(crate) decode_ms: f64,
    pub(crate) score_ms: f64,
    pub(crate) spans: usize,
    pub(crate) ranges: usize,
    pub(crate) bytes: usize,
    pub(crate) blocks: usize,
}

#[derive(Serialize)]
pub struct Response {
    pub(crate) segments: Vec<Vec<Hit>>,
    pub(crate) metrics: Metrics,
}
