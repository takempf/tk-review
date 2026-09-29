//! CLI-backed diff review.
//!
//! Shells out to an agent CLI in headless mode, the same way the git layer
//! shells out to `git`. Two engines are supported: `claude` (Claude Code,
//! `claude -p`) and `codex` (OpenAI Codex, `codex exec`). Both authenticate
//! through the CLI's own login, so the user's existing subscription covers the
//! usage — no API key. The process runs with the repository as its working
//! directory, which gives the agent's read-only tools the surrounding code, so
//! findings can account for context beyond the diff itself.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::git;
use crate::github::PrContext;

/// Ceiling on agentic turns for claude, as a backstop against a runaway
/// session. Generous enough for the model to read context around a sizeable
/// diff.
const MAX_TURNS: &str = "30";

/// How every prose field the agent writes should read. Shared by all the
/// prompts so the review, the explanation, and replies sound like one
/// reviewer. The app renders these fields as GitHub Markdown, and findings can
/// be posted to the pull request as-is, so Markdown is safe to ask for.
const WRITING_GUIDANCE: &str = r#"How to write:

Your readers are busy engineers fitting this in between other work. Most read the first one to three sentences of anything and skim the rest, so write for that. Saving the reader's time is the goal of every rule below:
- Lead with the point. A reader who stops after the first sentence should still know what matters and what to do.
- Keep every paragraph to one to three short sentences. When there is more to say, start a new paragraph or, usually better, a list.
- Sentences that carry file paths, identifiers, or jargon are slower to read, so keep those shorter still. Move the specifics out of the sentence and into a list or code block rather than stringing them through the prose.
- Prefer plain words. Say what happens to the user or the code ("uploads fail", "the cache never expires") before explaining the mechanism.
- One idea per piece. Two unrelated problems are two findings, not one long one.
- Cut what the reader can see for themselves: don't restate the diff, don't narrate how you investigated, don't hedge every sentence.
- When deep technical detail is needed, keep it but make it skimmable: the claim first, then the specifics as a list or a small code block. Never bury the conclusion under the detail.

Lists are the default for anything with more than one part, so use them liberally:
- A numbered list for anything ordered: steps to reproduce, a call path, a sequence of events, the order to fix things in.
- A bulleted list for parallel items: cases, conditions, affected files, options.
- Keep each item to a line or two, and never nest more than one level deep.

Your prose is rendered as GitHub-flavored Markdown. Beyond lists, use it where it makes the text easier to read, not as decoration:
- `inline code` for identifiers, file paths, flags, and literal values.
- A fenced code block with a language tag for a suggested fix or any snippet longer than a few tokens.
- **Bold** sparingly, for the one phrase a skimmer must not miss.
- No headings: these are comments, not documents.
A single plain sentence is often the right answer. Don't force structure onto something short.

For example, instead of one dense paragraph:

> `fetchUser` in `src/api/client.ts` now retries on every error including 4xx responses, which means a request rejected for bad credentials is retried twice more with backoff by `withRetry`, so the login form hangs for about seven seconds before showing the error, and the extra attempts also count against the rate limit.

write:

> A wrong password now takes about seven seconds to report.
>
> `fetchUser` retries every failure, including 4xx responses that can never succeed:
> 1. The login request is rejected with a 401.
> 2. `withRetry` tries twice more, with backoff.
> 3. The form shows the error only after the last attempt.
>
> The extra attempts also count against the rate limit. Retry only network errors and 5xx responses.

Before you answer, reread every piece of prose you wrote. Split any paragraph longer than three sentences, and turn any sentence that lists three or more things into a list.

Your prose may be posted as a GitHub pull request comment, where GitHub turns certain text patterns into links and notifications. Use this on purpose, and never by accident:
- `#123` links to issue or pull request 123 in this repository. Never write `#1`, `#2`, etc. to mean "the first finding" or "item 2" — it links to an unrelated pull request. Refer to other findings by what they are about (e.g. "the null-check finding in `parser.ts`") or say "finding 1" without the `#`.
- `@name` mentions and notifies that user or team. Only write `@name` when you mean to ping someone; wrap decorators, npm scopes, and similar in backticks (`@Injectable`, `@types/node`).
- A 7+ character hex string that matches a commit becomes a link to that commit. Cite a commit by its short SHA when it helps the reader; don't write hex strings that aren't commit references outside backticks.
- `owner/repo#123` and full GitHub URLs to issues, pull requests, commits, or lines also become links. Text inside `inline code` or fenced code blocks is never autolinked."#;

/// The JSON prompts' addendum to `WRITING_GUIDANCE`: Markdown lives inside
/// string values, and titles stay plain because the app shows them as labels.
const JSON_MARKDOWN_NOTE: &str = "Markdown goes inside the JSON string values, with newlines escaped as `\\n` as JSON requires. Titles are plain text: no Markdown in a `title`, and ideally no more than ten words.";

/// How the review and re-review prompts anchor a finding: one line, a span of
/// lines, or the whole file.
const LOCATION_GUIDANCE: &str = "`line` is the new-file line number a finding anchors to, or null when it applies to the file as a whole. When the problem spans several lines — a block, a function, a condition split across lines — set `line` to its first line and `endLine` to its last, so the whole span can be highlighted; otherwise `endLine` is null. Keep a span to the lines that actually show the problem, not the whole enclosing function.";

/// How the review and re-review prompts pick `verdict` and write `conclusion`:
/// the review the user would submit on GitHub, drafted for them to adjust.
const VERDICT_GUIDANCE: &str = r#"`verdict` is the GitHub review you recommend submitting:
- "approve": nothing needs to change before merging. Any findings are suggestions or nits the author can take or leave.
- "request_changes": at least one problem must be fixed before this merges, such as a real bug, a security issue, or data loss.
- "comment": somewhere in between. There are questions or concerns the author should answer, but you are not confident they block merging.

`conclusion` is the body of that GitHub review, addressed to the author. The findings are posted separately, so don't repeat their detail:
- Open with the bottom line in one sentence, e.g. "Good to merge." or "One bug to fix before this merges."
- If anything needs doing, follow with a short list of what, most important first. Name each item by what it is about, not by a finding number.
- Stop there: no praise padding, no sign-off, and at most about 60 words."#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    /// Path as it appears in the diff's compare side.
    pub path: String,
    /// New-file line number the finding anchors to, when there is one: the
    /// first line, for a finding that spans several.
    #[serde(default)]
    pub line: Option<u32>,
    /// Last new-file line of the span, for a finding that covers a range of
    /// lines; `None` for a single line or the whole file. See `tidy_span`.
    #[serde(default, alias = "end_line")]
    pub end_line: Option<u32>,
    /// One of critical | warning | suggestion | nit — but the model writes it,
    /// so treat it as a label rather than an enum.
    pub severity: String,
    pub title: String,
    pub body: String,
}

impl ReviewFinding {
    /// Settles what the model wrote into one shape per kind of location: a span
    /// that ends where it starts is a single line, one written backwards is
    /// turned around, and a span with no start is the whole file.
    fn tidy_span(&mut self) {
        match (self.line, self.end_line) {
            (None, _) => self.end_line = None,
            (Some(start), Some(end)) if end == start => self.end_line = None,
            (Some(start), Some(end)) if end < start => {
                self.line = Some(end);
                self.end_line = Some(start);
            }
            _ => {}
        }
    }

    /// Where the finding points, for the prompts that list findings back to the
    /// agent: `line: 12`, `lines: 12-18`, or `line: whole file`.
    fn location_label(&self) -> String {
        match (self.line, self.end_line) {
            (Some(start), Some(end)) => format!("lines: {start}-{end}"),
            (Some(line), None) => format!("line: {line}"),
            (None, _) => "line: whole file".to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<ReviewFinding>,
    /// One of approve | comment | request_changes — the GitHub review the
    /// agent recommends. The model writes it, so treat it as a label; empty
    /// when it gave none.
    #[serde(default)]
    pub verdict: String,
    /// A draft body for that GitHub review, addressed to the author.
    #[serde(default)]
    pub conclusion: String,
}

/// Reviews the whole comparison with the chosen engine and returns structured
/// findings.
///
/// `compare: None` reviews against the working tree, matching `diff_branches`.
/// `model: None` and `effort: None` use whatever the CLI itself is configured
/// to default to.
pub fn review_diff(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    engine: &str,
    model: Option<&str>,
    effort: Option<&str>,
    pr_context: Option<&PrContext>,
) -> Result<ReviewResult, GitError> {
    // Validated up front so a typo reports as itself rather than as whatever
    // the git plumbing happens to say first.
    if !matches!(engine, "claude" | "codex") {
        return Err(GitError::Command(format!(
            "unknown review engine: {engine}"
        )));
    }

    let patch = git::get_patch(root, merge_base, compare)?;
    if patch.trim().is_empty() {
        return Err(GitError::Command(
            "There is nothing to review: the diff is empty.".into(),
        ));
    }

    let prompt = build_prompt(compare, &patch, pr_context);
    let result_text = if engine == "claude" {
        claude_result_text(root, &prompt, model, effort)?
    } else {
        codex_result_text(root, &prompt, model, effort, Some(REVIEW_SCHEMA))?
    };
    let mut result: ReviewResult = parse_agent_json(&result_text)?;
    for finding in &mut result.findings {
        finding.tidy_span();
    }
    Ok(result)
}

/// The re-review's verdict on one finding from the previous review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingResolution {
    /// Index into the prior findings list the prompt numbered.
    pub index: usize,
    /// One of addressed | unaddressed | partial | obsolete — but the model
    /// writes it, so treat it as a label rather than an enum.
    pub status: String,
    /// What the verdict is grounded in — the fix found, or what still remains.
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReReviewResult {
    pub summary: String,
    /// One entry per prior finding, in principle; the model writes them, so
    /// callers must tolerate gaps and out-of-range indices.
    #[serde(default)]
    pub resolutions: Vec<FindingResolution>,
    /// New problems only — the prior findings are covered by `resolutions`.
    #[serde(default)]
    pub findings: Vec<ReviewFinding>,
    /// As on `ReviewResult`, but weighing the prior findings still open too.
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub conclusion: String,
}

/// Re-reviews the comparison against an earlier review: judges whether each
/// prior finding was addressed, then reviews the current diff for new issues.
///
/// One CLI run rather than two: the same read of the current code answers
/// both questions, and splitting them would double the agentic cost.
#[allow(clippy::too_many_arguments)]
pub fn re_review_diff(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    engine: &str,
    model: Option<&str>,
    effort: Option<&str>,
    prior_summary: &str,
    prior_findings: &[ReviewFinding],
    pr_context: Option<&PrContext>,
) -> Result<ReReviewResult, GitError> {
    if !matches!(engine, "claude" | "codex") {
        return Err(GitError::Command(format!(
            "unknown review engine: {engine}"
        )));
    }
    if prior_findings.is_empty() && prior_summary.trim().is_empty() {
        return Err(GitError::Command(
            "There is no previous review to check against.".into(),
        ));
    }

    let patch = git::get_patch(root, merge_base, compare)?;
    if patch.trim().is_empty() {
        return Err(GitError::Command(
            "There is nothing to review: the diff is empty.".into(),
        ));
    }

    let prompt = build_re_review_prompt(compare, prior_summary, prior_findings, &patch, pr_context);
    let result_text = if engine == "claude" {
        claude_result_text(root, &prompt, model, effort)?
    } else {
        codex_result_text(root, &prompt, model, effort, Some(RE_REVIEW_SCHEMA))?
    };
    let mut result: ReReviewResult = parse_agent_json(&result_text)?;
    for finding in &mut result.findings {
        finding.tidy_span();
    }
    Ok(result)
}

fn build_re_review_prompt(
    compare: Option<&str>,
    prior_summary: &str,
    prior_findings: &[ReviewFinding],
    patch: &str,
    pr_context: Option<&PrContext>,
) -> String {
    let target = match compare {
        Some(compare) => format!("the `{compare}` ref"),
        None => "the working tree, so it may include uncommitted work-in-progress".to_owned(),
    };

    let mut findings_list = String::new();
    for (index, finding) in prior_findings.iter().enumerate() {
        findings_list.push_str(&format!(
            "{index}. [{}] {} ({}) — {}\n   {}\n",
            finding.severity,
            finding.path,
            finding.location_label(),
            finding.title,
            finding.body
        ));
    }

    let mut prompt = format!(
        r#"You are re-reviewing a git diff you reviewed before, the way a careful senior engineer follows up on their own review. The compare side of the diff is {target}. The code may have changed since your earlier review.

You are running inside the repository the diff belongs to. Use your file reading and search tools freely: verdicts must be grounded in the code as it stands now, and the diff alone rarely shows whether a fix landed — read the file when it does not.

Your earlier review said:

{prior_summary}

Its findings, numbered:

{findings_list}
You have two jobs, in order:

1. For EVERY numbered finding, judge whether it has been addressed in the current code. Use `status` values: "addressed" (fixed), "unaddressed" (still present as reported), "partial" (improved but not fully fixed), "obsolete" (the code it pointed at is gone or changed enough that the finding no longer applies). In `note`, say what the verdict is grounded in — where the fix is, or what still remains. If a finding was wrong to begin with, mark it "obsolete" and say so.

2. Review the current diff for NEW problems, exactly as you would a fresh pull request: bugs, broken edge cases, security issues, misleading names or comments, missing error handling at real boundaries. Do not re-report the numbered findings — their resolutions cover them. Pay particular attention to code that changed since the earlier review: fixes introduce their own bugs.

Respond with ONLY a JSON object — no markdown fences, no prose before or after — matching this shape:

{{
  "summary": "One to three short sentences: how the earlier findings fared, and where the remaining risk is.",
  "verdict": "approve | comment | request_changes",
  "conclusion": "The GitHub review body to submit with the verdict, addressed to the author.",
  "resolutions": [
    {{
      "index": 0,
      "status": "addressed | unaddressed | partial | obsolete",
      "note": "What this verdict is grounded in."
    }}
  ],
  "findings": [
    {{
      "path": "path/as/it/appears/in/the/diff",
      "line": 123,
      "endLine": null,
      "severity": "critical | warning | suggestion | nit",
      "title": "One short sentence naming the problem.",
      "body": "What is wrong, why it matters, and what to do instead."
    }}
  ]
}}

`resolutions` must have exactly one entry per numbered finding, using its number as `index`. {LOCATION_GUIDANCE} Include new findings you are uncertain about, marked with a lower severity, rather than silently dropping them. Do not pad with praise, and do not report style nits a formatter would catch. An empty findings array is a valid answer when nothing new is wrong.

A finding's `body` is usually one short paragraph, followed by a list or code block only when the specifics need one.

{VERDICT_GUIDANCE}
Weigh the earlier findings that are still unaddressed or partial alongside the new ones. The conclusion should say what is left, not what was fixed.

{WRITING_GUIDANCE}

{JSON_MARKDOWN_NOTE} Keep each `note` to a sentence or two.

The diff:

{patch}"#
    );
    if let Some(pr) = pr_context {
        // Same placement as the first review's prompt: framing before the diff.
        let marker = "The diff:\n\n";
        if let Some(position) = prompt.find(marker) {
            let mut context = String::new();
            append_pr_context(&mut context, pr);
            prompt.insert_str(position, &context);
        }
    }
    prompt
}

/// A plain-language explanation of one file's part in the change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileExplanation {
    /// Path as it appears in the diff's compare side, matching `ReviewFinding`.
    pub path: String,
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    /// What the whole change does, as a readable paragraph or two.
    pub overall: String,
    #[serde(default)]
    pub files: Vec<FileExplanation>,
}

/// Explains the comparison in plain language: one overview plus one entry per
/// file. A reading aid rather than a judgement — see `build_explain_prompt`.
///
/// Deliberately a separate CLI run from `review_diff` rather than an extra
/// field on the review: the two jobs want different framing, and a failure in
/// one should not cost the other.
pub fn explain_diff(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    engine: &str,
    model: Option<&str>,
    effort: Option<&str>,
    pr_context: Option<&PrContext>,
) -> Result<ExplainResult, GitError> {
    if !matches!(engine, "claude" | "codex") {
        return Err(GitError::Command(format!(
            "unknown review engine: {engine}"
        )));
    }

    let patch = git::get_patch(root, merge_base, compare)?;
    if patch.trim().is_empty() {
        return Err(GitError::Command(
            "There is nothing to explain: the diff is empty.".into(),
        ));
    }

    let prompt = build_explain_prompt(compare, &patch, pr_context);
    let result_text = if engine == "claude" {
        claude_result_text(root, &prompt, model, effort)?
    } else {
        codex_result_text(root, &prompt, model, effort, Some(EXPLAIN_SCHEMA))?
    };
    parse_agent_json(&result_text)
}

fn build_explain_prompt(
    compare: Option<&str>,
    patch: &str,
    pr_context: Option<&PrContext>,
) -> String {
    let target = match compare {
        Some(compare) => format!("the `{compare}` ref"),
        None => "the working tree, so it may include uncommitted work-in-progress".to_owned(),
    };
    let mut prompt = format!(
        r#"You are helping a reviewer understand a git diff before they read it. The compare side of the diff is {target}.

You are explaining this change, not judging it. No findings, no verdicts, no praise, no suggestions — your only job is to orient the reader so the code makes sense when they get to it.

You are running inside the repository the diff belongs to. Use your file reading and search tools freely: when the diff alone does not explain what a file is for or why a change was needed, go read the surrounding code. That is exactly the gap you are filling.

Respond with ONLY a JSON object — no markdown fences, no prose before or after — matching this shape:

{{
  "overall": "What this change accomplishes and how it is put together.",
  "files": [
    {{
      "path": "path/as/it/appears/in/the/diff",
      "explanation": "What this file does, and what changed in it."
    }}
  ]
}}

For `overall`: what the change accomplishes, the shape of the approach, and how the pieces fit together — which files are the heart of the change and which are fallout (renames, plumbing, test updates). One to three sentences, or a sentence followed by a short list when the change has several distinct parts.

For each file: open with a clause of context on what the file does in this codebase, then say what changed in it and why. Let length follow complexity — one to three sentences for a typical file, a sentence and then a short list for a genuinely tricky one, a single line for a mechanical rename. Include every file in the diff that carries real meaning; group trivia (lockfiles, generated output) into a one-liner on one of them rather than padding. Skip binary files. Use the compare-side path exactly as the diff spells it.

Write for someone competent who has not seen this code before. Prefer concrete nouns from the codebase over generic description.

{WRITING_GUIDANCE}

{JSON_MARKDOWN_NOTE}

The diff:

{patch}"#
    );
    if let Some(pr) = pr_context {
        // The author's own framing belongs before the diff, next to the rest of
        // the orienting instructions.
        let marker = "The diff:\n\n";
        if let Some(position) = prompt.find(marker) {
            let mut context = String::new();
            append_pr_intent(&mut context, pr);
            prompt.insert_str(position, &context);
        }
    }
    prompt
}

/// The PR's own account of the change, as raw material for an explanation.
///
/// Deliberately not `append_pr_context`: that one tells a reviewer what has
/// already been argued so they don't repeat it. Here the description is a
/// source to draw on, and the discussion is background on why the code looks
/// the way it does.
fn append_pr_intent(prompt: &mut String, pr: &PrContext) {
    prompt.push_str(&format!(
        "This diff is pull request #{}: \"{}\" by @{}. The author describes it as follows — treat this as a source for your explanation, and correct it where the code disagrees:\n{}\n\n",
        pr.number, pr.title, pr.author, pr.body
    ));
    if pr.comments.is_empty() {
        return;
    }
    prompt.push_str(
        "Discussion on the pull request, which may explain why parts of the code look the way they do:\n",
    );
    for comment in &pr.comments {
        let anchor = match (&comment.path, comment.line) {
            (Some(path), Some(line)) => format!(" ({path}:{line})"),
            (Some(path), None) => format!(" ({path})"),
            (None, _) => String::new(),
        };
        prompt.push_str(&format!(
            "@{}{anchor}: {}\n\n",
            comment.author, comment.body
        ));
    }
}

/// One entry of a finding's (or the review's) comment thread.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadComment {
    /// `"user"` for the person; anything else is the reviewer.
    pub author: String,
    pub text: String,
}

/// Answers a follow-up comment on a review, in the voice of the reviewer.
///
/// The exchange is stateless: every call carries the review summary, the
/// finding (with its file's diff) or the whole patch, and the thread so far,
/// so replies keep working after restarts and don't depend on CLI session
/// files surviving.
#[allow(clippy::too_many_arguments)]
pub fn review_reply(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    engine: &str,
    model: Option<&str>,
    effort: Option<&str>,
    summary: &str,
    finding: Option<&ReviewFinding>,
    thread: &[ThreadComment],
    comment: &str,
    pr_context: Option<&PrContext>,
) -> Result<String, GitError> {
    if !matches!(engine, "claude" | "codex") {
        return Err(GitError::Command(format!(
            "unknown review engine: {engine}"
        )));
    }

    let patch = match finding {
        Some(finding) => git::get_file_patch(root, merge_base, compare, &finding.path)?,
        None => git::get_patch(root, merge_base, compare)?,
    };

    let prompt = build_reply_prompt(
        compare, summary, finding, thread, comment, &patch, pr_context,
    );
    let reply = if engine == "claude" {
        claude_result_text(root, &prompt, model, effort)?
    } else {
        codex_result_text(root, &prompt, model, effort, None)?
    };
    Ok(reply.trim().to_owned())
}

fn build_reply_prompt(
    compare: Option<&str>,
    summary: &str,
    finding: Option<&ReviewFinding>,
    thread: &[ThreadComment],
    comment: &str,
    patch: &str,
    pr_context: Option<&PrContext>,
) -> String {
    let target = match compare {
        Some(compare) => format!("the `{compare}` ref"),
        None => "the working tree, so it may include uncommitted work-in-progress".to_owned(),
    };

    let mut prompt = format!(
        "You are the code reviewer for a git diff (its compare side is {target}). You reviewed it earlier and wrote this summary:\n\n{summary}\n\n"
    );

    if let Some(pr) = pr_context {
        append_pr_context(&mut prompt, pr);
    }

    match finding {
        Some(finding) => {
            prompt.push_str(&format!(
                "This conversation is about one finding from your review:\n- file: {} ({})\n- severity: {}\n- {}\n- {}\n\nThe diff for that file:\n\n{patch}\n\n",
                finding.path,
                finding.location_label(),
                finding.severity,
                finding.title,
                finding.body
            ));
        }
        None => {
            prompt.push_str(&format!(
                "This conversation is about the review as a whole. The diff:\n\n{patch}\n\n"
            ));
        }
    }

    if !thread.is_empty() {
        prompt.push_str("The conversation so far:\n\n");
        for entry in thread {
            let who = if entry.author == "user" {
                "User"
            } else {
                "You"
            };
            prompt.push_str(&format!("{who}: {}\n\n", entry.text));
        }
    }

    prompt.push_str(&format!(
        "The user's new comment:\n\n{comment}\n\nYou are running inside the repository — use your file reading and search tools when checking the code would improve your answer. Reply directly to the user's comment: no JSON, no restating the finding, no preamble. Answer the question they asked first, and if the user shows you were wrong, say so plainly.\n\n{WRITING_GUIDANCE}"
    ));
    prompt
}

fn build_prompt(compare: Option<&str>, patch: &str, pr_context: Option<&PrContext>) -> String {
    let target = match compare {
        Some(compare) => format!("the `{compare}` ref"),
        None => "the working tree, so it may include uncommitted work-in-progress".to_owned(),
    };
    let mut prompt = format!(
        r#"You are reviewing a git diff the way a careful senior engineer reviews a pull request. The compare side of the diff is {target}.

You are running inside the repository the diff belongs to. Use your file reading and search tools to check surrounding context whenever it would change a finding — callers of a changed function, related tests, the definitions a change relies on.

Respond with ONLY a JSON object — no markdown fences, no prose before or after — matching this shape:

{{
  "summary": "One to three short sentences on the overall shape of the change and where the risk is.",
  "verdict": "approve | comment | request_changes",
  "conclusion": "The GitHub review body to submit with the verdict, addressed to the author.",
  "findings": [
    {{
      "path": "path/as/it/appears/in/the/diff",
      "line": 123,
      "endLine": null,
      "severity": "critical | warning | suggestion | nit",
      "title": "One short sentence naming the problem.",
      "body": "What is wrong, why it matters, and what to do instead."
    }}
  ]
}}

{LOCATION_GUIDANCE} Report real problems: bugs, broken edge cases, security issues, misleading names or comments, missing error handling at real boundaries. Include findings you are uncertain about, marked with a lower severity, rather than silently dropping them. Do not pad with praise, do not restate the diff, and do not report style nits a formatter would catch. An empty findings array is a valid answer for a clean diff.

A finding's `body` is usually one short paragraph, followed by a list or code block only when the specifics need one.

{VERDICT_GUIDANCE}

{WRITING_GUIDANCE}

{JSON_MARKDOWN_NOTE}

The diff:

{patch}"#
    );
    if let Some(pr) = pr_context {
        // Keep PR discussion ahead of the diff, where the reviewer's initial
        // framing instructions live, while leaving the exact diff ending intact.
        let marker = "The diff:\n\n";
        if let Some(position) = prompt.find(marker) {
            let mut context = String::new();
            append_pr_context(&mut context, pr);
            prompt.insert_str(position, &context);
        }
    }
    prompt
}

fn append_pr_context(prompt: &mut String, pr: &PrContext) {
    prompt.push_str(&format!(
        "This diff is pull request #{}: \"{}\" by @{}.\nDescription:\n{}\n\nExisting discussion (do not repeat points already raised; you may agree, disagree, or extend them):\n",
        pr.number, pr.title, pr.author, pr.body
    ));
    if pr.comments.is_empty() {
        prompt.push_str("(No existing discussion.)\n\n");
        return;
    }
    for comment in &pr.comments {
        let anchor = match (&comment.path, comment.line) {
            (Some(path), Some(line)) => format!(" ({path}:{line})"),
            (Some(path), None) => format!(" ({path})"),
            (None, _) => String::new(),
        };
        prompt.push_str(&format!(
            "@{}{anchor}: {}\n\n",
            comment.author, comment.body
        ));
    }
}

/// One way of launching a CLI: the program itself, plus a directory to put at
/// the front of the child's PATH when the program is a launcher that needs its
/// siblings (an npm shim starts with `#!/usr/bin/env node`, and `node` lives
/// in the same bin directory).
pub(crate) struct CliCandidate {
    pub(crate) program: PathBuf,
    pub(crate) path_prepend: Option<PathBuf>,
}

impl CliCandidate {
    fn plain(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            path_prepend: None,
        }
    }
}

/// Where a CLI is, given that a macOS app launched from the dock gets a
/// minimal PATH that misses every place these CLIs actually install to. The
/// bare name is preferred (respects the user's PATH when there is one), with
/// the common install locations — including node version-manager installs,
/// which is where an `npm i -g` puts codex — as fallbacks.
pub(crate) fn cli_candidates(name: &str) -> Vec<CliCandidate> {
    let mut candidates = vec![CliCandidate::plain(name)];
    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        candidates.push(CliCandidate::plain(home.join(".local/bin").join(name)));
        candidates.push(CliCandidate::plain(
            home.join(format!(".{name}/local/{name}")),
        ));

        // fnm and nvm keep one bin dir per node version; prefer the newest.
        for versions_dir in [
            home.join(".local/share/fnm/node-versions"),
            home.join(".nvm/versions/node"),
        ] {
            let Ok(entries) = std::fs::read_dir(&versions_dir) else {
                continue;
            };
            let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
            versions.sort();
            versions.reverse();
            for version in versions {
                for bin in [version.join("installation/bin"), version.join("bin")] {
                    let program = bin.join(name);
                    if program.is_file() {
                        candidates.push(CliCandidate {
                            program,
                            path_prepend: Some(bin),
                        });
                    }
                }
            }
        }
    }
    candidates.push(CliCandidate::plain(
        Path::new("/opt/homebrew/bin").join(name),
    ));
    candidates.push(CliCandidate::plain(Path::new("/usr/local/bin").join(name)));
    candidates
}

/// Spawns the first launchable candidate for `name`, feeds it the prompt on
/// stdin, and returns its output. The prompt goes through stdin rather than
/// argv because a patch can easily exceed the argument-size limit.
fn run_cli(
    root: &Path,
    name: &str,
    args: &[&str],
    prompt: &str,
    not_found: GitError,
) -> Result<std::process::Output, GitError> {
    if !root.is_dir() {
        return Err(GitError::NotARepo(root.display().to_string()));
    }

    let mut spawned = None;
    for candidate in cli_candidates(name) {
        let mut command = Command::new(&candidate.program);
        if let Some(prepend) = &candidate.path_prepend {
            let existing = std::env::var_os("PATH").unwrap_or_default();
            let mut path = prepend.as_os_str().to_owned();
            path.push(":");
            path.push(&existing);
            command.env("PATH", path);
        }
        match command
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => {
                spawned = Some(child);
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(GitError::Command(err.to_string())),
        }
    }
    let mut child = spawned.ok_or(not_found)?;

    child
        .stdin
        .take()
        .ok_or_else(|| GitError::Command(format!("could not open {name} stdin")))?
        .write_all(prompt.as_bytes())
        .map_err(|err| GitError::Command(err.to_string()))?;

    let output = child
        .wait_with_output()
        .map_err(|err| GitError::Command(err.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // On failure these CLIs often write the explanation to stdout instead.
        let stdout = String::from_utf8_lossy(&output.stdout);
        let log = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        let detail = failure_detail(&log, prompt);
        return Err(GitError::Command(format!("{name} failed: {detail}")));
    }
    Ok(output)
}

/// Lines of a failed CLI's log kept when no explicit error line is found.
const FAILURE_TAIL_LINES: usize = 20;

/// The part of a failed CLI's log worth showing. Codex's stderr is its whole
/// session log, which echoes the prompt (patch included) before the error, so
/// the raw log buries a one-line explanation under the diff. Codex reports each
/// failure as an `ERROR: ` line, often a JSON API error, so those come first;
/// failing that, the tail of the log with the prompt echo cut out.
fn failure_detail(log: &str, prompt: &str) -> String {
    let mut errors: Vec<String> = Vec::new();
    for line in log.lines() {
        let Some(rest) = line.strip_prefix("ERROR: ") else {
            continue;
        };
        let message = serde_json::from_str::<serde_json::Value>(rest)
            .ok()
            .and_then(|error| error["error"]["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| rest.trim().to_owned());
        // Codex retries once, so the same error usually shows up twice.
        if !errors.contains(&message) {
            errors.push(message);
        }
    }
    if !errors.is_empty() {
        return errors.join("\n");
    }

    let prompt = prompt.trim();
    let log = if prompt.is_empty() {
        log.to_owned()
    } else {
        log.replace(prompt, "")
    };
    let lines: Vec<&str> = log.trim().lines().collect();
    lines[lines.len().saturating_sub(FAILURE_TAIL_LINES)..].join("\n")
}

/// Runs `claude -p` and unwraps the CLI's JSON envelope down to the model's
/// final text.
fn claude_result_text(
    root: &Path,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<String, GitError> {
    let mut args = vec!["-p", "--output-format", "json", "--max-turns", MAX_TURNS];
    if let Some(model) = model {
        args.extend(["--model", model]);
    }
    if let Some(effort) = effort {
        args.extend(["--effort", effort]);
    }

    let output = run_cli(root, "claude", &args, prompt, GitError::ClaudeNotFound)?;
    unwrap_claude_envelope(&output.stdout)
}

/// Parses `claude -p --output-format json`: an envelope whose `result` field
/// carries the model's final text.
fn unwrap_claude_envelope(raw: &[u8]) -> Result<String, GitError> {
    let text = String::from_utf8_lossy(raw);
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(envelope) => {
            if envelope["is_error"].as_bool() == Some(true) {
                return Err(GitError::Command(format!(
                    "claude reported an error: {}",
                    envelope["result"].as_str().unwrap_or("unknown failure")
                )));
            }
            match envelope["result"].as_str() {
                Some(result) => Ok(result.to_owned()),
                // Not the envelope shape — treat the whole output as the answer.
                None => Ok(text.into_owned()),
            }
        }
        Err(_) => Ok(text.into_owned()),
    }
}

/// JSON Schema for the review shape, enforced by codex on its final message.
const REVIEW_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "summary": {"type": "string"},
    "verdict": {"type": "string", "enum": ["approve", "comment", "request_changes"]},
    "conclusion": {"type": "string"},
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {"type": "string"},
          "line": {"type": ["integer", "null"]},
          "endLine": {"type": ["integer", "null"]},
          "severity": {"type": "string"},
          "title": {"type": "string"},
          "body": {"type": "string"}
        },
        "required": ["path", "line", "endLine", "severity", "title", "body"],
        "additionalProperties": false
      }
    }
  },
  "required": ["summary", "verdict", "conclusion", "findings"],
  "additionalProperties": false
}"#;

/// JSON Schema for the re-review shape, enforced by codex on its final message.
const RE_REVIEW_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "summary": {"type": "string"},
    "verdict": {"type": "string", "enum": ["approve", "comment", "request_changes"]},
    "conclusion": {"type": "string"},
    "resolutions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": {"type": "integer"},
          "status": {"type": "string"},
          "note": {"type": "string"}
        },
        "required": ["index", "status", "note"],
        "additionalProperties": false
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {"type": "string"},
          "line": {"type": ["integer", "null"]},
          "endLine": {"type": ["integer", "null"]},
          "severity": {"type": "string"},
          "title": {"type": "string"},
          "body": {"type": "string"}
        },
        "required": ["path", "line", "endLine", "severity", "title", "body"],
        "additionalProperties": false
      }
    }
  },
  "required": ["summary", "verdict", "conclusion", "resolutions", "findings"],
  "additionalProperties": false
}"#;

/// JSON Schema for the explanation shape, enforced by codex on its final message.
const EXPLAIN_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "overall": {"type": "string"},
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {"type": "string"},
          "explanation": {"type": "string"}
        },
        "required": ["path", "explanation"],
        "additionalProperties": false
      }
    }
  },
  "required": ["overall", "files"],
  "additionalProperties": false
}"#;

/// Runs `codex exec` and returns the model's final message.
///
/// Codex's stdout is a human-readable activity log, so the final message is
/// captured through `--output-last-message` into a temp file instead of being
/// fished out of the log. When a `schema` is given, `--output-schema` pins the
/// message to it, so parsing is a formality rather than a gamble; replies are
/// plain text and pass `None`.
fn codex_result_text(
    root: &Path,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    schema: Option<&str>,
) -> Result<String, GitError> {
    let unique = format!(
        "tk-review-codex-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    );
    let out_path = std::env::temp_dir().join(format!("{unique}.txt"));
    let schema_path = std::env::temp_dir().join(format!("{unique}.schema.json"));
    if let Some(schema) = schema {
        std::fs::write(&schema_path, schema)
            .map_err(|err| GitError::Command(format!("could not write codex schema: {err}")))?;
    }

    let out_arg = out_path.display().to_string();
    let schema_arg = schema_path.display().to_string();
    let mut args = vec![
        "exec",
        // Review must never write to the repo; reads are all it needs.
        "--sandbox",
        "read-only",
        "--output-last-message",
        &out_arg,
    ];
    if schema.is_some() {
        args.extend(["--output-schema", &schema_arg]);
    }
    if let Some(model) = model {
        args.extend(["--model", model]);
    }
    // Codex has no effort flag; the documented spelling is a config override.
    let effort_arg = effort.map(|effort| format!("model_reasoning_effort={effort}"));
    if let Some(effort_arg) = &effort_arg {
        args.extend(["-c", effort_arg]);
    }
    // Read the prompt from stdin.
    args.push("-");

    let run = run_cli(root, "codex", &args, prompt, GitError::CodexNotFound);
    let message = std::fs::read_to_string(&out_path);
    // Best effort: the temp files are small, but don't leave a pair per review.
    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&schema_path);

    run?;
    message.map_err(|err| GitError::Command(format!("could not read codex output: {err}")))
}

/// Parses an agent's JSON answer out of its final text, tolerating fences and
/// stray prose around the object rather than sinking an otherwise good result.
fn parse_agent_json<T: serde::de::DeserializeOwned>(result_text: &str) -> Result<T, GitError> {
    let json = extract_json_object(result_text).ok_or_else(|| {
        GitError::Command(format!(
            "the agent did not answer in the expected format:\n{}",
            result_text.trim()
        ))
    })?;

    serde_json::from_str(json)
        .map_err(|err| GitError::Command(format!("could not parse the agent's answer: {err}")))
}

/// The outermost `{...}` span of the text, tolerating fences and stray prose.
fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| &text[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The claude path end to end: envelope in, structured review out.
    fn parse_claude(raw: &[u8]) -> Result<ReviewResult, GitError> {
        parse_agent_json(&unwrap_claude_envelope(raw)?)
    }

    fn envelope(result: &str) -> String {
        serde_json::json!({"type": "result", "is_error": false, "result": result}).to_string()
    }

    const REVIEW_JSON: &str = r#"{
        "summary": "Small, focused change.",
        "findings": [
            {"path": "src/a.ts", "line": 12, "severity": "warning",
             "title": "Off-by-one in loop bound.", "body": "The loop misses the last element."},
            {"path": "src/b.ts", "line": null, "severity": "nit",
             "title": "Stale comment.", "body": "The comment describes removed behavior."}
        ]
    }"#;

    #[test]
    fn parses_review_from_the_claude_envelope() {
        let review = parse_claude(envelope(REVIEW_JSON).as_bytes()).expect("parse");
        assert_eq!(review.summary, "Small, focused change.");
        assert_eq!(review.findings.len(), 2);
        assert_eq!(review.findings[0].line, Some(12));
        assert_eq!(review.findings[1].line, None);
    }

    /// The codex path hands `parse_agent_json` the final message directly.
    #[test]
    fn parses_review_from_a_bare_final_message() {
        let review: ReviewResult = parse_agent_json(REVIEW_JSON).expect("parse");
        assert_eq!(review.findings.len(), 2);
    }

    #[test]
    fn tolerates_fences_and_prose_around_the_json() {
        let wrapped = format!("Here is the review:\n```json\n{REVIEW_JSON}\n```\nDone.");
        let review: ReviewResult = parse_agent_json(&wrapped).expect("parse");
        assert_eq!(review.findings.len(), 2);
        let review = parse_claude(envelope(&wrapped).as_bytes()).expect("parse");
        assert_eq!(review.findings.len(), 2);
    }

    #[test]
    fn a_finding_can_span_a_range_of_lines() {
        let json = r#"{"summary": "One span.", "findings": [
            {"path": "src/a.ts", "line": 12, "endLine": 18, "severity": "warning",
             "title": "Loop body mutates its bound.", "body": "Hoist the length."}
        ]}"#;
        let review: ReviewResult = parse_agent_json(json).expect("parse");
        assert_eq!(review.findings[0].line, Some(12));
        assert_eq!(review.findings[0].end_line, Some(18));
        // Findings from before spans existed carry no end.
        let review: ReviewResult = parse_agent_json(REVIEW_JSON).expect("parse");
        assert_eq!(review.findings[0].end_line, None);
    }

    #[test]
    fn the_snake_case_spelling_of_end_line_is_accepted() {
        let json = r#"{"summary": "", "findings": [
            {"path": "a", "line": 3, "end_line": 5, "severity": "nit", "title": "t", "body": "b"}
        ]}"#;
        let review: ReviewResult = parse_agent_json(json).expect("parse");
        assert_eq!(review.findings[0].end_line, Some(5));
    }

    #[test]
    fn tidy_span_settles_what_the_model_wrote() {
        let finding = |line, end_line| ReviewFinding {
            path: "a".into(),
            line,
            end_line,
            severity: "nit".into(),
            title: "t".into(),
            body: "b".into(),
        };
        let tidied = |mut finding: ReviewFinding| {
            finding.tidy_span();
            (finding.line, finding.end_line)
        };
        assert_eq!(tidied(finding(Some(4), Some(9))), (Some(4), Some(9)));
        assert_eq!(tidied(finding(Some(4), Some(4))), (Some(4), None));
        assert_eq!(tidied(finding(Some(9), Some(4))), (Some(4), Some(9)));
        assert_eq!(tidied(finding(None, Some(4))), (None, None));
        assert_eq!(tidied(finding(Some(4), None)), (Some(4), None));
    }

    #[test]
    fn review_prompts_and_codex_schemas_ask_for_an_end_line() {
        let patch = "diff --git a/src/a.ts b/src/a.ts";
        assert!(build_prompt(None, patch, None).contains(LOCATION_GUIDANCE));
        assert!(
            build_re_review_prompt(None, "Summary.", &[], patch, None).contains(LOCATION_GUIDANCE)
        );
        for schema in [REVIEW_SCHEMA, RE_REVIEW_SCHEMA] {
            let schema: serde_json::Value = serde_json::from_str(schema).expect("schema");
            let finding = &schema["properties"]["findings"]["items"];
            assert!(finding["properties"]["endLine"].is_object());
            assert!(finding["required"]
                .as_array()
                .expect("required")
                .contains(&"endLine".into()));
        }
    }

    #[test]
    fn missing_findings_defaults_to_empty() {
        let review = parse_claude(envelope(r#"{"summary": "Clean."}"#).as_bytes()).expect("parse");
        assert!(review.findings.is_empty());
    }

    #[test]
    fn parses_the_recommended_verdict_and_conclusion() {
        let json = r#"{"summary": "Clean.", "verdict": "approve", "conclusion": "Good to merge.", "findings": []}"#;
        let review = parse_claude(envelope(json).as_bytes()).expect("parse");
        assert_eq!(review.verdict, "approve");
        assert_eq!(review.conclusion, "Good to merge.");
    }

    /// Reviews stored before verdicts existed, and models that skip the field,
    /// still parse; the app falls back to a plain comment.
    #[test]
    fn a_missing_verdict_defaults_to_empty() {
        let review: ReviewResult = parse_agent_json(REVIEW_JSON).expect("parse");
        assert_eq!(review.verdict, "");
        assert_eq!(review.conclusion, "");
    }

    #[test]
    fn review_prompts_ask_for_a_verdict_and_codex_schemas_require_it() {
        let patch = "diff --git a/src/a.ts b/src/a.ts";
        let finding = ReviewFinding {
            path: "src/a.ts".into(),
            line: Some(12),
            end_line: None,
            severity: "warning".into(),
            title: "Off-by-one in loop bound.".into(),
            body: "The loop misses the last element.".into(),
        };
        for prompt in [
            build_prompt(Some("feature"), patch, None),
            build_re_review_prompt(Some("feature"), "Summary.", &[finding], patch, None),
        ] {
            assert!(prompt.contains(VERDICT_GUIDANCE), "{prompt}");
            assert!(
                prompt.contains("\"verdict\": \"approve | comment | request_changes\""),
                "{prompt}"
            );
        }

        for schema in [REVIEW_SCHEMA, RE_REVIEW_SCHEMA] {
            let schema: serde_json::Value = serde_json::from_str(schema).expect("valid schema");
            let required = schema["required"].as_array().expect("required list");
            assert!(required.contains(&"verdict".into()), "{schema}");
            assert!(required.contains(&"conclusion".into()), "{schema}");
            assert_eq!(
                schema["properties"]["verdict"]["enum"],
                serde_json::json!(["approve", "comment", "request_changes"])
            );
        }
    }

    #[test]
    fn surfaces_cli_reported_errors() {
        let raw = r#"{"type": "result", "is_error": true, "result": "not logged in"}"#;
        let err = parse_claude(raw.as_bytes()).expect_err("should fail");
        assert!(err.to_string().contains("not logged in"), "{err}");
    }

    #[test]
    fn rejects_output_without_a_json_object() {
        let err =
            parse_claude(envelope("I could not review this.").as_bytes()).expect_err("no json");
        assert!(err.to_string().contains("expected format"), "{err}");
    }

    #[test]
    fn reply_prompt_carries_the_finding_and_the_thread() {
        let finding = ReviewFinding {
            path: "src/a.ts".into(),
            line: Some(12),
            end_line: None,
            severity: "warning".into(),
            title: "Off-by-one in loop bound.".into(),
            body: "The loop misses the last element.".into(),
        };
        let thread = vec![
            ThreadComment {
                author: "user".into(),
                text: "Is this reachable?".into(),
            },
            ThreadComment {
                author: "agent".into(),
                text: "Yes, via the empty-input path.".into(),
            },
        ];
        let prompt = build_reply_prompt(
            Some("feature"),
            "Small change.",
            Some(&finding),
            &thread,
            "Show me where.",
            "diff --git a/src/a.ts b/src/a.ts",
            None,
        );

        assert!(prompt.contains("Off-by-one in loop bound."), "{prompt}");
        assert!(prompt.contains("User: Is this reachable?"), "{prompt}");
        assert!(
            prompt.contains("You: Yes, via the empty-input path."),
            "{prompt}"
        );
        assert!(prompt.contains("Show me where."), "{prompt}");
        assert!(prompt.contains("diff --git a/src/a.ts"), "{prompt}");
    }

    #[test]
    fn every_prompt_carries_the_writing_guidance() {
        let patch = "diff --git a/src/a.ts b/src/a.ts";
        let finding = ReviewFinding {
            path: "src/a.ts".into(),
            line: Some(12),
            end_line: None,
            severity: "warning".into(),
            title: "Off-by-one in loop bound.".into(),
            body: "The loop misses the last element.".into(),
        };
        let json_prompts = [
            build_prompt(Some("feature"), patch, None),
            build_re_review_prompt(Some("feature"), "Summary.", &[finding.clone()], patch, None),
            build_explain_prompt(Some("feature"), patch, None),
        ];
        for prompt in &json_prompts {
            assert!(prompt.contains(WRITING_GUIDANCE), "{prompt}");
            assert!(prompt.contains(JSON_MARKDOWN_NOTE), "{prompt}");
            // Guidance is framing, so it belongs ahead of the diff.
            assert!(prompt.ends_with(patch), "{prompt}");
        }

        let reply = build_reply_prompt(Some("feature"), "Summary.", Some(&finding), &[], "Why?", patch, None);
        assert!(reply.contains(WRITING_GUIDANCE), "{reply}");
        assert!(!reply.contains("plain text"), "{reply}");
    }

    fn sample_pr() -> PrContext {
        PrContext {
            url: "https://github.com/acme/widgets/pull/7".into(),
            number: 7,
            title: "Avoid duplicate widgets".into(),
            body: "The API should remain backward compatible.".into(),
            author: "octo".into(),
            state: "open".into(),
            is_draft: false,
            base_ref: "main".into(),
            base_remote: "origin".into(),
            head_sha: "abc123".into(),
            compare_ref: "tk-review/pr/7".into(),
            comments: vec![crate::github::PrComment {
                id: 1,
                author: "reviewer".into(),
                body: "Please keep the old endpoint.".into(),
                created_at: "2026-08-06T00:00:00Z".into(),
                path: Some("src/api.rs".into()),
                line: Some(12),
                outdated: false,
            }],
        }
    }

    #[test]
    fn prompts_carry_pr_intent_and_existing_discussion() {
        let pr = sample_pr();
        let prompt = build_prompt(Some("tk-review/pr/7"), "diff --git a/a b/a", Some(&pr));

        assert!(prompt.contains("pull request #7: \"Avoid duplicate widgets\" by @octo"));
        assert!(prompt.contains("do not repeat points already raised"));
        assert!(prompt.contains("@reviewer (src/api.rs:12): Please keep the old endpoint."));
    }

    #[test]
    fn rejects_an_unknown_engine() {
        let dir = tempfile::tempdir().expect("temp dir");
        let err =
            review_diff(dir.path(), "HEAD", None, "gemini", None, None, None).expect_err("unknown");
        assert!(err.to_string().contains("unknown review engine"), "{err}");

        let err = explain_diff(dir.path(), "HEAD", None, "gemini", None, None, None)
            .expect_err("unknown");
        assert!(err.to_string().contains("unknown review engine"), "{err}");

        let err = re_review_diff(
            dir.path(),
            "HEAD",
            None,
            "gemini",
            None,
            None,
            "Earlier summary.",
            &[],
            None,
        )
        .expect_err("unknown");
        assert!(err.to_string().contains("unknown review engine"), "{err}");
    }

    #[test]
    fn a_re_review_needs_a_previous_review() {
        let dir = tempfile::tempdir().expect("temp dir");
        let err = re_review_diff(dir.path(), "HEAD", None, "claude", None, None, "  ", &[], None)
            .expect_err("nothing to check");
        assert!(err.to_string().contains("no previous review"), "{err}");
    }

    const RE_REVIEW_JSON: &str = r#"{
        "summary": "One finding fixed, one remains; the fix added a new problem.",
        "resolutions": [
            {"index": 0, "status": "addressed", "note": "The loop bound is now inclusive."},
            {"index": 1, "status": "unaddressed", "note": "The comment is unchanged."}
        ],
        "findings": [
            {"path": "src/a.ts", "line": 20, "severity": "warning",
             "title": "The new bound reads past empty input.", "body": "Guard the empty case."}
        ]
    }"#;

    #[test]
    fn parses_a_re_review_from_both_engine_paths() {
        // Claude: wrapped in the CLI's result envelope.
        let text = unwrap_claude_envelope(envelope(RE_REVIEW_JSON).as_bytes()).expect("envelope");
        let result: ReReviewResult = parse_agent_json(&text).expect("parse");
        assert_eq!(result.resolutions.len(), 2);
        assert_eq!(result.resolutions[0].index, 0);
        assert_eq!(result.resolutions[0].status, "addressed");
        assert_eq!(result.findings.len(), 1);

        // Codex: the bare final message.
        let result: ReReviewResult = parse_agent_json(RE_REVIEW_JSON).expect("parse");
        assert_eq!(result.resolutions.len(), 2);
    }

    #[test]
    fn a_re_review_without_resolutions_or_findings_is_still_valid() {
        let result: ReReviewResult =
            parse_agent_json(r#"{"summary": "Everything was addressed."}"#).expect("parse");
        assert!(result.resolutions.is_empty());
        assert!(result.findings.is_empty());
    }

    #[test]
    fn the_re_review_prompt_numbers_the_prior_findings_and_asks_for_both_jobs() {
        let prior = vec![
            ReviewFinding {
                path: "src/a.ts".into(),
                line: Some(12),
                end_line: Some(14),
                severity: "warning".into(),
                title: "Off-by-one in loop bound.".into(),
                body: "The loop misses the last element.".into(),
            },
            ReviewFinding {
                path: "src/b.ts".into(),
                line: None,
                end_line: None,
                severity: "nit".into(),
                title: "Stale comment.".into(),
                body: "The comment describes removed behavior.".into(),
            },
        ];
        let prompt = build_re_review_prompt(
            Some("feature"),
            "Small, focused change.",
            &prior,
            "diff --git a/src/a.ts b/src/a.ts",
            None,
        );

        assert!(prompt.contains("Small, focused change."), "{prompt}");
        assert!(
            prompt.contains("0. [warning] src/a.ts (lines: 12-14) — Off-by-one in loop bound."),
            "{prompt}"
        );
        assert!(
            prompt.contains("1. [nit] src/b.ts (line: whole file) — Stale comment."),
            "{prompt}"
        );
        // Both jobs, and the guard against double-reporting.
        assert!(prompt.contains("judge whether it has been addressed"), "{prompt}");
        assert!(prompt.contains("Review the current diff for NEW problems"), "{prompt}");
        assert!(prompt.contains("Do not re-report the numbered findings"), "{prompt}");
        assert!(prompt.contains("diff --git a/src/a.ts"), "{prompt}");
    }

    const EXPLAIN_JSON: &str = r#"{
        "overall": "Adds a cache in front of the widget lookup.",
        "files": [
            {"path": "src/a.ts", "explanation": "The lookup entry point; now consults the cache first."},
            {"path": "src/b.ts", "explanation": "Renamed for consistency."}
        ]
    }"#;

    #[test]
    fn parses_an_explanation_from_both_engine_paths() {
        // Claude: wrapped in the CLI's result envelope.
        let text = unwrap_claude_envelope(envelope(EXPLAIN_JSON).as_bytes()).expect("envelope");
        let explanation: ExplainResult = parse_agent_json(&text).expect("parse");
        assert_eq!(
            explanation.overall,
            "Adds a cache in front of the widget lookup."
        );
        assert_eq!(explanation.files.len(), 2);
        assert_eq!(explanation.files[0].path, "src/a.ts");

        // Codex: the bare final message.
        let explanation: ExplainResult = parse_agent_json(EXPLAIN_JSON).expect("parse");
        assert_eq!(explanation.files.len(), 2);
    }

    #[test]
    fn an_explanation_without_files_is_still_valid() {
        let explanation: ExplainResult =
            parse_agent_json(r#"{"overall": "A one-line typo fix."}"#).expect("parse");
        assert!(explanation.files.is_empty());
    }

    #[test]
    fn the_explain_prompt_asks_for_orientation_rather_than_judgement() {
        let prompt = build_explain_prompt(Some("feature"), "diff --git a/a b/a", None);

        assert!(
            prompt.contains("explaining this change, not judging it"),
            "{prompt}"
        );
        assert!(prompt.contains("No findings, no verdicts"), "{prompt}");
        // Length guidance is what keeps a complex file from getting one line.
        assert!(prompt.contains("one to three sentences for a typical file"), "{prompt}");
        assert!(
            prompt.contains("short list for a genuinely tricky one"),
            "{prompt}"
        );
        assert!(prompt.contains("diff --git a/a b/a"), "{prompt}");
    }

    /// The PR framing differs from the review's on purpose: a source to draw on
    /// rather than a set of points to avoid repeating.
    #[test]
    fn the_explain_prompt_treats_the_pr_description_as_a_source() {
        let pr = sample_pr();
        let prompt = build_explain_prompt(Some("tk-review/pr/7"), "diff --git a/a b/a", Some(&pr));

        assert!(prompt.contains("pull request #7: \"Avoid duplicate widgets\" by @octo"));
        assert!(prompt.contains("treat this as a source for your explanation"));
        assert!(prompt.contains("The API should remain backward compatible."));
        assert!(prompt.contains("@reviewer (src/api.rs:12): Please keep the old endpoint."));
        assert!(!prompt.contains("do not repeat points already raised"));
    }

    /// Trimmed from a real `codex exec` run with an unsupported model.
    const CODEX_FAILURE_LOG: &str = r#"OpenAI Codex v0.146.1
--------
model: gpt-6-sol
--------
user
Review this change.
diff --git a/a b/a
+    },

warning: Model metadata for `gpt-6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.
2026-09-28T15:44:45.015150Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}}
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}}
"#;

    #[test]
    fn a_codex_failure_shows_only_its_error_message() {
        let detail = failure_detail(CODEX_FAILURE_LOG, "Review this change.\ndiff --git a/a b/a");

        assert_eq!(
            detail,
            "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."
        );
    }

    #[test]
    fn a_plain_error_line_is_kept_as_written() {
        let detail = failure_detail(
            "user\nprompt\nERROR: stream disconnected before completion\n",
            "prompt",
        );

        assert_eq!(detail, "stream disconnected before completion");
    }

    #[test]
    fn without_error_lines_the_log_tail_omits_the_prompt_echo() {
        let prompt = (0..50)
            .map(|n| format!("patch line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let log = format!("header\nuser\n{prompt}\n\nsomething went wrong\n");

        let detail = failure_detail(&log, &prompt);

        assert!(!detail.contains("patch line"), "{detail}");
        assert!(detail.ends_with("something went wrong"), "{detail}");
    }
}
