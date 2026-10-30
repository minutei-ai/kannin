use crate::segment::{Cell, ColumnId, ColumnValue, Document};
use alyze::analyze::{
    AnalysisOptions, Analyzer, LanguageWithStopwords, ReusableBuffer, StemmingLanguage,
    StopwordRemoval, TokenizerOptions, stemming_cache::StemmingCache,
};
use alyze::uax29::word::Options as WordOptions;
use serde::{Deserialize, Serialize};

const MAX_ANALYSIS_TOKENS: usize = 65_536;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Arabic,
    Danish,
    Dutch,
    #[default]
    English,
    Finnish,
    French,
    German,
    Greek,
    Hungarian,
    Italian,
    Norwegian,
    Portuguese,
    Romanian,
    Russian,
    Spanish,
    Swedish,
    Tamil,
    Turkish,
}

impl Language {
    const fn stemming(self) -> StemmingLanguage {
        match self {
            Self::Arabic => StemmingLanguage::Arabic,
            Self::Danish => StemmingLanguage::Danish,
            Self::Dutch => StemmingLanguage::Dutch,
            Self::English => StemmingLanguage::English,
            Self::Finnish => StemmingLanguage::Finnish,
            Self::French => StemmingLanguage::French,
            Self::German => StemmingLanguage::German,
            Self::Greek => StemmingLanguage::Greek,
            Self::Hungarian => StemmingLanguage::Hungarian,
            Self::Italian => StemmingLanguage::Italian,
            Self::Norwegian => StemmingLanguage::Norwegian,
            Self::Portuguese => StemmingLanguage::Portuguese,
            Self::Romanian => StemmingLanguage::Romanian,
            Self::Russian => StemmingLanguage::Russian,
            Self::Spanish => StemmingLanguage::Spanish,
            Self::Swedish => StemmingLanguage::Swedish,
            Self::Tamil => StemmingLanguage::Tamil,
            Self::Turkish => StemmingLanguage::Turkish,
        }
    }

    const fn stopwords(self) -> Option<LanguageWithStopwords> {
        match self {
            Self::Danish => Some(LanguageWithStopwords::Danish),
            Self::Dutch => Some(LanguageWithStopwords::Dutch),
            Self::English => Some(LanguageWithStopwords::English),
            Self::Finnish => Some(LanguageWithStopwords::Finnish),
            Self::French => Some(LanguageWithStopwords::French),
            Self::German => Some(LanguageWithStopwords::German),
            Self::Hungarian => Some(LanguageWithStopwords::Hungarian),
            Self::Italian => Some(LanguageWithStopwords::Italian),
            Self::Norwegian => Some(LanguageWithStopwords::Norwegian),
            Self::Portuguese => Some(LanguageWithStopwords::Portuguese),
            Self::Russian => Some(LanguageWithStopwords::Russian),
            Self::Spanish => Some(LanguageWithStopwords::Spanish),
            Self::Swedish => Some(LanguageWithStopwords::Swedish),
            Self::Arabic | Self::Greek | Self::Romanian | Self::Tamil | Self::Turkish => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct WordV4Config {
    pub max_token_length: u8,
    pub case_sensitive: bool,
    pub stopwords: Option<Language>,
    pub stemming: Option<Language>,
    pub ascii_folding: bool,
}

impl Default for WordV4Config {
    fn default() -> Self {
        Self {
            max_token_length: 39,
            case_sensitive: false,
            stopwords: Some(Language::English),
            stemming: None,
            ascii_folding: false,
        }
    }
}

impl WordV4Config {
    fn options(self) -> Result<AnalysisOptions, String> {
        if self.max_token_length == 0 {
            return Err("Maximum token length must be between 1 and 255 characters".into());
        }
        let stopword_removal = self
            .stopwords
            .map(|language| {
                language
                    .stopwords()
                    .map(StopwordRemoval::ForLanguage)
                    .ok_or_else(|| "Stopword removal is unavailable for this language".to_owned())
            })
            .transpose()?;
        let options = AnalysisOptions {
            tokenizer: TokenizerOptions::UAX29Word(WordOptions::default()),
            maximum_token_length: Some(usize::from(self.max_token_length)),
            case_sensitive: self.case_sensitive,
            stopword_removal,
            stemming: self.stemming.map(Language::stemming),
            ascii_folding: self.ascii_folding,
        };
        if !options.valid() {
            return Err("Case-sensitive analysis cannot remove stopwords or apply stemming".into());
        }
        Ok(options)
    }
}

pub struct WordV4Analyzer {
    analyzer: Analyzer<'static>,
    buffer: ReusableBuffer,
}

impl WordV4Analyzer {
    #[doc = "# Errors\nRejects unsupported or inconsistent analyzer options before constructing the upstream analyzer."]
    pub fn new(config: WordV4Config) -> Result<Self, String> {
        let analyzer = Analyzer::new(config.options()?);
        let mut buffer = ReusableBuffer::new();
        *buffer.stemming_cache() = StemmingCache::new_with_capacity(1024);
        Ok(Self { analyzer, buffer })
    }

    pub fn analyze_inputs<'input>(
        &mut self,
        inputs: impl Iterator<Item = &'input str>,
        callback: impl FnMut(alyze::analyze::Token<'_>) -> bool,
    ) {
        self.analyzer
            .analyze_inputs(inputs, &mut self.buffer, callback);
    }

    #[doc = "# Errors\nRejects non-string attributes and arrays containing non-string values before emitting any tokens."]
    pub fn analyze_attribute(
        &mut self,
        document: &Document,
        name: &str,
        callback: impl FnMut(alyze::analyze::Token<'_>) -> bool,
    ) -> Result<(), String> {
        match document.column(ColumnId::Attribute(name)) {
            None
            | Some(ColumnValue::Attribute(Cell::Null | Cell::Legacy(serde_json::Value::Null))) => {}
            Some(ColumnValue::Attribute(
                Cell::String(text) | Cell::Legacy(serde_json::Value::String(text)),
            )) => {
                self.analyze_inputs(std::iter::once(text.as_str()), callback);
            }
            Some(ColumnValue::Attribute(Cell::Legacy(serde_json::Value::Array(values)))) => {
                if values.iter().any(|value| !value.is_string()) {
                    return Err("Full-text arrays must contain only strings".into());
                }
                self.analyze_inputs(
                    values.iter().filter_map(serde_json::Value::as_str),
                    callback,
                );
            }
            Some(ColumnValue::Attribute(Cell::Array(values))) => {
                let texts: Vec<&str> = values
                    .iter()
                    .filter_map(|value| match value {
                        Cell::String(text) => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                if texts.len() != values.len() {
                    return Err("Full-text arrays must contain only strings".into());
                }
                self.analyze_inputs(texts.into_iter(), callback);
            }
            Some(_) => return Err("Full-text attributes must be strings or string arrays".into()),
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
struct Token {
    text: String,
    position: usize,
    position_length: usize,
    input_index: usize,
    byte_start: usize,
    byte_end: usize,
}

#[doc = "# Errors\nRejects malformed JSON, invalid analyzer options, and input or output beyond the analysis budget."]
pub fn analyze_json(config: &str, inputs: &str) -> Result<String, String> {
    if config.len().saturating_add(inputs.len()) > crate::MAX_LOG_BYTES {
        return Err("Text analysis input exceeds its byte budget".into());
    }
    let config =
        serde_json::from_str(config).map_err(|cause| format!("Invalid analyzer: {cause}"))?;
    let inputs: Vec<String> =
        serde_json::from_str(inputs).map_err(|cause| format!("Invalid text inputs: {cause}"))?;
    let mut analyzer = WordV4Analyzer::new(config)?;
    let mut tokens = Vec::new();
    let mut exceeded = false;
    analyzer.analyze_inputs(inputs.iter().map(String::as_str), |token| {
        if tokens.len() == MAX_ANALYSIS_TOKENS {
            exceeded = true;
            return false;
        }
        tokens.push(Token {
            text: token.text.to_owned(),
            position: token.position,
            position_length: token.position_length,
            input_index: token.input_index,
            byte_start: token.byte_range.start,
            byte_end: token.byte_range.end,
        });
        true
    });
    if exceeded {
        return Err("Text analysis output exceeds its token budget".into());
    }
    serde_json::to_string(&tokens).map_err(|cause| format!("Invalid analyzed tokens: {cause}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_v4_preserves_position_gaps_and_array_identity() -> Result<(), String> {
        let mut analyzer = WordV4Analyzer::new(WordV4Config::default())?;
        let mut tokens = Vec::new();
        analyzer.analyze_inputs(["the CAFÉ", "", "and foxes"].into_iter(), |token| {
            tokens.push((token.text.to_owned(), token.position, token.input_index));
            true
        });
        assert_eq!(tokens, [("café".into(), 1, 0), ("foxes".into(), 3, 2)]);
        Ok(())
    }

    #[test]
    fn word_v4_streaming_abort_and_reuse_do_not_leak_positions() -> Result<(), String> {
        let mut analyzer = WordV4Analyzer::new(WordV4Config::default())?;
        let mut tokens = Vec::new();
        analyzer.analyze_inputs(["fox dog", "extra"].into_iter(), |token| {
            tokens.push(token.text.to_owned());
            false
        });
        assert_eq!(tokens, ["fox"]);
        tokens.clear();
        analyzer.analyze_inputs(std::iter::once("🐡 café"), |token| {
            tokens.push(format!(
                "{}:{}:{}",
                token.input_index, token.position, token.text
            ));
            true
        });
        assert_eq!(tokens, ["0:0:🐡", "0:1:café"]);
        Ok(())
    }

    #[test]
    fn word_v4_attribute_owner_never_reads_native_roles_or_partially_indexes_invalid_arrays()
    -> Result<(), String> {
        let document = Document::native(
            "a",
            1,
            "nativeexclusive",
            "bodyexclusive",
            [
                ("title".into(), serde_json::json!("attribute quasar")),
                ("text".into(), serde_json::json!(["fox", "", "the dog"])),
                ("absent".into(), serde_json::Value::Null),
                ("invalid".into(), serde_json::json!(["fox", null])),
                ("number".into(), serde_json::json!(42)),
            ]
            .into(),
            None,
        );
        let mut analyzer = WordV4Analyzer::new(WordV4Config::default())?;
        let mut tokens = Vec::new();
        analyzer.analyze_attribute(&document, "title", |token| {
            tokens.push((token.text.to_owned(), token.position, token.input_index));
            true
        })?;
        assert_eq!(
            tokens,
            [("attribute".into(), 0, 0), ("quasar".into(), 1, 0)]
        );
        tokens.clear();
        analyzer.analyze_attribute(&document, "text", |token| {
            tokens.push((token.text.to_owned(), token.position, token.input_index));
            true
        })?;
        assert_eq!(tokens, [("fox".into(), 0, 0), ("dog".into(), 2, 2)]);
        tokens.clear();
        for field in ["absent", "missing", "vector"] {
            analyzer.analyze_attribute(&document, field, |token| {
                tokens.push((token.text.to_owned(), token.position, token.input_index));
                true
            })?;
        }
        assert_eq!(tokens, Vec::<(String, usize, usize)>::new());
        for field in ["invalid", "number"] {
            assert!(
                analyzer
                    .analyze_attribute(&document, field, |token| {
                        tokens.push((token.text.to_owned(), token.position, token.input_index));
                        true
                    })
                    .is_err()
            );
        }
        assert_eq!(tokens, Vec::<(String, usize, usize)>::new());
        Ok(())
    }

    #[test]
    fn word_v4_character_limit_is_not_a_utf8_byte_limit() -> Result<(), String> {
        let mut analyzer = WordV4Analyzer::new(WordV4Config {
            max_token_length: 255,
            ..WordV4Config::default()
        })?;
        let maximum = "é".repeat(255);
        let oversized = "é".repeat(256);
        let mut tokens = Vec::new();
        analyzer.analyze_inputs(
            [maximum.as_str(), oversized.as_str(), "fox"].into_iter(),
            |token| {
                tokens.push((token.text.to_owned(), token.position, token.byte_range));
                true
            },
        );
        assert_eq!(tokens, [(maximum, 0, 0..510), ("fox".into(), 2, 0..3)]);
        Ok(())
    }

    #[test]
    fn word_v4_rejects_invalid_options_without_panicking() {
        for config in [
            WordV4Config {
                max_token_length: 0,
                ..WordV4Config::default()
            },
            WordV4Config {
                case_sensitive: true,
                ..WordV4Config::default()
            },
            WordV4Config {
                stopwords: Some(Language::Arabic),
                ..WordV4Config::default()
            },
            WordV4Config {
                case_sensitive: true,
                stopwords: None,
                stemming: Some(Language::English),
                ..WordV4Config::default()
            },
        ] {
            assert!(WordV4Analyzer::new(config).is_err());
        }
        assert!(analyze_json(r#"{"unknown":true}"#, r#"["fox"]"#).is_err());
        assert!(analyze_json("{}", "[null]").is_err());
        assert!(analyze_json("{}", r#"["\ud800"]"#).is_err());
    }

    #[test]
    fn word_v4_json_retains_escaped_inputs_and_rejects_budget_overflow() -> Result<(), String> {
        let encoded = analyze_json("{}", r#"["CAFÉ\n\"fox\""]"#)?;
        let tokens: Vec<serde_json::Value> =
            serde_json::from_str(&encoded).map_err(|cause| cause.to_string())?;
        assert_eq!(tokens[0]["text"], "café");
        assert_eq!(tokens[1]["text"], "fox");
        let source = serde_json::to_string(&["fox ".repeat(MAX_ANALYSIS_TOKENS + 1)])
            .map_err(|cause| cause.to_string())?;
        assert!(analyze_json("{}", &source).is_err_and(|cause| cause.contains("token budget")));
        let source = serde_json::to_string(&["x".repeat(crate::MAX_LOG_BYTES)])
            .map_err(|cause| cause.to_string())?;
        assert!(analyze_json("{}", &source).is_err_and(|cause| cause.contains("byte budget")));
        Ok(())
    }
}
