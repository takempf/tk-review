//! Model catalogs the agent CLIs leave on disk.
//!
//! Neither CLI exposes a "list models" command, but both cache the catalog
//! they fetch from their service: Claude Code under
//! `~/.claude/cache/model-catalog/`, codex at `~/.codex/models_cache.json`.
//! Reading those files gives the picker whatever the installed CLI currently
//! offers, refreshed whenever the user runs the CLI itself. No network, no
//! process spawn — a missing or unreadable cache simply yields `None`, and the
//! frontend falls back to its built-in suggestions.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    /// What the CLI's `--model` flag (or codex's `-m`) accepts.
    pub id: String,
    /// Human name from the catalog, e.g. "Fable 5.1".
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModels {
    pub models: Vec<ModelOption>,
    /// Effort levels any listed model accepts, in the catalog's order.
    pub efforts: Vec<String>,
}

/// The cached catalog for `engine`, or `None` when there is nothing usable.
pub fn agent_models(engine: &str) -> Option<EngineModels> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    match engine {
        "claude" => claude_models(&home.join(".claude/cache/model-catalog")),
        "codex" => codex_models(&home.join(".codex/models_cache.json")),
        _ => None,
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Appends `effort` unless already present, keeping first-seen order.
fn push_effort(efforts: &mut Vec<String>, effort: &str) {
    if !efforts.iter().any(|known| known == effort) {
        efforts.push(effort.to_owned());
    }
}

/// Claude Code writes one file per account/surface; take the most recently
/// fetched. Shape: `catalog.config.models[]` with `id`, `name`, and
/// `thinking.effort_options[].id`.
fn claude_models(dir: &Path) -> Option<EngineModels> {
    let newest = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| read_json(&path))
        .max_by_key(|doc| doc["fetchedAt"].as_u64().unwrap_or(0))?;
    parse_claude_catalog(&newest)
}

fn parse_claude_catalog(doc: &Value) -> Option<EngineModels> {
    let mut models = Vec::new();
    let mut efforts = Vec::new();
    for model in doc["catalog"]["config"]["models"].as_array()? {
        let Some(id) = model["id"].as_str() else { continue };
        let label = model["name"].as_str().unwrap_or(id);
        models.push(ModelOption {
            id: id.to_owned(),
            label: label.to_owned(),
        });
        for option in model["thinking"]["effort_options"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(effort) = option["id"].as_str() {
                push_effort(&mut efforts, effort);
            }
        }
    }
    (!models.is_empty()).then_some(EngineModels { models, efforts })
}

/// Codex: `models[]` with `slug`, `display_name`, `visibility` ("list" or
/// "hide"), `priority`, and `supported_reasoning_levels[].effort`.
fn codex_models(path: &Path) -> Option<EngineModels> {
    parse_codex_catalog(&read_json(path)?)
}

fn parse_codex_catalog(doc: &Value) -> Option<EngineModels> {
    let mut listed: Vec<&Value> = doc["models"]
        .as_array()?
        .iter()
        .filter(|model| model["visibility"].as_str() != Some("hide"))
        .collect();
    listed.sort_by_key(|model| model["priority"].as_u64().unwrap_or(u64::MAX));

    let mut models = Vec::new();
    let mut efforts = Vec::new();
    for model in listed {
        let Some(slug) = model["slug"].as_str() else { continue };
        let label = model["display_name"].as_str().unwrap_or(slug);
        models.push(ModelOption {
            id: slug.to_owned(),
            label: label.to_owned(),
        });
        for level in model["supported_reasoning_levels"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(effort) = level["effort"].as_str() {
                push_effort(&mut efforts, effort);
            }
        }
    }
    (!models.is_empty()).then_some(EngineModels { models, efforts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_catalog_lists_models_and_union_of_efforts() {
        let doc = json!({
            "catalog": { "config": { "models": [
                { "id": "claude-fable-5-1", "name": "Fable 5.1",
                  "thinking": { "effort_options": [{ "id": "low" }, { "id": "max" }] } },
                { "id": "claude-haiku-4-5", "name": "Haiku 4.5",
                  "thinking": { "effort_options": [{ "id": "low" }, { "id": "high" }] } }
            ] } }
        });
        let parsed = parse_claude_catalog(&doc).unwrap();
        assert_eq!(
            parsed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["claude-fable-5-1", "claude-haiku-4-5"]
        );
        assert_eq!(parsed.models[0].label, "Fable 5.1");
        assert_eq!(parsed.efforts, ["low", "max", "high"]);
    }

    #[test]
    fn codex_catalog_skips_hidden_and_orders_by_priority() {
        let doc = json!({ "models": [
            { "slug": "b", "display_name": "B", "visibility": "list", "priority": 2,
              "supported_reasoning_levels": [{ "effort": "medium" }] },
            { "slug": "hidden", "visibility": "hide", "priority": 0 },
            { "slug": "a", "display_name": "A", "visibility": "list", "priority": 1,
              "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "medium" }] }
        ] });
        let parsed = parse_codex_catalog(&doc).unwrap();
        assert_eq!(
            parsed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(parsed.efforts, ["low", "medium"]);
    }

    #[test]
    fn empty_or_malformed_catalog_is_none() {
        assert!(parse_claude_catalog(&json!({})).is_none());
        assert!(parse_codex_catalog(&json!({ "models": [] })).is_none());
    }
}
