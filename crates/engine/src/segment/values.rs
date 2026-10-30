//! The single attribute cell owner.
//!
//! `Columns` stores every attribute as a [`Cell`]. Historical native and canonical
//! ingress wraps the unchanged `serde_json::Value` in [`Cell::Legacy`], so its bytes,
//! equality and ordering stay exactly as they were. Typed ingress and the typed
//! segment format (version 6) decode into the exact scalar variants. Which reading
//! applies is decided by the surrounding format version and never by the shape of the
//! value, so a legacy object that merely resembles a typed tag stays legacy.
//!
//! Typed wire: strings, booleans and `null` are bare JSON; `i64`, `u64`, `f64`, `uuid`,
//! `datetime_ms` and `bytes` are one-key objects holding a canonical string; arrays are
//! homogeneous arrays of non-null, non-bytes scalars. Bare JSON numbers are rejected.

use super::ids::{format_uuid, parse_canonical_u64, parse_uuid};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::ser::SerializeMap as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BTreeMap;

/// Local bound for typed array length. It is not a claim about any hosted limit.
const MAX_ARRAY_ITEMS: usize = 4096;
/// Local bound for one decoded `bytes` cell.
const MAX_BYTES_CELL: usize = 8 * 1024 * 1024;
const MAX_COLUMNS: usize = 1024;
const MAX_NAME_BYTES: usize = 128;
const MAX_FILTERABLE: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    /// An opaque historical JSON value. Its meaning is the legacy raw-JSON semantics.
    Legacy(Value),
    Null,
    Bool(bool),
    String(String),
    I64(i64),
    U64(u64),
    /// Always finite. Equality and ordering treat `-0` and `0` as equal; storage keeps the bits.
    F64(f64),
    Uuid([u8; 16]),
    /// Signed 64-bit epoch milliseconds.
    DatetimeMs(i64),
    /// Never filterable or indexable.
    Bytes(Vec<u8>),
    Array(Vec<Cell>),
}

impl From<Value> for Cell {
    /// The native legacy ingress adapter: wraps a raw JSON value without reinterpreting it.
    fn from(value: Value) -> Self {
        Self::Legacy(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScalarType {
    String,
    Bool,
    I64,
    U64,
    F64,
    Uuid,
    DatetimeMs,
    Bytes,
}

impl ScalarType {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Bool => "bool",
            Self::I64 => "i64",
            Self::U64 => "u64",
            Self::F64 => "f64",
            Self::Uuid => "uuid",
            Self::DatetimeMs => "datetime_ms",
            Self::Bytes => "bytes",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "string" => Self::String,
            "bool" => Self::Bool,
            "i64" => Self::I64,
            "u64" => Self::U64,
            "f64" => Self::F64,
            "uuid" => Self::Uuid,
            "datetime_ms" => Self::DatetimeMs,
            "bytes" => Self::Bytes,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellType {
    Scalar(ScalarType),
    /// A homogeneous array of one non-bytes scalar type.
    Array(ScalarType),
}

impl CellType {
    #[doc = "# Errors\nRejects unknown scalar names, malformed array brackets and arrays of bytes."]
    pub fn parse(text: &str) -> Result<Self, String> {
        let unknown = || format!("Unknown attribute type {text}");
        if let Some(inner) = text.strip_prefix('[') {
            let name = inner.strip_suffix(']').ok_or_else(unknown)?;
            let element = ScalarType::parse(name).ok_or_else(unknown)?;
            if element == ScalarType::Bytes {
                return Err("Arrays of bytes are not supported".into());
            }
            return Ok(Self::Array(element));
        }
        ScalarType::parse(text)
            .map(Self::Scalar)
            .ok_or_else(unknown)
    }

    #[must_use]
    pub fn name(self) -> String {
        match self {
            Self::Scalar(scalar) => scalar.name().to_owned(),
            Self::Array(element) => format!("[{}]", element.name()),
        }
    }
}

impl Cell {
    #[must_use]
    pub const fn as_legacy(&self) -> Option<&Value> {
        match self {
            Self::Legacy(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn is_legacy(&self) -> bool {
        matches!(self, Self::Legacy(_))
    }

    const fn scalar_type(&self) -> Option<ScalarType> {
        match self {
            Self::String(_) => Some(ScalarType::String),
            Self::Bool(_) => Some(ScalarType::Bool),
            Self::I64(_) => Some(ScalarType::I64),
            Self::U64(_) => Some(ScalarType::U64),
            Self::F64(_) => Some(ScalarType::F64),
            Self::Uuid(_) => Some(ScalarType::Uuid),
            Self::DatetimeMs(_) => Some(ScalarType::DatetimeMs),
            Self::Bytes(_) => Some(ScalarType::Bytes),
            Self::Legacy(_) | Self::Null | Self::Array(_) => None,
        }
    }

    #[doc = "# Errors\nRejects legacy cells, non-finite floats, oversized bytes or arrays, and heterogeneous, nested, null or bytes array elements."]
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Legacy(_) => Err("Legacy attribute cell in a typed context".into()),
            Self::Null
            | Self::Bool(_)
            | Self::String(_)
            | Self::I64(_)
            | Self::U64(_)
            | Self::Uuid(_)
            | Self::DatetimeMs(_) => Ok(()),
            Self::F64(value) if value.is_finite() => Ok(()),
            Self::F64(_) => Err("Typed f64 cells must be finite".into()),
            Self::Bytes(bytes) if bytes.len() <= MAX_BYTES_CELL => Ok(()),
            Self::Bytes(_) => Err("Typed bytes cells exceed the decoded size bound".into()),
            Self::Array(items) => {
                if items.len() > MAX_ARRAY_ITEMS {
                    return Err("Typed arrays exceed the element bound".into());
                }
                let mut element = None;
                for item in items {
                    item.validate()?;
                    let kind = item
                        .scalar_type()
                        .filter(|kind| *kind != ScalarType::Bytes)
                        .ok_or("Typed arrays hold only non-null, non-bytes scalars")?;
                    if *element.get_or_insert(kind) != kind {
                        return Err("Typed arrays must be homogeneous".into());
                    }
                }
                Ok(())
            }
        }
    }

    fn conforms(&self, declared: CellType, nullable: bool) -> bool {
        match (self, declared) {
            (Self::Null, _) => nullable,
            (Self::Array(items), CellType::Array(element)) => {
                items.iter().all(|item| item.scalar_type() == Some(element))
            }
            (cell, CellType::Scalar(expected)) => cell.scalar_type() == Some(expected),
            _ => false,
        }
    }

    /// Strictly typed ordering. Only equal ordered kinds compare; there is no coercion.
    fn compare(&self, other: &Self) -> Option<Ordering> {
        match (self, other) {
            (Self::String(left), Self::String(right)) => Some(left.cmp(right)),
            (Self::I64(left), Self::I64(right))
            | (Self::DatetimeMs(left), Self::DatetimeMs(right)) => Some(left.cmp(right)),
            (Self::U64(left), Self::U64(right)) => Some(left.cmp(right)),
            (Self::F64(left), Self::F64(right)) => left.partial_cmp(right),
            (Self::Uuid(left), Self::Uuid(right)) => Some(left.cmp(right)),
            _ => None,
        }
    }

    /// Small enough to share one filter-mask representative key.
    pub(super) fn is_small_scalar(&self) -> bool {
        match self {
            Self::Legacy(value) => {
                !value.is_array()
                    && !value.is_object()
                    && value.as_str().is_none_or(|text| text.len() <= 256)
            }
            Self::String(text) => text.len() <= 256,
            Self::Array(_) | Self::Bytes(_) => false,
            Self::Null
            | Self::Bool(_)
            | Self::I64(_)
            | Self::U64(_)
            | Self::F64(_)
            | Self::Uuid(_)
            | Self::DatetimeMs(_) => true,
        }
    }
}

fn invalid<E: serde::de::Error>(message: &str) -> E {
    E::custom(message)
}

fn tagged<S: Serializer>(serializer: S, tag: &str, value: &str) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(Some(1))?;
    map.serialize_entry(tag, value)?;
    map.end()
}

impl Serialize for Cell {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Legacy(value) => value.serialize(serializer),
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::String(value) => serializer.serialize_str(value),
            Self::I64(value) => tagged(serializer, "i64", &value.to_string()),
            Self::U64(value) => tagged(serializer, "u64", &value.to_string()),
            Self::F64(value) => tagged(serializer, "f64", &format!("{:016x}", value.to_bits())),
            Self::Uuid(value) => tagged(serializer, "uuid", &format_uuid(*value)),
            Self::DatetimeMs(value) => tagged(serializer, "datetime_ms", &value.to_string()),
            Self::Bytes(value) => tagged(serializer, "bytes", &encode_base64(value)),
            Self::Array(items) => serializer.collect_seq(items),
        }
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode_base64(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let mut group = [0_u8; 3];
        group[..chunk.len()].copy_from_slice(chunk);
        let word = (u32::from(group[0]) << 16) | (u32::from(group[1]) << 8) | u32::from(group[2]);
        for position in 0..4 {
            if position <= chunk.len() {
                let index = usize::try_from((word >> (18 - 6 * position)) & 63).unwrap_or(0);
                output.push(char::from(BASE64[index]));
            } else {
                output.push('=');
            }
        }
    }
    output
}

const fn base64_sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Strict, lossless standard base64: padded, canonical alphabet, zero trailing bits.
fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err("Typed bytes cells require padded base64".into());
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 {
        return Err("Typed bytes cells have invalid base64 padding".into());
    }
    let decoded = bytes.len() / 4 * 3 - padding;
    if decoded > MAX_BYTES_CELL {
        return Err("Typed bytes cells exceed the decoded size bound".into());
    }
    let mut output = Vec::with_capacity(decoded);
    let mut accumulator = 0_u32;
    let mut bits = 0_u32;
    for byte in &bytes[..bytes.len() - padding] {
        let sextet = base64_sextet(*byte).ok_or("Typed bytes cells have invalid base64")?;
        accumulator = (accumulator << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(
                u8::try_from((accumulator >> bits) & 255).map_err(|cause| cause.to_string())?,
            );
            accumulator &= (1 << bits) - 1;
        }
    }
    if accumulator != 0 {
        return Err("Typed bytes cells have noncanonical base64".into());
    }
    Ok(output)
}

fn parse_canonical_i64(value: &str) -> Result<i64, String> {
    let parsed = value.parse::<i64>().map_err(|cause| cause.to_string())?;
    if parsed.to_string() != value {
        return Err("Typed signed integers require canonical decimal".into());
    }
    Ok(parsed)
}

fn parse_f64_bits(value: &str) -> Result<f64, String> {
    if value.len() != 16
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("Typed f64 cells require sixteen lowercase hexadecimal digits".into());
    }
    let number = f64::from_bits(u64::from_str_radix(value, 16).map_err(|cause| cause.to_string())?);
    if number.is_finite() {
        Ok(number)
    } else {
        Err("Typed f64 cells must be finite".into())
    }
}

fn parse_tagged(tag: &str, value: &str, allow_bytes: bool) -> Result<Cell, String> {
    match tag {
        "i64" => parse_canonical_i64(value).map(Cell::I64),
        "u64" => parse_canonical_u64(value).map(Cell::U64),
        "f64" => parse_f64_bits(value).map(Cell::F64),
        "uuid" => parse_uuid(value)
            .map(Cell::Uuid)
            .map_err(|_cause| "Typed uuid cells require canonical lowercase form".to_owned()),
        "datetime_ms" => parse_canonical_i64(value).map(Cell::DatetimeMs),
        "bytes" if allow_bytes => decode_base64(value).map(Cell::Bytes),
        "bytes" => Err("Bytes cells are not filterable or indexable".into()),
        _ => Err(format!("Unknown typed cell tag {tag}")),
    }
}

/// Decodes one typed cell. `element` restricts the position to a non-null scalar that is
/// legal inside a typed array.
#[derive(Clone, Copy)]
pub(super) struct CellSeed {
    pub(super) allow_bytes: bool,
    pub(super) element: bool,
}

impl<'de> DeserializeSeed<'de> for CellSeed {
    type Value = Cell;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Cell, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for CellSeed {
    type Value = Cell;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a typed attribute cell")
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Cell, E> {
        Ok(Cell::Bool(value))
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Cell, E> {
        Ok(Cell::String(value.to_owned()))
    }

    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Cell, E> {
        Ok(Cell::String(value))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Cell, E> {
        if self.element {
            return Err(invalid("Typed arrays reject null elements"));
        }
        Ok(Cell::Null)
    }

    fn visit_i64<E: serde::de::Error>(self, _value: i64) -> Result<Cell, E> {
        Err(invalid("Typed attributes reject bare JSON numbers"))
    }

    fn visit_u64<E: serde::de::Error>(self, _value: u64) -> Result<Cell, E> {
        Err(invalid("Typed attributes reject bare JSON numbers"))
    }

    fn visit_f64<E: serde::de::Error>(self, _value: f64) -> Result<Cell, E> {
        Err(invalid("Typed attributes reject bare JSON numbers"))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Cell, A::Error> {
        if self.element {
            return Err(invalid("Typed arrays reject nested arrays"));
        }
        let mut items = Vec::new();
        let mut element = None;
        let seed = Self {
            allow_bytes: false,
            element: true,
        };
        while let Some(item) = sequence.next_element_seed(seed)? {
            if items.len() == MAX_ARRAY_ITEMS {
                return Err(invalid("Typed arrays exceed the element bound"));
            }
            let kind = item.scalar_type();
            if *element.get_or_insert(kind) != kind {
                return Err(invalid("Typed arrays must be homogeneous"));
            }
            items.push(item);
        }
        Ok(Cell::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Cell, A::Error> {
        let tag: String = map
            .next_key()?
            .ok_or_else(|| invalid::<A::Error>("Typed tag objects hold exactly one tag"))?;
        let value: String = map.next_value()?;
        if map.next_key::<serde::de::IgnoredAny>()?.is_some() {
            return Err(invalid("Typed tag objects hold exactly one tag"));
        }
        parse_tagged(&tag, &value, self.allow_bytes).map_err(serde::de::Error::custom)
    }
}

/// Decodes a JSON object of typed cells, rejecting duplicate attribute names.
#[derive(Clone, Copy)]
pub(super) struct TypedAttributesSeed {
    pub(super) allow_bytes: bool,
}

impl<'de> DeserializeSeed<'de> for TypedAttributesSeed {
    type Value = BTreeMap<String, Cell>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for TypedAttributesSeed {
    type Value = BTreeMap<String, Cell>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a typed attribute object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut attributes = BTreeMap::new();
        while let Some(name) = map.next_key::<String>()? {
            let cell = map.next_value_seed(CellSeed {
                allow_bytes: self.allow_bytes,
                element: false,
            })?;
            if attributes.insert(name, cell).is_some() {
                return Err(invalid("Duplicate typed attribute name"));
            }
        }
        Ok(attributes)
    }
}

/// Typed attributes as they appear on the stored and canonical typed wire.
pub(super) struct TypedAttributes(pub(super) BTreeMap<String, Cell>);

impl<'de> Deserialize<'de> for TypedAttributes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        TypedAttributesSeed { allow_bytes: true }
            .deserialize(deserializer)
            .map(Self)
    }
}

/// Decodes one typed cell from a JSON value that is a filter operand.
fn operand(value: &Value, element: bool) -> Result<Cell, String> {
    CellSeed {
        allow_bytes: false,
        element,
    }
    .deserialize(value)
    .map_err(|cause| cause.to_string())
}

fn operand_list(value: &Value, element: bool, name: &str) -> Result<Vec<Cell>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("Invalid {name} filter"))?;
    if items.len() > MAX_ARRAY_ITEMS {
        return Err(format!("Invalid {name} filter"));
    }
    items.iter().map(|item| operand(item, element)).collect()
}

#[derive(Clone, Copy)]
enum Bound {
    Gt,
    Gte,
    Lt,
    Lte,
}

impl Bound {
    const fn accepts(self, order: Ordering) -> bool {
        match self {
            Self::Gt => order.is_gt(),
            Self::Gte => order.is_ge(),
            Self::Lt => order.is_lt(),
            Self::Lte => order.is_le(),
        }
    }
}

enum Predicate {
    Eq(Cell),
    Ne(Cell),
    Exists(bool),
    In(Vec<Cell>),
    NotIn(Vec<Cell>),
    Contains(Cell),
    NotContains(Cell),
    ContainsAny(Vec<Cell>),
    NotContainsAny(Vec<Cell>),
    Range(Bound, Cell),
}

/// A filter whose operand was decoded once with typed-wire rules. It evaluates against typed
/// cells only, with exact equality and strictly same-kind ordering: a different kind never
/// equals and never orders, and nothing is coerced through floating point.
pub(super) struct TypedFilter(Predicate);

impl TypedFilter {
    pub(super) fn prepare(op: &str, value: &Value) -> Result<Self, String> {
        Ok(Self(match op {
            "eq" => Predicate::Eq(operand(value, false)?),
            "ne" => Predicate::Ne(operand(value, false)?),
            "exists" => Predicate::Exists(value.as_bool().ok_or("Invalid exists filter")?),
            "in" => Predicate::In(operand_list(value, false, "in")?),
            "notIn" => Predicate::NotIn(operand_list(value, false, "notIn")?),
            "contains" => Predicate::Contains(operand(value, true)?),
            "notContains" => Predicate::NotContains(operand(value, true)?),
            "containsAny" => Predicate::ContainsAny(operand_list(value, true, "containsAny")?),
            "notContainsAny" => {
                Predicate::NotContainsAny(operand_list(value, true, "notContainsAny")?)
            }
            "gt" => Predicate::Range(Bound::Gt, operand(value, false)?),
            "gte" => Predicate::Range(Bound::Gte, operand(value, false)?),
            "lt" => Predicate::Range(Bound::Lt, operand(value, false)?),
            "lte" => Predicate::Range(Bound::Lte, operand(value, false)?),
            _ => return Err("Unknown filter operation".into()),
        }))
    }

    pub(super) fn matches(&self, actual: Option<&Cell>) -> Result<bool, String> {
        if actual.is_some_and(Cell::is_legacy) {
            return Err("Legacy attribute cell in a typed segment".into());
        }
        let listed = |items: &[Cell]| actual.is_some_and(|value| items.contains(value));
        let holds = |expected: &Cell| matches!(actual, Some(Cell::Array(values)) if values.contains(expected));
        Ok(match &self.0 {
            Predicate::Eq(expected) => actual == Some(expected),
            Predicate::Ne(expected) => actual != Some(expected),
            Predicate::Exists(flag) => actual.is_some() == *flag,
            Predicate::In(items) => listed(items),
            Predicate::NotIn(items) => !listed(items),
            Predicate::Contains(expected) => holds(expected),
            Predicate::NotContains(expected) => !holds(expected),
            Predicate::ContainsAny(items) => items.iter().any(holds),
            Predicate::NotContainsAny(items) => !items.iter().any(holds),
            Predicate::Range(bound, expected) => actual
                .and_then(|value| value.compare(expected))
                .is_some_and(|order| bound.accepts(order)),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ColumnSpec {
    pub name: String,
    pub ty: CellType,
    pub filterable: bool,
    pub nullable: bool,
}

impl ColumnSpec {
    #[doc = "# Errors\nRejects empty, overlong or `$`-prefixed names, filterable or indexable bytes, and arrays of bytes."]
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() || self.name.len() > MAX_NAME_BYTES || self.name.starts_with('$') {
            return Err(format!("Invalid attribute name {}", self.name));
        }
        match self.ty {
            CellType::Array(ScalarType::Bytes) => {
                return Err("Arrays of bytes are not supported".into());
            }
            CellType::Scalar(ScalarType::Bytes) if self.filterable => {
                return Err("Bytes attributes cannot be filterable".into());
            }
            CellType::Scalar(_) | CellType::Array(_) => {}
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnWire {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    filterable: bool,
    #[serde(default)]
    nullable: bool,
}

/// Normalized, validated attribute declarations for a typed segment.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct AttributeSchema {
    columns: BTreeMap<String, ColumnSpec>,
}

impl AttributeSchema {
    #[doc = "# Errors\nRejects invalid or duplicate columns, more than 1024 columns and more than 64 filterable columns."]
    pub fn new(columns: Vec<ColumnSpec>) -> Result<Self, String> {
        if columns.len() > MAX_COLUMNS {
            return Err("Attribute declarations exceed 1024 columns".into());
        }
        let mut declared = BTreeMap::new();
        for column in columns {
            column.validate()?;
            let name = column.name.clone();
            if declared.insert(name.clone(), column).is_some() {
                return Err(format!("Duplicate attribute declaration {name}"));
            }
        }
        if declared.values().filter(|column| column.filterable).count() > MAX_FILTERABLE {
            return Err("Filterable attributes exceed 64".into());
        }
        Ok(Self { columns: declared })
    }

    #[doc = "# Errors\nRejects malformed JSON, unknown members (including unimplemented features such as full-text, vector, inference or drop flags), non-boolean flags, unknown types and everything `new` rejects."]
    pub fn from_json(json: &str) -> Result<Self, String> {
        let wire: Vec<ColumnWire> =
            serde_json::from_str(json).map_err(|cause| cause.to_string())?;
        Self::new(
            wire.into_iter()
                .map(|column| -> Result<ColumnSpec, String> {
                    Ok(ColumnSpec {
                        ty: CellType::parse(&column.ty)?,
                        name: column.name,
                        filterable: column.filterable,
                        nullable: column.nullable,
                    })
                })
                .collect::<Result<_, String>>()?,
        )
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&ColumnSpec> {
        self.columns.get(name)
    }

    pub fn columns(&self) -> impl ExactSizeIterator<Item = &ColumnSpec> {
        self.columns.values()
    }

    #[must_use]
    pub fn filterable_names(&self) -> Vec<String> {
        self.columns
            .values()
            .filter(|column| column.filterable)
            .map(|column| column.name.clone())
            .collect()
    }

    #[doc = "# Errors\nRejects undeclared attributes, legacy cells, invalid cells, kind mismatches, and null in a non-nullable column. A missing entry is always allowed and stays distinct from null."]
    pub fn validate_attributes(&self, attributes: &BTreeMap<String, Cell>) -> Result<(), String> {
        for (name, cell) in attributes {
            let column = self
                .columns
                .get(name)
                .ok_or_else(|| format!("Undeclared attribute {name}"))?;
            cell.validate()?;
            if !cell.conforms(column.ty, column.nullable) {
                return Err(format!(
                    "Attribute {name} does not match its declared {} type",
                    column.ty.name()
                ));
            }
        }
        Ok(())
    }

    #[doc = "# Errors\nRejects a named text attribute that is not declared as a string or an array of strings."]
    pub fn validate_text_field(&self, name: &str) -> Result<(), String> {
        match self.columns.get(name).map(|column| column.ty) {
            Some(CellType::Scalar(ScalarType::String) | CellType::Array(ScalarType::String)) => {
                Ok(())
            }
            _ => Err(format!(
                "Named text attribute {name} must be a declared string or string array"
            )),
        }
    }
}

#[doc = "# Errors\nRejects malformed JSON, duplicate attribute names, bare numbers, malformed or unknown tags and heterogeneous arrays."]
pub fn decode_typed_attributes(json: &str) -> Result<BTreeMap<String, Cell>, String> {
    let mut decoder = serde_json::Deserializer::from_str(json);
    let attributes = TypedAttributesSeed { allow_bytes: true }
        .deserialize(&mut decoder)
        .map_err(|cause| cause.to_string())?;
    decoder.end().map_err(|cause| cause.to_string())?;
    Ok(attributes)
}

/// Validates a directory attribute object: the typed grammar without `bytes`, which is never
/// filterable and therefore never part of a directory.
pub(super) fn validate_directory_attributes(raw: &str) -> Result<(), String> {
    let mut decoder = serde_json::Deserializer::from_str(raw);
    TypedAttributesSeed { allow_bytes: false }
        .deserialize(&mut decoder)
        .map_err(|cause| cause.to_string())?;
    decoder.end().map_err(|cause| cause.to_string())
}

#[cfg(test)]
mod tests;
