use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git executable not found on PATH")]
    GitNotFound,
    #[error("claude executable not found on PATH")]
    ClaudeNotFound,
    #[error("codex executable not found on PATH")]
    CodexNotFound,
    #[error(
        "GitHub CLI (`gh`) executable not found on PATH; install it from https://cli.github.com/"
    )]
    GhNotFound,
    #[error("not a git repository: {0}")]
    NotARepo(String),
    #[error("unknown revision: {0}")]
    BadRevision(String),
    #[error("{0}")]
    Command(String),
}

impl GitError {
    /// Stable discriminant so the frontend can branch on the failure without
    /// matching on human-readable text.
    fn kind(&self) -> &'static str {
        match self {
            Self::GitNotFound => "gitNotFound",
            Self::ClaudeNotFound => "claudeNotFound",
            Self::CodexNotFound => "codexNotFound",
            Self::GhNotFound => "ghNotFound",
            Self::NotARepo(_) => "notARepo",
            Self::BadRevision(_) => "badRevision",
            Self::Command(_) => "command",
        }
    }
}

impl Serialize for GitError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("GitError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}
