#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const MAX_DIMENSIONS: usize = 16_384;
const MAX_RESULTS: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DistanceMetric {
    CosineDistance,
    EuclideanSquared,
}

impl TryFrom<&str> for DistanceMetric {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "cosine_distance" => Ok(Self::CosineDistance),
            "euclidean_squared" => Ok(Self::EuclideanSquared),
            _ => Err("Unsupported dense vector distance metric".into()),
        }
    }
}

#[derive(Clone, Copy)]
enum Scoring {
    NativeCosineSimilarity,
    Distance(DistanceMetric),
}

/// Exact, bounded selection of caller-owned eligible document locations.
/// Native construction returns cosine similarity; explicit metrics return distances.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct VectorRanker {
    query: VectorQuery,
    scoring: Scoring,
    limit: usize,
    hits: Vec<(String, f64)>,
}

impl VectorRanker {
    #[doc = "# Errors\nRejects invalid query vectors or result limits outside 1..=10000."]
    pub fn try_new(values: &[f32], limit: usize) -> Result<Self, String> {
        Self::prepare(values, limit, Scoring::NativeCosineSimilarity)
    }

    #[doc = "# Errors\nRejects invalid query vectors or result limits. Zero-magnitude queries are valid only for squared Euclidean distance."]
    pub fn try_new_for_distance(
        values: &[f32],
        limit: usize,
        metric: DistanceMetric,
    ) -> Result<Self, String> {
        Self::prepare(values, limit, Scoring::Distance(metric))
    }

    fn prepare(values: &[f32], limit: usize, scoring: Scoring) -> Result<Self, String> {
        if !(1..=MAX_RESULTS).contains(&limit) {
            return Err("Vector result limit exceeds the supported range".into());
        }
        Ok(Self {
            query: VectorQuery::prepare(
                values,
                match scoring {
                    Scoring::NativeCosineSimilarity => DistanceMetric::CosineDistance,
                    Scoring::Distance(metric) => metric,
                },
            )?,
            scoring,
            limit,
            hits: Vec::with_capacity(limit),
        })
    }

    #[doc = "# Errors\nRejects malformed candidate vectors and duplicate retained keys."]
    pub fn offer(&mut self, key: &str, values: &[f32]) -> Result<bool, String> {
        if key.is_empty() || key.len() > 512 {
            return Err("Vector candidate key exceeds its byte budget".into());
        }
        let score = match self.scoring {
            Scoring::NativeCosineSimilarity => self.query.cosine(values)?,
            Scoring::Distance(DistanceMetric::CosineDistance) => 1.0 - self.query.cosine(values)?,
            Scoring::Distance(DistanceMetric::EuclideanSquared) => {
                self.query.squared_euclidean(values)?
            }
        };
        if self.hits.iter().any(|(existing, _)| existing == key) {
            return Err("Vector candidate key is already retained".into());
        }
        let position = self.hits.partition_point(|(existing_key, existing_score)| {
            let order = match self.scoring {
                Scoring::NativeCosineSimilarity => existing_score.total_cmp(&score).reverse(),
                Scoring::Distance(_) => existing_score.total_cmp(&score),
            };
            order.is_lt()
                || (order.is_eq()
                    && crate::segment::compare_document_ids(existing_key, key).is_lt())
        });
        if position >= self.limit {
            return Ok(false);
        }
        if self.hits.len() == self.limit {
            self.hits.pop();
        }
        self.hits.insert(position, (key.to_owned(), score));
        Ok(true)
    }

    #[doc = "# Errors\nRejects corrupt frames, wrong dimensions, invalid vectors or duplicate retained keys. Returns the key the caller should discard, if any."]
    pub fn offer_frame(&mut self, key: &str, frame: &[u8]) -> Result<Option<String>, String> {
        let expected = self.query.values.len() * size_of::<f32>();
        let declared = frame.get(..4).ok_or("Truncated vector frame")?;
        let declared = u32::from_le_bytes(
            declared
                .try_into()
                .map_err(|cause: std::array::TryFromSliceError| cause.to_string())?,
        );
        if usize::try_from(declared).map_err(|cause| cause.to_string())? != expected
            || frame.len() > expected + 8192
        {
            return Err("Vector frame exceeds query dimensions".into());
        }
        let decoded = crate::segment::decode_page(frame)?;
        let (chunks, remainder) = decoded.as_chunks::<4>();
        if !remainder.is_empty() {
            return Err("Vector frame length is not divisible by four".into());
        }
        let values: Vec<_> = chunks
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect();
        let discarded = if self.hits.len() == self.limit {
            self.hits.last().map(|(key, _)| key.clone())
        } else {
            None
        };
        if self.offer(key, &values)? {
            Ok(discarded)
        } else {
            Ok(Some(key.to_owned()))
        }
    }

    #[must_use]
    pub fn results(&self) -> &[(String, f64)] {
        &self.hits
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl VectorRanker {
    #[wasm_bindgen(constructor)]
    #[doc = "# Errors\nRejects invalid query vectors or result limits."]
    pub fn new(values: &[f32], limit: usize) -> Result<Self, JsValue> {
        Self::try_new(values, limit).map_err(|cause| JsValue::from_str(&cause))
    }

    #[doc = "# Errors\nRejects unsupported metrics, invalid query vectors or result limits. Results contain distances in ascending order."]
    pub fn with_metric(values: &[f32], limit: usize, metric: &str) -> Result<Self, JsValue> {
        let metric = DistanceMetric::try_from(metric).map_err(|cause| JsValue::from_str(&cause))?;
        Self::try_new_for_distance(values, limit, metric).map_err(|cause| JsValue::from_str(&cause))
    }

    #[doc = "# Errors\nRejects corrupt frames, wrong dimensions, invalid candidate vectors or duplicate retained keys."]
    pub fn push_frame(&mut self, key: &str, frame: &[u8]) -> Result<Option<String>, JsValue> {
        self.offer_frame(key, frame)
            .map_err(|cause| JsValue::from_str(&cause))
    }

    #[doc = "# Errors\nRejects result serialization failures."]
    pub fn finish(&self) -> Result<String, JsValue> {
        serde_json::to_string(self.results()).map_err(|cause| JsValue::from_str(&cause.to_string()))
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct VectorQuery {
    values: Vec<f64>,
    norm: f64,
}

impl VectorQuery {
    #[doc = "# Errors\nRejects empty, oversized, nonfinite or zero-magnitude query vectors."]
    pub fn try_new(values: &[f32]) -> Result<Self, String> {
        Self::prepare(values, DistanceMetric::CosineDistance)
    }

    fn prepare(values: &[f32], metric: DistanceMetric) -> Result<Self, String> {
        if values.is_empty() || values.len() > MAX_DIMENSIONS {
            return Err("Vector dimensions exceed the supported range".into());
        }
        let mut squared = 0.0_f64;
        let mut prepared = Vec::with_capacity(values.len());
        for &value in values {
            if !value.is_finite() {
                return Err("Vector contains a nonfinite component".into());
            }
            let value = f64::from(value);
            squared = value.mul_add(value, squared);
            prepared.push(value);
        }
        if squared <= 0.0 && metric == DistanceMetric::CosineDistance {
            return Err("Vector has zero magnitude".into());
        }
        Ok(Self {
            values: prepared,
            norm: squared.sqrt(),
        })
    }

    #[doc = "# Errors\nRejects dimension mismatches, nonfinite components or zero-magnitude candidates."]
    pub fn cosine(&self, candidate: &[f32]) -> Result<f64, String> {
        if self.norm <= 0.0 {
            return Err("Cosine query has zero magnitude".into());
        }
        if candidate.len() != self.values.len() {
            return Err("Vector dimensions differ from the query".into());
        }
        let mut dot = 0.0_f64;
        let mut squared = 0.0_f64;
        for (&left, &right) in self.values.iter().zip(candidate) {
            if !right.is_finite() {
                return Err("Vector contains a nonfinite component".into());
            }
            let right = f64::from(right);
            dot = left.mul_add(right, dot);
            squared = right.mul_add(right, squared);
        }
        if squared <= 0.0 {
            return Err("Vector has zero magnitude".into());
        }
        Ok((dot / (self.norm * squared.sqrt())).clamp(-1.0, 1.0))
    }

    #[doc = "# Errors\nRejects dimension mismatches and nonfinite candidate components."]
    pub fn squared_euclidean(&self, candidate: &[f32]) -> Result<f64, String> {
        if candidate.len() != self.values.len() {
            return Err("Vector dimensions differ from the query".into());
        }
        let mut squared = 0.0_f64;
        for (&left, &right) in self.values.iter().zip(candidate) {
            if !right.is_finite() {
                return Err("Vector contains a nonfinite component".into());
            }
            let delta = left - f64::from(right);
            squared = delta.mul_add(delta, squared);
        }
        Ok(squared)
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl VectorQuery {
    #[wasm_bindgen(constructor)]
    #[doc = "# Errors\nRejects invalid query dimensions, nonfinite values or zero magnitude."]
    pub fn new(values: &[f32]) -> Result<Self, JsValue> {
        Self::try_new(values).map_err(|cause| JsValue::from_str(&cause))
    }

    #[doc = "# Errors\nRejects invalid candidate dimensions, nonfinite values or zero magnitude."]
    pub fn score(&self, values: &[f32]) -> Result<f64, JsValue> {
        self.cosine(values)
            .map_err(|cause| JsValue::from_str(&cause))
    }
}

#[cfg(test)]
mod tests {
    use super::{DistanceMetric, MAX_DIMENSIONS, VectorQuery, VectorRanker};

    fn frame(values: &[f32]) -> Result<Vec<u8>, String> {
        let raw: Vec<_> = values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let mut frame = Vec::new();
        crate::segment::append(&mut frame, &raw)?;
        Ok(frame)
    }

    #[test]
    fn frame_selection_reports_eviction_and_rejects_corruption_atomically() -> Result<(), String> {
        let mut ranker = VectorRanker::try_new(&[1.0, 0.0], 1)?;
        assert_eq!(ranker.offer_frame("z", &frame(&[0.0, 1.0])?)?, None);
        assert_eq!(
            ranker.offer_frame("b", &frame(&[1.0, 0.0])?)?,
            Some("z".into())
        );
        assert_eq!(
            ranker.offer_frame("a", &frame(&[1.0, 0.0])?)?,
            Some("b".into())
        );
        assert_eq!(
            ranker.offer_frame("c", &frame(&[1.0, 0.0])?)?,
            Some("c".into())
        );
        let original = ranker.results().to_vec();
        let mut corrupt = frame(&[1.0, 0.0])?;
        corrupt[4] ^= 1;
        for invalid in [
            corrupt,
            frame(&[1.0])?,
            frame(&[f32::NAN, 0.0])?,
            vec![255; 4],
        ] {
            assert!(ranker.offer_frame("invalid", &invalid).is_err());
            assert_eq!(ranker.results(), original);
        }
        Ok(())
    }

    #[test]
    fn selection_is_bounded_exact_and_deterministic() -> Result<(), String> {
        let mut ranker = VectorRanker::try_new(&[1.0, 0.0], 2)?;
        assert!(ranker.offer("9", &[-1.0, 0.0])?);
        assert!(ranker.offer("8", &[0.0, 1.0])?);
        assert!(ranker.offer("7", &[1.0, 0.0])?);
        assert!(!ranker.offer("10", &[-1.0, 0.0])?);
        assert!(ranker.offer("3", &[1.0, 0.0])?);
        assert_eq!(
            ranker
                .results()
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec!["3", "7"]
        );
        assert!(
            ranker
                .results()
                .iter()
                .all(|(_, score)| (*score - 1.0).abs() < 1.0e-12)
        );
        assert!(ranker.offer("3", &[1.0, 0.0]).is_err());
        assert!(VectorRanker::try_new(&[1.0], 0).is_err());
        assert!(VectorRanker::try_new(&[1.0], super::MAX_RESULTS + 1).is_err());
        Ok(())
    }

    #[test]
    fn vector_ties_match_the_existing_text_document_order() -> Result<(), String> {
        let mut ranker = VectorRanker::try_new(&[1.0], 3)?;
        for key in ["\u{e000}", "😀", "a"] {
            ranker.offer(key, &[1.0])?;
        }
        assert_eq!(
            ranker
                .results()
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "😀", "\u{e000}"]
        );
        Ok(())
    }

    #[test]
    fn cosine_preserves_direction_and_ignores_magnitude() -> Result<(), String> {
        let query = VectorQuery::try_new(&[3.0, 4.0])?;
        for (candidate, expected) in [
            ([6.0, 8.0], 1.0_f64),
            ([-6.0, -8.0], -1.0),
            ([4.0, -3.0], 0.0),
        ] {
            assert!((query.cosine(&candidate)? - expected).abs() < 1.0e-12);
        }
        Ok(())
    }

    #[test]
    fn float32_extrema_remain_finite_without_norm_overflow() -> Result<(), String> {
        for value in [f32::MAX, f32::MIN_POSITIVE, f32::from_bits(1)] {
            let query = VectorQuery::try_new(&[value, value])?;
            let score = query.cosine(&[value, value])?;
            assert!(score.is_finite());
            assert!((score - 1.0).abs() < 1.0e-12);
        }
        Ok(())
    }

    #[test]
    fn malformed_vectors_fail_before_scoring() -> Result<(), String> {
        assert!(VectorQuery::try_new(&[]).is_err());
        assert!(VectorQuery::try_new(&[0.0, 0.0]).is_err());
        assert!(VectorQuery::try_new(&[f32::NAN]).is_err());
        assert!(VectorQuery::try_new(&[f32::INFINITY]).is_err());
        assert!(VectorQuery::try_new(&vec![1.0; MAX_DIMENSIONS + 1]).is_err());
        let query = VectorQuery::try_new(&[1.0, 0.0])?;
        for candidate in [
            &[1.0][..],
            &[0.0, 0.0],
            &[f32::NAN, 1.0],
            &[f32::INFINITY, 1.0],
        ] {
            assert!(query.cosine(candidate).is_err());
        }
        Ok(())
    }

    #[test]
    fn explicit_cosine_distance_does_not_change_native_similarity() -> Result<(), String> {
        let mut distance =
            VectorRanker::try_new_for_distance(&[1.0, 0.0], 3, DistanceMetric::CosineDistance)?;
        let mut native = VectorRanker::try_new(&[1.0, 0.0], 3)?;
        for (key, vector) in [
            ("opposite", [-1.0, 0.0]),
            ("orthogonal", [0.0, 2.0]),
            ("parallel", [10.0, 0.0]),
        ] {
            distance.offer(key, &vector)?;
            native.offer(key, &vector)?;
        }
        assert_eq!(
            distance.results(),
            [
                ("parallel".into(), 0.0),
                ("orthogonal".into(), 1.0),
                ("opposite".into(), 2.0),
            ]
        );
        assert_eq!(
            native.results(),
            [
                ("parallel".into(), 1.0),
                ("orthogonal".into(), 0.0),
                ("opposite".into(), -1.0),
            ]
        );
        Ok(())
    }

    #[test]
    fn squared_euclidean_preserves_magnitude_and_admits_the_origin() -> Result<(), String> {
        let mut ranker =
            VectorRanker::try_new_for_distance(&[3.0, 4.0], 3, DistanceMetric::EuclideanSquared)?;
        for (key, vector) in [
            ("parallel", [6.0, 8.0]),
            ("origin", [0.0, 0.0]),
            ("same", [3.0, 4.0]),
        ] {
            ranker.offer_frame(key, &frame(&vector)?)?;
        }
        assert_eq!(
            ranker.results(),
            [
                ("same".into(), 0.0),
                ("origin".into(), 25.0),
                ("parallel".into(), 25.0),
            ]
        );
        let mut origin =
            VectorRanker::try_new_for_distance(&[0.0, 0.0], 1, DistanceMetric::EuclideanSquared)?;
        origin.offer_frame("zero", &frame(&[0.0, 0.0])?)?;
        assert_eq!(origin.results(), [("zero".into(), 0.0)]);
        assert!(
            VectorRanker::try_new_for_distance(&[0.0], 1, DistanceMetric::CosineDistance).is_err()
        );
        assert!(VectorRanker::try_new(&[0.0], 1).is_err());
        Ok(())
    }

    #[test]
    fn distance_top_k_matches_an_independent_exhaustive_integer_oracle() -> Result<(), String> {
        let query = [2.0_f32, -3.0, 0.0];
        let documents: Vec<_> = (0..40_u8)
            .map(|index| {
                (
                    format!("{index:02}"),
                    [
                        f32::from(index % 11),
                        f32::from(index % 7) - 3.0,
                        f32::from(index % 5),
                    ],
                )
            })
            .collect();
        let mut expected: Vec<_> = documents
            .iter()
            .map(|(id, vector)| {
                let distance = query
                    .iter()
                    .zip(vector)
                    .map(|(&left, &right)| {
                        let delta = f64::from(left) - f64::from(right);
                        delta * delta
                    })
                    .sum::<f64>();
                (id.clone(), distance)
            })
            .collect();
        expected.sort_by(|left, right| {
            left.1
                .total_cmp(&right.1)
                .then_with(|| left.0.cmp(&right.0))
        });
        for limit in [1, 3, 8, 40] {
            let mut forward = VectorRanker::try_new_for_distance(
                &query,
                limit,
                DistanceMetric::EuclideanSquared,
            )?;
            let mut reversed = VectorRanker::try_new_for_distance(
                &query,
                limit,
                DistanceMetric::EuclideanSquared,
            )?;
            for (id, vector) in &documents {
                forward.offer(id, vector)?;
            }
            for (id, vector) in documents.iter().rev() {
                reversed.offer_frame(id, &frame(vector)?)?;
            }
            assert_eq!(forward.results(), &expected[..limit]);
            assert_eq!(reversed.results(), &expected[..limit]);
        }
        Ok(())
    }

    #[test]
    fn distance_errors_leave_retained_hits_unchanged() -> Result<(), String> {
        for metric in [
            DistanceMetric::CosineDistance,
            DistanceMetric::EuclideanSquared,
        ] {
            let mut ranker = VectorRanker::try_new_for_distance(&[1.0, 0.0], 1, metric)?;
            ranker.offer_frame("retained", &frame(&[1.0, 0.0])?)?;
            let expected = ranker.results().to_vec();
            let mut corrupt = frame(&[1.0, 0.0])?;
            corrupt[4] ^= 1;
            for invalid in [
                corrupt,
                frame(&[1.0])?,
                frame(&[f32::NAN, 0.0])?,
                vec![255; 4],
            ] {
                assert!(ranker.offer_frame("invalid", &invalid).is_err());
                assert_eq!(ranker.results(), expected);
            }
            assert!(ranker.offer("retained", &[1.0, 0.0]).is_err());
            assert_eq!(ranker.results(), expected);
            assert!(VectorRanker::try_new_for_distance(&[], 1, metric).is_err());
            assert!(VectorRanker::try_new_for_distance(&[f32::INFINITY], 1, metric).is_err());
            assert!(VectorRanker::try_new_for_distance(&[1.0], 0, metric).is_err());
            assert!(
                VectorRanker::try_new_for_distance(&[1.0], super::MAX_RESULTS + 1, metric).is_err()
            );
        }
        for metric in ["", "dot_product", "COSINE_DISTANCE"] {
            assert!(DistanceMetric::try_from(metric).is_err());
        }
        Ok(())
    }

    #[test]
    fn squared_euclidean_f32_extremes_do_not_overflow_or_underflow() -> Result<(), String> {
        for value in [f32::MAX, f32::MIN_POSITIVE, f32::from_bits(1)] {
            let mut ranker = VectorRanker::try_new_for_distance(
                &[value, value],
                2,
                DistanceMetric::EuclideanSquared,
            )?;
            ranker.offer("opposite", &[-value, -value])?;
            ranker.offer("same", &[value, value])?;
            let results = ranker.results();
            assert_eq!(results[0], ("same".into(), 0.0));
            assert_eq!(results[1].0, "opposite");
            assert!(results[1].1.is_finite());
            assert!(results[1].1 > 0.0);
        }
        Ok(())
    }
}
