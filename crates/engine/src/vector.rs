#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const MAX_DIMENSIONS: usize = 16_384;
const MAX_RESULTS: usize = 10_000;

/// Exact, bounded cosine selection. Keys identify caller-owned document locations.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct VectorRanker {
    query: VectorQuery,
    limit: usize,
    hits: Vec<(u32, f64)>,
}

impl VectorRanker {
    #[doc = "# Errors\nRejects invalid query vectors or result limits outside 1..=10000."]
    pub fn try_new(values: &[f32], limit: usize) -> Result<Self, String> {
        if !(1..=MAX_RESULTS).contains(&limit) {
            return Err("Vector result limit exceeds the supported range".into());
        }
        Ok(Self {
            query: VectorQuery::try_new(values)?,
            limit,
            hits: Vec::with_capacity(limit),
        })
    }

    #[doc = "# Errors\nRejects malformed candidate vectors and duplicate retained keys."]
    pub fn offer(&mut self, key: u32, values: &[f32]) -> Result<bool, String> {
        let score = self.query.cosine(values)?;
        if self.hits.iter().any(|(existing, _)| *existing == key) {
            return Err("Vector candidate key is already retained".into());
        }
        let position = self.hits.partition_point(|(existing_key, existing_score)| {
            existing_score.total_cmp(&score).is_gt()
                || (existing_score.total_cmp(&score).is_eq() && *existing_key < key)
        });
        if position >= self.limit {
            return Ok(false);
        }
        if self.hits.len() == self.limit {
            self.hits.pop();
        }
        self.hits.insert(position, (key, score));
        Ok(true)
    }

    #[must_use]
    pub fn results(&self) -> &[(u32, f64)] {
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

    #[doc = "# Errors\nRejects malformed candidate vectors or duplicate retained keys."]
    pub fn push(&mut self, key: u32, values: &[f32]) -> Result<bool, JsValue> {
        self.offer(key, values)
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
        if squared <= 0.0 {
            return Err("Vector has zero magnitude".into());
        }
        Ok(Self {
            values: prepared,
            norm: squared.sqrt(),
        })
    }

    #[doc = "# Errors\nRejects dimension mismatches, nonfinite components or zero-magnitude candidates."]
    pub fn cosine(&self, candidate: &[f32]) -> Result<f64, String> {
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
    use super::{MAX_DIMENSIONS, VectorQuery, VectorRanker};

    #[test]
    fn selection_is_bounded_exact_and_deterministic() -> Result<(), String> {
        let mut ranker = VectorRanker::try_new(&[1.0, 0.0], 2)?;
        assert!(ranker.offer(9, &[-1.0, 0.0])?);
        assert!(ranker.offer(8, &[0.0, 1.0])?);
        assert!(ranker.offer(7, &[1.0, 0.0])?);
        assert!(!ranker.offer(10, &[-1.0, 0.0])?);
        assert!(ranker.offer(3, &[1.0, 0.0])?);
        assert_eq!(ranker.results(), &[(3, 1.0), (7, 1.0)]);
        assert!(ranker.offer(3, &[1.0, 0.0]).is_err());
        assert!(VectorRanker::try_new(&[1.0], 0).is_err());
        assert!(VectorRanker::try_new(&[1.0], super::MAX_RESULTS + 1).is_err());
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
}
