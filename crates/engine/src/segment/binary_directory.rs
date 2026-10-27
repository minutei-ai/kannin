use super::{
    BlockMeta, DocumentMeta, FILTER_CACHE_BYTES, Header, Range, TermDictionary, TermMeta, get_int,
    put_int,
};
use std::cell::RefCell;

fn put_long(mut value: u64, bytes: &mut Vec<u8>) {
    while value >= 128 {
        bytes.push(value.to_le_bytes()[0] | 128);
        value >>= 7;
    }
    bytes.push(value.to_le_bytes()[0]);
}

fn put_text(value: &str, bytes: &mut Vec<u8>) -> Result<(), String> {
    put_int(
        u32::try_from(value.len()).map_err(|cause| cause.to_string())?,
        bytes,
    );
    bytes.extend_from_slice(value.as_bytes());
    Ok(())
}

const fn integer_size(mut value: usize) -> usize {
    let mut size = 1;
    while value >= 128 {
        value >>= 7;
        size += 1;
    }
    size
}

fn encode_columns(header: &Header, bytes: &mut Vec<u8>) -> Result<(), String> {
    put_int(header.metadata_end, bytes);
    put_int(header.vector_end, bytes);
    put_int(
        u32::try_from(header.vector_ranges.len()).map_err(|cause| cause.to_string())?,
        bytes,
    );
    for range in &header.vector_ranges {
        put_int(range.offset, bytes);
        put_int(range.length, bytes);
    }
    Ok(())
}

pub(super) fn encode(header: &Header) -> Result<Vec<u8>, String> {
    encode_terms(header, &header.terms)
}

fn plan_attributes(
    column: &super::AttributeColumn,
) -> Result<(std::collections::BTreeMap<&str, u32>, bool, usize), String> {
    let mut attributes: std::collections::BTreeMap<&str, u32> = match column {
        super::AttributeColumn::Dense(values) => {
            values.iter().map(|value| (value.get(), 0)).collect()
        }
        super::AttributeColumn::Dictionary { .. } => std::collections::BTreeMap::new(),
    };
    for (index, value) in attributes.values_mut().enumerate() {
        *value = u32::try_from(index).map_err(|cause| cause.to_string())?;
    }
    let (plain_bytes, dictionary_bytes, unique) = match column {
        super::AttributeColumn::Dictionary { values, counts, .. } => {
            let mut plain = 0;
            let mut dictionary = integer_size(values.len());
            for (index, (value, count)) in values.iter().zip(counts).enumerate() {
                let bytes = integer_size(value.get().len()) + value.get().len();
                plain += bytes * usize::from(*count);
                dictionary += bytes + integer_size(index) * usize::from(*count);
            }
            (plain, dictionary, values.len())
        }
        super::AttributeColumn::Dense(values) => {
            let plain = values
                .iter()
                .map(|value| integer_size(value.get().len()) + value.get().len())
                .sum::<usize>();
            let mut dictionary = integer_size(attributes.len())
                + attributes
                    .keys()
                    .map(|value| integer_size(value.len()) + value.len())
                    .sum::<usize>();
            for value in values {
                dictionary += integer_size(
                    *attributes
                        .get(value.get())
                        .ok_or("Missing directory attribute")? as usize,
                );
            }
            (plain, dictionary, attributes.len())
        }
    };
    let dictionary = dictionary_bytes < plain_bytes;
    Ok((attributes, dictionary, unique))
}

pub(super) fn encode_terms(header: &Header, terms: &TermDictionary) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    put_int(header.version, &mut bytes);
    put_int(
        u32::try_from(header.documents.len()).map_err(|cause| cause.to_string())?,
        &mut bytes,
    );
    let (attributes, dictionary, unique) = plan_attributes(&header.documents.attributes)?;
    put_int(u32::from(dictionary), &mut bytes);
    if dictionary {
        put_int(
            u32::try_from(unique).map_err(|cause| cause.to_string())?,
            &mut bytes,
        );
        match &header.documents.attributes {
            super::AttributeColumn::Dictionary { values, .. } => {
                for value in values {
                    put_text(value.get(), &mut bytes)?;
                }
            }
            super::AttributeColumn::Dense(_) => {
                for value in attributes.keys() {
                    put_text(value, &mut bytes)?;
                }
            }
        }
    }
    for (row, document) in header.documents.iter().enumerate() {
        put_text(document.id, &mut bytes)?;
        put_long(document.revision, &mut bytes);
        put_int(document.title_length, &mut bytes);
        put_int(document.body_length, &mut bytes);
        if dictionary {
            let index = match &header.documents.attributes {
                super::AttributeColumn::Dictionary { indexes, .. } => u32::from(indexes[row]),
                super::AttributeColumn::Dense(_) => *attributes
                    .get(document.attributes.get())
                    .ok_or("Missing directory attribute")?,
            };
            put_int(index, &mut bytes);
        } else {
            put_text(document.attributes.get(), &mut bytes)?;
        }
        put_int(document.data.offset, &mut bytes);
        put_int(document.data.length, &mut bytes);
        put_int(u32::from(document.vector), &mut bytes);
    }
    put_int(
        u32::try_from(terms.len()).map_err(|cause| cause.to_string())?,
        &mut bytes,
    );
    for (term, metadata) in terms {
        put_text(term, &mut bytes)?;
        put_int(metadata.df, &mut bytes);
        put_int(
            u32::try_from(metadata.blocks.len()).map_err(|cause| cause.to_string())?,
            &mut bytes,
        );
        for block in &metadata.blocks {
            for value in [
                block.first,
                block.last,
                block.count,
                block.max_title_tf,
                block.max_body_tf,
                block.min_title_length,
                block.min_body_length,
                block.data.offset,
                block.data.length,
            ] {
                put_int(value, &mut bytes);
            }
        }
    }
    put_long(header.total_title_length, &mut bytes);
    put_long(header.total_body_length, &mut bytes);
    encode_columns(header, &mut bytes)?;
    Ok(bytes)
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    available: usize,
}

impl<'a> Decoder<'a> {
    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        self.available = self
            .available
            .checked_sub(bytes)
            .ok_or("Directory allocation budget exceeded")?;
        Ok(())
    }

    fn integer(&mut self) -> Result<u32, String> {
        get_int(self.bytes, &mut self.offset)
    }

    fn long(&mut self) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..=63).step_by(7) {
            let byte = *self
                .bytes
                .get(self.offset)
                .ok_or("Truncated directory integer")?;
            self.offset += 1;
            if shift == 63 && byte > 1 {
                return Err("Overflowing directory integer".into());
            }
            value |= u64::from(byte & 127) << shift;
            if byte < 128 {
                return Ok(value);
            }
        }
        Err("Overflowing directory integer".into())
    }

    fn text_slice(&mut self) -> Result<&'a str, String> {
        let length = self.integer()? as usize;
        let end = self
            .offset
            .checked_add(length)
            .ok_or("Directory string overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("Truncated directory string")?;
        self.offset = end;
        std::str::from_utf8(value).map_err(|cause| cause.to_string())
    }

    fn text(&mut self) -> Result<String, String> {
        let value = self.text_slice()?;
        self.charge(
            value
                .len()
                .checked_add(16)
                .ok_or("Directory allocation overflow")?,
        )?;
        Ok(value.to_owned())
    }

    fn range(&mut self) -> Result<Range, String> {
        Ok(Range {
            offset: self.integer()?,
            length: self.integer()?,
        })
    }
    fn document_id(&mut self, ids: &mut String) -> Result<std::ops::Range<usize>, String> {
        let value = self.text_slice()?;
        let start = ids.len();
        let end = start
            .checked_add(value.len())
            .ok_or("Directory id overflow")?;
        if end > ids.capacity() {
            let capacity = end.max(ids.capacity().saturating_mul(2));
            self.charge(capacity - ids.capacity())?;
            ids.reserve_exact(capacity - ids.len());
        }
        ids.push_str(value);
        Ok(start..end)
    }

    fn attribute_values(&mut self, count: usize) -> Result<Vec<super::DocumentAttributes>, String> {
        self.charge(count * size_of::<super::DocumentAttributes>())?;
        let mut values = Vec::<super::DocumentAttributes>::with_capacity(count);
        for _ in 0..count {
            let value = serde_json::value::RawValue::from_string(self.text()?)
                .map_err(|cause| cause.to_string())?;
            if values
                .last()
                .is_some_and(|previous| previous.get() >= value.get())
            {
                return Err("Directory attributes are not strictly sorted".into());
            }
            values.push(super::DocumentAttributes::Shared(value.into()));
        }
        Ok(values)
    }

    fn scalar<T: Copy + PartialEq>(
        &mut self,
        column: &mut super::ScalarColumn<T>,
        capacity: usize,
        read: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<(), String> {
        let value = read(self)?;
        column.push_charged(value, capacity, |bytes| self.charge(bytes))
    }

    fn documents(&mut self) -> Result<super::DocumentTable, String> {
        let count = self.integer()? as usize;
        if count > 10000 {
            return Err("Directory document limit exceeded".into());
        }
        if count > self.bytes.len().saturating_sub(self.offset) / 9 {
            return Err("Truncated directory documents".into());
        }
        self.charge(
            count
                .checked_mul(size_of::<DocumentMeta<std::ops::Range<usize>, (), (), ()>>())
                .ok_or("Directory allocation overflow")?,
        )?;
        let mode = self.integer()?;
        let mut values = Vec::<super::DocumentAttributes>::new();
        let mut indexes = Vec::<u16>::new();
        let mut counts = Vec::<u16>::new();
        match mode {
            0 => {
                self.charge(count * size_of::<super::DocumentAttributes>())?;
                values.reserve_exact(count);
            }
            1 => {
                let unique = self.integer()? as usize;
                if unique == 0
                    || unique > count
                    || unique > self.bytes.len().saturating_sub(self.offset) / 2
                {
                    return Err("Invalid directory attribute count".into());
                }
                self.charge((unique + count) * size_of::<u16>())?;
                values = self.attribute_values(unique)?;
                indexes.reserve_exact(count);
                counts.reserve_exact(unique);
                counts.resize(unique, 0);
            }
            _ => return Err("Invalid directory attribute mode".into()),
        }
        let mut documents = Vec::with_capacity(count);
        let mut title_lengths = super::ScalarColumn::new();
        let mut body_lengths = super::ScalarColumn::new();
        let mut vectors = super::ScalarColumn::new();
        let mut ids = String::new();
        for _ in 0..count {
            let id = self.document_id(&mut ids)?;
            let revision = self.long()?;
            self.scalar(&mut title_lengths, count, Self::integer)?;
            self.scalar(&mut body_lengths, count, Self::integer)?;
            if mode == 0 {
                values.push(super::DocumentAttributes::Owned(
                    serde_json::value::RawValue::from_string(self.text()?)
                        .map_err(|cause| cause.to_string())?,
                ));
            } else {
                let index = self.integer()? as usize;
                let frequency = counts
                    .get_mut(index)
                    .ok_or("Invalid directory attribute index")?;
                *frequency += 1;
                indexes.push(u16::try_from(index).map_err(|cause| cause.to_string())?);
            }
            let data = self.range()?;
            self.scalar(&mut vectors, count, |decoder| match decoder.integer()? {
                0 => Ok(false),
                1 => Ok(true),
                _ => Err("Invalid directory vector flag".into()),
            })?;
            documents.push(DocumentMeta {
                id,
                revision,
                title_length: (),
                body_length: (),
                attributes: (),
                data,
                vector: (),
            });
        }
        if counts.contains(&0) {
            return Err("Unused directory attribute".into());
        }
        Ok(super::DocumentTable {
            ids,
            rows: documents,
            title_lengths,
            body_lengths,
            vectors,
            attributes: if mode == 0 {
                super::AttributeColumn::Dense(values)
            } else {
                super::AttributeColumn::Dictionary {
                    values,
                    indexes,
                    counts,
                }
            },
        })
    }

    fn terms(&mut self, document_count: usize) -> Result<TermDictionary, String> {
        let count = self.integer()? as usize;
        if count > self.bytes.len().saturating_sub(self.offset) / 3 {
            return Err("Truncated directory terms".into());
        }
        self.charge(
            count
                .checked_mul(size_of::<(std::ops::Range<usize>, TermMeta)>())
                .ok_or("Directory allocation overflow")?,
        )?;
        let mut entries = Vec::<(std::ops::Range<usize>, TermMeta)>::with_capacity(count);
        let mut text_length = 0usize;
        for _ in 0..count {
            let term = self.text_slice()?;
            let range = self.offset - term.len()..self.offset;
            text_length = text_length
                .checked_add(term.len())
                .ok_or("Directory allocation overflow")?;
            if entries
                .last()
                .is_some_and(|previous| self.bytes[previous.0.clone()] >= self.bytes[range.clone()])
            {
                return Err("Directory terms are not strictly sorted".into());
            }
            let df = self.integer()?;
            let count = self.integer()? as usize;
            if count > document_count {
                return Err("Directory block count exceeds document count".into());
            }
            if count > self.bytes.len().saturating_sub(self.offset) / 9 {
                return Err("Truncated directory blocks".into());
            }
            self.charge(
                count
                    .checked_mul(size_of::<BlockMeta>())
                    .ok_or("Directory allocation overflow")?,
            )?;
            let mut blocks = Vec::with_capacity(count);
            for _ in 0..count {
                blocks.push(BlockMeta {
                    first: self.integer()?,
                    last: self.integer()?,
                    count: self.integer()?,
                    max_title_tf: self.integer()?,
                    max_body_tf: self.integer()?,
                    min_title_length: self.integer()?,
                    min_body_length: self.integer()?,
                    data: self.range()?,
                });
            }
            entries.push((
                range,
                TermMeta {
                    df,
                    blocks: blocks.into_boxed_slice(),
                },
            ));
        }
        self.charge(
            text_length
                .checked_add(16)
                .ok_or("Directory allocation overflow")?,
        )?;
        let mut text = String::with_capacity(text_length);
        for (range, _) in &mut entries {
            let start = text.len();
            text.push_str(
                std::str::from_utf8(&self.bytes[range.clone()])
                    .map_err(|cause| cause.to_string())?,
            );
            *range = start..text.len();
        }
        Ok(TermDictionary {
            text: text.into_boxed_str(),
            entries: entries.into_boxed_slice(),
        })
    }
}

pub(super) fn decode(bytes: &[u8], max_heap_bytes: usize) -> Result<Header, String> {
    let mut decoder = Decoder {
        bytes,
        offset: 0,
        available: max_heap_bytes,
    };
    decoder.charge(size_of::<Header>() + 32 + FILTER_CACHE_BYTES)?;
    let version = decoder.integer()?;
    let documents = decoder.documents()?;
    let terms = decoder.terms(documents.len())?;
    let total_title_length = decoder.long()?;
    let total_body_length = decoder.long()?;
    let metadata_end = decoder.integer()?;
    let vector_end = decoder.integer()?;
    let count = decoder.integer()? as usize;
    if count > documents.len() {
        return Err("Vector range count exceeds document count".into());
    }
    decoder.charge(
        count
            .checked_mul(size_of::<Range>())
            .ok_or("Vector range allocation overflow")?,
    )?;
    let mut vector_ranges = Vec::with_capacity(count);
    for _ in 0..count {
        vector_ranges.push(Range {
            offset: decoder.integer()?,
            length: decoder.integer()?,
        });
    }
    decoder.charge(documents.len().div_ceil(64) * size_of::<u32>())?;
    let vector_prefix = super::vector_prefix(&documents)?;
    if decoder.offset != bytes.len() {
        return Err("Trailing directory bytes".into());
    }
    Ok(Header {
        filter_masks: RefCell::default(),
        version,
        documents,
        terms,
        total_title_length,
        total_body_length,
        metadata_end,
        vector_end,
        vector_ranges,
        vector_prefix,
    })
}

#[cfg(test)]
mod dictionary_frames_tests {
    use super::{decode, put_int, put_long, put_text};
    fn payload(values: &[&str], indices: &[u32]) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        put_int(2, &mut bytes);
        put_int(
            u32::try_from(indices.len()).map_err(|e| e.to_string())?,
            &mut bytes,
        );
        put_int(1, &mut bytes);
        put_int(
            u32::try_from(values.len()).map_err(|e| e.to_string())?,
            &mut bytes,
        );
        for value in values {
            put_text(value, &mut bytes)?;
        }
        for (i, index) in indices.iter().enumerate() {
            put_text(&format!("row-{i:04}"), &mut bytes)?;
            put_long(0, &mut bytes);
            put_int(0, &mut bytes);
            put_int(0, &mut bytes);
            put_int(*index, &mut bytes);
            put_int(0, &mut bytes);
            put_int(0, &mut bytes);
            put_int(0, &mut bytes);
        }
        put_int(0, &mut bytes);
        put_long(0, &mut bytes);
        put_long(0, &mut bytes);
        put_int(0, &mut bytes);
        put_int(0, &mut bytes);
        put_int(0, &mut bytes);
        Ok(bytes)
    }
    #[test]
    fn invalid_dictionary_shapes_are_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let valid = payload(&["0"], &[0])?;
        assert!(decode(&valid, 1024 * 1024).is_ok());
        for end in 0..valid.len() {
            assert!(decode(&valid[..end], 1024 * 1024).is_err());
        }
        for bytes in [
            payload(&["0"], &[1])?,
            payload(&["0", "1"], &[0, 0])?,
            payload(&["0", "0"], &[0, 1])?,
            payload(&["1", "0"], &[0, 1])?,
            payload(&["{"], &[0])?,
            payload(&[], &[0])?,
        ] {
            assert!(decode(&bytes, 1024 * 1024).is_err());
        }
        let mut mode = valid.clone();
        mode[2] = 2;
        assert!(decode(&mode, 1024 * 1024).is_err());
        let mut utf8 = valid;
        utf8[5] = 255;
        assert!(decode(&utf8, 1024 * 1024).is_err());
        Ok(())
    }
}
