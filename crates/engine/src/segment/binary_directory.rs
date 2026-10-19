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

pub(super) fn encode(header: &Header) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    put_int(header.version, &mut bytes);
    put_int(
        u32::try_from(header.documents.len()).map_err(|cause| cause.to_string())?,
        &mut bytes,
    );
    for document in &header.documents {
        put_text(&document.id, &mut bytes)?;
        put_long(document.revision, &mut bytes);
        put_int(document.title_length, &mut bytes);
        put_int(document.body_length, &mut bytes);
        put_text(document.attributes.get(), &mut bytes)?;
        put_int(document.data.offset, &mut bytes);
        put_int(document.data.length, &mut bytes);
        put_int(u32::from(document.vector), &mut bytes);
    }
    put_int(
        u32::try_from(header.terms.len()).map_err(|cause| cause.to_string())?,
        &mut bytes,
    );
    for (term, metadata) in &header.terms {
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
    fn documents(&mut self) -> Result<Vec<DocumentMeta>, String> {
        let count = self.integer()? as usize;
        if count > 10000 {
            return Err("Directory document limit exceeded".into());
        }
        if count > self.bytes.len().saturating_sub(self.offset) / 9 {
            return Err("Truncated directory documents".into());
        }
        self.charge(
            count
                .checked_mul(size_of::<DocumentMeta>())
                .ok_or("Directory allocation overflow")?,
        )?;
        let mut documents = Vec::with_capacity(count);
        for _ in 0..count {
            let id = self.text()?;
            let revision = self.long()?;
            let title_length = self.integer()?;
            let body_length = self.integer()?;
            let attributes = serde_json::value::RawValue::from_string(self.text()?)
                .map_err(|cause| cause.to_string())?;
            let data = self.range()?;
            let vector = match self.integer()? {
                0 => false,
                1 => true,
                _ => return Err("Invalid directory vector flag".into()),
            };
            documents.push(DocumentMeta {
                id,
                revision,
                title_length,
                body_length,
                attributes,
                data,
                vector,
            });
        }
        Ok(documents)
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
    })
}
