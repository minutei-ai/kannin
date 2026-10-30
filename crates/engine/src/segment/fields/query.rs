use super::super::{Header, MAX_QUERY_TERMS};
use super::source::Workspace;
use super::{FieldAnalysis, TOKEN_BUDGET};
use crate::analysis::{WordV4Analyzer, WordV4Config};
use crate::normalize_text;
use std::collections::BTreeSet;

const PHRASE_LIMIT: usize = 64;
// Upper-bound estimate for one `BTreeSet<&str>` entry: the key plus node slack.
const UNIQUE_SET_ENTRY_BYTES: usize = size_of::<&str>() + 16;

struct QueryToken {
    term: String,
    position: u32,
}

pub(super) struct FieldPlan {
    pub(super) ordinal: usize,
    pub(super) unique: Vec<String>,
    // For each unique term, the offsets of its tokens from the first token.
    // Only populated for phrase queries.
    pub(super) deltas: Vec<Vec<u32>>,
}

pub(super) fn plan_field(
    header: &Header,
    ordinal: usize,
    text: &str,
    mode: &str,
    workspace: &mut Workspace,
) -> Result<FieldPlan, String> {
    let field = header.fields.get(ordinal).ok_or("Missing text field")?;
    workspace.reserve(text.len())?;
    let tokens = query_tokens(field.analysis(), text, mode, workspace)?;
    let unique = unique_terms(&tokens, workspace)?;
    let deltas = if mode == "phrase" {
        phrase_deltas(&tokens, &unique, workspace)?
    } else {
        Vec::new()
    };
    let heap = tokens.iter().map(|token| token.term.len()).sum::<usize>();
    workspace.release(text.len() + tokens.capacity() * size_of::<QueryToken>() + heap);
    Ok(FieldPlan {
        ordinal,
        unique,
        deltas,
    })
}

fn query_tokens(
    analysis: FieldAnalysis,
    text: &str,
    mode: &str,
    workspace: &mut Workspace,
) -> Result<Vec<QueryToken>, String> {
    let tokens = match analysis {
        FieldAnalysis::Native => native_query_tokens(text, workspace)?,
        FieldAnalysis::WordV4(config) => word_query_tokens(config, text, workspace)?,
    };
    if mode == "phrase" && tokens.len() > PHRASE_LIMIT {
        return Err("Phrase exceeds budget".into());
    }
    Ok(tokens)
}

fn push_token(
    tokens: &mut Vec<QueryToken>,
    term: &str,
    position: u32,
    workspace: &mut Workspace,
) -> Result<(), String> {
    if tokens.len() == TOKEN_BUDGET {
        return Err("Text analysis output exceeds its token budget".into());
    }
    workspace.grow(tokens)?;
    workspace.reserve(term.len())?;
    tokens.push(QueryToken {
        term: term.to_owned(),
        position,
    });
    Ok(())
}

fn native_query_tokens(text: &str, workspace: &mut Workspace) -> Result<Vec<QueryToken>, String> {
    let normalized = normalize_text(text);
    let mut tokens = Vec::new();
    for (position, term) in normalized.split_whitespace().enumerate() {
        let position = u32::try_from(position).map_err(|cause| cause.to_string())?;
        push_token(&mut tokens, term, position, workspace)?;
    }
    Ok(tokens)
}

fn word_query_tokens(
    config: WordV4Config,
    text: &str,
    workspace: &mut Workspace,
) -> Result<Vec<QueryToken>, String> {
    let mut analyzer = WordV4Analyzer::new(config)?;
    let mut tokens = Vec::new();
    let mut failure = None;
    analyzer.analyze_inputs(std::iter::once(text), |token| {
        let Ok(position) = u32::try_from(token.position) else {
            failure = Some("Token position exceeds u32".to_owned());
            return false;
        };
        match push_token(&mut tokens, token.text, position, workspace) {
            Ok(()) => true,
            Err(cause) => {
                failure = Some(cause);
                false
            }
        }
    });
    if let Some(failure) = failure {
        return Err(failure);
    }
    Ok(tokens)
}

fn unique_terms(tokens: &[QueryToken], workspace: &mut Workspace) -> Result<Vec<String>, String> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut unique: Vec<String> = Vec::new();
    for token in tokens {
        if seen.contains(token.term.as_str()) {
            continue;
        }
        if unique.len() == MAX_QUERY_TERMS {
            return Err("Invalid search budget".into());
        }
        workspace.grow(&mut unique)?;
        workspace.reserve(token.term.len() + UNIQUE_SET_ENTRY_BYTES)?;
        seen.insert(token.term.as_str());
        unique.push(token.term.clone());
    }
    workspace.release(unique.len() * UNIQUE_SET_ENTRY_BYTES);
    Ok(unique)
}

fn phrase_deltas(
    tokens: &[QueryToken],
    unique: &[String],
    workspace: &mut Workspace,
) -> Result<Vec<Vec<u32>>, String> {
    let Some(origin) = tokens.first().map(|token| token.position) else {
        return Ok(Vec::new());
    };
    let count_bytes = workspace.reserve_items::<usize>(unique.len())?;
    let mut counts = vec![0_usize; unique.len()];
    for token in tokens {
        let index = unique
            .iter()
            .position(|term| term == &token.term)
            .ok_or("Phrase term is not indexed")?;
        counts[index] += 1;
    }
    workspace.reserve_items::<Vec<u32>>(unique.len())?;
    workspace.reserve_items::<u32>(tokens.len())?;
    let mut deltas: Vec<Vec<u32>> = counts.into_iter().map(Vec::with_capacity).collect();
    workspace.release(count_bytes);
    for token in tokens {
        let index = unique
            .iter()
            .position(|term| term == &token.term)
            .ok_or("Phrase term is not indexed")?;
        let delta = token
            .position
            .checked_sub(origin)
            .ok_or("Phrase position underflow")?;
        deltas[index].push(delta);
    }
    Ok(deltas)
}
