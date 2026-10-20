//! Specialist reviewers: subagents a claude review hands parts of a diff to.
//!
//! A general review spreads its attention across everything a diff touches,
//! and the problems that cost the most usually take one kind of expertise to
//! see: a lock on a busy table, a texture nobody disposes, a resolver reading
//! through a pool that skips row-level security. Each specialist owns one of
//! those areas. It picks the files of a diff in its area, and carries a
//! checklist of how changes there have gone wrong in practice, along with the
//! rules the person running the review keeps for it on this repository.
//!
//! A claude review is told to launch every specialist that picked something,
//! all at once, and to merge what they report into its own findings, naming on
//! each finding who raised it. Codex takes no subagent definitions, so a codex
//! review gets the same checklists in its own prompt.

use std::collections::HashSet;

use serde::Serialize;

use crate::review::{insert_before_diff, ReviewFinding};
use crate::rules::RepoRules;

/// One specialist: what it reviews, how it picks its files, and what it is
/// told.
pub struct Specialist {
    /// Its rules' key in the repository's rules.
    pub key: &'static str,
    /// The `subagent_type` it is launched as, and its key in `--agents`.
    pub name: &'static str,
    /// What the app calls it, on findings and in the rules dialog.
    pub label: &'static str,
    /// What it reviews, in a sentence: the lead reviewer's list, and the
    /// subagent's description.
    summary: &'static str,
    /// When a review launches it, for the rules dialog.
    launches: &'static str,
    /// An example rule, for the rules dialog.
    placeholder: &'static str,
    /// Who it is, to finish "You are …".
    role: &'static str,
    /// Why its area gets a specialist at all.
    stakes: &'static str,
    /// What to read in the repository before judging, beyond its rules.
    preparation: &'static str,
    /// Where to look for history on what it reviews.
    history: &'static str,
    /// How changes in its area go wrong, and how to weigh what it finds.
    checklist: &'static str,
    /// Agentic turns it gets: its own, not the main run's, since a subagent's
    /// turns don't count against the session's `--max-turns`.
    turns: usize,
    /// Whether a file's change is in its area.
    picks: fn(&FileChange) -> bool,
}

/// The name the lead reviewer goes by in a finding's `reviewers`.
pub const LEAD: &str = "lead";

/// What the app calls the lead reviewer.
const LEAD_LABEL: &str = "Lead";

/// Every specialist, in the order the app lists them.
pub static SPECIALISTS: &[Specialist] = &[
    Specialist {
        key: "migrations",
        name: "migration-reviewer",
        label: "Migrations",
        summary: "Reviews database migrations for what fails in production: locks on busy tables, deploys that fail halfway, breakage for pods still running the old code, and data loss.",
        launches: "When a diff changes files under a `migrations`, `migration`, or `migrate` directory.",
        placeholder: "e.g. orders has 80M rows: any lock on it needs a lock_timeout.",
        role: "a database specialist reviewing the migrations in a pull request",
        stakes: "A bad migration fails in production rather than in tests: it locks a busy table and stalls the app, fails a deploy halfway, breaks the pods still running the old code, or loses data.",
        preparation: "Read a few of the newest migrations beside these, so you hold these to the repository's conventions. Search the codebase for every table and column they touch, so you know what the running code expects.",
        history: "Run `git log --oneline -S '<table>' -- <the migrations directory>` for each table these touch, for earlier migrations on it that were reverted, fixed, or followed by a fix. In Linear or Slack, search the table's name alongside words like migration, lock, outage, deadlock, or timeout.",
        checklist: include_str!("specialists/migrations.md"),
        turns: 50,
        picks: |file| file.is_migration() || file.is_schema_dump(),
    },
    Specialist {
        key: "security",
        name: "security-reviewer",
        label: "Security",
        summary: "Reviews code for who can do what: missing authentication and authorization checks, data from one tenant reaching another, trust in what the client sends, injection, and secrets or personal data leaking.",
        launches: "When a diff changes server code, or browser code that handles markup, credentials, storage, redirects, or messages from other windows.",
        placeholder: "e.g. The admin pool skips row-level security, so every read through it must check membership first.",
        role: "an application security specialist reviewing a pull request",
        stakes: "Security holes pass every test, because tests exercise what a legitimate user does. They surface later as a pentest finding, a customer's data in another customer's account, or an incident.",
        preparation: "Find how this repository authenticates a request and authorizes access: the middleware, the helpers every handler is expected to call, and which database connections or clients bypass those checks. Then trace each changed entry point from the request to the data it reads or writes.",
        history: "Run `git log` on the files you review, for earlier security fixes to the same code. In Linear or Slack, search for words like security, pentest, permission, authorization, leak, or vulnerability alongside the feature's name.",
        checklist: include_str!("specialists/security.md"),
        turns: 40,
        // Browser code only where it touches what an attacker can reach: a
        // layout or styling change has nothing for this review to find.
        picks: |file| {
            file.is_code()
                && !file.is_test()
                && !file.is_migration()
                && (!file.is_frontend() || file.mentions(SECURITY_TERMS))
        },
    },
    Specialist {
        key: "runtime",
        name: "runtime-reviewer",
        label: "Backend runtime",
        summary: "Reviews server code for how it behaves under production load and failure: connections held during slow work, side effects inside transactions, retries and idempotency, timeouts that don't stop anything, and memory.",
        launches: "When a diff changes server code that deals with transactions, pools, queues, jobs, retries, timeouts, storage, or outside services.",
        placeholder: "e.g. Never await a network call inside transact(): it holds a pooled connection and its locks.",
        role: "a backend reliability specialist reviewing a pull request",
        stakes: "These problems don't show in tests or on a quiet staging server. They show under production load, during a provider's outage, or on the second attempt of a job, as crash loops, stalled pools, double charges, and work that never finishes.",
        preparation: "Find how this repository runs work outside a request: its job queues and workers, its database pools and transaction helpers, and the clients it uses for outside services. Read the helpers the changed code calls rather than assuming what they do.",
        history: "Run `git log` on the files you review, for earlier fixes to the same code. In Linear or Slack, search for words like incident, outage, crash loop, timeout, retry, or stuck alongside the worker's or service's name.",
        checklist: include_str!("specialists/runtime.md"),
        turns: 40,
        picks: |file| {
            file.is_code()
                && !file.is_test()
                && !file.is_migration()
                && !file.is_frontend()
                && file.mentions(RUNTIME_TERMS)
        },
    },
    Specialist {
        key: "graphql",
        name: "graphql-reviewer",
        label: "GraphQL",
        summary: "Reviews GraphQL schemas, resolvers, and client operations for breaking changes to clients already deployed, query cost, pagination, error handling, and the client cache.",
        launches: "When a diff changes GraphQL schemas, documents, resolvers, or client code that uses a GraphQL client.",
        placeholder: "e.g. Only persisted queries reach production, so a changed fragment needs the API deployed first.",
        role: "a GraphQL specialist reviewing a pull request",
        stakes: "A GraphQL change breaks clients that are already running, which tests built from the new code never are: open tabs on an old bundle, older app or plugin versions, and integrations. A resolver that is fine for one row can be quadratic for a large tenant.",
        preparation: "Find how this repository builds its schema (generated from the database, code-first, or schema-first), where its client documents and generated types live, and how the client caches results. Read the committed schema's diff, if there is one, alongside the code.",
        history: "Run `git log` on the files you review, for earlier fixes to the same resolvers or operations. In Linear or Slack, search for words like GraphQL, resolver, timeout, N+1, or the operation's name.",
        checklist: include_str!("specialists/graphql.md"),
        turns: 40,
        picks: |file| {
            // A generated schema still shows the API the change adds.
            !file.is_test()
                && !file.is_migration()
                && (matches!(file.extension().as_str(), "graphql" | "gql")
                    || (file.is_code()
                        && (file.in_dir(&["graphql", "resolvers", "postgraphile"])
                            || file.mentions(GRAPHQL_TERMS))))
        },
    },
    Specialist {
        key: "rollout",
        name: "rollout-reviewer",
        label: "Rollout",
        summary: "Reviews a change for what happens while it rolls out and if it is rolled back: old code against the new schema or API, new code against the old, clients and jobs already in flight, and stored data in the old shape.",
        launches: "When a diff changes a contract between things that deploy separately: migrations, API schemas and operations, job payloads, stored client state, or routes.",
        placeholder: "e.g. Prod can roll back to either of the last two releases, so both must work against this schema.",
        role: "a deployment specialist reviewing a pull request",
        stakes: "Every release runs side by side with the one before it for a while, and some clients never reload. A change that works once everything is on the new version can still break the old pods, the open tabs, the queued jobs, or the rollback.",
        preparation: "Find how this repository deploys: what runs migrations and when, which services start on the new code before or after them, how clients pick up a new release, and what a rollback reverts. Then list what this change asks the old and new versions of each side to agree on.",
        history: "Run `git log` on the files you review, for earlier fixes to the same contract. In Linear or Slack, search for words like deploy, rollback, release, outdated client, or breaking change.",
        checklist: include_str!("specialists/rollout.md"),
        turns: 30,
        picks: |file| {
            file.is_migration()
                || (!file.is_test()
                    && (matches!(file.extension().as_str(), "graphql" | "gql" | "proto")
                        || ["openapi", "swagger"]
                            .iter()
                            .any(|name| file.name().contains(name))
                        || (file.is_code() && file.mentions(ROLLOUT_TERMS))))
        },
    },
    Specialist {
        key: "frontend",
        name: "frontend-reviewer",
        label: "Frontend platform",
        summary: "Reviews browser code for what differs between browsers and devices, what users with assistive technology meet, bundle size and code splitting, layout and rendering cost, and browser APIs used with their limits.",
        launches: "When a diff changes markup, styles, components, bundler or browser-support config, or scripts that use browser APIs.",
        placeholder: "e.g. iPad Safari 16 is the oldest browser we support.",
        role: "a web platform specialist reviewing a pull request",
        stakes: "Browser problems pass every test that runs in one desktop Chromium. They show up on a customer's iPad, behind a screen reader, on a slow connection, or after a deploy, when an open tab asks for a chunk that no longer exists.",
        preparation: "Find which browsers and hosts this app supports (browserslist, the bundler's build target, docs, device test configs, and any desktop or plugin shells that embed it), how it is bundled and split, and its design system and styling approach.",
        history: "Run `git log` on the files you review, for earlier fixes to the same code. In Linear or Slack, search for words like Safari, iPad, iOS, Firefox, browser, accessibility, or bundle size alongside the feature's name.",
        checklist: include_str!("specialists/frontend.md"),
        turns: 30,
        picks: |file| {
            !file.is_test()
                && !file.is_generated()
                && (file.is_ui()
                    || BROWSER_CONFIG
                        .iter()
                        .any(|name| file.name().starts_with(name))
                    || (file.is_script() && !file.is_backend() && file.mentions(BROWSER_TERMS)))
        },
    },
    Specialist {
        key: "react",
        name: "react-reviewer",
        label: "React",
        summary: "Reviews React code for render loops and storms, effects and their cleanup, stale state and closures, state that should be derived, keys, error boundaries, and data-fetching cache updates.",
        launches: "When a diff changes `.tsx` or `.jsx` files, hooks, or scripts that use React or a React state library.",
        placeholder: "e.g. Read store state with getState() in event handlers rather than subscribing.",
        role: "a React specialist reviewing a pull request",
        stakes: "React bugs rarely fail a test. They freeze a tab in a render loop, leak subscriptions until the app slows to a crawl, run an action twice, or show stale data, usually on the path nobody clicked in review.",
        preparation: "Find which React version this app runs and whether the React Compiler is on, its state libraries and data-fetching client, and its conventions for hooks and components. Read the hooks and stores the changed components call rather than assuming what they return.",
        history: "Run `git log` on the files you review, for earlier fixes to the same components. In Linear or Slack, search for words like rerender, infinite loop, freeze, stale, or flicker alongside the feature's name.",
        checklist: include_str!("specialists/react.md"),
        turns: 30,
        picks: |file| {
            !file.is_test()
                && !file.is_generated()
                && (matches!(file.extension().as_str(), "tsx" | "jsx")
                    || (file.is_script() && (file.is_hook() || file.mentions(REACT_TERMS))))
        },
    },
    Specialist {
        key: "graphics",
        name: "graphics-reviewer",
        label: "Graphics",
        summary: "Reviews WebGL, three.js, react-three-fiber, shader, and canvas code for GPU memory and disposal, context loss, device limits, per-frame cost, the render loop, and colour, alpha, and precision.",
        launches: "When a diff changes shaders, or code that uses three.js, react-three-fiber, WebGL, render targets, textures, or canvases.",
        placeholder: "e.g. The canvas renders on demand, so every imperative change must call invalidate().",
        role: "a real-time graphics specialist reviewing a pull request",
        stakes: "Graphics bugs depend on the device. A leak that a desktop GPU absorbs for hours crashes an iPad in minutes, a shader that is exact on one GPU bands on another, and a render loop that never settles drains the battery while the page sits idle.",
        preparation: "Find how this app renders: its canvases and renderers, whether frames render continuously or on demand, its colour management, and its helpers for textures, render targets, disposal, and memory budgets. Read the materials and shaders the changed code uses.",
        history: "Run `git log` on the files you review, for earlier fixes to the same code. In Linear or Slack, search for words like WebGL, context lost, GPU, memory, texture, shader, or iPad crash.",
        checklist: include_str!("specialists/graphics.md"),
        turns: 30,
        picks: |file| {
            !file.is_test()
                && !file.is_generated()
                && !file.is_backend()
                && (SHADER_EXTENSIONS.contains(&file.extension().as_str())
                    || file.in_dir(&["glsl", "shader", "shaders"])
                    || ((file.is_script() || file.is_ui()) && file.mentions(GRAPHICS_TERMS)))
        },
    },
    Specialist {
        key: "billing",
        name: "billing-reviewer",
        label: "Billing",
        summary: "Reviews code that charges, credits, refunds, meters usage, or enforces plan limits, for charging twice or not at all, races on balances, refunds that miss, and limits enforced only on the client.",
        launches: "When a diff changes code or migrations that deal with billing, payments, credits, refunds, quotas, usage, or pricing.",
        placeholder: "e.g. Every paid operation goes through wrapUsage, which charges and refunds.",
        role: "a billing specialist reviewing a pull request",
        stakes: "Billing bugs cost money directly, in one direction or the other, and customers find them before monitoring does. They hide in retries, failure paths, and races between two requests, which tests rarely exercise.",
        preparation: "Find how this repository charges and refunds: the helpers every paid operation goes through, where balances and usage are stored, how plans and limits are looked up, and what the payment provider's webhooks update. Read those helpers rather than assuming what they do.",
        history: "Run `git log` on the files you review, for earlier fixes to the same code. In Linear or Slack, search for words like billing, credits, refund, charged, overcharge, or plan limit.",
        checklist: include_str!("specialists/billing.md"),
        turns: 30,
        picks: |file| file.is_code() && !file.is_test() && file.mentions(BILLING_TERMS),
    },
    Specialist {
        key: "analytics",
        name: "analytics-reviewer",
        label: "Analytics",
        summary: "Reviews analytics and tracking events for events that fire twice or never, fields whose meaning changes under existing dashboards, schemas and registries left out of step, and personal data sent where it shouldn't go.",
        launches: "When a diff changes code that emits or defines analytics, tracking, or telemetry events.",
        placeholder: "e.g. Every event is declared in the tracking schema and documented in docs/tracking_events.md.",
        role: "an analytics specialist reviewing a pull request",
        stakes: "A broken event doesn't fail anything users see. It quietly corrupts the dashboards and decisions built on it, and by the time someone notices, the data from the weeks in between can't be fixed.",
        preparation: "Find how this repository defines and sends events: its event schemas or registry, the helpers that emit them, where they are documented, and any checklist for changing them.",
        history: "Run `git log` on the files you review, for earlier fixes to the same events. In Linear or Slack, search for the event's name, or words like analytics, tracking, or dashboard.",
        checklist: include_str!("specialists/analytics.md"),
        turns: 20,
        picks: |file| file.is_code() && !file.is_test() && file.mentions(ANALYTICS_TERMS),
    },
    Specialist {
        key: "architecture",
        name: "architecture-reviewer",
        label: "Architecture",
        summary: "Reviews whether each fix is made where its problem starts: workarounds that hide a symptom while the cause stays reachable, such as errors swallowed, races papered over with delays, special cases for one input, data corrected downstream of where it goes wrong, and fixes in the wrong layer.",
        launches: "When a diff changes source code, tests, or migrations.",
        placeholder: "e.g. Data problems are fixed in the resolver or the migration, never patched over in the client.",
        role: "a software architect reviewing a pull request for fixes made in the wrong place",
        stakes: "A workaround passes its tests, because they were written for the symptom it hides. The cause stays, and comes back on the next path that reaches it, or as a second workaround on top of the first, until nobody can say why the code works.",
        preparation: "Work out what the change is for before judging it. Then, for each fix it makes, read upstream from the symptom to the code where the problem starts, and search for the other code that reaches the same cause.",
        history: "Run `git log` on the files you review, and `git log -S` on the workaround's shape, for earlier patches to the same symptom. In Linear or Slack, search the symptom alongside words like workaround, hack, regression, or root cause.",
        checklist: include_str!("specialists/architecture.md"),
        turns: 40,
        picks: |file| file.is_code(),
    },
    Specialist {
        key: "maintainability",
        name: "maintainability-reviewer",
        label: "Maintainability",
        summary: "Reviews code for what will cost the next developer: duplicates of helpers that already exist, misleading names and comments, tests that can't fail, and broken module boundaries. Simplifications and cleanups only when the repository's rules ask for them.",
        launches: "When a diff changes source code or tests.",
        placeholder: "e.g. Comments explain why, never what; remove comments addressed to the reviewer.",
        role: "a maintainability specialist reviewing a pull request",
        stakes: "Code is read far more often than it is written, and this kind of cost compounds: a second copy of a helper drifts from the first, a name that lies sends the next change the wrong way, and a test that can't fail lets the bug it was written for come back.",
        preparation: "Learn how the code around the change is organised and named. Before you call anything a duplicate, search the repository for the helper, constant, type, or component it repeats, and note its path.",
        history: "Run `git log` on the files you review where it shows how the code around the change came to be the way it is, or that the same cleanup was asked for before.",
        checklist: include_str!("specialists/maintainability.md"),
        turns: 30,
        picks: |file| file.is_code() && !file.is_migration(),
    },
];

/// Words in changed server code that put it in the runtime reviewer's area.
const RUNTIME_TERMS: &[&str] = &[
    "transact",
    "transaction",
    "savepoint",
    "commit",
    "rollback",
    "pool",
    "connect(",
    ".query(",
    "queue",
    "worker",
    "job",
    "cron",
    "schedule",
    "retry",
    "retries",
    "backoff",
    "timeout",
    "deadline",
    "abortcontroller",
    "abortsignal",
    "lock",
    "mutex",
    "semaphore",
    "idempot",
    "webhook",
    "upload",
    "download",
    "bucket",
    "storage",
    "stream",
    "buffer",
    "spawn",
    "child_process",
    "process.exit",
    "unhandledrejection",
    "fetch(",
    "axios",
    "redis",
    "bullmq",
    "graphile",
    "notify",
    "listen(",
    "sharp",
];

/// Words in changed code that put it in the GraphQL reviewer's area.
const GRAPHQL_TERMS: &[&str] = &[
    "graphql",
    "gql`",
    "gql(",
    "makeextendschemaplugin",
    "makewrapresolversplugin",
    "postgraphile",
    "resolver",
    "urql",
    "graphcache",
    "apollo",
    "usequery(",
    "usemutation(",
    "usesubscription(",
    "typedefs",
    "smarttags",
    "@omit",
];

/// Words in changed code that mean it touches a contract between things that
/// deploy separately.
const ROLLOUT_TERMS: &[&str] = &[
    "enqueue",
    "addjob",
    "queue.add",
    "payload",
    "@deprecated",
    "deprecat",
    "localstorage",
    "sessionstorage",
    "indexeddb",
    "persist(",
    "enum ",
    "@get(",
    "@post(",
    "@put(",
    "@patch(",
    "@delete(",
    "router.",
    "app.get(",
    "app.post(",
    "graphql",
    "gql`",
    "featureflag",
    "feature_flag",
    "useflag",
    "useunifiedflag",
];

/// File names, by their start, of the config that decides how browser code is
/// built and which browsers it targets.
const BROWSER_CONFIG: &[&str] = &[
    ".browserslistrc",
    "browserslist",
    "vite.config",
    "webpack.config",
    "rollup.config",
    "rspack.config",
    "next.config",
    "postcss.config",
    "tailwind.config",
    "babel.config",
    ".babelrc",
];

/// Words in changed scripts that mean they use the browser.
const BROWSER_TERMS: &[&str] = &[
    "document.",
    "window.",
    "navigator.",
    "localstorage",
    "sessionstorage",
    "indexeddb",
    "addeventlistener",
    "requestanimationframe",
    "resizeobserver",
    "intersectionobserver",
    "mutationobserver",
    "createimagebitmap",
    "createobjecturl",
    "crossorigin",
    "clipboard",
    "pointercapture",
    "matchmedia",
    "serviceworker",
    "new image(",
    "new worker(",
    "offscreencanvas",
    "lazy(",
];

/// Words in changed browser code that put it within an attacker's reach:
/// markup built from strings, credentials and what stores them, redirects,
/// and messages from other windows.
const SECURITY_TERMS: &[&str] = &[
    "dangerouslysetinnerhtml",
    "innerhtml",
    "outerhtml",
    "insertadjacenthtml",
    "eval(",
    "new function(",
    "postmessage",
    "window.open",
    "_blank",
    "location.href",
    "location.assign",
    "redirect",
    "sanitize",
    "dompurify",
    "token",
    "secret",
    "password",
    "credential",
    "apikey",
    "api_key",
    "auth",
    "permission",
    "cookie",
    "localstorage",
    "sessionstorage",
];

/// Words in changed scripts that mean they use React.
const REACT_TERMS: &[&str] = &[
    "from \"react\"",
    "from 'react'",
    "usestate",
    "useeffect",
    "uselayouteffect",
    "usememo",
    "usecallback",
    "useref",
    "usecontext",
    "usereducer",
    "usesyncexternalstore",
    "zustand",
    "@urql",
    "createcontext",
];

/// Extensions of shader source files.
const SHADER_EXTENSIONS: &[&str] = &["glsl", "vert", "frag", "wgsl", "hlsl", "metal"];

/// Words in changed code that mean it renders with the GPU or a canvas.
const GRAPHICS_TERMS: &[&str] = &[
    "from \"three\"",
    "from 'three'",
    "\"three/",
    "'three/",
    "three.js",
    "@react-three",
    "/* glsl */",
    "glsl`",
    "webgl",
    "gl_fragcolor",
    "gl_position",
    "gl_fragcoord",
    "sampler2d",
    "shadermaterial",
    "useframe",
    "usethree",
    "usefbo",
    "rendertarget",
    "datatexture",
    "canvastexture",
    "videotexture",
    "textureloader",
    "texture.",
    ".texture",
    "maxtexturesize",
    "bufferattribute",
    "buffergeometry",
    "getcontext(",
    "offscreencanvas",
    "uniforms",
    "fragmentshader",
    "vertexshader",
    "mipmap",
    "premultiplied",
    "colorspace",
    "invalidate()",
];

/// Words in changed code that mean it deals with money or limits.
const BILLING_TERMS: &[&str] = &[
    "billing",
    "invoice",
    "stripe",
    "refund",
    "payment",
    "credit",
    "quota",
    "entitlement",
    "pricing",
    "wrapusage",
    "usagedata",
    "charge",
    "metered",
    "subscriptionplan",
];

/// Words in changed code that mean it emits or defines analytics events.
const ANALYTICS_TERMS: &[&str] = &[
    "analytics",
    "telemetry",
    "trackingevent",
    "trackevent",
    "track(",
    "logevent",
    "posthog",
    "amplitude",
    "mixpanel",
    "gtag(",
    "datalayer",
    "bigquery",
];

/// Extensions of source code, beside components and scripts.
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "py", "go", "rb", "java", "kt", "scala", "cs", "php", "ex", "exs", "swift", "c", "cc",
    "cpp", "h", "hpp", "sql", "sh", "graphql", "gql", "proto",
];

/// One file's part of a patch.
pub struct FileChange<'a> {
    /// Its compare-side path, or for a deletion, the path it was deleted from.
    pub path: String,
    /// The section itself, from its `diff --git` line on.
    pub section: &'a str,
    /// Marked `linguist-generated` in the repository's gitattributes.
    pub marked_generated: bool,
}

impl FileChange<'_> {
    /// The file's own name.
    fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }

    /// Its extension, lowercased; empty when it has none.
    fn extension(&self) -> String {
        match self.name().rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() => extension.to_ascii_lowercase(),
            _ => String::new(),
        }
    }

    /// The directories it sits in, outermost first.
    fn dirs(&self) -> impl Iterator<Item = &str> {
        let mut dirs = self.path.split('/');
        dirs.next_back();
        dirs
    }

    fn in_dir(&self, names: &[&str]) -> bool {
        self.dirs()
            .any(|dir| names.iter().any(|name| dir.eq_ignore_ascii_case(name)))
    }

    /// Under a `migrations`, `migration`, or `migrate` directory: where Umzug,
    /// Knex, Prisma, Django, Flyway, Alembic, and Rails (`db/migrate`) keep them.
    fn is_migration(&self) -> bool {
        self.dirs()
            .any(|dir| matches!(dir, "migrations" | "migration" | "migrate"))
    }

    fn is_test(&self) -> bool {
        let name = self.name();
        [".test.", ".spec.", "_test.", ".stories."]
            .iter()
            .any(|marker| name.contains(marker))
            || name.starts_with("test_")
            || self.in_dir(&["__tests__", "__mocks__", "test", "tests", "e2e", "fixtures"])
    }

    /// Generated or vendored, so nobody reviews it line by line: marked so in
    /// the gitattributes, or named the way generated files usually are.
    fn is_generated(&self) -> bool {
        self.marked_generated
            || self.in_dir(&["generated", "__generated__", "vendor", "node_modules"])
            || self.name().starts_with("generated")
            || self.name().contains(".min.")
            || self.name().contains(".generated.")
    }

    /// A dump of the database's schema that migrations regenerate, such as
    /// `schema.sql`. Only the migration reviewer reads it, to compare what a
    /// migration redefines with what is there now.
    fn is_schema_dump(&self) -> bool {
        matches!(self.name(), "schema.sql" | "structure.sql" | "schema.rb")
    }

    /// Part of a server, judging by where it lives.
    fn is_backend(&self) -> bool {
        self.in_dir(&[
            "api",
            "server",
            "backend",
            "worker",
            "workers",
            "functions",
            "lambda",
            "src-tauri",
        ])
    }

    /// Markup, styles, or components.
    fn is_ui(&self) -> bool {
        matches!(
            self.extension().as_str(),
            "tsx"
                | "jsx"
                | "vue"
                | "svelte"
                | "astro"
                | "html"
                | "htm"
                | "css"
                | "scss"
                | "sass"
                | "less"
                | "styl"
        )
    }

    /// JavaScript or TypeScript that isn't a component.
    fn is_script(&self) -> bool {
        matches!(
            self.extension().as_str(),
            "ts" | "mts" | "cts" | "js" | "mjs" | "cjs"
        )
    }

    /// Source code a person wrote: what a review reads line by line.
    fn is_code(&self) -> bool {
        let extension = self.extension();
        let workflow = self.path.starts_with(".github/workflows/")
            && matches!(extension.as_str(), "yml" | "yaml");
        let code = self.is_script()
            || matches!(
                extension.as_str(),
                "tsx" | "jsx" | "vue" | "svelte" | "astro"
            )
            || SOURCE_EXTENSIONS.contains(&extension.as_str())
            || SHADER_EXTENSIONS.contains(&extension.as_str())
            || self.name() == "Dockerfile"
            || workflow;
        code && !self.is_generated() && !self.is_schema_dump()
    }

    /// A React hook's own file: `useThing.ts`.
    fn is_hook(&self) -> bool {
        self.name()
            .strip_prefix("use")
            .and_then(|rest| rest.chars().next())
            .is_some_and(|first| first.is_ascii_uppercase())
    }

    /// Part of a browser app, judging by where it lives, even when it is a
    /// plain script.
    fn is_frontend(&self) -> bool {
        self.is_ui()
            || self.is_hook()
            || self.in_dir(&[
                "web",
                "client",
                "frontend",
                "ui",
                "components",
                "pages",
                "hooks",
                "browser",
            ])
    }

    /// The lines it adds and removes, without their markers, headers, or the
    /// unchanged lines around them.
    fn changed_lines(&self) -> String {
        self.section
            .lines()
            .skip_while(|line| !line.starts_with("@@"))
            .filter_map(|line| line.strip_prefix('+').or_else(|| line.strip_prefix('-')))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Whether its changed lines mention any of `terms`. See `mentions`.
    fn mentions(&self, terms: &[&str]) -> bool {
        mentions(&self.changed_lines(), terms)
    }
}

/// Whether `text` mentions any of `terms`, each written in lowercase. A term
/// that starts with a letter or digit must start a word, which a capital in
/// camelCase does too, so `job` is found in `jobs`, `job_id`, and `addJob` but
/// not in `cronjob`, and `lock` is not found in `block`. Case is ignored
/// otherwise.
fn mentions(text: &str, terms: &[&str]) -> bool {
    // ASCII lowercasing keeps every byte where it was, so an index into the
    // lowered text is one into the original.
    let lowered = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    terms.iter().any(|term| {
        let wordlike = term
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric);
        lowered.match_indices(*term).any(|(at, _)| {
            if !wordlike || at == 0 {
                return true;
            }
            let before = bytes[at - 1];
            !before.is_ascii_alphanumeric()
                || (before.is_ascii_lowercase() && bytes[at].is_ascii_uppercase())
        })
    })
}

/// The paths a patch changes, as `file_changes` reads them.
pub fn changed_paths(patch: &str) -> Vec<String> {
    file_changes(patch, &HashSet::new())
        .into_iter()
        .map(|file| file.path)
        .collect()
}

/// A patch split into its files' sections, with the paths in `generated`
/// marked as generated.
pub fn file_changes<'a>(patch: &'a str, generated: &HashSet<String>) -> Vec<FileChange<'a>> {
    let mut starts: Vec<usize> = patch
        .match_indices("diff --git ")
        .map(|(at, _)| at)
        .collect();
    // Only the ones that open a line: a file's own text could contain it.
    starts.retain(|&at| at == 0 || patch.as_bytes()[at - 1] == b'\n');
    starts.push(patch.len());
    starts
        .windows(2)
        .map(|bounds| &patch[bounds[0]..bounds[1]])
        .filter_map(|section| {
            let path = section_path(section)?;
            Some(FileChange {
                marked_generated: generated.contains(&path),
                path,
                section,
            })
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

/// Most of the diff one specialist's definition carries. Past this, the rest
/// of its files are listed by path for it to read itself, so a sweeping
/// change doesn't hand every specialist the whole of it.
const SLICE_LIMIT: usize = 192 * 1024;

/// A specialist a review launches, with the files it picked.
struct Picked<'a> {
    specialist: &'static Specialist,
    files: Vec<&'a FileChange<'a>>,
}

/// The specialists a claude run must launch, held to it: a run that answers
/// without launching all of them is asked again.
pub struct Panel {
    /// The `subagent_type` of each, in the order they are listed.
    pub names: Vec<&'static str>,
    /// Their definitions, as `--agents` JSON.
    pub agents: String,
}

/// Sets a review up to give every area of the diff that has a specialist that
/// specialist's review. Claude is told to launch them as subagents and to
/// merge what they find, and the panel it returns is for the run to define
/// them and hold it to that. Codex, which takes no subagent definitions, gets
/// each one's checklist in its own prompt. `None` when no specialist picks
/// anything, or for codex. `generated` holds the paths marked generated,
/// which most specialists leave alone. `only`, when given, holds the paths a
/// re-review looks at, and the specialists pick from those alone.
pub fn add_specialist_reviews(
    prompt: &mut String,
    engine: &str,
    patch: &str,
    compare: Option<&str>,
    generated: &HashSet<String>,
    rules: &RepoRules,
    only: Option<&HashSet<String>>,
) -> Option<Panel> {
    let mut changes = file_changes(patch, generated);
    if let Some(only) = only {
        changes.retain(|file| only.contains(&file.path));
    }
    let picked: Vec<Picked> = SPECIALISTS
        .iter()
        .filter_map(|specialist| {
            let files: Vec<&FileChange> = changes
                .iter()
                .filter(|file| (specialist.picks)(file))
                .collect();
            (!files.is_empty()).then_some(Picked { specialist, files })
        })
        .collect();
    if picked.is_empty() {
        return None;
    }

    if engine != "claude" {
        insert_before_diff(prompt, patch, &codex_checklists(&picked, rules));
        return None;
    }

    insert_before_diff(prompt, patch, &lead_instructions(&picked));
    let agents: serde_json::Map<String, serde_json::Value> = picked
        .iter()
        .map(|picked| {
            let definition = serde_json::json!({
                "description": format!("{} Launch it whenever the review asks for it.", picked.specialist.summary),
                "prompt": specialist_prompt(picked, compare, rules.specialist(picked.specialist.key)),
                "model": "inherit",
                "maxTurns": picked.specialist.turns,
            });
            (picked.specialist.name.to_owned(), definition)
        })
        .collect();
    Some(Panel {
        names: picked.iter().map(|picked| picked.specialist.name).collect(),
        agents: serde_json::Value::Object(agents).to_string(),
    })
}

/// Most paths the lead's list names for one specialist before it counts the
/// rest.
const LISTED_PATHS: usize = 6;

/// `files` as a short list of paths for the lead reviewer.
fn path_list(files: &[&FileChange]) -> String {
    let mut list = files
        .iter()
        .take(LISTED_PATHS)
        .map(|file| format!("`{}`", file.path))
        .collect::<Vec<_>>()
        .join(", ");
    if files.len() > LISTED_PATHS {
        list.push_str(&format!(", and {} more", files.len() - LISTED_PATHS));
    }
    list
}

/// What the lead reviewer is told to do with its panel.
fn lead_instructions(picked: &[Picked]) -> String {
    let panel: String = picked
        .iter()
        .map(|picked| {
            format!(
                "- `{}` ({}): {} Its files: {}.\n",
                picked.specialist.name,
                picked.specialist.label,
                picked.specialist.summary,
                path_list(&picked.files)
            )
        })
        .collect();
    format!(
        r#"Parts of this diff get a specialist's review on top of yours. Each specialist is a subagent defined for this run, already holding its checklist and the diffs of the files in its area:
{panel}
1. In your first response, launch every one of them with the Agent tool, in the foreground, alongside your first reads: one response with an Agent call for each, so they work at the same time. Tell each in a few sentences what the change is for and what it needs to know from the rest of the diff, such as which code reads or writes the tables a migration touches, or which server change a client change depends on, and whether that ships in this same change.
2. Review the whole diff yourself, but spend your reading where no specialist is looking: the files none of them picked, and how the parts of the change fit together, such as a client change and the server change it relies on. Within a specialist's area, check what it reports rather than reviewing those files again from the start.
3. Check each finding a specialist reports against the code before you use it. Report the ones that hold as ordinary findings on their file and line, or about the change as a whole where that's how the specialist reported it, merged with your own and with each other's so each problem appears once, and drop the ones that don't hold.
4. In each finding's `reviewers`, name everyone who raised it: `{LEAD}` when you found it yourself, and the subagent's name for each specialist whose report it came from. A problem that you and a specialist both found lists both.
5. Weigh them in the verdict. A problem a specialist rates critical that holds up must be fixed before this merges.

"#
    )
}

/// What a codex review gets in place of the panel: each specialist's checklist
/// and rules, for the files in its area.
fn codex_checklists(picked: &[Picked], rules: &RepoRules) -> String {
    let mut text = String::from("Parts of this diff fall in areas that get a specialist's checklist on top of an ordinary review. Review the files in each area against its checklist as well as everything else, and report what you find as ordinary findings on the file and line, or about the change as a whole when no one place shows it.\n\n");
    for picked in picked {
        text.push_str(&format!(
            "{} checklist, for {}. {}\n\n{}\n\n",
            picked.specialist.label,
            path_list(&picked.files),
            picked.specialist.stakes,
            guidance(picked.specialist, rules.specialist(picked.specialist.key)),
        ));
    }
    text
}

/// Adds every specialist's rules for the repository to a prompt that weighs
/// findings without launching the specialists, such as the check of a
/// review's findings. Nothing, when no specialist has rules kept.
pub fn add_specialist_rules(prompt: &mut String, patch: &str, rules: &RepoRules) {
    let kept: String = SPECIALISTS
        .iter()
        .filter_map(|specialist| {
            let rules = rules.specialist(specialist.key).trim();
            (!rules.is_empty()).then(|| format!("{} rules:\n\n{rules}\n\n", specialist.label))
        })
        .collect();
    if kept.is_empty() {
        return;
    }
    insert_before_diff(
        prompt,
        patch,
        &format!("The person running this review also keeps rules for the specialist reviewers that look at parts of a diff. A finding can rest on one of these rather than on anything in the code:\n\n{kept}"),
    );
}

/// A specialist's checklist, followed by the repository's own rules for it
/// when the person running the review keeps any.
fn guidance(specialist: &Specialist, rules: &str) -> String {
    let checklist = specialist.checklist.trim_end();
    let rules = rules.trim();
    if rules.is_empty() {
        return checklist.to_owned();
    }
    format!("{checklist}\n\nThis repository's own {} rules, kept by the person running the review. Where they are more specific than the checklist above, they win:\n\n{rules}", specialist.label)
}

/// The prompt a specialist's subagent is defined with: who it is, how to get
/// its bearings, its checklist and rules, how to report, and the diffs of the
/// files it picked, as many as fit.
fn specialist_prompt(picked: &Picked, compare: Option<&str>, rules: &str) -> String {
    let specialist = picked.specialist;
    let mut diffs = String::new();
    let mut unsent: Vec<&str> = Vec::new();
    for file in &picked.files {
        if unsent.is_empty() && diffs.len() + file.section.len() <= SLICE_LIMIT {
            diffs.push_str(file.section);
        } else {
            unsent.push(&file.path);
        }
    }
    let unsent = if unsent.is_empty() {
        String::new()
    } else {
        let read = match compare {
            Some(compare) => format!("with `git show {compare}:<path>`"),
            None => "from the working tree".to_owned(),
        };
        format!(
            "\n\nThese files are in your area too, but their diffs didn't fit here. Read them {read}, and `git log -p` them where you need to see what changed:\n{}",
            unsent
                .iter()
                .map(|path| format!("- `{path}`\n"))
                .collect::<String>()
        )
    };

    format!(
        r#"You are {role}, alongside the lead reviewer who launched you. They will tell you what the change is for and what the rest of the diff does that bears on your files. You are read-only: read and search the repository, never change it.

{stakes} That is why your area gets a specialist's review on top of theirs.

Before judging, read this repository's own rules for your area: `CLAUDE.md` and `AGENTS.md` at the root and beside the files you review, skills under `.claude/skills` whose descriptions cover your area, and the docs those point to. Hold the change to them. {preparation} The working tree may not match the diff's compare side, so the diffs below are the authority on what changed. Make independent reads and searches in the same response rather than one per turn.

Look for history only for a problem you'd rate critical or warning, where it would change the finding, and stop as soon as you have enough: a few turns at most. {history} Use Linear or Slack only if their tools turn up through ToolSearch. When a past incident, PR, or fix bears on a problem you report, cite it in that entry. Skip any source that's missing or refused.

{guidance}

Report back in plain text, one entry per problem, most serious first:
- `path:line` or `path:start-end`, in new-file line numbers, or "the whole change" for a problem with the approach that no one place shows
- severity: critical, warning, suggestion, or nit
- one sentence naming the problem
- the failure: the concrete inputs, state, or sequence of events that goes wrong, and what the user or the system sees
- the fix, and what the finding rests on: the rule, PR, incident, or code you checked

Only report problems you can point to in the diff or the code, with a failure you can describe. Leave out what a formatter, linter, type checker, or CI check already catches, and matters of taste. Say "Nothing to report in my area." when there is nothing. End with one line on anything you could not check from the repository.

The diffs of the files in your area:

{diffs}{unsent}"#,
        role = specialist.role,
        stakes = specialist.stakes,
        preparation = specialist.preparation,
        history = specialist.history,
        guidance = guidance(specialist, rules),
    )
}

/// `schema`, the JSON Schema a review answers against, with a `reviewers`
/// list required on every finding, naming who raised it: the lead reviewer or
/// one of the panel's specialists.
pub fn with_reviewers(schema: &str, panel: &Panel) -> String {
    let mut schema: serde_json::Value =
        serde_json::from_str(schema).expect("the review schemas are valid JSON");
    let names: Vec<&str> = std::iter::once(LEAD)
        .chain(panel.names.iter().copied())
        .collect();
    let finding = &mut schema["properties"]["findings"]["items"];
    finding["properties"]["reviewers"] = serde_json::json!({
        "type": "array",
        "items": {"type": "string", "enum": names},
        "minItems": 1,
    });
    if let Some(required) = finding["required"].as_array_mut() {
        required.push("reviewers".into());
    }
    schema.to_string()
}

/// Settles who raised each finding into the names the app shows: the lead
/// first, then the specialists in their usual order, each once. Without a
/// panel nobody else reviewed, so nobody is named.
pub fn credit_reviewers(findings: &mut [ReviewFinding], panel: Option<&Panel>) {
    for finding in findings {
        if panel.is_none() {
            finding.reviewers.clear();
            continue;
        }
        let named = |name: &str| {
            finding
                .reviewers
                .iter()
                .any(|reviewer| reviewer.trim().eq_ignore_ascii_case(name))
        };
        let mut labels: Vec<String> = Vec::new();
        if named(LEAD) {
            labels.push(LEAD_LABEL.to_owned());
        }
        labels.extend(
            SPECIALISTS
                .iter()
                .filter(|specialist| named(specialist.name))
                .map(|specialist| specialist.label.to_owned()),
        );
        finding.reviewers = labels;
    }
}

/// Rules the person running a review can keep for one reviewer, as the rules
/// dialog lists them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSlot {
    /// The rules' key: `review` for the lead, otherwise the specialist's key.
    pub key: &'static str,
    pub label: &'static str,
    /// What it reviews and when it runs.
    pub about: String,
    pub placeholder: &'static str,
}

/// Every reviewer that takes rules, the lead first.
pub fn rule_slots() -> Vec<RuleSlot> {
    std::iter::once(RuleSlot {
        key: "review",
        label: LEAD_LABEL,
        about: "Reads the whole diff on every review and re-review, launches the specialists, and merges what they find. Its rules hold every review to the repository's conventions.".to_owned(),
        placeholder: "e.g. Money is always integer cents, never floats.",
    })
    .chain(SPECIALISTS.iter().map(|specialist| RuleSlot {
        key: specialist.key,
        label: specialist.label,
        about: format!(
            "{} A Claude review launches it {}",
            specialist.summary,
            lowercase_first(specialist.launches)
        ),
        placeholder: specialist.placeholder,
    }))
    .collect()
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One file's section of a patch, as `git diff` writes it.
    fn file_section(header: &str, hunk: &str) -> String {
        format!("{header}\n@@ -1,1 +1,1 @@\n{hunk}\n")
    }

    /// A section that modifies `path` with `hunk`.
    fn modified(path: &str, hunk: &str) -> String {
        file_section(
            &format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}"),
            hunk,
        )
    }

    /// A patch that adds a migration, edits another, deletes a third, renames a
    /// fourth, and changes some code alongside them.
    fn migration_patch() -> String {
        [
            file_section(
                "diff --git a/apps/api/src/migrations/0002_add_owner.sql b/apps/api/src/migrations/0002_add_owner.sql\nnew file mode 100644\n--- /dev/null\n+++ b/apps/api/src/migrations/0002_add_owner.sql",
                "+ALTER TABLE drawing ADD COLUMN owner_id uuid;",
            ),
            modified(
                "src/api/drawings.ts",
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

    /// The paths the specialist named `key` picks from `patch`.
    fn picked_by(key: &str, patch: &str) -> Vec<String> {
        let specialist = SPECIALISTS
            .iter()
            .find(|specialist| specialist.key == key)
            .expect("specialist");
        let generated = HashSet::from(["apps/api/schema.graphql".to_owned()]);
        file_changes(patch, &generated)
            .into_iter()
            .filter(|file| (specialist.picks)(file))
            .map(|file| file.path)
            .collect()
    }

    /// The `--agents` definition of the subagent `name`, parsed.
    fn definition(panel: &Panel, name: &str) -> serde_json::Value {
        let agents: serde_json::Value = serde_json::from_str(&panel.agents).expect("agents JSON");
        agents[name].clone()
    }

    fn prompt_for(patch: &str) -> String {
        format!("Review this.\n\nThe diff:\n\n{patch}")
    }

    #[test]
    fn finds_the_migrations_a_patch_changes_by_where_they_live() {
        let patch = migration_patch();
        assert_eq!(
            picked_by("migrations", &patch),
            [
                "apps/api/src/migrations/0002_add_owner.sql",
                "db/migrate/0001_old.rb",
                "migrations/b.sql",
            ]
        );
        // A file named like a migrations directory is not in one.
        let file = modified("migrations", "-a\n+b");
        assert!(picked_by("migrations", &file).is_empty());
    }

    #[test]
    fn terms_must_start_a_word_but_camel_case_starts_one() {
        assert!(mentions("await addJob(payload)", &["job"]));
        assert!(mentions("const jobs = [];", &["job"]));
        assert!(mentions("JOB_LIMIT", &["job"]));
        assert!(!mentions("const block = 1;", &["lock"]));
        assert!(!mentions("cronjob", &["job"]));
        // Terms that open with punctuation match anywhere.
        assert!(mentions("db.query(sql)", &[".query("]));
        assert!(mentions(
            "import { Mesh } from \"three\";",
            &["from \"three\""]
        ));
        // Case is ignored past the word's start.
        assert!(mentions("new WebGLRenderer()", &["webgl"]));
    }

    #[test]
    fn specialists_pick_the_files_in_their_area() {
        let patch = [
            modified(
                "apps/web/src/Canvas.tsx",
                "+const mesh = useThree().scene;\n+useEffect(() => {}, []);",
            ),
            modified(
                "apps/web/src/styles.css",
                "+.grid { container-type: inline-size; }",
            ),
            modified(
                "apps/web/src/useDrag.ts",
                "+export const useDrag = () => 1;",
            ),
            modified(
                "apps/web/src/lib/glsl/blend.ts",
                "+export const blend = '';",
            ),
            modified(
                "apps/api/src/plugins/creditsPlugin.ts",
                "+await transact(pool, () => refundCredits(job));",
            ),
            modified(
                "apps/api/src/plugins/creditsPlugin.test.ts",
                "+expect(refundCredits).toHaveBeenCalled();",
            ),
            modified(
                "apps/api/schema.graphql",
                "+  exportDrawing(id: UUID!): Boolean",
            ),
            modified(
                "apps/api/src/analytics/events.ts",
                "+publishTrackingEvent({ type: 'EXPORT' });",
            ),
            modified("docs/README.md", "+Some words about billing and WebGL."),
        ]
        .concat();

        assert_eq!(
            picked_by("frontend", &patch),
            ["apps/web/src/Canvas.tsx", "apps/web/src/styles.css"]
        );
        assert_eq!(
            picked_by("react", &patch),
            ["apps/web/src/Canvas.tsx", "apps/web/src/useDrag.ts"]
        );
        assert_eq!(
            picked_by("graphics", &patch),
            ["apps/web/src/Canvas.tsx", "apps/web/src/lib/glsl/blend.ts"]
        );
        assert_eq!(
            picked_by("runtime", &patch),
            ["apps/api/src/plugins/creditsPlugin.ts"]
        );
        assert_eq!(
            picked_by("billing", &patch),
            ["apps/api/src/plugins/creditsPlugin.ts"]
        );
        assert_eq!(picked_by("graphql", &patch), ["apps/api/schema.graphql"]);
        assert_eq!(picked_by("rollout", &patch), ["apps/api/schema.graphql"]);
        assert_eq!(
            picked_by("analytics", &patch),
            ["apps/api/src/analytics/events.ts"]
        );
        // Security reads code but not tests; maintainability reads tests too.
        // Neither reads docs.
        let security = picked_by("security", &patch);
        assert!(!security.iter().any(|path| path.contains(".test.")));
        assert!(!security.iter().any(|path| path.ends_with(".md")));
        let maintainability = picked_by("maintainability", &patch);
        assert!(maintainability
            .iter()
            .any(|path| path.ends_with("creditsPlugin.test.ts")));
        assert!(!maintainability.iter().any(|path| path.ends_with(".md")));
        assert!(picked_by("migrations", &patch).is_empty());
        // A skipped or loosened test is a workaround too, so architecture
        // reads tests, and migrations, which can repair what code keeps
        // writing wrong.
        let architecture = picked_by("architecture", &patch);
        assert!(architecture
            .iter()
            .any(|path| path.ends_with("creditsPlugin.test.ts")));
        assert!(!architecture.iter().any(|path| path.ends_with(".md")));
        assert!(picked_by("architecture", &migration_patch())
            .contains(&"apps/api/src/migrations/0002_add_owner.sql".to_owned()));
    }

    #[test]
    fn security_reads_browser_code_only_where_an_attacker_can_reach_it() {
        let patch = [
            modified(
                "apps/web/src/Layout.tsx",
                "+<div className={css.grid}>{children}</div>",
            ),
            modified(
                "apps/web/src/Comment.tsx",
                "+<div dangerouslySetInnerHTML={{ __html: body }} />",
            ),
            modified(
                "apps/web/src/session.ts",
                "+localStorage.setItem('token', token);",
            ),
            modified(
                "apps/api/src/routes/export.ts",
                "+export const route = handler;",
            ),
        ]
        .concat();
        assert_eq!(
            picked_by("security", &patch),
            [
                "apps/web/src/Comment.tsx",
                "apps/web/src/session.ts",
                "apps/api/src/routes/export.ts"
            ]
        );
    }

    #[test]
    fn a_claude_review_launches_every_specialist_that_picked_something() {
        let patch = migration_patch();
        let mut prompt = prompt_for(&patch);
        let panel = add_specialist_reviews(
            &mut prompt,
            "claude",
            &patch,
            Some("feature"),
            &HashSet::new(),
            &RepoRules::default(),
            None,
        )
        .expect("a panel");

        assert!(
            panel.names.contains(&"migration-reviewer"),
            "{:?}",
            panel.names
        );
        assert!(
            panel.names.contains(&"security-reviewer"),
            "{:?}",
            panel.names
        );
        assert!(
            panel.names.contains(&"rollout-reviewer"),
            "{:?}",
            panel.names
        );
        assert!(
            !panel.names.contains(&"graphics-reviewer"),
            "{:?}",
            panel.names
        );

        // The lead is told to launch them all at once, about which files, to
        // check and merge what they find, and to credit whoever raised each.
        assert!(prompt.contains("launch every one of them"), "{prompt}");
        assert!(
            prompt.contains("- `migration-reviewer` (Migrations):"),
            "{prompt}"
        );
        assert!(
            prompt.contains("`apps/api/src/migrations/0002_add_owner.sql`"),
            "{prompt}"
        );
        assert!(prompt.contains("In each finding's `reviewers`"), "{prompt}");
        assert!(prompt.ends_with(&format!("The diff:\n\n{patch}")));
        // The checklists stay with the specialists.
        let migrations = &SPECIALISTS[0];
        assert!(
            !prompt.contains(migrations.checklist.trim_end()),
            "{prompt}"
        );

        // Each carries its checklist and only its own files' diffs.
        let definition = definition(&panel, "migration-reviewer");
        let subagent = definition["prompt"].as_str().expect("prompt");
        assert!(subagent.contains(migrations.checklist.trim_end()));
        assert!(subagent.contains("+ALTER TABLE drawing ADD COLUMN owner_id uuid;"));
        assert!(subagent.contains("rename to migrations/b.sql"));
        assert!(!subagent.contains("const owner"));
        assert!(subagent.contains("the failure:"), "{subagent}");
        // It works with the run's own tools, which the run holds to reads.
        assert!(definition["tools"].is_null());
        assert_eq!(definition["maxTurns"], migrations.turns);
        assert!(definition["description"]
            .as_str()
            .is_some_and(|text| !text.is_empty()));
    }

    #[test]
    fn a_codex_review_gets_the_checklists_in_its_prompt() {
        let patch = migration_patch();
        let mut prompt = prompt_for(&patch);
        assert!(add_specialist_reviews(
            &mut prompt,
            "codex",
            &patch,
            None,
            &HashSet::new(),
            &RepoRules::default(),
            None
        )
        .is_none());
        assert!(
            prompt.contains(SPECIALISTS[0].checklist.trim_end()),
            "{prompt}"
        );
        assert!(prompt.contains("Migrations checklist, for "), "{prompt}");
        assert!(prompt.contains("`db/migrate/0001_old.rb`"), "{prompt}");
        assert!(!prompt.contains("subagent"), "{prompt}");
        assert!(prompt.ends_with(&format!("The diff:\n\n{patch}")));
    }

    #[test]
    fn a_diff_no_specialist_picks_is_left_alone() {
        let patch = modified("docs/guide.md", "+More words.");
        let mut prompt = prompt_for(&patch);
        let before = prompt.clone();
        for engine in ["claude", "codex"] {
            assert!(add_specialist_reviews(
                &mut prompt,
                engine,
                &patch,
                None,
                &HashSet::new(),
                &RepoRules::default(),
                None
            )
            .is_none());
            assert_eq!(prompt, before);
        }
    }

    #[test]
    fn a_specialists_rules_follow_its_checklist_for_either_engine() {
        let patch = migration_patch();
        let rule = "The orders table is huge: always set a lock timeout.";
        let mut rules = RepoRules::default();
        rules.specialists.insert("migrations".into(), rule.into());

        let mut prompt = prompt_for(&patch);
        let panel = add_specialist_reviews(
            &mut prompt,
            "claude",
            &patch,
            None,
            &HashSet::new(),
            &rules,
            None,
        )
        .expect("panel");
        let definition = definition(&panel, "migration-reviewer");
        let subagent = definition["prompt"].as_str().expect("prompt");
        let checklist = subagent
            .find(SPECIALISTS[0].checklist.trim_end())
            .expect("checklist");
        assert!(subagent.find(rule).expect("rules") > checklist);
        // The lead's prompt stays short: the rules go to the specialist.
        assert!(!prompt.contains(rule), "{prompt}");
        // And to no other specialist.
        let security = definition_prompt(&panel, "security-reviewer");
        assert!(!security.contains(rule));

        let mut prompt = prompt_for(&patch);
        add_specialist_reviews(
            &mut prompt,
            "codex",
            &patch,
            None,
            &HashSet::new(),
            &rules,
            None,
        );
        assert!(
            prompt.contains(&guidance(&SPECIALISTS[0], rule)),
            "{prompt}"
        );
        assert_eq!(
            guidance(&SPECIALISTS[0], " "),
            SPECIALISTS[0].checklist.trim_end()
        );
    }

    fn definition_prompt(panel: &Panel, name: &str) -> String {
        definition(panel, name)["prompt"]
            .as_str()
            .expect("prompt")
            .to_owned()
    }

    #[test]
    fn a_slice_too_large_to_carry_lists_the_rest_by_path() {
        let big = format!("+{}", "x".repeat(SLICE_LIMIT));
        let patch = [
            modified("src/small.rs", "+fn small() {}"),
            modified("src/big.rs", &big),
            modified("src/after.rs", "+fn after() {}"),
        ]
        .concat();
        let mut prompt = prompt_for(&patch);
        let panel = add_specialist_reviews(
            &mut prompt,
            "claude",
            &patch,
            Some("feature"),
            &HashSet::new(),
            &RepoRules::default(),
            None,
        )
        .expect("panel");
        let subagent = definition_prompt(&panel, "maintainability-reviewer");
        assert!(subagent.contains("+fn small() {}"));
        assert!(!subagent.contains(&big));
        // Once one file is left out, the rest are too, so the diffs it does
        // carry are a whole prefix of its files.
        assert!(!subagent.contains("+fn after() {}"));
        assert!(
            subagent.contains("- `src/big.rs`\n- `src/after.rs`\n"),
            "{subagent}"
        );
        assert!(subagent.contains("`git show feature:<path>`"));
    }

    #[test]
    fn the_schema_asks_each_finding_who_raised_it() {
        let panel = Panel {
            names: vec!["security-reviewer", "react-reviewer"],
            agents: "{}".into(),
        };
        let schema: serde_json::Value = serde_json::from_str(&with_reviewers(
            r#"{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}}}"#,
            &panel,
        ))
        .expect("schema");
        let finding = &schema["properties"]["findings"]["items"];
        assert_eq!(
            finding["properties"]["reviewers"]["items"]["enum"],
            serde_json::json!(["lead", "security-reviewer", "react-reviewer"])
        );
        assert_eq!(
            finding["required"],
            serde_json::json!(["title", "reviewers"])
        );
    }

    #[test]
    fn findings_name_their_reviewers_lead_first_once_each() {
        let finding = |reviewers: &[&str]| ReviewFinding {
            path: "a.ts".into(),
            line: None,
            end_line: None,
            severity: "warning".into(),
            title: "t".into(),
            body: "b".into(),
            reviewers: reviewers.iter().map(|name| (*name).to_owned()).collect(),
            posted_url: None,
            failure: String::new(),
            fix: String::new(),
        };
        let panel = Panel {
            names: vec!["security-reviewer", "migration-reviewer"],
            agents: "{}".into(),
        };
        let mut findings = vec![
            finding(&["security-reviewer", "lead", "migration-reviewer", "lead"]),
            finding(&["Security-Reviewer "]),
        ];
        credit_reviewers(&mut findings, Some(&panel));
        assert_eq!(findings[0].reviewers, ["Lead", "Migrations", "Security"]);
        assert_eq!(findings[1].reviewers, ["Security"]);

        // With no panel, nobody else reviewed, so nobody is named.
        let mut findings = vec![finding(&["lead"])];
        credit_reviewers(&mut findings, None);
        assert!(findings[0].reviewers.is_empty());
    }

    #[test]
    fn every_reviewer_has_a_rule_slot_with_a_distinct_key() {
        let slots = rule_slots();
        assert_eq!(slots[0].key, "review");
        assert_eq!(slots.len(), SPECIALISTS.len() + 1);
        let mut keys: Vec<&str> = slots.iter().map(|slot| slot.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), slots.len());
        assert!(
            slots[1].about.contains("A Claude review launches it when"),
            "{}",
            slots[1].about
        );
        for specialist in SPECIALISTS {
            assert!(specialist.name.ends_with("-reviewer"));
            assert!(
                !specialist.checklist.trim().is_empty(),
                "{}",
                specialist.key
            );
        }
    }
}
