use crate::{
    protocol::{Cutoff, Query, Request, Segment},
    rank::Ranker,
    reader::Reader,
};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Response, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use raio_engine::segment::{self, BuiltSegment, Document, Filter, Search, Statistics};
use std::{cell::Cell, collections::BTreeMap, convert::Infallible, future::Future, rc::Rc};
use tokio::{net::TcpListener, task::LocalSet};

type Failure = Box<dyn std::error::Error>;

struct Source {
    url: reqwest::Url,
    reads: Rc<Cell<usize>>,
}

fn run(test: impl Future<Output = Result<(), Failure>>) -> Result<(), Failure> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(LocalSet::new().run_until(test))
}

fn fixture() -> Result<BuiltSegment, Failure> {
    let documents = (0..300)
        .map(|index| Document {
            id: format!("document-{index:03}"),
            revision: 1,
            title: String::new(),
            text: if index % 2 == 0 {
                String::from("café alpha beta")
            } else {
                String::from("beta alpha alpha")
            },
            attributes: BTreeMap::from([(String::from("group"), serde_json::json!(index % 3))]),
            vector: None,
        })
        .collect();
    Ok(segment::build(documents)?)
}

fn request(
    fixture: &BuiltSegment,
    mode: &str,
    filters: Vec<Filter>,
    dead: Vec<u32>,
) -> Result<Request, Failure> {
    let (_, offset) = segment::parse_header(&fixture.bytes)?;
    Ok(Request {
        bucket: String::from("physical-bucket"),
        query: Query {
            text: String::from("alpha beta"),
            mode: mode.to_owned(),
            top_k: 10,
            filters,
            statistics: Statistics {
                documents: 300,
                title_length: fixture.header.total_title_length,
                body_length: fixture.header.total_body_length,
                frequencies: fixture
                    .header
                    .terms
                    .iter()
                    .map(|(word, meta)| (word.clone(), u64::from(meta.df)))
                    .collect(),
            },
        },
        segments: vec![Segment {
            key: String::from("namespace/immutable"),
            header_bytes: u32::try_from(offset)?,
            bytes: u32::try_from(fixture.bytes.len())?,
            dead,
        }],
        cutoff: None,
    })
}

fn source(
    fixture: Rc<BuiltSegment>,
) -> futures_util::future::LocalBoxFuture<'static, Result<Source, Failure>> {
    Box::pin(async move {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = reqwest::Url::parse(&format!("http://{}/", listener.local_addr()?))?;
        let reads = Rc::new(Cell::new(0));
        let acquired = reads.clone();
        drop(tokio::task::spawn_local(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let fixture = fixture.clone();
                let reads = acquired.clone();
                drop(tokio::task::spawn_local(async move {
                    let service =
                        service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                            let fixture = fixture.clone();
                            let reads = reads.clone();
                            async move {
                                reads.set(reads.get() + 1);
                                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                                let body = (|| -> Result<Vec<u8>, Failure> {
                                    let url = reqwest::Url::parse(&format!(
                                        "http://local{}",
                                        request.uri()
                                    ))?;
                                    let parameters = url.query_pairs().collect::<BTreeMap<_, _>>();
                                    let offset = parameters
                                        .get("offset")
                                        .ok_or("Missing offset")?
                                        .parse::<usize>()?;
                                    let length = parameters
                                        .get("length")
                                        .ok_or("Missing length")?
                                        .parse::<usize>()?;
                                    let bytes = fixture
                                        .bytes
                                        .get(offset..offset + length)
                                        .ok_or("Invalid range")?;
                                    if url.path() == "/directory-v1" {
                                        return Ok(segment::compress_directory(bytes)?);
                                    }
                                    Ok(bytes.to_vec())
                                })();
                                let mut response = match body {
                                    Ok(bytes) => Response::new(Full::new(Bytes::from(bytes))),
                                    Err(error) => {
                                        let mut response = Response::new(Full::new(Bytes::from(
                                            error.to_string(),
                                        )));
                                        *response.status_mut() = hyper::StatusCode::BAD_REQUEST;
                                        response
                                    }
                                };
                                response.headers_mut().insert(
                                    hyper::header::CONNECTION,
                                    hyper::header::HeaderValue::from_static("close"),
                                );
                                Ok::<_, Infallible>(response)
                            }
                        });
                    if let Err(error) = http1::Builder::new()
                        .serve_connection(TokioIo::new(socket), service)
                        .await
                    {
                        eprintln!("Fixture transport failed: {error}");
                    }
                }));
            }
        }));
        Ok(Source { url, reads })
    })
}

#[test]
fn ranged_ranking_matches_full_segment_with_filters_tombstones_and_cutoffs() -> Result<(), Failure>
{
    run(async {
        let fixture = Rc::new(fixture()?);
        let Source { url, .. } = source(fixture.clone()).await?;
        let ranker = Ranker::new(Reader::new(url)?);
        for mode in ["any", "all", "phrase"] {
            let input = request(
                &fixture,
                mode,
                vec![Filter {
                    field: String::from("group"),
                    op: String::from("eq"),
                    value: serde_json::json!(1),
                }],
                vec![1, 4, 7],
            )?;
            let mut oracle = Search::new(
                fixture.header.clone(),
                input.query.statistics.clone(),
                &input.query.text,
                mode,
                10,
                &input.segments[0].dead,
                &input.query.filters,
            )?;
            let (_, offset) = segment::parse_header(&fixture.bytes)?;
            for term in ["alpha", "beta"] {
                for block in &fixture.header.terms[term].blocks {
                    let start = offset + usize::try_from(block.data.offset)?;
                    oracle.add(
                        term,
                        &fixture.bytes[start..start + usize::try_from(block.data.length)?],
                    )?;
                }
            }
            let expected = oracle.finish()?;
            let result = ranker
                .rank(input)
                .await
                .map_err(|error| error.to_string())?;
            let hits = &result.segments[0];
            assert_eq!(hits.len(), expected.len());
            for (hit, expected) in hits.iter().zip(&expected) {
                assert_eq!(hit.row, expected.row);
                assert_eq!(hit.score.to_bits(), expected.score.to_bits());
                let document = &fixture.header.documents[usize::try_from(expected.row)?];
                assert_eq!(hit.id, document.id);
                assert_eq!(hit.data.offset, document.data.offset);
                assert_eq!(hit.data.length, document.data.length);
            }
            let mut input = request(&fixture, mode, Vec::new(), Vec::new())?;
            input.cutoff = Some(Cutoff {
                score: f64::MAX,
                id: String::from("boundary"),
            });
            let excluded = ranker
                .rank(input)
                .await
                .map_err(|error| error.to_string())?;
            assert!(excluded.segments[0].is_empty());
        }
        Ok(())
    })
}

#[test]
fn cold_ranges_reuse_only_immutable_bucket_scoped_data() -> Result<(), Failure> {
    run(async {
        let fixture = Rc::new(fixture()?);
        let Source { url, reads } = source(fixture.clone()).await?;
        let ranker = Ranker::new(Reader::new(url)?);
        let first = ranker
            .rank(request(&fixture, "any", Vec::new(), Vec::new())?)
            .await
            .map_err(|error| error.to_string())?;
        assert!(first.metrics.source_reads > 0);
        assert!(first.metrics.source_bytes < u64::try_from(fixture.bytes.len())?);
        let loaded = reads.get();
        let second = ranker
            .rank(request(&fixture, "any", Vec::new(), vec![0, 1, 2])?)
            .await
            .map_err(|error| error.to_string())?;
        assert_eq!(second.metrics.source_reads, 0);
        assert_eq!(reads.get(), loaded);
        assert_eq!(second.metrics.header_hits, 1);
        assert!(second.segments[0].iter().all(|hit| hit.row > 2));
        let mut other = request(&fixture, "any", Vec::new(), Vec::new())?;
        other.bucket = String::from("another-physical-bucket");
        let result = ranker
            .rank(other)
            .await
            .map_err(|error| error.to_string())?;
        assert!(result.metrics.source_reads > 0);
        assert!(reads.get() > loaded);
        Ok(())
    })
}

#[test]
fn concurrent_cold_queries_share_source_acquisition() -> Result<(), Failure> {
    run(async {
        let fixture = Rc::new(fixture()?);
        let Source { url, reads } = source(fixture.clone()).await?;
        let ranker = Ranker::new(Reader::new(url)?);
        let first = request(&fixture, "any", Vec::new(), Vec::new())?;
        let second = request(&fixture, "any", Vec::new(), Vec::new())?;
        let (first, second) =
            futures_util::future::join(ranker.rank(first), ranker.rank(second)).await;
        let first = first.map_err(|error| error.to_string())?;
        let second = second.map_err(|error| error.to_string())?;
        assert_eq!(
            serde_json::to_vec(&first.segments)?,
            serde_json::to_vec(&second.segments)?
        );
        assert_eq!(
            u64::try_from(reads.get())?,
            first.metrics.source_reads + second.metrics.source_reads
        );
        assert_eq!(reads.get(), 2);
        Ok(())
    })
}

#[test]
fn cancelled_waiter_keeps_one_bounded_source_producer() -> Result<(), Failure> {
    run(async {
        let fixture = Rc::new(fixture()?);
        let Source { url, reads } = source(fixture.clone()).await?;
        let reader = Reader::new(url)?;
        let input = request(&fixture, "any", Vec::new(), Vec::new())?;
        let metrics = Rc::new(std::cell::RefCell::new(crate::protocol::Metrics::default()));
        let producer = {
            let reader = reader.clone();
            let metrics = metrics.clone();
            tokio::task::spawn_local(async move {
                reader
                    .header(&input.bucket, &input.segments[0], &metrics)
                    .await
            })
        };
        while reads.get() == 0 {
            tokio::task::yield_now().await;
        }
        producer.abort();
        assert!(producer.await.is_err_and(|error| error.is_cancelled()));
        let input = request(&fixture, "any", Vec::new(), Vec::new())?;
        let header = reader
            .header(&input.bucket, &input.segments[0], &metrics)
            .await
            .map_err(|error| error.to_string())?;
        assert_eq!(header.documents.len(), fixture.header.documents.len());
        assert_eq!(reads.get(), 1);
        assert_eq!(metrics.borrow().source_reads, 1);
        Ok(())
    })
}
