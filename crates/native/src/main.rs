pub mod cache;
pub mod error;
pub mod protocol;
pub mod rank;
pub mod reader;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Request, Response, StatusCode, body::Incoming, server::conn::http1, service::service_fn,
};
use hyper_util::rt::TokioIo;
use std::{convert::Infallible, rc::Rc, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore, task::LocalSet};

fn response(status: StatusCode, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(body.into()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        hyper::header::CACHE_CONTROL,
        hyper::header::HeaderValue::from_static("no-store"),
    );
    response
}

fn handle(
    request: Request<Incoming>,
    ranker: Rc<rank::Ranker>,
    slots: Arc<Semaphore>,
) -> futures_util::future::LocalBoxFuture<'static, Result<Response<Full<Bytes>>, Infallible>> {
    Box::pin(async move {
        if request.method() == hyper::Method::GET && request.uri().path() == "/ready" {
            return Ok(response(StatusCode::OK, Bytes::new()));
        }
        if request.method() != hyper::Method::POST || request.uri().path() != "/rank" {
            return Ok(response(StatusCode::NOT_FOUND, Bytes::new()));
        }
        let Ok(_permit) = slots.try_acquire_owned() else {
            return Ok(response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Native ranking capacity exceeded",
            ));
        };
        let collected = tokio::time::timeout(
            Duration::from_secs(10),
            Limited::new(request.into_body(), 4 * 1024 * 1024).collect(),
        )
        .await;
        let body = match collected {
            Ok(Ok(body)) => body.to_bytes(),
            Ok(Err(error)) => return Ok(response(StatusCode::BAD_REQUEST, error.to_string())),
            Err(error) => return Ok(response(StatusCode::REQUEST_TIMEOUT, error.to_string())),
        };
        let input = match serde_json::from_slice::<protocol::Request>(&body) {
            Ok(input) => input,
            Err(error) => return Ok(response(StatusCode::BAD_REQUEST, error.to_string())),
        };
        match ranker.rank(input).await {
            Ok(output) => match serde_json::to_vec(&output) {
                Ok(bytes) => {
                    let mut output = response(StatusCode::OK, bytes);
                    output.headers_mut().insert(
                        hyper::header::CONTENT_TYPE,
                        hyper::header::HeaderValue::from_static("application/json"),
                    );
                    Ok(output)
                }
                Err(error) => Ok(response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    error.to_string(),
                )),
            },
            Err(error) => {
                eprintln!("Native ranking failed: {error:?}");
                Ok(response(StatusCode::BAD_GATEWAY, error.to_string()))
            }
        }
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(LocalSet::new().run_until(async {
        let reader = reader::Reader::new(reqwest::Url::parse(&std::env::var("SOURCE_URL")?)?)?;
        let ranker = Rc::new(rank::Ranker::new(reader));
        let requests = Arc::new(Semaphore::new(4));
        let connections = Arc::new(Semaphore::new(16));
        let listener = TcpListener::bind("0.0.0.0:8080").await?;
        loop {
            let (socket, _) = listener.accept().await?;
            let Ok(permit) = connections.clone().try_acquire_owned() else {
                drop(socket);
                continue;
            };
            let ranker = ranker.clone();
            let requests = requests.clone();
            drop(tokio::task::spawn_local(async move {
                let _permit = permit;
                let service =
                    service_fn(move |request| handle(request, ranker.clone(), requests.clone()));
                let result = http1::Builder::new()
                    .keep_alive(false)
                    .max_headers(32)
                    .serve_connection(TokioIo::new(socket), service);
                match tokio::time::timeout(Duration::from_mins(1), result).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("Native HTTP connection failed: {error}"),
                    Err(error) => eprintln!("Native HTTP deadline exceeded: {error}"),
                }
            }));
        }
    }))
}

#[cfg(test)]
mod tests;
