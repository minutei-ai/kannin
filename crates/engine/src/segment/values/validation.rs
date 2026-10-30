use super::{MAX_ARRAY_ITEMS, MAX_FILTERABLE, MAX_NAME_BYTES, ScalarType, invalid, parse_tagged};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::borrow::Cow;
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(transparent)]
struct Text<'a>(#[serde(borrow)] Cow<'a, str>);

#[derive(Clone, Copy)]
struct CellCheck {
    element: bool,
}

impl<'de> DeserializeSeed<'de> for CellCheck {
    type Value = Option<ScalarType>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for CellCheck {
    type Value = Option<ScalarType>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a typed directory cell")
    }

    fn visit_bool<E: serde::de::Error>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(Some(ScalarType::Bool))
    }

    fn visit_str<E: serde::de::Error>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(Some(ScalarType::String))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        if self.element {
            return Err(invalid("Typed arrays reject null elements"));
        }
        Ok(None)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        if self.element {
            return Err(invalid("Typed arrays reject nested arrays"));
        }
        let mut count = 0;
        let mut kind = None;
        while let Some(element) = sequence.next_element_seed(Self { element: true })? {
            if count == MAX_ARRAY_ITEMS {
                return Err(invalid("Typed arrays exceed the element bound"));
            }
            if *kind.get_or_insert(element) != element {
                return Err(invalid("Typed arrays must be homogeneous"));
            }
            count += 1;
        }
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let tag = map
            .next_key::<Text<'de>>()?
            .ok_or_else(|| invalid::<A::Error>("Typed tag objects hold exactly one tag"))?;
        let value: Text<'de> = map.next_value()?;
        if map.next_key::<serde::de::IgnoredAny>()?.is_some() {
            return Err(invalid("Typed tag objects hold exactly one tag"));
        }
        parse_tagged(&tag.0, &value.0, false)
            .map(|cell| cell.scalar_type())
            .map_err(serde::de::Error::custom)
    }
}

struct AttributesCheck;

impl<'de> Visitor<'de> for AttributesCheck {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a typed directory attribute object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let mut names = BTreeSet::new();
        while let Some(Text(name)) = map.next_key::<Text<'de>>()? {
            if names.len() == MAX_FILTERABLE {
                return Err(invalid(
                    "Typed directory exceeds the filterable column bound",
                ));
            }
            if name.is_empty() || name.len() > MAX_NAME_BYTES || name.starts_with('$') {
                return Err(invalid("Invalid typed directory attribute name"));
            }
            if !names.insert(name) {
                return Err(invalid("Duplicate typed attribute name"));
            }
            map.next_value_seed(CellCheck { element: false })?;
        }
        Ok(())
    }
}

pub(super) fn validate(raw: &str) -> Result<(), String> {
    let mut decoder = serde_json::Deserializer::from_str(raw);
    decoder
        .deserialize_map(AttributesCheck)
        .map_err(|cause| cause.to_string())?;
    decoder.end().map_err(|cause| cause.to_string())
}

pub(super) const fn reservation(raw_bytes: usize) -> usize {
    // Retain at most 64 bounded names. Array cells are consumed individually.
    // Decoder scratch may grow geometrically to twice the current string length;
    // the borrowed-or-owned tag/value pair can additionally retain one raw length.
    let names =
        MAX_FILTERABLE * (MAX_NAME_BYTES + 4 * size_of::<String>() + 8 * size_of::<usize>());
    raw_bytes.saturating_mul(3).saturating_add(names)
}
