//! Measures how stable reviews are: runs the same review of the same diff
//! several times, and reports how far the findings agree from run to run.
//!
//! ```sh
//! # Three reviews of a PR whose commits are already local (open it in the app first)
//! cargo run --release --example review_bench -- run --repo ~/code/app \
//!     --pr https://github.com/owner/app/pull/123 --runs 3 --out bench/pr123
//! # Or of any two refs
//! cargo run --release --example review_bench -- run --repo ~/code/app \
//!     --base origin/main --compare my-branch --out bench/my-branch
//! # Re-reviews of the PR as it is now, following up on one of those runs,
//! # looking at what changed since (or with --whole, the whole diff again)
//! cargo run --release --example review_bench -- run --repo ~/code/app \
//!     --pr https://github.com/owner/app/pull/123 --from bench/pr123/run-1.json --out bench/pr123-re
//! # The report again, or side by side for a before and after
//! cargo run --release --example review_bench -- report bench/pr123 bench/pr123-after
//! ```
//!
//! Each run is written to the output folder as `run-N.json` as soon as it
//! finishes, so a bench that's stopped partway keeps what it had, and running
//! it again into the same folder adds runs. The report goes to `report.md`
//! beside them, with a column to mark which findings were worth fixing.
//!
//! Runs reuse the app's review exactly, rules kept for the repository
//! included, so they cost what a review in the app costs.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tk_review_lib::error::GitError;
use tk_review_lib::github::{self, PrContext};
use tk_review_lib::review::{
    self, FindingResolution, PriorReview, ReviewFinding, SetAsideFinding, WithdrawnFinding,
};
use tk_review_lib::runs::AgentRuns;
use tk_review_lib::{git, rules};

/// How many lines apart two findings on the same file can start or end and
/// still count as the same problem: runs often anchor one problem a line or
/// two differently.
const LINE_SLACK: u32 = 3;

/// One review as the bench keeps it: what it found, and what it took.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchRun {
    /// `review`, `re-review` (of what changed since), or `full re-review`.
    #[serde(default = "first_review")]
    kind: String,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
    base: String,
    compare: String,
    merge_base: String,
    /// The commit `compare` was, which a re-review following up on this run
    /// looks for changes since.
    #[serde(default)]
    head: Option<String>,
    seconds: u64,
    summary: String,
    verdict: String,
    findings: Vec<ReviewFinding>,
    #[serde(default)]
    withdrawn: Vec<WithdrawnFinding>,
    #[serde(default)]
    cut_short: bool,
    #[serde(default)]
    check_failure: Option<String>,
    /// A re-review's verdicts on the findings it followed up on.
    #[serde(default)]
    resolutions: Vec<FindingResolution>,
    /// A re-review's new findings outside what changed since.
    #[serde(default)]
    outside: Vec<ReviewFinding>,
}

fn first_review() -> String {
    "review".to_owned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]),
        Some("report") if args.len() > 1 => report(&args[1..]),
        _ => Err(USAGE.to_owned()),
    };
    if let Err(message) = outcome {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

const USAGE: &str = "usage:
  review_bench run --repo PATH (--pr URL | --base REF --compare REF) [--engine claude|codex]
                   [--model ID] [--effort LEVEL] [--runs N] [--out DIR]
                   [--from RUN.json [--whole]]
  review_bench report DIR [DIR...]";

/// The `run` command's options.
#[derive(Debug, Default)]
struct RunOptions {
    repo: Option<String>,
    pr: Option<String>,
    base: Option<String>,
    compare: Option<String>,
    engine: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    runs: Option<usize>,
    out: Option<String>,
    /// A saved run to follow up on with re-reviews.
    from: Option<String>,
    /// Re-review the whole diff, not only what changed since.
    whole: bool,
}

fn parse_run_options(args: &[String]) -> Result<RunOptions, String> {
    let mut options = RunOptions::default();
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        if flag == "--whole" {
            options.whole = true;
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| format!("{flag} needs a value\n\n{USAGE}"))?
            .clone();
        match flag.as_str() {
            "--repo" => options.repo = Some(value),
            "--pr" => options.pr = Some(value),
            "--base" => options.base = Some(value),
            "--compare" => options.compare = Some(value),
            "--engine" => options.engine = Some(value),
            "--model" => options.model = Some(value),
            "--effort" => options.effort = Some(value),
            "--runs" => {
                options.runs = Some(
                    value
                        .parse()
                        .map_err(|_| format!("--runs takes a number, not {value}"))?,
                )
            }
            "--out" => options.out = Some(value),
            "--from" => options.from = Some(value),
            _ => return Err(format!("unknown option {flag}\n\n{USAGE}")),
        }
    }
    Ok(options)
}

fn run(args: &[String]) -> Result<(), String> {
    let options = parse_run_options(args)?;
    let from: Option<BenchRun> = options
        .from
        .as_deref()
        .map(|path| {
            let text = fs::read_to_string(path).map_err(|error| format!("{path}: {error}"))?;
            serde_json::from_str(&text).map_err(|error| format!("{path}: {error}"))
        })
        .transpose()?;
    if options.whole && from.is_none() {
        return Err(format!(
            "--whole re-reviews a run given with --from\n\n{USAGE}"
        ));
    }
    let repo = PathBuf::from(
        options
            .repo
            .ok_or_else(|| format!("--repo is required\n\n{USAGE}"))?,
    );
    let pr: Option<PrContext> = options
        .pr
        .as_deref()
        .map(|url| github::read_pr_context(&repo, url))
        .transpose()
        .map_err(|error| error.to_string())?;
    let base = options
        .base
        .or_else(|| {
            pr.as_ref()
                .map(|pr| format!("{}/{}", pr.base_remote, pr.base_ref))
        })
        .or_else(|| from.as_ref().map(|run| run.base.clone()))
        .ok_or_else(|| format!("--base or --pr is required\n\n{USAGE}"))?;
    let compare = options
        .compare
        .or_else(|| pr.as_ref().map(|pr| pr.compare_ref.clone()))
        .or_else(|| from.as_ref().map(|run| run.compare.clone()))
        .ok_or_else(|| format!("--compare or --pr is required\n\n{USAGE}"))?;
    // What a re-review follows up on: the saved run, as the app would keep it.
    let prior = from.as_ref().map(|run| PriorReview {
        summary: run.summary.clone(),
        findings: run.findings.clone(),
        set_aside: run
            .withdrawn
            .iter()
            .map(|withdrawn| SetAsideFinding {
                finding: withdrawn.finding.clone(),
                why: "withdrawn".to_owned(),
                note: withdrawn.reason.clone(),
            })
            .collect(),
        head: run.head.clone(),
    });
    let kind = match (&prior, options.whole) {
        (None, _) => "review",
        (Some(_), false) => "re-review",
        (Some(_), true) => "full re-review",
    };
    let summary = git::diff_branches(&repo, &base, Some(&compare)).map_err(|error| {
        format!("{error}\n\nA PR's commits must be local: open it in the app first, or fetch them.")
    })?;
    let engine = options.engine.unwrap_or_else(|| "claude".to_owned());
    let rules_file = dirs::config_dir()
        .ok_or("could not find the app's config folder")?
        .join("com.tkempf.tk-review/repo-rules.json");
    let rules = rules::load(&rules_file, &repo)
        .map_err(|error| error.to_string())?
        .rules;
    let out = PathBuf::from(options.out.unwrap_or_else(|| "bench".to_owned()));
    fs::create_dir_all(&out).map_err(|error| format!("{}: {error}", out.display()))?;

    let first = next_run_number(&out);
    let runs = options.runs.unwrap_or(3);
    let agents = AgentRuns::default();
    for number in first..first + runs {
        eprintln!(
            "run {number}: {kind} of {base}...{compare} with {engine}, {} files",
            summary.files.len()
        );
        let agent_run = agents.start(format!("bench-{number}"), || {});
        let started = Instant::now();
        let record = |seconds: u64| BenchRun {
            kind: kind.to_owned(),
            engine: engine.clone(),
            model: options.model.clone(),
            effort: options.effort.clone(),
            base: base.clone(),
            compare: compare.clone(),
            merge_base: summary.merge_base.clone(),
            head: summary.compare_head.clone(),
            seconds,
            summary: String::new(),
            verdict: String::new(),
            findings: Vec::new(),
            withdrawn: Vec::new(),
            cut_short: false,
            check_failure: None,
            resolutions: Vec::new(),
            outside: Vec::new(),
        };
        let outcome: Result<BenchRun, GitError> = match &prior {
            None => review::review_diff(
                &repo,
                &summary.merge_base,
                Some(&compare),
                &engine,
                options.model.as_deref(),
                options.effort.as_deref(),
                pr.as_ref(),
                &rules,
                &agent_run,
            )
            .map(|result| BenchRun {
                summary: result.summary,
                verdict: result.verdict,
                findings: result.findings,
                withdrawn: result.withdrawn,
                cut_short: result.cut_short,
                check_failure: result.check_failure,
                ..record(started.elapsed().as_secs())
            }),
            Some(prior) => review::re_review_diff(
                &repo,
                &summary.merge_base,
                Some(&compare),
                &engine,
                options.model.as_deref(),
                options.effort.as_deref(),
                prior,
                options.whole,
                pr.as_ref(),
                &rules,
                &agent_run,
            )
            .map(|result| BenchRun {
                summary: result.summary,
                verdict: result.verdict,
                findings: result.findings,
                withdrawn: result.withdrawn,
                cut_short: result.cut_short,
                check_failure: result.check_failure,
                resolutions: result.resolutions,
                outside: result.outside,
                ..record(started.elapsed().as_secs())
            }),
        };
        let seconds = started.elapsed().as_secs();
        match outcome {
            Ok(record) => {
                let path = out.join(format!("run-{number}.json"));
                let json = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
                fs::write(&path, json).map_err(|error| format!("{}: {error}", path.display()))?;
                eprintln!(
                    "run {number}: {} findings, {} outside, {} withdrawn, {}",
                    record.findings.len(),
                    record.outside.len(),
                    record.withdrawn.len(),
                    minutes(seconds)
                );
            }
            Err(error) => {
                let path = out.join(format!("run-{number}.error.txt"));
                let _ = fs::write(
                    &path,
                    format!("{error}\n\n{}", error.detail().unwrap_or("")),
                );
                eprintln!("run {number}: failed after {}: {error}", minutes(seconds));
            }
        }
    }
    report(&[out.display().to_string()])
}

/// The number the next run in `out` gets, after any it already holds.
fn next_run_number(out: &Path) -> usize {
    let Ok(entries) = fs::read_dir(out) else {
        return 1;
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let rest = name.strip_prefix("run-")?;
            rest.split('.').next()?.parse::<usize>().ok()
        })
        .max()
        .map_or(1, |last| last + 1)
}

fn minutes(seconds: u64) -> String {
    format!("{}m{:02}s", seconds / 60, seconds % 60)
}

fn report(dirs: &[String]) -> Result<(), String> {
    for dir in dirs {
        let dir = Path::new(dir);
        let runs = load_runs(dir)?;
        if runs.is_empty() {
            eprintln!("{}: no runs yet", dir.display());
            continue;
        }
        let text = render_report(dir, &runs);
        println!("{text}");
        let path = dir.join("report.md");
        fs::write(&path, &text).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    Ok(())
}

/// The runs kept in `dir`, in the order they ran.
fn load_runs(dir: &Path) -> Result<Vec<(usize, BenchRun)>, String> {
    let entries = fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let mut runs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(number) = name
            .strip_prefix("run-")
            .and_then(|rest| rest.strip_suffix(".json"))
            .and_then(|number| number.parse::<usize>().ok())
        else {
            continue;
        };
        let text = fs::read_to_string(entry.path()).map_err(|error| format!("{name}: {error}"))?;
        let run: BenchRun =
            serde_json::from_str(&text).map_err(|error| format!("{name}: {error}"))?;
        runs.push((number, run));
    }
    runs.sort_by_key(|(number, _)| *number);
    Ok(runs)
}

/// One problem as the runs reported it: which runs found it, and the finding
/// each wrote. A run appears at most once.
#[derive(Debug)]
struct Issue<'a> {
    found: Vec<(usize, &'a ReviewFinding)>,
}

/// The span a finding points at, or `None` for the whole file.
fn span(finding: &ReviewFinding) -> Option<(u32, u32)> {
    let start = finding.line?;
    Some((start, finding.end_line.unwrap_or(start).max(start)))
}

/// Whether two findings, from different runs, are about the same problem: the
/// same file, and lines within `LINE_SLACK` of each other, or both about the
/// file as a whole. Wording isn't compared, since runs word one problem every
/// which way, so two problems on neighbouring lines can count as one.
fn same_problem(a: &ReviewFinding, b: &ReviewFinding) -> bool {
    if a.path != b.path {
        return false;
    }
    match (span(a), span(b)) {
        (None, None) => true,
        (Some((a_start, a_end)), Some((b_start, b_end))) => {
            a_start <= b_end + LINE_SLACK && b_start <= a_end + LINE_SLACK
        }
        _ => false,
    }
}

/// Groups the runs' findings into problems: each finding joins the first
/// problem already holding a match from another run, or starts its own.
fn group_issues<'a>(runs: &[(usize, &'a [ReviewFinding])]) -> Vec<Issue<'a>> {
    let mut issues: Vec<Issue> = Vec::new();
    for (run, findings) in runs {
        for finding in *findings {
            let existing = issues.iter_mut().find(|issue| {
                issue.found.iter().all(|(other, _)| other != run)
                    && issue
                        .found
                        .iter()
                        .any(|(_, other)| same_problem(finding, other))
            });
            match existing {
                Some(issue) => issue.found.push((*run, finding)),
                None => issues.push(Issue {
                    found: vec![(*run, finding)],
                }),
            }
        }
    }
    issues
}

/// How alike two runs' findings are: the problems both found, over the
/// problems either did. 1 for two runs that found nothing.
fn overlap(issues: &[Issue], a: usize, b: usize) -> f64 {
    let has = |issue: &Issue, run: usize| issue.found.iter().any(|(other, _)| *other == run);
    let both = issues
        .iter()
        .filter(|issue| has(issue, a) && has(issue, b))
        .count();
    let either = issues
        .iter()
        .filter(|issue| has(issue, a) || has(issue, b))
        .count();
    if either == 0 {
        1.0
    } else {
        both as f64 / either as f64
    }
}

/// The mean overlap over every pair of runs; `None` with fewer than two.
fn mean_overlap(issues: &[Issue], runs: &[usize]) -> Option<f64> {
    let mut total = 0.0;
    let mut pairs = 0;
    for (i, a) in runs.iter().enumerate() {
        for b in &runs[i + 1..] {
            total += overlap(issues, *a, *b);
            pairs += 1;
        }
    }
    (pairs > 0).then(|| total / pairs as f64)
}

const SEVERITIES: [&str; 4] = ["critical", "warning", "suggestion", "nit"];

fn render_report(dir: &Path, runs: &[(usize, BenchRun)]) -> String {
    let mut text = format!("# {}\n\n", dir.display());
    let first = &runs[0].1;
    text.push_str(&format!(
        "{} {} on `{}...{}`, model {}, effort {}.\n\n",
        first.engine,
        first.kind,
        first.base,
        first.compare,
        first.model.as_deref().unwrap_or("default"),
        first.effort.as_deref().unwrap_or("default"),
    ));

    // A re-review also says what it made of the findings it followed up on,
    // and how many new ones fell outside what changed.
    let follow_up = runs.iter().any(|(_, run)| run.kind != "review");
    text.push_str(
        "| Run | Time | Findings | Critical | Warning | Suggestion | Nit | Withdrawn | Verdict |",
    );
    text.push_str(if follow_up {
        " Outside | Verdicts |\n"
    } else {
        "\n"
    });
    text.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    text.push_str(if follow_up { " --- | --- |\n" } else { "\n" });
    for (number, run) in runs {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for finding in &run.findings {
            let severity = finding.severity.to_ascii_lowercase();
            let key = SEVERITIES.iter().find(|known| **known == severity).copied();
            *counts.entry(key.unwrap_or("other")).or_default() += 1;
        }
        let notes = [
            run.cut_short.then_some("cut short"),
            run.check_failure.as_ref().map(|_| "unchecked"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ");
        text.push_str(&format!(
            "| {number} | {}{} | {} | {} | {} | {} | {} | {} | {} |",
            minutes(run.seconds),
            if notes.is_empty() {
                String::new()
            } else {
                format!(" ({notes})")
            },
            run.findings.len(),
            counts.get("critical").unwrap_or(&0),
            counts.get("warning").unwrap_or(&0),
            counts.get("suggestion").unwrap_or(&0),
            counts.get("nit").unwrap_or(&0),
            run.withdrawn.len(),
            run.verdict,
        ));
        if follow_up {
            let mut verdicts: BTreeMap<String, usize> = BTreeMap::new();
            for resolution in &run.resolutions {
                *verdicts
                    .entry(resolution.status.to_ascii_lowercase())
                    .or_default() += 1;
            }
            let verdicts = verdicts
                .iter()
                .map(|(status, count)| format!("{count} {status}"))
                .collect::<Vec<_>>()
                .join(", ");
            text.push_str(&format!(" {} | {verdicts} |", run.outside.len()));
        }
        text.push('\n');
    }

    let numbers: Vec<usize> = runs.iter().map(|(number, _)| *number).collect();
    let findings: Vec<(usize, &[ReviewFinding])> = runs
        .iter()
        .map(|(number, run)| (*number, run.findings.as_slice()))
        .collect();
    let mut issues = group_issues(&findings);
    issues.sort_by_key(|issue| std::cmp::Reverse(issue.found.len()));
    let in_all = issues
        .iter()
        .filter(|issue| issue.found.len() == runs.len())
        .count();
    let in_one = issues.iter().filter(|issue| issue.found.len() == 1).count();
    text.push_str(&format!(
        "\n{} distinct problems: {in_all} found by every run, {in_one} by only one.",
        issues.len()
    ));
    if let Some(mean) = mean_overlap(&issues, &numbers) {
        text.push_str(&format!(
            " Runs agree on {:.0}% of what they find, on average (problems both found, over problems either found, for each pair of runs).",
            mean * 100.0
        ));
    }
    text.push_str(&format!(
        "\n\nFindings count as the same problem when they're on the same file within {LINE_SLACK} lines of each other, so read the list below for the real picture.\n\n"
    ));

    text.push_str("| Found by | Severity | Where | Title | Worth fixing? |\n");
    text.push_str("| --- | --- | --- | --- | --- |\n");
    for issue in &issues {
        let (_, finding) = issue.found[0];
        let mut severities: Vec<String> = issue
            .found
            .iter()
            .map(|(_, finding)| finding.severity.to_ascii_lowercase())
            .collect();
        severities.dedup();
        let at = match span(finding) {
            Some((start, end)) if end > start => format!("{}:{start}-{end}", finding.path),
            Some((start, _)) => format!("{}:{start}", finding.path),
            None => finding.path.clone(),
        };
        text.push_str(&format!(
            "| {}/{} | {} | `{at}` | {} | |\n",
            issue.found.len(),
            runs.len(),
            severities.join(", "),
            finding.title.replace('|', "\\|"),
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(path: &str, line: Option<u32>, end_line: Option<u32>) -> ReviewFinding {
        ReviewFinding {
            path: path.to_owned(),
            line,
            end_line,
            severity: "warning".to_owned(),
            title: format!("{path}:{line:?}"),
            body: String::new(),
            reviewers: Vec::new(),
            posted_url: None,
            failure: String::new(),
            fix: String::new(),
        }
    }

    #[test]
    fn findings_on_nearby_lines_of_one_file_are_one_problem() {
        let a = finding("src/a.rs", Some(10), None);
        assert!(same_problem(&a, &finding("src/a.rs", Some(12), None)));
        assert!(same_problem(&a, &finding("src/a.rs", Some(1), Some(8))));
        assert!(!same_problem(&a, &finding("src/a.rs", Some(20), None)));
        assert!(!same_problem(&a, &finding("src/b.rs", Some(10), None)));
        assert!(!same_problem(&a, &finding("src/a.rs", None, None)));
        assert!(same_problem(
            &finding("src/a.rs", None, None),
            &finding("src/a.rs", None, None)
        ));
    }

    #[test]
    fn runs_are_compared_by_the_problems_they_share() {
        let one = [finding("a", Some(1), None), finding("b", Some(1), None)];
        let two = [finding("a", Some(2), None), finding("c", Some(1), None)];
        let three = [finding("a", Some(40), None)];
        let issues = group_issues(&[(1, &one), (2, &two), (3, &three)]);
        // a:1 and a:2 are one problem; a:40, b, and c are each their own.
        assert_eq!(issues.len(), 4);
        assert_eq!(issues[0].found.len(), 2);
        // Runs 1 and 2 share one of the three problems between them.
        assert!((overlap(&issues, 1, 2) - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(overlap(&issues, 1, 3), 0.0);
    }

    #[test]
    fn a_run_counts_once_toward_a_problem() {
        // Two findings of one run on neighbouring lines stay two problems.
        let one = [finding("a", Some(1), None), finding("a", Some(2), None)];
        let two = [finding("a", Some(1), None)];
        let issues = group_issues(&[(1, &one), (2, &two)]);
        assert_eq!(issues.len(), 2);
        assert_eq!(mean_overlap(&issues, &[1, 2]), Some(0.5));
    }

    #[test]
    fn two_runs_that_find_nothing_agree() {
        let issues = group_issues(&[(1, &[]), (2, &[])]);
        assert_eq!(mean_overlap(&issues, &[1, 2]), Some(1.0));
        assert_eq!(mean_overlap(&issues, &[1]), None);
    }
}
