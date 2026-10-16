use crate::{
    error::Error,
    protocol::{Cutoff, Hit, Metrics, Query, Request, Response, Segment},
    reader::Reader,
};
use futures_util::{StreamExt, TryStreamExt, stream};
use raio_engine::segment::{BlockMeta, Search};
use std::{cell::RefCell, rc::Rc, sync::Arc, time::Instant};
use tokio::sync::Semaphore;

struct Span {
    term: String,
    blocks: Vec<BlockMeta>,
    offset: u32,
}

struct Group {
    offset: u32,
    end: u32,
    gaps: u32,
    spans: Vec<Span>,
}

pub struct Ranker {
    reader: Rc<Reader>,
    slots: Arc<Semaphore>,
}

impl Ranker {
    pub(crate) fn new(reader: Rc<Reader>) -> Self {
        Self {
            reader,
            slots: Arc::new(Semaphore::new(4)),
        }
    }

    pub(crate) fn rank(
        &self,
        input: Request,
    ) -> futures_util::future::LocalBoxFuture<'_, Result<Response, Rc<Error>>> {
        Box::pin(async move {
            Self::validate(&input).map_err(Rc::new)?;
            let metrics = Rc::new(RefCell::new(Metrics::default()));
            let segments = stream::iter(input.segments.iter())
                .map(|segment| {
                    self.segment(
                        &input.bucket,
                        segment,
                        &input.query,
                        input.cutoff.as_ref(),
                        metrics.clone(),
                    )
                })
                .buffered(4)
                .try_collect()
                .await?;
            let (headers, ranges) = self.reader.cache_bytes();
            let mut metrics = metrics.take();
            metrics.header_cache_bytes = headers;
            metrics.range_cache_bytes = ranges;
            Ok(Response { segments, metrics })
        })
    }

    fn validate(input: &Request) -> Result<(), Error> {
        if input.bucket.is_empty()
            || input.bucket.len() > 128
            || input.segments.is_empty()
            || input.segments.len() > 8
            || input.query.text.is_empty()
            || input.query.text.len() > 32768
            || input.query.statistics.frequencies.len() > 64
            || input.query.filters.len() > 16
            || !(1..=100).contains(&input.query.top_k)
            || input.segments.iter().any(|segment| {
                segment.key.is_empty()
                    || segment.key.len() > 1024
                    || !(16..=16 * 1024 * 1024).contains(&segment.header_bytes)
                    || segment.bytes < segment.header_bytes
                    || segment.bytes > 16 * 1024 * 1024
                    || segment.dead.len() > 10000
            })
            || input.cutoff.as_ref().is_some_and(|cutoff| {
                !cutoff.score.is_finite() || cutoff.score <= 0.0 || cutoff.id.len() > 512
            })
        {
            return Err(Error::Invalid(String::from(
                "Invalid native ranking request",
            )));
        }
        Ok(())
    }

    fn groups(search: &Search, cutoff: Option<&Cutoff>) -> Result<Vec<Group>, Rc<Error>> {
        let requested = cutoff
            .map_or_else(
                || search.posting_spans_seeded(),
                |cutoff| search.posting_spans_after(cutoff.score, &cutoff.id),
            )
            .map_err(|error| Rc::new(Error::Invalid(error)))?;
        let mut groups: Vec<Group> = Vec::new();
        for posting in requested {
            let first = posting
                .blocks
                .first()
                .ok_or_else(|| Rc::new(Error::Invalid(String::from("Empty posting span"))))?;
            let first_offset = first.data.offset;
            let mut end = first_offset;
            for block in &posting.blocks {
                if block.data.offset < end
                    || block.data.offset - end > 4096
                    || block.data.length == 0
                {
                    return Err(Rc::new(Error::Invalid(String::from(
                        "Invalid posting span",
                    ))));
                }
                end = block
                    .data
                    .offset
                    .checked_add(block.data.length)
                    .ok_or_else(|| {
                        Rc::new(Error::Invalid(String::from("Posting span overflow")))
                    })?;
            }
            let span = Span {
                term: posting.term.to_owned(),
                blocks: posting.blocks.into_iter().cloned().collect(),
                offset: first_offset,
            };
            if let Some(previous) = groups.last_mut()
                && span.offset >= previous.end
                && u64::from(previous.gaps) + u64::from(span.offset) - u64::from(previous.end)
                    <= 16384
                && end - previous.offset <= 1024 * 1024
            {
                previous.gaps += span.offset - previous.end;
                previous.end = end;
                previous.spans.push(span);
            } else {
                groups.push(Group {
                    offset: span.offset,
                    end,
                    gaps: 0,
                    spans: vec![span],
                });
            }
        }
        Ok(groups)
    }

    fn decode(
        search: &mut Search,
        window: &[Group],
        bytes: Vec<Rc<Vec<u8>>>,
        metrics: &RefCell<Metrics>,
    ) -> Result<(), Rc<Error>> {
        for (group, bytes) in window.iter().zip(bytes) {
            metrics.borrow_mut().ranges += 1;
            metrics.borrow_mut().bytes += bytes.len();
            for span in &group.spans {
                metrics.borrow_mut().spans += 1;
                metrics.borrow_mut().blocks += span.blocks.len();
                for block in &span.blocks {
                    let offset = usize::try_from(block.data.offset - group.offset)
                        .map_err(|error| Rc::new(Error::Invalid(error.to_string())))?;
                    let length = usize::try_from(block.data.length)
                        .map_err(|error| Rc::new(Error::Invalid(error.to_string())))?;
                    let page = bytes.get(offset..offset + length).ok_or_else(|| {
                        Rc::new(Error::Invalid(String::from("Truncated posting span")))
                    })?;
                    search
                        .add(&span.term, page)
                        .map_err(|error| Rc::new(Error::Invalid(error)))?;
                }
            }
        }
        Ok(())
    }

    fn segment<'a>(
        &'a self,
        bucket: &'a str,
        segment: &'a Segment,
        query: &'a Query,
        cutoff: Option<&'a Cutoff>,
        metrics: Rc<RefCell<Metrics>>,
    ) -> futures_util::future::LocalBoxFuture<'a, Result<Vec<Hit>, Rc<Error>>> {
        Box::pin(async move {
            let _permit = self
                .slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|error| Rc::new(Error::Acquire(error)))?;
            let started = Instant::now();
            let header = self.reader.header(bucket, segment, &metrics).await?;
            let mut search = Search::new(
                header.clone(),
                query.statistics.clone(),
                &query.text,
                &query.mode,
                query.top_k,
                &segment.dead,
                &query.filters,
            )
            .map_err(|error| Rc::new(Error::Invalid(error)))?;
            {
                let mut measured = metrics.borrow_mut();
                measured.prepare_ms = started
                    .elapsed()
                    .as_secs_f64()
                    .mul_add(1000.0, measured.prepare_ms);
            }
            let groups = Self::groups(&search, cutoff)?;
            for window in groups.chunks(4) {
                let started = Instant::now();
                let bytes: Vec<_> = stream::iter(window)
                    .map(|group| {
                        let offset = segment.header_bytes.checked_add(group.offset);
                        let metrics = metrics.clone();
                        async move {
                            let offset = offset.ok_or_else(|| {
                                Rc::new(Error::Invalid(String::from("Posting offset overflow")))
                            })?;
                            self.reader
                                .range(bucket, segment, offset, group.end - group.offset, &metrics)
                                .await
                        }
                    })
                    .buffered(4)
                    .try_collect()
                    .await?;
                {
                    let mut measured = metrics.borrow_mut();
                    measured.acquire_ms = started
                        .elapsed()
                        .as_secs_f64()
                        .mul_add(1000.0, measured.acquire_ms);
                }
                let started = Instant::now();
                Self::decode(&mut search, window, bytes, &metrics)?;
                {
                    let mut measured = metrics.borrow_mut();
                    measured.decode_ms = started
                        .elapsed()
                        .as_secs_f64()
                        .mul_add(1000.0, measured.decode_ms);
                }
            }
            let started = Instant::now();
            let hits = search
                .finish()
                .map_err(|error| Rc::new(Error::Invalid(error)))?;
            let ranked = hits
                .into_iter()
                .map(|hit| {
                    let document = &header.documents[hit.row as usize];
                    Hit {
                        row: hit.row,
                        id: document.id.clone(),
                        score: hit.score,
                        data: document.data.clone(),
                    }
                })
                .collect();
            {
                let mut measured = metrics.borrow_mut();
                measured.score_ms = started
                    .elapsed()
                    .as_secs_f64()
                    .mul_add(1000.0, measured.score_ms);
            }
            Ok(ranked)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Ranker;
    use raio_engine::segment::{Document, Search, Statistics, build};
    use std::collections::BTreeMap;

    #[test]
    fn distant_posting_offsets_do_not_overflow_gap_accounting()
    -> Result<(), Box<dyn std::error::Error>> {
        let built = build(vec![Document {
            id: String::from("document"),
            revision: 1,
            title: String::new(),
            text: String::from("alpha beta gamma"),
            attributes: BTreeMap::new(),
            vector: None,
        }])?;
        let mut header = built.header;
        for (term, offset) in [("alpha", 0), ("beta", 10), ("gamma", u32::MAX - 5)] {
            let metadata = header.terms.get_mut(term).ok_or("Missing fixture term")?;
            let block = metadata.blocks.first_mut().ok_or("Missing fixture block")?;
            block.data.offset = offset;
            block.data.length = 1;
        }
        let statistics = Statistics {
            documents: 1,
            title_length: 0,
            body_length: 3,
            frequencies: header.terms.keys().map(|term| (term.clone(), 1)).collect(),
        };
        let search = Search::new(header, statistics, "alpha beta gamma", "any", 10, &[], &[])?;
        let groups = Ranker::groups(&search, None).map_err(|error| error.to_string())?;
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].gaps, 9);
        assert_eq!(groups[1].offset, u32::MAX - 5);
        Ok(())
    }
}
