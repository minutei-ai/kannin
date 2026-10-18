use super::{
    BLOCK_SIZE, BlockMeta, DocumentMeta, FILTER_CACHE_BYTES, Header, QueryTerms, Range,
    TermDictionary, TermMeta, get_int, put_int,
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

    fn blocks(
        &mut self,
        document_count: usize,
        wanted: bool,
        validate: bool,
    ) -> Result<Box<[BlockMeta]>, String> {
        let count = self.integer()? as usize;
        if count > document_count {
            return Err("Directory block count exceeds document count".into());
        }
        if count > self.bytes.len().saturating_sub(self.offset) / 9 {
            return Err("Truncated directory blocks".into());
        }
        let capacity = if wanted { count } else { 0 };
        self.charge(
            capacity
                .checked_mul(size_of::<BlockMeta>())
                .ok_or("Directory allocation overflow")?,
        )?;
        let mut blocks = Vec::with_capacity(capacity);
        let mut previous = None;
        for _ in 0..count {
            let block = BlockMeta {
                first: self.integer()?,
                last: self.integer()?,
                count: self.integer()?,
                max_title_tf: self.integer()?,
                max_body_tf: self.integer()?,
                min_title_length: self.integer()?,
                min_body_length: self.integer()?,
                data: self.range()?,
            };
            if validate {
                if previous.is_some_and(|last| last >= block.first) {
                    return Err("Posting block rows are not strictly ordered".into());
                }
                if block.last as usize >= document_count
                    || block.first > block.last
                    || block.count as usize > BLOCK_SIZE
                {
                    return Err("Invalid posting block directory".into());
                }
            }
            previous = Some(block.last);
            if wanted {
                blocks.push(block);
            }
        }
        Ok(blocks.into_boxed_slice())
    }

    fn terms(
        &mut self,
        document_count: usize,
        selected: Option<&QueryTerms>,
    ) -> Result<TermDictionary, String> {
        let count = self.integer()? as usize;
        if count > self.bytes.len().saturating_sub(self.offset) / 3 {
            return Err("Truncated directory terms".into());
        }
        let capacity = selected.map_or(count, |words| words.order.len().min(count));
        self.charge(
            capacity
                .checked_mul(size_of::<(String, TermMeta)>())
                .ok_or("Directory allocation overflow")?,
        )?;
        let mut entries = Vec::<(String, TermMeta)>::with_capacity(capacity);
        let mut previous: Option<&str> = None;
        let mut selection = selected.map(|query| {
            query
                .order
                .iter()
                .map(|index| query.words[*index].as_str())
                .peekable()
        });
        for _ in 0..count {
            let term = self.text_slice()?;
            if previous.is_some_and(|last| last >= term) {
                return Err("Directory terms are not strictly sorted".into());
            }
            previous = Some(term);
            let df = self.integer()?;
            if selected.is_some() && df as usize > document_count {
                return Err("Invalid term document frequency".into());
            }
            let wanted = selection.as_mut().is_none_or(|words| {
                while words.next_if(|word| *word < term).is_some() {}
                words.peek().is_some_and(|word| *word == term)
            });
            let blocks = self.blocks(document_count, wanted, selected.is_some())?;
            if wanted {
                self.charge(
                    term.len()
                        .checked_add(16)
                        .ok_or("Directory allocation overflow")?,
                )?;
                entries.push((term.to_owned(), TermMeta { df, blocks }));
            }
        }
        Ok(TermDictionary {
            entries: entries.into_boxed_slice(),
        })
    }
}

pub(super) fn decode(
    bytes: &[u8],
    max_heap_bytes: usize,
    selected: Option<&QueryTerms>,
) -> Result<Header, String> {
    let mut decoder = Decoder {
        bytes,
        offset: 0,
        available: max_heap_bytes,
    };
    decoder.charge(size_of::<Header>() + 32 + FILTER_CACHE_BYTES)?;
    let version = decoder.integer()?;
    let documents = decoder.documents()?;
    let terms = decoder.terms(documents.len(), selected)?;
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
