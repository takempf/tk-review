//! CLI-backed diff review.
//!
//! Shells out to an agent CLI in headless mode, the same way the git layer
//! shells out to `git`. Two engines are supported: `claude` (Claude Code,
//! `claude -p`) and `codex` (OpenAI Codex, `codex exec`). Both authenticate
//! through the CLI's own login, so the user's existing subscription covers the
//! usage — no API key. The process runs with the repository as its working
//! directory, which gives the agent's read-only tools the surrounding code, so
//! findings can account for context beyond the diff itself.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::git;
use crate::github::{review_comment_id, PrComment, PrContext};
use crate::rules::RepoRules;
use crate::runs::{AgentRun, Stop, QUIET_LIMIT, RUN_LIMIT};

/// Fewest agentic turns a claude run gets. A small diff can still reach far:
/// e2e helpers that finish jobs (5 files) took a run 32 turns, about seven
/// minutes, tracing the job pipeline they drive before it ran out. The limit
/// is a cap, not a target, so runs that need fewer still stop sooner.
const MIN_TURNS: usize = 60;

/// Most agentic turns a claude run gets, however large the diff. The run's
/// time limit (`RUN_LIMIT`) is the real backstop against a runaway session,
/// and a run stopped by it leaves nothing, where one stopped here can still
/// answer from what it read. So this stays well short of what an hour holds:
/// at the 13 seconds or so that run's turns took, about half of it.
const MAX_TURNS: usize = 150;

/// Agentic turns for a claude run over `patch`. A flat limit that suits a
/// small change starves a large one, where most of the turns go on reading
/// around the changed files, so the budget grows with how many there are.
fn turn_budget(patch: &str) -> usize {
    let files = patch
        .lines()
        .filter(|line| line.starts_with("diff --git "))
        .count();
    (MIN_TURNS + files / 2).min(MAX_TURNS)
}

/// Tells claude its turn budget, which it otherwise cannot see. A turn is one
/// response however many tool calls it makes, so batching independent reads
/// is what stretches the budget; reading the riskiest changes first is what
/// makes a run that does stop short still worth having.
fn turn_budget_note(turns: usize) -> String {
    format!(
        "This run has a budget of {turns} turns, and a turn is one of your responses however many tool calls it makes. Make independent reads and searches in the same response rather than one per turn, look at the riskiest changes first, and stop investigating in good time to write the answer."
    )
}

/// The built-in tools a claude run gets. Runs are `--restricted`, which drops
/// the tools that run commands unless they are named here, so Bash is named,
/// and the permission rules below hold it to reads.
const CLAUDE_TOOLS: &str = "Read,Grep,Glob,Bash,Agent,ToolSearch";

/// What a claude run may use beyond reading the repository: its history
/// through git and `gh`, and the team's tracker and chat through the claude.ai
/// Linear and Slack connectors, for whoever has them. Reads only, and Slack's
/// public channels only, since findings can be posted to the pull request. A
/// headless run is refused anything not allowed here, and `--restricted`
/// keeps a repository's own settings from allowing more.
const ALLOWED_TOOLS: &[&str] = &[
    "ToolSearch",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git blame:*)",
    "Bash(gh pr view:*)",
    "Bash(gh pr diff:*)",
    "Bash(gh pr list:*)",
    "Bash(gh issue view:*)",
    "Bash(gh issue list:*)",
    "Bash(gh search:*)",
    "mcp__claude_ai_Linear__list_issues",
    "mcp__claude_ai_Linear__get_issue",
    "mcp__claude_ai_Linear__list_comments",
    "mcp__claude_ai_Linear__list_documents",
    "mcp__claude_ai_Linear__get_document",
    "mcp__claude_ai_Linear__list_projects",
    "mcp__claude_ai_Linear__get_project",
    "mcp__claude_ai_Linear__list_teams",
    "mcp__claude_ai_Linear__get_team",
    "mcp__claude_ai_Linear__list_issue_labels",
    "mcp__claude_ai_Linear__get_attachment",
    "mcp__claude_ai_Slack__slack_search_public",
    "mcp__claude_ai_Slack__slack_search_channels",
    "mcp__claude_ai_Slack__slack_read_channel",
    "mcp__claude_ai_Slack__slack_read_thread",
    "mcp__claude_ai_Slack__slack_read_canvas",
];

/// What no claude run may use, whatever anything else allows: every tool that
/// writes, anything that could carry the code off to the web, and the
/// spellings of the allowed commands that write a file or open a browser.
/// Nothing allows these today, since `--restricted` ignores the settings files
/// that could; this keeps it that way if that ever changes.
const DENIED_TOOLS: &[&str] = &[
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Bash(gh api:*)",
    "Bash(gh * --web*)",
    "Bash(gh * -w*)",
    "Bash(git * --output*)",
    "mcp__claude_ai_Slack__slack_send_message",
    "mcp__claude_ai_Slack__slack_send_message_draft",
    "mcp__claude_ai_Slack__slack_schedule_message",
    "mcp__claude_ai_Slack__slack_add_reaction",
    "mcp__claude_ai_Slack__slack_create_canvas",
    "mcp__claude_ai_Slack__slack_update_canvas",
    "mcp__claude_ai_Slack__slack_create_conversation",
    "mcp__claude_ai_Slack__slack_search_public_and_private",
    "mcp__claude_ai_Linear__save_issue",
    "mcp__claude_ai_Linear__save_comment",
    "mcp__claude_ai_Linear__save_document",
    "mcp__claude_ai_Linear__save_project",
    "mcp__claude_ai_Linear__save_milestone",
    "mcp__claude_ai_Linear__save_initiative",
    "mcp__claude_ai_Linear__save_initiative_label",
    "mcp__claude_ai_Linear__save_issue_label",
    "mcp__claude_ai_Linear__save_project_label",
    "mcp__claude_ai_Linear__save_release",
    "mcp__claude_ai_Linear__save_release_note",
    "mcp__claude_ai_Linear__save_status_update",
    "mcp__claude_ai_Linear__save_diff_comment",
    "mcp__claude_ai_Linear__create_attachment",
    "mcp__claude_ai_Linear__create_attachment_from_upload",
    "mcp__claude_ai_Linear__create_initiative_label",
    "mcp__claude_ai_Linear__create_issue_label",
    "mcp__claude_ai_Linear__prepare_attachment_upload",
    "mcp__claude_ai_Linear__delete_attachment",
    "mcp__claude_ai_Linear__delete_comment",
    "mcp__claude_ai_Linear__delete_diff_comment",
    "mcp__claude_ai_Linear__delete_status_update",
    "mcp__claude_ai_Linear__share_issue",
    "mcp__claude_ai_Linear__unshare_issue",
    "mcp__claude_ai_Linear__mark_notification",
    "mcp__claude_ai_Linear__merge_diff",
    "mcp__claude_ai_Linear__update_diff",
    "mcp__claude_ai_Linear__resolve_diff_thread",
    "mcp__claude_ai_Linear__submit_diff_review",
    "mcp__claude_ai_Linear__restore_initiative_label",
    "mcp__claude_ai_Linear__restore_issue_label",
    "mcp__claude_ai_Linear__restore_project_label",
    "mcp__claude_ai_Linear__retire_initiative_label",
    "mcp__claude_ai_Linear__retire_issue_label",
    "mcp__claude_ai_Linear__retire_project_label",
];

/// Tells claude what it can read beyond the repository, and when it's worth it.
const CONTEXT_SOURCES_NOTE: &str = r#"Beyond the repository, this run can read some of the history and discussion around it. All of it is read-only:
- git history: `git log`, `git show`, and `git blame`, run from the working directory rather than with `git -C`
- GitHub, through `gh pr view`, `gh pr diff`, `gh pr list`, `gh issue view`, `gh issue list`, and `gh search`
- Linear, and Slack's public channels, when their tools turn up through ToolSearch
Reach for these when the code can't answer something that matters: the ticket a change is for, an earlier change to the same code, a past incident. Don't use them as routine, and carry on without any that are missing or refused. What you write may be posted to the pull request, so link to what you found and paraphrase it rather than quoting conversations."#;

/// Adds the access every claude run gets to its arguments: restricted, with
/// the tools and permission rules above.
fn push_access(args: &mut Vec<&str>) {
    args.extend(["--restricted", "--tools", CLAUDE_TOOLS, "--allowedTools"]);
    args.extend(ALLOWED_TOOLS);
    args.push("--disallowedTools");
    args.extend(DENIED_TOOLS);
}

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
    /// GitHub's permalink once the finding was sent to the PR. The app keeps
    /// it; the model never writes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_url: Option<String>,
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
    /// The agent ran out of turns and answered from what it had read by then,
    /// so the review may have gaps. Set by the app, never by the model.
    #[serde(default, skip_deserializing)]
    pub cut_short: bool,
}

/// Reviews the whole comparison with the chosen engine and returns structured
/// findings.
///
/// `compare: None` reviews against the working tree, matching `diff_branches`.
/// `model: None` and `effort: None` use whatever the CLI itself is configured
/// to default to. `rules` are the ones kept for the repository on this machine.
#[allow(clippy::too_many_arguments)]
pub fn review_diff(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    engine: &str,
    model: Option<&str>,
    effort: Option<&str>,
    pr_context: Option<&PrContext>,
    rules: &RepoRules,
    run: &AgentRun,
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

    let mut prompt = build_prompt(compare, &patch, pr_context);
    add_repo_instructions(&mut prompt, &patch, root, engine);
    add_review_rules(&mut prompt, &patch, &rules.review);
    let specialist = add_migration_review(&mut prompt, engine, &patch, &rules.migrations);
    let answer = if engine == "claude" {
        claude_result_text(
            root,
            &prompt,
            model,
            effort,
            turn_budget(&patch),
            specialist.as_ref(),
            run,
        )?
    } else {
        AgentText::complete(codex_result_text(
            root,
            &prompt,
            model,
            effort,
            Some(REVIEW_SCHEMA),
            run,
        )?)
    };
    let mut result: ReviewResult = parse_agent_json(&answer.text)?;
    result.cut_short = answer.cut_short;
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
    /// As on `ReviewResult`.
    #[serde(default, skip_deserializing)]
    pub cut_short: bool,
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
    rules: &RepoRules,
    run: &AgentRun,
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

    let mut prompt =
        build_re_review_prompt(compare, prior_summary, prior_findings, &patch, pr_context);
    add_repo_instructions(&mut prompt, &patch, root, engine);
    add_review_rules(&mut prompt, &patch, &rules.review);
    let specialist = add_migration_review(&mut prompt, engine, &patch, &rules.migrations);
    let answer = if engine == "claude" {
        claude_result_text(
            root,
            &prompt,
            model,
            effort,
            turn_budget(&patch),
            specialist.as_ref(),
            run,
        )?
    } else {
        AgentText::complete(codex_result_text(
            root,
            &prompt,
            model,
            effort,
            Some(RE_REVIEW_SCHEMA),
            run,
        )?)
    };
    let mut result: ReReviewResult = parse_agent_json(&answer.text)?;
    result.cut_short = answer.cut_short;
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
            "{index}. [{}] {} ({}) — {}\n   {}\n{}",
            finding.severity,
            finding.path,
            finding.location_label(),
            finding.title,
            finding.body,
            github_thread_note(finding, pr_context)
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

1. For EVERY numbered finding, judge whether it has been addressed in the current code. Use `status` values: "addressed" (fixed), "unaddressed" (still present as reported), "partial" (improved but not fully fixed), "obsolete" (the code it pointed at is gone or changed enough that the finding no longer applies). In `note`, say what the verdict is grounded in — where the fix is, or what still remains. If a finding was wrong to begin with, mark it "obsolete" and say so. Where a finding was sent to the pull request, what happened to it there follows it: whether its GitHub thread is resolved, and any replies. Take a reply saying it was fixed, or a resolved thread, as a claim to check against the code rather than as the verdict, and say in `note` when one bears on it.

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
        let mut context = String::new();
        append_pr_context(&mut context, pr);
        insert_before_diff(&mut prompt, patch, &context);
    }
    prompt
}

/// How the explanation should sound, with samples of the voice it borrows.
/// Kept in its own file because it is mostly source material, not instructions.
const EXPLAIN_VOICE: &str = include_str!("voice.md");

/// A short note on what one file's changes are for, shown at the top of that
/// file in the diff.
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
    /// The walkthrough of the whole change, for the explain panel.
    pub overall: String,
    /// Notes for the files that benefit from one; the rest are left out.
    #[serde(default)]
    pub files: Vec<FileExplanation>,
    /// As on `ReviewResult`.
    #[serde(default, skip_deserializing)]
    pub cut_short: bool,
}

/// Explains the comparison in plain language: a walkthrough of the whole
/// change, plus a short note for each file that benefits from one. A reading
/// aid rather than a judgement — see `build_explain_prompt`.
///
/// Deliberately a separate CLI run from `review_diff` rather than an extra
/// field on the review: the two jobs want different framing, and a failure in
/// one should not cost the other.
#[allow(clippy::too_many_arguments)]
pub fn explain_diff(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    engine: &str,
    model: Option<&str>,
    effort: Option<&str>,
    pr_context: Option<&PrContext>,
    run: &AgentRun,
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

    let mut prompt = build_explain_prompt(compare, &patch, pr_context);
    add_repo_instructions(&mut prompt, &patch, root, engine);
    let answer = if engine == "claude" {
        claude_result_text(root, &prompt, model, effort, turn_budget(&patch), None, run)?
    } else {
        AgentText::complete(codex_result_text(
            root,
            &prompt,
            model,
            effort,
            Some(EXPLAIN_SCHEMA),
            run,
        )?)
    };
    let mut result: ExplainResult = parse_agent_json(&answer.text)?;
    result.cut_short = answer.cut_short;
    Ok(result)
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
  "overall": "The walkthrough: what this change does, why, and how it is put together.",
  "files": [
    {{
      "path": "path/as/it/appears/in/the/diff",
      "explanation": "A short note on what the changes in this file are for."
    }}
  ]
}}

`overall` is the walkthrough, shown in a panel of its own. It is the reader's one stop for understanding the change: thorough enough that someone who reads only this knows what changed, why, and where to look, and skimmable enough that someone who reads only the first line of each part still gets the gist.
- Open with the short version: a sentence or two on what the change does and why, in terms of what users or callers see before how the code does it.
- Then walk through the parts in the order that makes them easiest to follow (usually cause before effect, data before UI), not in file order. Say which files are the heart of the change and which are fallout: renames, plumbing, test updates.
- Give the why wherever the code doesn't make it obvious: the bug, constraint, or trade-off behind an approach. If the diff doesn't say, read the code around it. If you still can't tell, describe what it does rather than inventing a motive.
- Point out what a reader would trip over: a behavior change hiding in a refactor, an ordering that matters, a surprising dependency. Frame these as orientation ("heads up: ..."), not as findings.
- Use a small table where it reads better than prose: before and after behavior, which file does what, a set of cases and what happens in each. Keep tables to a few columns of short cells.
- It is a document rather than a comment, so short `###` headings are welcome when the walkthrough covers more than two or three parts. Never put a heading over a single paragraph, and don't open with a title.
- Length follows the change. A one-line fix gets a few sentences; a large change can run to several short sections. Never pad.

Each entry in `files` is a note shown at the top of that file in the diff, so the reader sees it just before reading the code:
- Write one only for files whose changes benefit from explaining. Leave out lockfiles that follow a manifest change, generated output, formatting-only edits, and pure renames. For a set of repetitive mechanical edits, explain the shared reason once on a representative file and name the others there.
- Lead with why this file needed to change, then how its behavior or implementation changed. Tie it to this file's part in the change rather than repeating the walkthrough.
- When a file has several separate changes, cover each one that needs explaining as a short list, and skip the ones that explain themselves.
- Keep it to one to three short sentences, or a sentence and a short list. The walkthrough carries the detail.
- Explain tests by the behavior they cover, and deletions by what replaces them or why they're no longer needed.
- Refer to functions and blocks by name, not by line number.
- Skip binary files. Use the compare-side path exactly as the diff spells it.

Write for someone competent who has not seen this code before. Prefer concrete nouns from the codebase over generic description.

{WRITING_GUIDANCE}

The walkthrough's `###` headings are the one exception to "No headings" above.

{voice}

{JSON_MARKDOWN_NOTE}

The diff:

{patch}"#,
        voice = EXPLAIN_VOICE.trim_end(),
    );
    if let Some(pr) = pr_context {
        // The author's own framing belongs with the rest of the orienting
        // instructions.
        let mut context = String::new();
        append_pr_intent(&mut context, pr);
        insert_before_diff(&mut prompt, patch, &context);
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
        let anchor = comment_anchor(comment);
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
    run: &AgentRun,
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
        claude_result_text(root, &prompt, model, effort, turn_budget(&patch), None, run)?.text
    } else {
        codex_result_text(root, &prompt, model, effort, None, run)?
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
                "This conversation is about one finding from your review:\n- file: {} ({})\n- severity: {}\n- {}\n- {}\n{}\nThe diff for that file:\n\n{patch}\n\n",
                finding.path,
                finding.location_label(),
                finding.severity,
                finding.title,
                finding.body,
                github_thread_note(finding, pr_context)
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
        let mut context = String::new();
        append_pr_context(&mut context, pr);
        insert_before_diff(&mut prompt, patch, &context);
    }
    prompt
}

/// Puts `text` just ahead of the `patch` that ends a prompt, where the framing
/// instructions live, leaving the exact diff ending intact. Located from the
/// end rather than by searching, since a PR description or the patch itself
/// can contain the words that introduce the diff.
fn insert_before_diff(prompt: &mut String, patch: &str, text: &str) {
    let ending = format!("The diff:\n\n{patch}");
    if prompt.ends_with(&ending) {
        prompt.insert_str(prompt.len() - ending.len(), text);
    }
}

/// Most of a repository's agent instructions a prompt carries. The ones seen
/// run to a few dozen kilobytes; this only stops a runaway file.
const REPO_INSTRUCTIONS_LIMIT: usize = 64 * 1024;

/// Adds the repository's instructions for agents, its root `CLAUDE.md` or
/// failing that `AGENTS.md`, to a claude prompt. A `--restricted` run doesn't
/// load them itself, and they hold the conventions a review is judged by.
/// Codex reads `AGENTS.md` on its own, so it is left alone.
fn add_repo_instructions(prompt: &mut String, patch: &str, root: &Path, engine: &str) {
    if engine != "claude" {
        return;
    }
    let Some((name, text)) = ["CLAUDE.md", "AGENTS.md"].iter().find_map(|name| {
        let text = std::fs::read_to_string(root.join(name)).ok()?;
        (!text.trim().is_empty()).then_some((*name, text))
    }) else {
        return;
    };
    let mut end = text.len().min(REPO_INSTRUCTIONS_LIMIT);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let cut = if end < text.len() {
        "\n[…cut short]"
    } else {
        ""
    };
    insert_before_diff(
        prompt,
        patch,
        &format!(
            "The repository's own instructions for agents working in it, from its root `{name}`. They describe its conventions. Directories may have their own `CLAUDE.md` or `AGENTS.md` for the code beside them, worth reading where they cover changed files:\n\n<repository-instructions>\n{}{cut}\n</repository-instructions>\n\n",
            text[..end].trim_end()
        ),
    );
}

/// Adds the rules kept for the repository on this machine to a review prompt.
fn add_review_rules(prompt: &mut String, patch: &str, rules: &str) {
    let rules = rules.trim();
    if rules.is_empty() {
        return;
    }
    insert_before_diff(
        prompt,
        patch,
        &format!("The person running this review keeps these rules for this repository. Hold the diff to them as you would to the repository's own conventions, and where they conflict with general advice, they win:\n\n{rules}\n\n"),
    );
}

/// The migration checklist, followed by the repository's own migration rules
/// when the person running the review keeps any.
fn migration_guidance(rules: &str) -> String {
    let guidance = MIGRATION_GUIDANCE.trim_end();
    let rules = rules.trim();
    if rules.is_empty() {
        return guidance.to_owned();
    }
    format!("{guidance}\n\nThis repository's own migration rules, kept by the person running the review. Where they are more specific than the checklist above, they win:\n\n{rules}")
}

/// What to check in a database migration, drawn from the migrations that have
/// gone wrong in practice. Kept in its own file because it is long, and shared
/// by the claude subagent and the codex prompt.
const MIGRATION_GUIDANCE: &str = include_str!("migration_review.md");

/// The subagent a claude review hands a diff's migrations to.
const MIGRATION_REVIEWER: &str = "migration-reviewer";

/// Agentic turns the migration reviewer gets: enough to read around the
/// migrations and look up their tables' history. Its own, not the main run's:
/// a subagent's turns don't count against the session's `--max-turns`.
const MIGRATION_REVIEWER_TURNS: usize = 50;

/// The per-file sections of a patch that change database migrations, as
/// `(path, section)`. A migration is anything under a `migrations`,
/// `migration`, or `migrate` directory: where Umzug, Knex, Prisma, Django,
/// Flyway, Alembic, and Rails (`db/migrate`) keep them.
fn migration_sections(patch: &str) -> Vec<(String, &str)> {
    let mut starts: Vec<usize> = patch
        .match_indices("diff --git ")
        .map(|(at, _)| at)
        .collect();
    // Only the ones that open a line: a migration's own text could contain it.
    starts.retain(|&at| at == 0 || patch.as_bytes()[at - 1] == b'\n');
    starts.push(patch.len());
    starts
        .windows(2)
        .map(|bounds| &patch[bounds[0]..bounds[1]])
        .filter_map(|section| {
            let path = section_path(section)?;
            path.split('/')
                .rev()
                .skip(1)
                .any(|dir| matches!(dir, "migrations" | "migration" | "migrate"))
                .then_some((path, section))
        })
        .collect()
}

/// The path one file's section of a patch is about: its compare-side path, or
/// for a deletion, the path it was deleted from. Read from the header only,
/// since a removed SQL comment is a hunk line that starts `---` too.
fn section_path(section: &str) -> Option<String> {
    let mut path = None;
    for line in section.lines().skip(1) {
        if line.starts_with("@@") {
            break;
        }
        let named = line
            .strip_prefix("+++ ")
            .filter(|rest| *rest != "/dev/null")
            .and_then(|rest| rest.trim_matches('"').strip_prefix("b/"))
            .or_else(|| line.strip_prefix("rename to "))
            .or_else(|| {
                path.is_none()
                    .then(|| {
                        line.strip_prefix("--- ")?
                            .trim_matches('"')
                            .strip_prefix("a/")
                    })
                    .flatten()
            });
        if let Some(named) = named {
            path = Some(named.to_owned());
        }
    }
    path
}

/// A subagent a claude run is told to hand part of its work to, and is held
/// to: a run that answers without launching it is asked again.
struct Specialist {
    /// The `subagent_type` it is launched as, and its key in `agents`.
    name: &'static str,
    /// Its definition, as `--agents` JSON.
    agents: String,
}

/// Sets a review up to give the migrations a diff changes a specialist's
/// review: claude is told to hand them to the `migration-reviewer` subagent,
/// which is returned for the run to define and hold it to; codex, which takes
/// no subagent definitions, gets the same checklist in its own prompt. `None`
/// when the diff changes no migrations, or for codex.
fn add_migration_review(
    prompt: &mut String,
    engine: &str,
    patch: &str,
    rules: &str,
) -> Option<Specialist> {
    let sections = migration_sections(patch);
    if sections.is_empty() {
        return None;
    }
    let guidance = migration_guidance(rules);
    let files: String = sections
        .iter()
        .map(|(path, _)| format!("- `{path}`\n"))
        .collect();
    let stakes = "A bad migration fails in production rather than in tests: it locks a busy table and stalls the app, fails a deploy halfway, breaks the pods still running the old code, or loses data. So migrations get a specialist's review on top of yours.";

    if engine != "claude" {
        insert_before_diff(
            prompt,
            patch,
            &format!("This diff changes database migrations:\n{files}\n{stakes} Review each one against the checklist below as well as everything else, and report what you find as ordinary findings on the migration's file and line.\n\n{guidance}\n\n"),
        );
        return None;
    }

    insert_before_diff(
        prompt,
        patch,
        &format!(
            r#"This diff changes database migrations:
{files}
{stakes}
1. In your first response, launch the `{MIGRATION_REVIEWER}` subagent with the Agent tool, in the foreground, alongside your first reads. It already has the migrations' diffs. Tell it in a few sentences what the rest of this diff does with the tables and columns they touch: which code reads or writes them, and whether that code ships in this same change.
2. Review the rest of the diff yourself as usual, including the code that reads and writes what the migrations change.
3. Check each finding it reports against the code before you use it. Report the ones that hold as ordinary findings on the migration's file and line, merged with your own so each problem appears once, and drop the ones that don't.
4. Weigh them in the verdict. A migration that can lock a busy table, fail a deploy, break running code, or lose data must be fixed before this merges.

"#
        ),
    );
    let diffs: String = sections.iter().map(|(_, section)| *section).collect();
    let definition = serde_json::json!({
        "description": "Reviews the database migrations in a diff for what fails in production: locks on busy tables, deploys that fail halfway, breakage for pods still running the old code, and data loss. Launch it whenever a diff changes migrations.",
        "prompt": format!(
            r#"You are a database specialist reviewing the migrations in a pull request, alongside the main reviewer who launched you. They will tell you what the rest of the change does with the tables these migrations touch. You are read-only: read and search the repository, never change it.

Before judging, read the repository's own rules for migrations (try CLAUDE.md and AGENTS.md at the root and near the migrations directory), and a few of the newest migrations beside these, so you hold these to the repository's conventions. Search the codebase for every table and column they touch, so you know what the running code expects. The working tree may not match the diff's compare side, so the diffs below are the authority on what the migrations say. Make independent reads and searches in the same response rather than one per turn.

Then look for history on each table these migrations touch, and stop as soon as you have enough. Spend a few turns on it at most:
1. `git log --oneline -S '<table>' -- <the migrations directory>`, for earlier migrations on that table that were reverted, fixed, or followed by a fix.
2. If Linear or Slack tools turn up through ToolSearch, search them for the table's name alongside words like migration, lock, outage, deadlock, or timeout.
When a past incident bears on a problem you report, cite it with a link in that entry. Skip any source that's missing or refused.

{guidance}

Report back in plain text, one entry per problem, most serious first:
- `path:line` or `path:start-end`, in new-file line numbers
- severity: critical, warning, or suggestion
- one sentence naming the problem, then why it matters in production and the fix

Only report problems you can point to in the diff or the code. Say "No migration problems found." when there are none. End with one line on anything you could not check from the repository, such as how large a table is in production.

The migrations' diffs:

{diffs}"#,
        ),
        "model": "inherit",
        "maxTurns": MIGRATION_REVIEWER_TURNS,
    });
    Some(Specialist {
        name: MIGRATION_REVIEWER,
        agents: serde_json::json!({ MIGRATION_REVIEWER: definition }).to_string(),
    })
}

/// What became of a finding on the pull request, for the prompts that follow
/// up on it: whether its GitHub thread is resolved, and what was said there
/// after it, as lines to follow the finding. Empty for one never sent, sent as
/// a top-level comment (GitHub keeps no thread for those), or sent since the
/// PR was last read.
fn github_thread_note(finding: &ReviewFinding, pr: Option<&PrContext>) -> String {
    let (Some(pr), Some(url)) = (pr, finding.posted_url.as_deref()) else {
        return String::new();
    };
    let Some(thread) = pr.thread_for(url) else {
        return String::new();
    };
    let state = match (thread.resolved, &thread.resolved_by) {
        (true, Some(by)) => format!("resolved by @{by}"),
        (true, None) => "resolved".to_owned(),
        (false, _) => "unresolved".to_owned(),
    };
    let outdated = if thread.outdated {
        ", and outdated: the lines it was on have changed since"
    } else {
        ""
    };
    let posted = review_comment_id(url);
    let replies: Vec<&PrComment> = thread
        .comment_ids
        .iter()
        .skip_while(|id| Some(**id) != posted)
        .skip(1)
        .filter_map(|id| pr.comments.iter().find(|comment| comment.id == *id))
        .collect();
    let mut note =
        format!("   It was sent to the pull request, where its thread is {state}{outdated}.");
    if replies.is_empty() {
        note.push_str(" Nobody has replied there.\n");
        return note;
    }
    note.push_str(" Replies there:\n");
    for reply in replies {
        note.push_str(&format!(
            "   - @{}: {}\n",
            reply.author,
            reply.body.trim().replace('\n', "\n     ")
        ));
    }
    note
}

/// Where an inline comment sits, as the prompts show it: ` (src/a.rs:12-18)`,
/// marked when the lines are the old file's, and when they have changed
/// since. Empty for a top-level comment.
fn comment_anchor(comment: &PrComment) -> String {
    let Some(path) = &comment.path else {
        return String::new();
    };
    let lines = match (comment.start_line, comment.line) {
        (Some(start), Some(end)) if start < end => format!(":{start}-{end}"),
        (_, Some(line)) => format!(":{line}"),
        _ => String::new(),
    };
    let old = if comment.old_side && comment.line.is_some() {
        " in the old file"
    } else {
        ""
    };
    let outdated = if comment.outdated { ", outdated" } else { "" };
    format!(" ({path}{lines}{old}{outdated})")
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
        let anchor = comment_anchor(comment);
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
/// stdin, and waits for it to exit, successfully or not — or for `run` to stop
/// it: cancelled, gone quiet, or run too long. The prompt goes through stdin
/// rather than argv because a patch can easily exceed the argument-size limit.
fn spawn_cli(
    root: &Path,
    name: &str,
    args: &[&str],
    prompt: &str,
    not_found: GitError,
    run: &AgentRun,
) -> Result<Output, GitError> {
    if !root.is_dir() {
        return Err(GitError::NotARepo(root.display().to_string()));
    }
    // Cancelled between one process of the run and the next.
    if run.is_cancelled() {
        return Err(GitError::Cancelled);
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
    let child = spawned.ok_or(not_found)?;

    let finished = run
        .wait(child, prompt)
        .map_err(|err| GitError::Command(err.to_string()))?;
    match finished.stopped {
        None => Ok(finished.output),
        Some(Stop::Cancelled) => Err(GitError::Cancelled),
        Some(Stop::Quiet) => Err(GitError::detailed(
            format!(
                "{name} wrote nothing for {} minutes, so it was stopped. It may have lost its connection.",
                QUIET_LIMIT.as_secs() / 60
            ),
            failure_log(&finished.output, prompt),
        )),
        Some(Stop::TooLong) => Err(GitError::detailed(
            format!(
                "{name} was still going after {} minutes, so it was stopped.",
                RUN_LIMIT.as_secs() / 60
            ),
            failure_log(&finished.output, prompt),
        )),
    }
}

/// `spawn_cli`, with a non-zero exit turned into an error.
fn run_cli(
    root: &Path,
    name: &str,
    args: &[&str],
    prompt: &str,
    not_found: GitError,
    run: &AgentRun,
) -> Result<Output, GitError> {
    let output = spawn_cli(root, name, args, prompt, not_found, run)?;
    if !output.status.success() {
        return Err(cli_failure(name, &output, prompt));
    }
    Ok(output)
}

/// A failed CLI run as an error: the CLI's own explanation up front, and its
/// output behind it for debugging.
fn cli_failure(name: &str, output: &Output, prompt: &str) -> GitError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    // On failure these CLIs often write the explanation to stdout instead.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let log = if stderr.trim().is_empty() {
        &stdout
    } else {
        &stderr
    };
    GitError::detailed(
        format!("{name} failed: {}", failure_summary(log, prompt)),
        failure_log(output, prompt),
    )
}

/// Lines of a failed CLI's log kept when no explicit error line is found. The
/// whole log is in the error's detail, so this only needs to be a pointer.
const FAILURE_TAIL_LINES: usize = 5;

/// The part of a failed CLI's log worth leading with. Codex's stderr is its
/// whole session log, which echoes the prompt (patch included) before the
/// error, so the raw log buries a one-line explanation under the diff. Codex
/// reports each failure as an `ERROR: ` line, often a JSON API error, so those
/// come first; failing that, the tail of the log with the prompt echo cut out.
fn failure_summary(log: &str, prompt: &str) -> String {
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

    let log = without_prompt(log, prompt);
    let lines: Vec<&str> = log.trim().lines().collect();
    lines[lines.len().saturating_sub(FAILURE_TAIL_LINES)..].join("\n")
}

/// Bytes kept from the end of each output stream in a failure's detail. A
/// codex session log carries every tool call's output, so it can run to
/// megabytes, and the end is where it went wrong.
const FAILURE_LOG_BYTES: usize = 64 * 1024;

/// A failed run's exit status and both output streams, for the error's detail.
fn failure_log(output: &Output, prompt: &str) -> String {
    let mut log = format!("{}\n", output.status);
    for (label, stream) in [("stderr", &output.stderr), ("stdout", &output.stdout)] {
        let text = without_prompt(&String::from_utf8_lossy(stream), prompt);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let mut start = text.len().saturating_sub(FAILURE_LOG_BYTES);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        let elided = if start > 0 { "…\n" } else { "" };
        log.push_str(&format!("\n{label}:\n{elided}{}\n", &text[start..]));
    }
    log
}

/// The log with the CLI's echo of the prompt cut out.
fn without_prompt(log: &str, prompt: &str) -> String {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        log.to_owned()
    } else {
        log.replace(prompt, "")
    }
}

/// An agent's final text, and whether it answered before it had finished.
struct AgentText {
    text: String,
    /// It hit the turn limit and was asked to answer from what it had read.
    cut_short: bool,
}

impl AgentText {
    fn complete(text: String) -> Self {
        Self {
            text,
            cut_short: false,
        }
    }
}

/// What claude is told when a run stops at the turn limit. The pending tool
/// calls are dropped, so it has to say where its answer rests on unfinished
/// checks.
const WRAP_UP_PROMPT: &str = "You have run out of turns, so stop investigating: no more tool calls. Give your final answer now, in exactly the format the first message asked for, based on what you have read so far. Where you did not get to check something, say so where it matters rather than leaving it out.";

/// Runs `claude -p` and unwraps the CLI's result envelope down to the model's
/// final text. Its events stream as it works, which is what shows the run is
/// still alive; the envelope is the last of them.
///
/// It gets `turns` agentic turns, and is told so. A run that stops at the
/// limit has usually done most of its reading, so rather than throw that away,
/// the session is resumed once with its tools taken away and the model asked
/// to answer from what it has.
///
/// A `specialist` is defined for the run, and a run that answers without
/// launching it is resumed once and told to.
fn claude_result_text(
    root: &Path,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    turns: usize,
    specialist: Option<&Specialist>,
    run: &AgentRun,
) -> Result<AgentText, GitError> {
    let defaults = ClaudeDefaults::read();
    let model = model.or(defaults.model.as_deref());
    let effort = effort.or(defaults.effort.as_deref());
    // Through a file rather than argv: the definition carries the migrations'
    // diffs, which can outgrow the argument-size limit.
    let agents_file = specialist
        .map(|specialist| TempFile::write("agents.json", &specialist.agents))
        .transpose()?;
    let agents_arg = agents_file
        .as_ref()
        .map(|file| file.0.display().to_string());
    let max_turns = turns.to_string();
    let system_note = format!("{}\n\n{CONTEXT_SOURCES_NOTE}", turn_budget_note(turns));
    let mut args = vec![
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        &max_turns,
        "--append-system-prompt",
        &system_note,
    ];
    push_access(&mut args);
    if let Some(agents_arg) = &agents_arg {
        args.extend(["--agents", agents_arg]);
    }
    push_model_and_effort(&mut args, model, effort);
    let output = spawn_cli(root, "claude", &args, prompt, GitError::ClaudeNotFound, run)?;
    let stopped = match read_claude_output(&output) {
        ClaudeOutcome::Answer(text) => {
            let (Some(specialist), Some(agents_arg)) = (specialist, &agents_arg) else {
                return Ok(AgentText::complete(text));
            };
            if launched_subagent(&output, specialist.name) {
                return Ok(AgentText::complete(text));
            }
            let insisted = insist_on_specialist(
                root,
                &output,
                specialist.name,
                agents_arg,
                model,
                effort,
                run,
            )?;
            return Ok(AgentText::complete(insisted.unwrap_or(text)));
        }
        ClaudeOutcome::Failed(error) => return Err(error),
        ClaudeOutcome::OutOfTurns(stopped) => stopped,
    };

    let mut args = vec![
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--resume",
        &stopped.session_id,
        "--tools",
        "",
        "--max-turns",
        "1",
    ];
    push_model_and_effort(&mut args, model, effort);
    let wrap_up = spawn_cli(
        root,
        "claude",
        &args,
        WRAP_UP_PROMPT,
        GitError::ClaudeNotFound,
        run,
    );
    let failure = match wrap_up.map(|output| read_claude_output(&output)) {
        // Stopping the run is not the wrap-up failing.
        Err(GitError::Cancelled) => return Err(GitError::Cancelled),
        Ok(ClaudeOutcome::Answer(text)) => {
            return Ok(AgentText {
                text,
                cut_short: true,
            });
        }
        Ok(ClaudeOutcome::Failed(error)) => error,
        Ok(ClaudeOutcome::OutOfTurns(again)) => again.error,
        Err(error) => error,
    };
    let mut message = "Claude used all its turns before it finished, and then could not answer from what it had read.".to_owned();
    if let Some(note) = &stopped.denials {
        message.push(' ');
        message.push_str(note);
    }
    Err(GitError::detailed(
        message,
        format!(
            "The run that ran out of turns:\n{}\n\nAsked to answer from what it had read, it failed with: {failure}\n{}",
            stopped.error.detail().unwrap_or_default(),
            failure.detail().unwrap_or_default(),
        ),
    ))
}

/// Turns a run gets when it is resumed to launch a specialist it skipped:
/// enough to launch it, check what it reports, and answer again.
const SPECIALIST_RETRY_TURNS: &str = "12";

/// Resumes a run that answered without launching the specialist it was told
/// to, and has it launch it now and answer again. `None` when that produces
/// no answer, so the caller keeps the one it has: a review without the
/// specialist beats no review.
fn insist_on_specialist(
    root: &Path,
    output: &Output,
    name: &str,
    agents_arg: &str,
    model: Option<&str>,
    effort: Option<&str>,
    run: &AgentRun,
) -> Result<Option<String>, GitError> {
    let Some(session_id) = result_envelope(&String::from_utf8_lossy(&output.stdout))
        .and_then(|envelope| envelope["session_id"].as_str().map(str::to_owned))
    else {
        return Ok(None);
    };
    let prompt = format!(
        "You answered without launching the `{name}` subagent, which this review requires. Launch it now with the Agent tool, check what it reports against the code, and then give your final answer again, complete and in exactly the format the first message asked for, with the findings that hold merged in."
    );
    let mut args = vec![
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--resume",
        &session_id,
        "--max-turns",
        SPECIALIST_RETRY_TURNS,
        "--agents",
        agents_arg,
    ];
    push_access(&mut args);
    push_model_and_effort(&mut args, model, effort);
    match spawn_cli(
        root,
        "claude",
        &args,
        &prompt,
        GitError::ClaudeNotFound,
        run,
    ) {
        Err(GitError::Cancelled) => Err(GitError::Cancelled),
        Ok(output) => match read_claude_output(&output) {
            ClaudeOutcome::Answer(text) => Ok(Some(text)),
            _ => Ok(None),
        },
        Err(_) => Ok(None),
    }
}

/// Whether a claude run's event stream shows it launching the subagent
/// `name`. The Agent tool is still called `Task` in older CLIs.
fn launched_subagent(output: &Output, name: &str) -> bool {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|event| event["type"] == "assistant")
        .any(|event| {
            event["message"]["content"]
                .as_array()
                .is_some_and(|blocks| {
                    blocks.iter().any(|block| {
                        block["type"] == "tool_use"
                            && matches!(block["name"].as_str(), Some("Agent" | "Task"))
                            && block["input"]["subagent_type"] == name
                    })
                })
        })
}

/// A file in the temp directory, removed when dropped.
struct TempFile(PathBuf);

impl TempFile {
    fn write(name: &str, contents: &str) -> Result<Self, GitError> {
        let path = std::env::temp_dir().join(format!(
            "tk-review-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, contents)
            .map_err(|err| GitError::Command(format!("could not write {name}: {err}")))?;
        Ok(Self(path))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        // Best effort: it is small, but don't leave one per review.
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The model and effort claude defaults to in the user's own settings.
/// `--restricted` runs skip that settings file, so a review left on "the CLI's
/// default" passes these explicitly to get the same thing.
#[derive(Debug, Default, PartialEq, Eq)]
struct ClaudeDefaults {
    model: Option<String>,
    effort: Option<String>,
}

impl ClaudeDefaults {
    /// From `settings.json` in claude's config directory: `CLAUDE_CONFIG_DIR`,
    /// or `~/.claude`. None, when there is no such file.
    fn read() -> Self {
        let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".claude")));
        dir.and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok())
            .map(|text| Self::from_settings(&text))
            .unwrap_or_default()
    }

    fn from_settings(text: &str) -> Self {
        let settings: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        let field = |name: &str| {
            settings[name]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Self {
            model: field("model"),
            effort: field("effortLevel"),
        }
    }
}

fn push_model_and_effort<'a>(
    args: &mut Vec<&'a str>,
    model: Option<&'a str>,
    effort: Option<&'a str>,
) {
    if let Some(model) = model {
        args.extend(["--model", model]);
    }
    if let Some(effort) = effort {
        args.extend(["--effort", effort]);
    }
}

/// How a `claude -p` run ended.
enum ClaudeOutcome {
    Answer(String),
    /// Stopped at the turn limit, in a session that can be resumed.
    OutOfTurns(OutOfTurns),
    Failed(GitError),
}

struct OutOfTurns {
    session_id: String,
    /// What to report if resuming doesn't produce an answer either.
    error: GitError,
    denials: Option<String>,
}

/// Reads a claude run's stdout: an envelope whose `result` field carries the
/// model's final text, or on failure says what went wrong. The envelope comes
/// on stdout whatever the exit status, so it is read first.
fn read_claude_output(output: &Output) -> ClaudeOutcome {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(envelope) = result_envelope(&stdout) else {
        return if output.status.success() {
            // Not the envelope shape — treat the whole output as the answer.
            ClaudeOutcome::Answer(stdout.into_owned())
        } else {
            ClaudeOutcome::Failed(cli_failure("claude", output, ""))
        };
    };

    if envelope["is_error"].as_bool() != Some(true) {
        if let Some(result) = envelope["result"].as_str() {
            return ClaudeOutcome::Answer(result.to_owned());
        }
    }

    let denials = permission_denials_note(&envelope);
    let subtype = envelope["subtype"].as_str().unwrap_or_default();
    let errors: Vec<&str> = envelope["errors"]
        .as_array()
        .map(|errors| errors.iter().filter_map(|error| error.as_str()).collect())
        .unwrap_or_default();
    let mut message = match subtype {
        "error_max_turns" => "Claude used all its turns before it finished.".to_owned(),
        "error_max_budget_usd" => {
            "Claude reached its spending limit before it finished.".to_owned()
        }
        _ => match envelope["result"].as_str().map(str::trim) {
            Some(result) if !result.is_empty() => format!("Claude reported an error: {result}"),
            _ if !errors.is_empty() => {
                format!("Claude stopped partway through: {}", errors.join("; "))
            }
            _ => "Claude stopped without an answer or a reason.".to_owned(),
        },
    };
    if let Some(note) = &denials {
        message.push(' ');
        message.push_str(note);
    }
    let detail = serde_json::to_string_pretty(&envelope).unwrap_or_else(|_| stdout.into_owned());
    let error = GitError::detailed(message, detail);

    match envelope["session_id"].as_str() {
        Some(session_id) if subtype == "error_max_turns" => ClaudeOutcome::OutOfTurns(OutOfTurns {
            session_id: session_id.to_owned(),
            error,
            denials,
        }),
        _ => ClaudeOutcome::Failed(error),
    }
}

/// The `result` envelope a claude run ends with: the last line of its
/// `stream-json` output, or the whole of it from `--output-format json`.
fn result_envelope(stdout: &str) -> Option<serde_json::Value> {
    let is_result = |value: &serde_json::Value| value["type"] == "result";
    serde_json::from_str(stdout.trim())
        .ok()
        .filter(is_result)
        .or_else(|| {
            stdout
                .lines()
                .rev()
                .filter_map(|line| serde_json::from_str(line).ok())
                .find(is_result)
        })
}

/// Tool calls the CLI refused the model, which on a run that failed are often
/// where its turns went: `"8 of its tool calls were refused permission (Bash
/// ×7, Write)."`
fn permission_denials_note(envelope: &serde_json::Value) -> Option<String> {
    let denials = envelope["permission_denials"].as_array()?;
    if denials.is_empty() {
        return None;
    }
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for denial in denials {
        let tool = denial["tool_name"].as_str().unwrap_or("unknown tool");
        match counts.iter_mut().find(|(name, _)| *name == tool) {
            Some((_, count)) => *count += 1,
            None => counts.push((tool, 1)),
        }
    }
    let tools = counts
        .iter()
        .map(|(tool, count)| match count {
            1 => (*tool).to_owned(),
            _ => format!("{tool} ×{count}"),
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(match denials.len() {
        1 => format!("One of its tool calls was refused permission ({tools})."),
        count => format!("{count} of its tool calls were refused permission ({tools})."),
    })
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
    run: &AgentRun,
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

    let finished = run_cli(root, "codex", &args, prompt, GitError::CodexNotFound, run);
    let message = std::fs::read_to_string(&out_path);
    // Best effort: the temp files are small, but don't leave a pair per review.
    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&schema_path);

    finished?;
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

    /// What a finished claude run left behind: its exit status and stdout.
    fn claude_output(stdout: &str, succeeded: bool) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            // A raw wait status: the exit code sits in the second byte.
            status: std::process::ExitStatus::from_raw(if succeeded { 0 } else { 1 << 8 }),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    /// A clean exit's stdout down to the model's text, or the error it reports.
    fn unwrap_claude_envelope(raw: &[u8]) -> Result<String, GitError> {
        match read_claude_output(&claude_output(&String::from_utf8_lossy(raw), true)) {
            ClaudeOutcome::Answer(text) => Ok(text),
            ClaudeOutcome::OutOfTurns(stopped) => Err(stopped.error),
            ClaudeOutcome::Failed(error) => Err(error),
        }
    }

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

    /// A patch touching `files` files, as `git diff` writes one.
    fn patch_of(files: usize) -> String {
        (0..files)
            .map(|n| format!("diff --git a/f{n} b/f{n}\n--- a/f{n}\n+++ b/f{n}\n@@ -1 +1 @@\n-diff --git\n+x\n"))
            .collect()
    }

    #[test]
    fn the_turn_budget_grows_with_the_diff_within_bounds() {
        assert_eq!(turn_budget(&patch_of(1)), MIN_TURNS);
        assert_eq!(turn_budget(&patch_of(40)), MIN_TURNS + 20);
        // The size of the pull request that prompted this: 139 files.
        assert!(turn_budget(&patch_of(139)) > 90);
        assert_eq!(turn_budget(&patch_of(1000)), MAX_TURNS);
    }

    #[test]
    fn the_budget_note_names_the_budget_and_asks_for_batched_reads() {
        let note = turn_budget_note(64);
        assert!(note.contains("64 turns"), "{note}");
        assert!(note.contains("same response"), "{note}");
    }

    #[test]
    fn reads_the_envelope_at_the_end_of_a_stream() {
        let stream = [
            r#"{"type":"system","subtype":"init","session_id":"s1"}"#.to_owned(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"{ not the answer }"}]}}"#
                .to_owned(),
            envelope(REVIEW_JSON),
        ]
        .join("\n");
        let review = parse_claude(stream.as_bytes()).expect("parse");
        assert_eq!(review.summary, "Small, focused change.");
    }

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
            posted_url: None,
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
            posted_url: None,
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

    /// Trimmed from a real re-review that hit the turn limit after spending a
    /// quarter of its turns on shell commands it wasn't allowed to run.
    const OUT_OF_TURNS_ENVELOPE: &str = r#"{
        "type": "result",
        "subtype": "error_max_turns",
        "is_error": true,
        "num_turns": 31,
        "stop_reason": "tool_use",
        "session_id": "d87f50d5-6f14-4858-9539-0244f050e9e4",
        "terminal_reason": "max_turns",
        "errors": ["Reached maximum number of turns (30)"],
        "permission_denials": [
            {"tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": {"command": "pnpm --version"}},
            {"tool_name": "Bash", "tool_use_id": "toolu_2", "tool_input": {"command": "gh pr checks 7927"}},
            {"tool_name": "Write", "tool_use_id": "toolu_3", "tool_input": {"file_path": "/tmp/test.sh"}},
            {"tool_name": "Bash", "tool_use_id": "toolu_4", "tool_input": {"command": "ls ~/Library/pnpm"}}
        ]
    }"#;

    #[test]
    fn a_run_out_of_turns_can_be_resumed() {
        let ClaudeOutcome::OutOfTurns(stopped) =
            read_claude_output(&claude_output(OUT_OF_TURNS_ENVELOPE, false))
        else {
            panic!("expected a resumable run");
        };

        assert_eq!(stopped.session_id, "d87f50d5-6f14-4858-9539-0244f050e9e4");
        assert_eq!(
            stopped.error.to_string(),
            "Claude used all its turns before it finished. 4 of its tool calls were refused permission (Bash ×3, Write)."
        );
        assert_eq!(
            stopped.denials.as_deref(),
            Some("4 of its tool calls were refused permission (Bash ×3, Write).")
        );
    }

    /// The envelope is the debugging record, so none of it is dropped.
    #[test]
    fn a_failed_run_keeps_its_envelope_as_the_detail() {
        let ClaudeOutcome::OutOfTurns(stopped) =
            read_claude_output(&claude_output(OUT_OF_TURNS_ENVELOPE, false))
        else {
            panic!("expected a resumable run");
        };
        let detail = stopped.error.detail().expect("detail");

        assert!(
            detail.contains("\"command\": \"gh pr checks 7927\""),
            "{detail}"
        );
        assert!(detail.contains("\"num_turns\": 31"), "{detail}");
    }

    #[test]
    fn a_run_out_of_turns_without_a_session_is_a_plain_failure() {
        let raw = r#"{"type": "result", "subtype": "error_max_turns", "is_error": true}"#;

        let ClaudeOutcome::Failed(error) = read_claude_output(&claude_output(raw, false)) else {
            panic!("nothing to resume without a session id");
        };
        assert_eq!(
            error.to_string(),
            "Claude used all its turns before it finished."
        );
    }

    #[test]
    fn an_execution_error_reports_what_the_cli_said() {
        let raw = r#"{"type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": ["API Error: 529 overloaded"]}"#;

        let error = unwrap_claude_envelope(raw.as_bytes()).expect_err("should fail");
        assert_eq!(
            error.to_string(),
            "Claude stopped partway through: API Error: 529 overloaded"
        );
    }

    #[test]
    fn a_failed_run_without_an_envelope_reports_its_output() {
        let mut output = claude_output("", false);
        output.stderr = b"Error: unknown option '--effrot'".to_vec();

        let ClaudeOutcome::Failed(error) = read_claude_output(&output) else {
            panic!("a non-zero exit without an envelope is a failure");
        };
        assert_eq!(
            error.to_string(),
            "claude failed: Error: unknown option '--effrot'"
        );
        let detail = error.detail().expect("detail");
        assert!(detail.contains("exit status: 1"), "{detail}");
        assert!(
            detail.contains("stderr:\nError: unknown option"),
            "{detail}"
        );
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
            posted_url: None,
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
            posted_url: None,
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

        let reply = build_reply_prompt(
            Some("feature"),
            "Summary.",
            Some(&finding),
            &[],
            "Why?",
            patch,
            None,
        );
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
            head_ref: "avoid-duplicate-widgets".into(),
            head_sha: "abc123".into(),
            compare_ref: "tk-review/pr/7".into(),
            comments: vec![crate::github::PrComment {
                in_reply_to: None,
                id: 1,
                author: "reviewer".into(),
                body: "Please keep the old endpoint.".into(),
                created_at: "2026-08-06T00:00:00Z".into(),
                path: Some("src/api.rs".into()),
                line: Some(12),
                start_line: None,
                old_side: false,
                outdated: false,
            }],
            threads: Vec::new(),
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

    /// One file's section of a patch, as `git diff` writes it.
    fn file_section(header: &str, hunk: &str) -> String {
        format!("{header}\n@@ -1,1 +1,1 @@\n{hunk}\n")
    }

    /// A patch that adds a migration, edits another, deletes a third, renames a
    /// fourth, and changes some code alongside them.
    fn migration_patch() -> String {
        [
            file_section(
                "diff --git a/apps/api/src/migrations/0002_add_owner.sql b/apps/api/src/migrations/0002_add_owner.sql\nnew file mode 100644\n--- /dev/null\n+++ b/apps/api/src/migrations/0002_add_owner.sql",
                "+ALTER TABLE drawing ADD COLUMN owner_id uuid;",
            ),
            file_section(
                "diff --git a/src/api/drawings.ts b/src/api/drawings.ts\n--- a/src/api/drawings.ts\n+++ b/src/api/drawings.ts",
                // Out of context, a hunk line can read like a header.
                "+++ b/apps/api/src/migrations/not_a_file.sql\n+const owner = drawing.owner_id;",
            ),
            file_section(
                "diff --git a/db/migrate/0001_old.rb b/db/migrate/0001_old.rb\ndeleted file mode 100644\n--- a/db/migrate/0001_old.rb\n+++ /dev/null",
                "-class Old < ActiveRecord::Migration; end",
            ),
            "diff --git a/migrations/a.sql b/migrations/b.sql\nsimilarity index 100%\nrename from migrations/a.sql\nrename to migrations/b.sql\n".to_owned(),
        ]
        .concat()
    }

    #[test]
    fn finds_the_migrations_a_patch_changes_by_where_they_live() {
        let patch = migration_patch();
        let paths: Vec<String> = migration_sections(&patch)
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        assert_eq!(
            paths,
            [
                "apps/api/src/migrations/0002_add_owner.sql",
                "db/migrate/0001_old.rb",
                "migrations/b.sql",
            ]
        );
        assert!(migration_sections(&patch_of(3)).is_empty());
        // A file named like a migrations directory is not in one.
        assert!(migration_sections("diff --git a/migrations b/migrations\n--- a/migrations\n+++ b/migrations\n@@ -1 +1 @@\n-a\n+b\n").is_empty());
    }

    /// The `--agents` definition the review hands claude, parsed.
    fn reviewer_definition(specialist: &Specialist) -> serde_json::Value {
        assert_eq!(specialist.name, MIGRATION_REVIEWER);
        let agents: serde_json::Value =
            serde_json::from_str(&specialist.agents).expect("agents JSON");
        agents[MIGRATION_REVIEWER].clone()
    }

    #[test]
    fn a_claude_review_of_migrations_hands_them_to_the_migration_reviewer() {
        let patch = migration_patch();
        let mut prompt = build_prompt(Some("feature"), &patch, Some(&sample_pr()));
        let specialist =
            add_migration_review(&mut prompt, "claude", &patch, "").expect("a specialist");

        // The main reviewer is told to launch it, about which files, and to
        // fold what it finds into its own findings.
        assert!(
            prompt.contains("launch the `migration-reviewer` subagent"),
            "{prompt}"
        );
        assert!(
            prompt.contains("- `apps/api/src/migrations/0002_add_owner.sql`"),
            "{prompt}"
        );
        assert!(prompt.contains("Weigh them in the verdict"), "{prompt}");
        assert!(!prompt.contains(MIGRATION_GUIDANCE.trim_end()), "{prompt}");
        // Framing, so ahead of the diff and after the PR's own account.
        assert!(prompt.ends_with(&format!("The diff:\n\n{patch}")));
        assert!(
            prompt.find("launch the").unwrap() > prompt.find("Avoid duplicate widgets").unwrap()
        );

        // The subagent carries the checklist and the migrations' diffs, but
        // not the rest of the diff, and can only read.
        let definition = reviewer_definition(&specialist);
        let subagent_prompt = definition["prompt"].as_str().expect("prompt");
        assert!(subagent_prompt.contains(MIGRATION_GUIDANCE.trim_end()));
        assert!(subagent_prompt.contains("+ALTER TABLE drawing ADD COLUMN owner_id uuid;"));
        assert!(subagent_prompt.contains("rename to migrations/b.sql"));
        assert!(!subagent_prompt.contains("const owner"));
        // It works with the run's own tools, which the run holds to reads.
        assert!(definition["tools"].is_null());
        assert_eq!(definition["maxTurns"], MIGRATION_REVIEWER_TURNS);
        assert!(definition["description"]
            .as_str()
            .is_some_and(|text| !text.is_empty()));
    }

    #[test]
    fn a_codex_review_of_migrations_gets_the_checklist_in_its_prompt() {
        let patch = migration_patch();
        let mut prompt = build_re_review_prompt(Some("feature"), "Summary.", &[], &patch, None);
        assert!(add_migration_review(&mut prompt, "codex", &patch, "").is_none());
        assert!(prompt.contains(MIGRATION_GUIDANCE.trim_end()), "{prompt}");
        assert!(prompt.contains("- `db/migrate/0001_old.rb`"), "{prompt}");
        assert!(!prompt.contains("subagent"), "{prompt}");
        assert!(prompt.ends_with(&format!("The diff:\n\n{patch}")));
    }

    #[test]
    fn a_review_without_migrations_is_left_alone() {
        let patch = patch_of(2);
        let mut prompt = build_prompt(None, &patch, None);
        let before = prompt.clone();
        for engine in ["claude", "codex"] {
            assert!(add_migration_review(&mut prompt, engine, &patch, "").is_none());
            assert_eq!(prompt, before);
        }
    }

    #[test]
    fn the_repositorys_review_rules_frame_the_diff() {
        let patch = patch_of(1);
        let mut prompt = build_prompt(None, &patch, None);
        add_review_rules(&mut prompt, &patch, "  Money is always in integer cents.\n");
        assert!(
            prompt.contains("keeps these rules for this repository"),
            "{prompt}"
        );
        assert!(
            prompt.contains("Money is always in integer cents.\n\nThe diff:"),
            "{prompt}"
        );
        assert!(prompt.ends_with(&patch));

        let before = prompt.clone();
        add_review_rules(&mut prompt, &patch, " \n ");
        assert_eq!(prompt, before);
    }

    #[test]
    fn the_repositorys_migration_rules_follow_the_checklist_for_either_engine() {
        let patch = migration_patch();
        let rules = "The orders table is huge: always set a lock timeout.";

        let mut prompt = build_prompt(None, &patch, None);
        let specialist =
            add_migration_review(&mut prompt, "claude", &patch, rules).expect("a specialist");
        let definition = reviewer_definition(&specialist);
        let subagent_prompt = definition["prompt"].as_str().expect("prompt");
        let checklist = subagent_prompt
            .find(MIGRATION_GUIDANCE.trim_end())
            .expect("checklist");
        assert!(subagent_prompt.find(rules).expect("rules") > checklist);
        // The main reviewer's prompt stays short: the rules go to the specialist.
        assert!(!prompt.contains(rules), "{prompt}");

        let mut prompt = build_prompt(None, &patch, None);
        add_migration_review(&mut prompt, "codex", &patch, rules);
        assert!(prompt.contains(&migration_guidance(rules)), "{prompt}");

        assert_eq!(migration_guidance(" "), MIGRATION_GUIDANCE.trim_end());
    }

    #[test]
    fn framing_lands_before_the_diff_even_when_the_pr_quotes_the_marker() {
        let mut pr = sample_pr();
        pr.body = "Before.\n\nThe diff:\n\nAfter.".into();
        let patch = migration_patch();
        let mut prompt = build_prompt(None, &patch, Some(&pr));
        add_migration_review(&mut prompt, "claude", &patch, "");
        let note = prompt
            .find("This diff changes database migrations")
            .expect("note");
        assert!(note > prompt.find("After.").expect("PR body"), "{prompt}");
        assert!(prompt.ends_with(&format!("The diff:\n\n{patch}")));
    }

    /// Every tool the claude.ai Slack and Linear connectors offered as of
    /// October 2026.
    const CONNECTOR_TOOLS: &str = "slack_add_reaction slack_create_canvas slack_create_conversation slack_get_reactions slack_list_channel_members slack_read_canvas slack_read_channel slack_read_file slack_read_thread slack_read_user_profile slack_schedule_message slack_search_channels slack_search_emojis slack_search_public slack_search_public_and_private slack_search_users slack_send_message slack_send_message_draft slack_update_canvas | create_attachment create_attachment_from_upload create_initiative_label create_issue_label delete_attachment delete_comment delete_diff_comment delete_status_update extract_images get_agent_skill get_attachment get_diff get_diff_threads get_document get_initiative get_issue get_issue_status get_milestone get_notifications get_project get_release get_release_note get_status_updates get_team get_template get_triage_responsibility get_user get_workspace list_agent_skills list_comments list_custom_views list_cycles list_diffs list_documents list_initiative_labels list_initiatives list_issue_labels list_issue_statuses list_issues list_milestones list_project_labels list_projects list_release_notes list_release_pipelines list_releases list_teams list_templates list_users mark_notification merge_diff prepare_attachment_upload resolve_diff_thread restore_initiative_label restore_issue_label restore_project_label retire_initiative_label retire_issue_label retire_project_label save_comment save_diff_comment save_document save_initiative save_initiative_label save_issue save_issue_label save_milestone save_project save_project_label save_release save_release_note save_status_update search_documentation share_issue submit_diff_review unshare_issue update_diff";

    #[test]
    fn claude_runs_are_restricted_to_reads() {
        let mut args = Vec::new();
        push_access(&mut args);
        assert_eq!(&args[..3], ["--restricted", "--tools", CLAUDE_TOOLS]);
        for writer in ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"] {
            assert!(
                !CLAUDE_TOOLS.split(',').any(|tool| tool == writer),
                "{writer}"
            );
            assert!(DENIED_TOOLS.contains(&writer), "{writer}");
        }
        for rule in ALLOWED_TOOLS {
            assert!(
                !DENIED_TOOLS.contains(rule),
                "{rule} is both allowed and denied"
            );
        }

        // Commands: history reads only.
        let reads = [
            "Bash(git log:",
            "Bash(git show:",
            "Bash(git blame:",
            "Bash(gh pr view:",
            "Bash(gh pr diff:",
            "Bash(gh pr list:",
            "Bash(gh issue view:",
            "Bash(gh issue list:",
            "Bash(gh search:",
        ];
        for rule in ALLOWED_TOOLS
            .iter()
            .filter(|rule| rule.starts_with("Bash("))
        {
            assert!(reads.iter().any(|read| rule.starts_with(read)), "{rule}");
        }

        // Connectors: every tool that writes is denied, and only reads are
        // allowed. Slack's private search is out, since findings get posted.
        let (slack, linear) = CONNECTOR_TOOLS.split_once(" | ").expect("two servers");
        let tools = slack
            .split(' ')
            .map(|tool| format!("mcp__claude_ai_Slack__{tool}"))
            .chain(
                linear
                    .split(' ')
                    .map(|tool| format!("mcp__claude_ai_Linear__{tool}")),
            );
        for tool in tools {
            let name = tool
                .rsplit("__")
                .next()
                .expect("name")
                .trim_start_matches("slack_");
            let reads = ["get_", "list_", "read_", "search_", "extract_"]
                .iter()
                .any(|verb| name.starts_with(verb));
            if !reads {
                assert!(
                    DENIED_TOOLS.contains(&tool.as_str()),
                    "{tool} writes but isn't denied"
                );
            }
            if ALLOWED_TOOLS.contains(&tool.as_str()) {
                assert!(reads && name != "search_public_and_private", "{tool}");
            }
        }
    }

    #[test]
    fn claude_prompts_carry_the_repositorys_agent_instructions() {
        let dir = tempfile::tempdir().expect("temp dir");
        let patch = patch_of(1);
        let prompt_for = |engine: &str| {
            let mut prompt = build_prompt(None, &patch, None);
            add_repo_instructions(&mut prompt, &patch, dir.path(), engine);
            prompt
        };
        let bare = build_prompt(None, &patch, None);
        assert_eq!(prompt_for("claude"), bare, "no instructions to carry");

        std::fs::write(
            dir.path().join("AGENTS.md"),
            "Migrations are forward-only.\n",
        )
        .expect("write");
        let prompt = prompt_for("claude");
        assert!(prompt.contains("from its root `AGENTS.md`"), "{prompt}");
        assert!(
            prompt.contains("<repository-instructions>\nMigrations are forward-only.\n</repository-instructions>"),
            "{prompt}"
        );
        assert!(prompt.ends_with(&format!("The diff:\n\n{patch}")));
        // Codex reads AGENTS.md itself.
        assert_eq!(prompt_for("codex"), bare);

        std::fs::write(dir.path().join("CLAUDE.md"), "Use pnpm.").expect("write");
        let prompt = prompt_for("claude");
        assert!(
            prompt.contains("from its root `CLAUDE.md`") && prompt.contains("Use pnpm."),
            "{prompt}"
        );
        assert!(!prompt.contains("forward-only"), "{prompt}");
    }

    #[test]
    fn a_blank_model_and_effort_follow_the_users_claude_settings() {
        let defaults = ClaudeDefaults::from_settings(
            r#"{"model": "opus[1m]", "effortLevel": "xhigh", "theme": "dark"}"#,
        );
        assert_eq!(defaults.model.as_deref(), Some("opus[1m]"));
        assert_eq!(defaults.effort.as_deref(), Some("xhigh"));
        assert_eq!(
            ClaudeDefaults::from_settings(r#"{"model": " "}"#),
            ClaudeDefaults::default()
        );
        assert_eq!(
            ClaudeDefaults::from_settings("not json"),
            ClaudeDefaults::default()
        );
    }

    #[test]
    fn spots_a_subagent_launch_in_the_event_stream() {
        let launch = |name: &str, kind: &str| {
            serde_json::json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Starting."},
                {"type": "tool_use", "name": name, "input": {"subagent_type": kind, "prompt": "Go."}}
            ]}})
            .to_string()
        };
        let stream = |events: &[String]| {
            claude_output(&[events, &[envelope("{}")]].concat().join("\n"), true)
        };

        assert!(launched_subagent(
            &stream(&[launch("Agent", MIGRATION_REVIEWER)]),
            MIGRATION_REVIEWER
        ));
        assert!(launched_subagent(
            &stream(&[launch("Task", MIGRATION_REVIEWER)]),
            MIGRATION_REVIEWER
        ));
        assert!(!launched_subagent(
            &stream(&[launch("Agent", "Explore")]),
            MIGRATION_REVIEWER
        ));
        assert!(!launched_subagent(&stream(&[]), MIGRATION_REVIEWER));
    }

    #[test]
    fn rejects_an_unknown_engine() {
        let dir = tempfile::tempdir().expect("temp dir");
        let run = AgentRun::detached();
        let rules = RepoRules::default();
        let err = review_diff(
            dir.path(),
            "HEAD",
            None,
            "gemini",
            None,
            None,
            None,
            &rules,
            &run,
        )
        .expect_err("unknown");
        assert!(err.to_string().contains("unknown review engine"), "{err}");

        let err = explain_diff(dir.path(), "HEAD", None, "gemini", None, None, None, &run)
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
            &rules,
            &run,
        )
        .expect_err("unknown");
        assert!(err.to_string().contains("unknown review engine"), "{err}");
    }

    #[test]
    fn a_re_review_needs_a_previous_review() {
        let dir = tempfile::tempdir().expect("temp dir");
        let err = re_review_diff(
            dir.path(),
            "HEAD",
            None,
            "claude",
            None,
            None,
            "  ",
            &[],
            None,
            &RepoRules::default(),
            &AgentRun::detached(),
        )
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
                posted_url: None,
            },
            ReviewFinding {
                path: "src/b.ts".into(),
                line: None,
                end_line: None,
                severity: "nit".into(),
                title: "Stale comment.".into(),
                body: "The comment describes removed behavior.".into(),
                posted_url: None,
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
        assert!(
            prompt.contains("judge whether it has been addressed"),
            "{prompt}"
        );
        assert!(
            prompt.contains("Review the current diff for NEW problems"),
            "{prompt}"
        );
        assert!(
            prompt.contains("Do not re-report the numbered findings"),
            "{prompt}"
        );
        assert!(prompt.contains("diff --git a/src/a.ts"), "{prompt}");
    }

    /// A posted finding's thread follows it in the re-review, so the author's
    /// "fixed" gets checked rather than taken on trust.
    #[test]
    fn the_re_review_prompt_carries_what_happened_to_a_posted_finding() {
        let mut pr = sample_pr();
        let posted = "https://github.com/acme/widgets/pull/7#discussion_r40";
        pr.comments = vec![
            crate::github::PrComment {
                in_reply_to: None,
                id: 40,
                author: "me".into(),
                body: "Off-by-one in loop bound.".into(),
                created_at: "2026-08-06T00:00:00Z".into(),
                path: Some("src/a.ts".into()),
                line: Some(14),
                start_line: Some(12),
                old_side: false,
                outdated: true,
            },
            crate::github::PrComment {
                in_reply_to: None,
                id: 41,
                author: "octo".into(),
                body: "Fixed: the bound is now inclusive.\nAdded a test.".into(),
                created_at: "2026-08-07T00:00:00Z".into(),
                path: Some("src/a.ts".into()),
                line: Some(14),
                start_line: Some(12),
                old_side: false,
                outdated: true,
            },
        ];
        pr.threads = vec![crate::github::PrThread {
            id: "T1".into(),
            resolved: false,
            resolved_by: None,
            outdated: true,
            comment_ids: vec![40, 41],
        }];
        let finding = |posted_url: Option<&str>| ReviewFinding {
            path: "src/a.ts".into(),
            line: Some(12),
            end_line: Some(14),
            severity: "warning".into(),
            title: "Off-by-one in loop bound.".into(),
            body: "The loop misses the last element.".into(),
            posted_url: posted_url.map(str::to_owned),
        };
        let prompt = build_re_review_prompt(
            Some("feature"),
            "Small, focused change.",
            &[finding(Some(posted)), finding(None)],
            "diff --git a/src/a.ts b/src/a.ts",
            Some(&pr),
        );

        assert!(
            prompt.contains(
                "   It was sent to the pull request, where its thread is unresolved, and outdated: the lines it was on have changed since. Replies there:\n   - @octo: Fixed: the bound is now inclusive.\n     Added a test.\n1. [warning]"
            ),
            "{prompt}"
        );
        // Only the posted one has a thread to report.
        assert_eq!(
            prompt.matches("It was sent to the pull request").count(),
            1,
            "{prompt}"
        );
        assert!(
            prompt.contains("as a claim to check against the code"),
            "{prompt}"
        );
        // The discussion shows where each comment sits, spans and all.
        assert!(
            prompt.contains("@octo (src/a.ts:12-14, outdated): Fixed"),
            "{prompt}"
        );

        // The same thread follows the finding into a conversation about it.
        let reply = build_reply_prompt(
            Some("feature"),
            "Small, focused change.",
            Some(&finding(Some(posted))),
            &[],
            "Is this really fixed?",
            "diff --git a/src/a.ts b/src/a.ts",
            Some(&pr),
        );
        assert!(
            reply.contains(
                "- The loop misses the last element.\n   It was sent to the pull request"
            ),
            "{reply}"
        );
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
        assert!(prompt.contains("diff --git a/a b/a"), "{prompt}");
    }

    /// The walkthrough and the file notes are read in different places, so
    /// they get different briefs: one thorough, one short and selective.
    #[test]
    fn the_explain_prompt_briefs_the_walkthrough_and_the_file_notes_apart() {
        let prompt = build_explain_prompt(Some("feature"), "diff --git a/a b/a", None);

        assert!(prompt.contains("`overall` is the walkthrough"), "{prompt}");
        assert!(prompt.contains("Use a small table"), "{prompt}");
        assert!(
            prompt.contains("short `###` headings are welcome"),
            "{prompt}"
        );
        assert!(
            prompt.contains("one exception to \"No headings\""),
            "{prompt}"
        );
        // A note on a lockfile is noise in the diff, not help.
        assert!(
            prompt.contains("only for files whose changes benefit from explaining"),
            "{prompt}"
        );
        assert!(prompt.contains("not by line number"), "{prompt}");
    }

    #[test]
    fn the_explain_prompt_carries_the_voice_and_its_samples() {
        let prompt = build_explain_prompt(Some("feature"), "diff --git a/a b/a", None);

        assert!(prompt.contains("How to sound:"), "{prompt}");
        assert!(prompt.contains("song and dance"), "{prompt}");
        // The voice is framing, so it stays ahead of the diff.
        assert!(prompt.ends_with("diff --git a/a b/a"), "{prompt}");
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
    fn a_codex_failure_leads_with_its_error_message() {
        let summary = failure_summary(CODEX_FAILURE_LOG, "Review this change.\ndiff --git a/a b/a");

        assert_eq!(
            summary,
            "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."
        );
    }

    #[test]
    fn a_plain_error_line_is_kept_as_written() {
        let summary = failure_summary(
            "user\nprompt\nERROR: stream disconnected before completion\n",
            "prompt",
        );

        assert_eq!(summary, "stream disconnected before completion");
    }

    #[test]
    fn without_error_lines_the_log_tail_omits_the_prompt_echo() {
        let prompt = (0..50)
            .map(|n| format!("patch line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let log = format!("header\nuser\n{prompt}\n\nsomething went wrong\n");

        let summary = failure_summary(&log, &prompt);

        assert!(!summary.contains("patch line"), "{summary}");
        assert!(summary.ends_with("something went wrong"), "{summary}");
    }

    /// The detail keeps the whole log, minus the prompt the CLI echoed back.
    #[test]
    fn a_failure_log_keeps_both_streams_without_the_prompt() {
        let prompt = "Review this change.\ndiff --git a/a b/a";
        let mut output = claude_output("partial output", false);
        output.stderr = CODEX_FAILURE_LOG.as_bytes().to_vec();

        let log = failure_log(&output, prompt);

        assert!(log.starts_with("exit status: 1\n"), "{log}");
        assert!(log.contains("stderr:\nOpenAI Codex v0.146.1"), "{log}");
        assert!(log.contains("worker quit with fatal"), "{log}");
        assert!(log.contains("stdout:\npartial output"), "{log}");
        assert!(!log.contains("diff --git"), "{log}");
    }

    /// A codex session log can run to megabytes; its end is what matters.
    #[test]
    fn a_failure_log_keeps_the_end_of_a_long_stream() {
        let mut output = claude_output("", false);
        output.stderr = format!("{}the end", "é".repeat(FAILURE_LOG_BYTES)).into_bytes();

        let log = failure_log(&output, "");

        assert!(log.len() < FAILURE_LOG_BYTES + 64, "{}", log.len());
        assert!(log.contains("stderr:\n…\n"), "elided start");
        assert!(log.trim_end().ends_with("the end"));
    }
}
