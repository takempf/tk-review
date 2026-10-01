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
    /// The page cancelled the agent run; nothing went wrong.
    #[error("the run was cancelled")]
    Cancelled,
    /// A failure explained in a sentence or two, with the raw output behind it
    /// kept for debugging: the app shows `message` and keeps `detail` one
    /// click away.
    #[error("{message}")]
    Detailed { message: String, detail: String },
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
            Self::Cancelled => "cancelled",
            Self::Command(_) | Self::Detailed { .. } => "command",
        }
    }

    pub fn detailed(message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Detailed {
            message: message.into(),
            detail: detail.into(),
        }
    }

    /// The raw output behind the message, when there is any.
    pub fn detail(&self) -> Option<&str> {
        match self {
            Self::Detailed { detail, .. } => Some(detail),
            _ => None,
        }
    }
}

impl Serialize for GitError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("GitError", 3)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.serialize_field("detail", &self.detail())?;
        state.end()
    }
}
