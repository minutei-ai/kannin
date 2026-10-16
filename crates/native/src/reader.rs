use crate::{
    cache::Cache,
    error::Error,
    protocol::{Metrics, Segment},
};
use raio_engine::segment::{self, Header};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc, sync::Arc, time::Duration};
use tokio::sync::{Semaphore, watch};

type Acquisition = watch::Receiver<Option<Result<Rc<Vec<u8>>, Rc<Error>>>>;

pub struct Reader {
    client: reqwest::Client,
    source: reqwest::Url,
    io: Arc<Semaphore>,
    pending: RefCell<BTreeMap<String, Acquisition>>,
    headers: RefCell<Cache<Header>>,
    ranges: RefCell<Cache<Vec<u8>>>,
}

impl Reader {
    pub(crate) fn new(source: reqwest::Url) -> Result<Rc<Self>, Error> {
        if source.scheme() != "http"
            || source.host_str().is_none()
            || !source.username().is_empty()
            || source.password().is_some()
            || source.query().is_some()
            || source.fragment().is_some()
            || source.path() != "/"
        {
            return Err(Error::Invalid(String::from(
                "SOURCE_URL must identify a private HTTP origin",
            )));
        }
        Ok(Rc::new(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(30))
                .build()?,
            source,
            io: Arc::new(Semaphore::new(4)),
            pending: RefCell::new(BTreeMap::new()),
            headers: RefCell::new(Cache::new(256 * 1024 * 1024)),
            ranges: RefCell::new(Cache::new(64 * 1024 * 1024)),
        }))
    }

    pub(crate) fn cache_bytes(&self) -> (usize, usize) {
        (self.headers.borrow().bytes(), self.ranges.borrow().bytes())
    }

    pub(crate) fn header<'a>(
        self: &'a Rc<Self>,
        bucket: &'a str,
        segment: &'a Segment,
        metrics: &'a Rc<RefCell<Metrics>>,
    ) -> futures_util::future::LocalBoxFuture<'a, Result<Rc<Header>, Rc<Error>>> {
        Box::pin(async move {
            let identity = format!(
                "{bucket}:{}:{}:{}",
                segment.key, segment.header_bytes, segment.bytes
            );
            if let Some(header) = self.headers.borrow_mut().get(&identity) {
                metrics.borrow_mut().header_hits += 1;
                return Ok(header);
            }
            let bytes = self
                .acquire(bucket, &segment.key, 0, segment.header_bytes, metrics)
                .await?;
            if let Some(header) = self.headers.borrow_mut().get(&identity) {
                metrics.borrow_mut().header_hits += 1;
                return Ok(header);
            }
            let (header, parsed_bytes) =
                segment::parse_header(&bytes).map_err(|error| Rc::new(Error::Invalid(error)))?;
            if parsed_bytes != segment.header_bytes as usize {
                return Err(Rc::new(Error::Invalid(String::from(
                    "Canonical directory length mismatch",
                ))));
            }
            let header = Rc::new(header);
            let charge = header.heap_bytes();
            if charge > 80 * 1024 * 1024 {
                return Err(Rc::new(Error::Invalid(String::from(
                    "Decoded directory exceeds eighty MiB",
                ))));
            }
            self.headers
                .borrow_mut()
                .insert(identity, header.clone(), charge);
            Ok(header)
        })
    }

    pub(crate) fn range<'a>(
        self: &'a Rc<Self>,
        bucket: &'a str,
        segment: &'a Segment,
        offset: u32,
        length: u32,
        metrics: &'a Rc<RefCell<Metrics>>,
    ) -> futures_util::future::LocalBoxFuture<'a, Result<Rc<Vec<u8>>, Rc<Error>>> {
        Box::pin(async move {
            if length == 0
                || length > 16 * 1024 * 1024
                || offset < segment.header_bytes
                || offset
                    .checked_add(length)
                    .is_none_or(|end| end > segment.bytes)
            {
                return Err(Rc::new(Error::Invalid(String::from(
                    "Invalid native posting range",
                ))));
            }
            self.acquire(bucket, &segment.key, offset, length, metrics)
                .await
        })
    }

    fn acquire<'a>(
        self: &'a Rc<Self>,
        bucket: &'a str,
        key: &'a str,
        offset: u32,
        length: u32,
        metrics: &'a Rc<RefCell<Metrics>>,
    ) -> futures_util::future::LocalBoxFuture<'a, Result<Rc<Vec<u8>>, Rc<Error>>> {
        Box::pin(async move {
            let identity = format!("{bucket}:{key}:{offset}:{length}");
            if let Some(bytes) = self.ranges.borrow_mut().get(&identity) {
                metrics.borrow_mut().range_hits += 1;
                return Ok(bytes);
            }
            let existing = self.pending.borrow().get(&identity).cloned();
            if let Some(receiver) = existing {
                return Self::receive(receiver).await;
            }
            let permit = self
                .io
                .clone()
                .acquire_owned()
                .await
                .map_err(|error| Rc::new(Error::Acquire(error)))?;
            if let Some(bytes) = self.ranges.borrow_mut().get(&identity) {
                metrics.borrow_mut().range_hits += 1;
                return Ok(bytes);
            }
            let existing = self.pending.borrow().get(&identity).cloned();
            if let Some(receiver) = existing {
                drop(permit);
                return Self::receive(receiver).await;
            }
            let mut source = self.source.clone();
            source.set_path("/range");
            source
                .query_pairs_mut()
                .append_pair("key", key)
                .append_pair("offset", &offset.to_string())
                .append_pair("length", &length.to_string());
            let (sender, receiver) = watch::channel(None);
            self.pending
                .borrow_mut()
                .insert(identity.clone(), receiver.clone());
            let reader = self.clone();
            let metrics = metrics.clone();
            drop(tokio::task::spawn_local(async move {
                let _permit = permit;
                let maximum = length as usize;
                let result = reader
                    .download(source, maximum, &metrics)
                    .await
                    .map(Rc::new)
                    .map_err(Rc::new);
                if let Ok(bytes) = &result {
                    reader.ranges.borrow_mut().insert(
                        identity.clone(),
                        bytes.clone(),
                        bytes.capacity(),
                    );
                }
                reader.pending.borrow_mut().remove(&identity);
                drop(sender.send_replace(Some(result)));
            }));
            Self::receive(receiver).await
        })
    }

    fn receive(
        mut receiver: Acquisition,
    ) -> futures_util::future::LocalBoxFuture<'static, Result<Rc<Vec<u8>>, Rc<Error>>> {
        Box::pin(async move {
            loop {
                let result = receiver.borrow().clone();
                if let Some(result) = result {
                    return result;
                }
                receiver
                    .changed()
                    .await
                    .map_err(|error| Rc::new(Error::Receiver(error)))?;
            }
        })
    }

    fn download<'a>(
        &'a self,
        source: reqwest::Url,
        maximum: usize,
        metrics: &'a Rc<RefCell<Metrics>>,
    ) -> futures_util::future::LocalBoxFuture<'a, Result<Vec<u8>, Error>> {
        Box::pin(async move {
            metrics.borrow_mut().source_reads += 1;
            let mut response = self.client.get(source).send().await?;
            if !response.status().is_success() {
                let status = response.status().as_u16();
                let mut body = Vec::new();
                while let Some(chunk) = response.chunk().await? {
                    metrics.borrow_mut().source_bytes += u64::try_from(chunk.len())
                        .map_err(|error| Error::Invalid(error.to_string()))?;
                    let remaining = 2048 - body.len();
                    body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                    if body.len() == 2048 {
                        break;
                    }
                }
                return Err(Error::SourceStatus(
                    status,
                    String::from_utf8_lossy(&body).into_owned(),
                ));
            }
            if response
                .content_length()
                .is_some_and(|length| length > maximum as u64)
            {
                return Err(Error::Invalid(String::from(
                    "Source response exceeds range budget",
                )));
            }
            let mut bytes = Vec::with_capacity(maximum);
            while let Some(chunk) = response.chunk().await? {
                metrics.borrow_mut().source_bytes += u64::try_from(chunk.len())
                    .map_err(|error| Error::Invalid(error.to_string()))?;
                if bytes.len() + chunk.len() > maximum {
                    return Err(Error::Invalid(String::from(
                        "Source response exceeds range budget",
                    )));
                }
                bytes.extend_from_slice(&chunk);
            }
            if bytes.len() != maximum {
                return Err(Error::Invalid(String::from(
                    "Source response length mismatch",
                )));
            }
            Ok(bytes)
        })
    }
}
