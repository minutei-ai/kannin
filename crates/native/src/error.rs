use std::fmt;

#[derive(Debug)]
pub enum Error {
    Invalid(String),
    Source(reqwest::Error),
    SourceStatus(u16, String),
    Acquire(tokio::sync::AcquireError),
    Receiver(tokio::sync::watch::error::RecvError),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::Source(error) => write!(formatter, "{error}"),
            Self::SourceStatus(status, message) => {
                write!(formatter, "Source HTTP {status}: {message}")
            }
            Self::Acquire(error) => write!(formatter, "{error}"),
            Self::Receiver(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Source(error) => Some(error),
            Self::Acquire(error) => Some(error),
            Self::Receiver(error) => Some(error),
            Self::Invalid(_) | Self::SourceStatus(_, _) => None,
        }
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Source(error)
    }
}
