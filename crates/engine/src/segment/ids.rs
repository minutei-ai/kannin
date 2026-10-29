use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[doc = "Canonical document identity. Strings remain strings; integer and UUID identities never alias them."]
#[derive(Clone, Copy, Debug)]
pub enum DocumentId<S = String> {
    String(S),
    Uint(u64),
    Uuid([u8; 16]),
}

pub type DocumentIdRef<'a> = DocumentId<&'a str>;

impl<S: AsRef<str>> DocumentId<S> {
    #[must_use]
    pub fn borrowed(&self) -> DocumentIdRef<'_> {
        match self {
            Self::String(value) => DocumentId::String(value.as_ref()),
            Self::Uint(value) => DocumentId::Uint(*value),
            Self::Uuid(value) => DocumentId::Uuid(*value),
        }
    }

    #[doc = "# Errors\nRejects typed identities at historical string-only adapters."]
    pub fn native_str(&self) -> Result<&str, String> {
        match self {
            Self::String(value) => Ok(value.as_ref()),
            Self::Uint(_) | Self::Uuid(_) => {
                Err("Typed document id requires a canonical adapter".into())
            }
        }
    }

    #[must_use]
    pub fn is_valid(&self) -> bool {
        match self {
            Self::String(value) => {
                !value.as_ref().is_empty() && value.as_ref().encode_utf16().count() <= 128
            }
            Self::Uint(_) | Self::Uuid(_) => true,
        }
    }

    #[must_use]
    pub fn encoded_len(&self) -> usize {
        match self {
            Self::String(value) => value.as_ref().len(),
            Self::Uint(_) => 20,
            Self::Uuid(_) => 36,
        }
    }

    #[must_use]
    pub fn into_boxed(self) -> DocumentId<Box<str>> {
        match self {
            Self::String(value) => DocumentId::String(value.as_ref().into()),
            Self::Uint(value) => DocumentId::Uint(value),
            Self::Uuid(value) => DocumentId::Uuid(value),
        }
    }
}

impl DocumentId<String> {
    #[must_use]
    pub const fn heap_bytes(&self) -> usize {
        match self {
            Self::String(value) => value.capacity(),
            Self::Uint(_) | Self::Uuid(_) => 0,
        }
    }
}

impl DocumentIdRef<'_> {
    #[must_use]
    pub fn to_owned(self) -> DocumentId {
        match self {
            Self::String(value) => DocumentId::String(value.to_owned()),
            Self::Uint(value) => DocumentId::Uint(value),
            Self::Uuid(value) => DocumentId::Uuid(value),
        }
    }
}

impl From<String> for DocumentId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}
impl From<&str> for DocumentId {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}
impl<'a> From<&'a str> for DocumentIdRef<'a> {
    fn from(value: &'a str) -> Self {
        Self::String(value)
    }
}
impl<'a> From<&'a String> for DocumentIdRef<'a> {
    fn from(value: &'a String) -> Self {
        Self::String(value)
    }
}
impl<'a, S: AsRef<str>> From<&'a DocumentId<S>> for DocumentIdRef<'a> {
    fn from(value: &'a DocumentId<S>) -> Self {
        value.borrowed()
    }
}
impl From<&str> for DocumentId<Box<str>> {
    fn from(value: &str) -> Self {
        Self::String(value.into())
    }
}

impl<S: AsRef<str>> PartialOrd for DocumentId<S> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl<S: AsRef<str>> Eq for DocumentId<S> {}

impl<S: AsRef<str>, T: AsRef<str>> PartialEq<DocumentId<T>> for DocumentId<S> {
    fn eq(&self, other: &DocumentId<T>) -> bool {
        compare(self.borrowed(), other.borrowed()).is_eq()
    }
}

impl<S: AsRef<str>> Ord for DocumentId<S> {
    fn cmp(&self, other: &Self) -> Ordering {
        compare(self.borrowed(), other.borrowed())
    }
}

pub(super) fn compare(left: DocumentIdRef<'_>, right: DocumentIdRef<'_>) -> Ordering {
    match (left, right) {
        (DocumentId::String(left), DocumentId::String(right)) => {
            left.encode_utf16().cmp(right.encode_utf16())
        }
        (DocumentId::Uint(left), DocumentId::Uint(right)) => left.cmp(&right),
        (DocumentId::Uuid(left), DocumentId::Uuid(right)) => left.cmp(&right),
        (DocumentId::String(_), _) | (DocumentId::Uint(_), DocumentId::Uuid(_)) => Ordering::Less,
        (DocumentId::Uint(_) | DocumentId::Uuid(_), DocumentId::String(_))
        | (DocumentId::Uuid(_), DocumentId::Uint(_)) => Ordering::Greater,
    }
}

impl<S: AsRef<str>> PartialEq<&str> for DocumentId<S> {
    fn eq(&self, other: &&str) -> bool {
        matches!(self, Self::String(value) if value.as_ref() == *other)
    }
}
impl<S: AsRef<str>> PartialEq<String> for DocumentId<S> {
    fn eq(&self, other: &String) -> bool {
        matches!(self, Self::String(value) if value.as_ref() == other.as_str())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", deny_unknown_fields)]
enum TaggedId {
    #[serde(rename = "uint")]
    Uint(String),
    #[serde(rename = "uuid")]
    Uuid(String),
}

fn parse_uuid(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 36 {
        return Err("UUID id must use canonical lowercase form".into());
    }
    let mut result = [0; 16];
    let mut nibble = 0;
    for (index, byte) in value.bytes().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return Err("UUID id must use canonical lowercase form".into());
            }
            continue;
        }
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => return Err("UUID id must use canonical lowercase form".into()),
        };
        result[nibble / 2] = (result[nibble / 2] << 4) | digit;
        nibble += 1;
    }
    Ok(result)
}

fn format_uuid(value: [u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(36);
    for (index, byte) in value.into_iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            output.push('-');
        }
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 15)]));
    }
    output
}

impl<S: AsRef<str>> Serialize for DocumentId<S> {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        match self {
            Self::String(value) => serializer.serialize_str(value.as_ref()),
            Self::Uint(value) => TaggedId::Uint(value.to_string()).serialize(serializer),
            Self::Uuid(value) => TaggedId::Uuid(format_uuid(*value)).serialize(serializer),
        }
    }
}

impl<'de, S: From<String>> Deserialize<'de> for DocumentId<S> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            String(String),
            Tagged(TaggedId),
        }
        match Wire::deserialize(deserializer)? {
            Wire::String(value) => Ok(Self::String(value.into())),
            Wire::Tagged(TaggedId::Uint(value)) => {
                if value.is_empty()
                    || (value.len() > 1 && value.starts_with('0'))
                    || !value.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err(serde::de::Error::custom(
                        "Uint id requires canonical unsigned decimal",
                    ));
                }
                value
                    .parse::<u64>()
                    .map(Self::Uint)
                    .map_err(serde::de::Error::custom)
            }
            Wire::Tagged(TaggedId::Uuid(value)) => parse_uuid(&value)
                .map(Self::Uuid)
                .map_err(serde::de::Error::custom),
        }
    }
}

impl From<String> for DocumentId<Box<str>> {
    fn from(value: String) -> Self {
        Self::String(value.into_boxed_str())
    }
}
impl<S: AsRef<str>> PartialEq<DocumentId<S>> for String {
    fn eq(&self, other: &DocumentId<S>) -> bool {
        other == self
    }
}
impl<S: AsRef<str>> PartialEq<DocumentId<S>> for &str {
    fn eq(&self, other: &DocumentId<S>) -> bool {
        other == self
    }
}

#[cfg(test)]
mod tests {
    use super::DocumentId;
    use serde_json::json;

    #[test]
    fn canonical_transport_keeps_exact_domains_and_bounds() -> Result<(), Box<dyn std::error::Error>>
    {
        for value in [0, 1, 2, 10, u64::MAX] {
            let id = DocumentId::<String>::Uint(value);
            let wire = json!({"kind":"uint","value":value.to_string()});
            assert_eq!(serde_json::to_value(&id)?, wire);
            assert_eq!(serde_json::from_value::<DocumentId>(wire)?, id);
        }
        assert!(DocumentId::<String>::Uint(2) < DocumentId::Uint(10));
        assert_ne!(
            DocumentId::<String>::Uint(1),
            DocumentId::<String>::from("1")
        );
        assert_eq!(
            serde_json::to_value(DocumentId::<String>::from("1"))?,
            json!("1")
        );
        for value in [
            "",
            "00",
            "01",
            "+1",
            "-1",
            "1.0",
            " 1",
            "18446744073709551616",
        ] {
            assert!(
                serde_json::from_value::<DocumentId>(json!({"kind":"uint","value":value})).is_err()
            );
        }
        for wire in [
            json!(1),
            json!({"kind":"uint","value":1}),
            json!({"kind":"uint","value":"1","extra":0}),
            json!({"kind":"unknown","value":"1"}),
        ] {
            assert!(serde_json::from_value::<DocumentId>(wire).is_err());
        }
        Ok(())
    }

    #[test]
    fn uuid_transport_rejects_noncanonical_form_and_never_infers_strings()
    -> Result<(), Box<dyn std::error::Error>> {
        let first = "00112233-4455-6677-8899-aabbccddeeff";
        let second = "00112233-4455-6677-8899-aabbccddef00";
        let decode =
            |value| serde_json::from_value::<DocumentId>(json!({"kind":"uuid","value":value}));
        let id = decode(first)?;
        assert_eq!(
            serde_json::to_value(&id)?,
            json!({"kind":"uuid","value":first})
        );
        assert!(id < decode(second)?);
        assert_ne!(id, DocumentId::<String>::from(first));
        assert!(id.native_str().is_err());
        assert!(DocumentId::<String>::Uint(u64::MAX).native_str().is_err());
        for value in [
            "00112233-4455-6677-8899-AABBCCDDEEFF",
            "00112233445566778899aabbccddeeff",
            "00112233_4455-6677-8899-aabbccddeeff",
            "00112233-4455-6677-8899-aabbccddeefg",
            "00112233-4455-6677-8899-aabbccddeeff0",
        ] {
            assert!(decode(value).is_err());
        }
        Ok(())
    }
}
