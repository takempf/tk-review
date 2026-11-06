//! The import graph between a snapshot's files, as imported and through barrels.

use std::collections::HashMap;
use std::sync::LazyLock;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    CallExpression, Declaration, Expression, ImportDeclarationSpecifier, ImportExpression,
    Statement,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;
use regex::Regex;

use super::posix_path::{dirname, join, normalize};
use super::resolver::Resolver;
use super::FileKind;

/// What kind of import a link stands for. The values are the viewer's.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub(super) enum LinkKind {
    Import = 0,
    TypeOnly = 1,
    /// `import()` or `require()`.
    Dynamic = 2,
    ReExport = 3,
    /// `vi.mock()` and the like.
    Mock = 4,
    /// "/images/x.png", served from a public/ folder, or `new URL('./x', import.meta.url)`.
    AssetUrl = 5,
}

impl LinkKind {
    /// Of two links between the same files, the lower rank stays.
    fn rank(self) -> u8 {
        match self {
            Self::Import => 0,
            Self::ReExport => 1,
            Self::Dynamic => 2,
            Self::AssetUrl => 3,
            Self::TypeOnly => 4,
            Self::Mock => 5,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct Link {
    pub from: usize,
    pub to: usize,
    pub kind: LinkKind,
    /// The barrel a through link passed, when it passed one.
    pub via: Option<usize>,
}

pub(super) struct SourceFile<'a> {
    pub path: &'a str,
    pub kind: FileKind,
    pub text: &'a str,
}

pub(super) struct ImportGraph {
    /// To the module each import names, often an `index.ts` barrel.
    pub links: Vec<Link>,
    /// To the files that define the imported names, past barrels' re-exports.
    pub through_links: Vec<Link>,
    /// External packages by how often they're imported, most first.
    pub packages: Vec<(String, usize)>,
    /// The external packages each file imports, by file index.
    pub file_packages: Vec<Vec<String>>,
}

const MAX_PACKAGES: usize = 80;
const MAX_REEXPORT_DEPTH: usize = 25;

const RESOLVE_EXTENSIONS: [&str; 14] = [
    "",
    ".ts",
    ".tsx",
    ".d.ts",
    ".js",
    ".jsx",
    ".mjs",
    ".mts",
    ".cjs",
    ".json",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.mjs",
];

static CSS_IMPORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"@import\s+['"]([^'"]+)['"]"#).expect("valid regex"));
static PYTHON_FROM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*from\s+(\.*)([A-Za-z0-9_.]*)\s+import\s+(.+)").expect("valid regex")
});
static PYTHON_IMPORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*import\s+([A-Za-z0-9_.]+)").expect("valid regex"));
// Ends on the character after the path, since the regex crate has no lookahead.
static PUBLIC_ASSET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)["'`(](/[A-Za-z0-9_\-./@]+\.(?:png|jpe?g|webp|gif|svg))["'`)?#]"#)
        .expect("valid regex")
});
static RELATIVE_ASSET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url"#).expect("valid regex")
});

/// Where an exported name comes from.
enum ExportSource {
    Local,
    Reexported { file: String, name: String },
}

#[derive(Default)]
struct Exports {
    named: HashMap<String, ExportSource>,
    stars: Vec<String>,
}

struct Import {
    from: usize,
    file: String,
    /// The names imported and how; `None` for an import of the whole module.
    names: Option<Vec<(String, LinkKind)>>,
    kind: LinkKind,
}

struct ImportedName {
    imported: String,
    local: String,
    type_only: bool,
}

struct ExportedName {
    /// The name in the module it comes from, or in this file.
    original: String,
    exported: String,
    type_only: bool,
}

/// A module's top-level imports and exports, copied out of its syntax tree.
enum ModuleStatement {
    Import {
        source: String,
        type_only: bool,
        /// `None` for `import './x'`, which imports no names.
        names: Option<Vec<ImportedName>>,
    },
    ExportAll {
        source: String,
        type_only: bool,
        /// `ns` in `export * as ns from`.
        namespace: Option<String>,
    },
    ExportFrom {
        source: String,
        type_only: bool,
        names: Vec<ExportedName>,
    },
    ExportLocal {
        names: Vec<ExportedName>,
    },
    Declare {
        names: Vec<String>,
    },
}

struct ModuleFacts {
    statements: Vec<ModuleStatement>,
    /// `import()`, `require()` and `.mock()` calls anywhere in the file.
    calls: Vec<(String, LinkKind)>,
}

#[derive(Default)]
struct CallCollector {
    calls: Vec<(String, LinkKind)>,
}

fn literal_text(expression: &Expression) -> Option<String> {
    match expression {
        Expression::StringLiteral(literal) => literal.value.as_str().map(str::to_owned),
        Expression::TemplateLiteral(template) => template
            .single_quasi()
            .and_then(|quasi| quasi.as_str())
            .map(str::to_owned),
        _ => None,
    }
}

impl<'a> Visit<'a> for CallCollector {
    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        if let Some(spec) = literal_text(&it.source) {
            self.calls.push((spec, LinkKind::Dynamic));
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let spec = it
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
            .and_then(literal_text);
        if let Some(spec) = spec {
            match &it.callee {
                Expression::Identifier(callee) if callee.name == "require" => {
                    self.calls.push((spec, LinkKind::Dynamic));
                }
                Expression::StaticMemberExpression(callee)
                    if callee.property.name == "mock" || callee.property.name == "doMock" =>
                {
                    self.calls.push((spec, LinkKind::Mock));
                }
                _ => {}
            }
        }
        walk::walk_call_expression(self, it);
    }
}

fn declared_names(declaration: &Declaration) -> Vec<String> {
    match declaration {
        Declaration::VariableDeclaration(variables) => variables
            .declarations
            .iter()
            .flat_map(|declarator| declarator.id.get_binding_identifiers())
            .map(|identifier| identifier.name.to_string())
            .collect(),
        Declaration::TSNamespaceDeclaration(namespace) => vec![namespace.id.name.to_string()],
        other => other
            .id()
            .map(|identifier| vec![identifier.name.to_string()])
            .unwrap_or_default(),
    }
}

fn module_statement(statement: &Statement) -> Option<ModuleStatement> {
    Some(match statement {
        Statement::ImportDeclaration(import) => ModuleStatement::Import {
            source: import.source.value.as_str()?.to_owned(),
            type_only: import.import_kind.is_type(),
            names: import.specifiers.as_ref().map(|specifiers| {
                specifiers
                    .iter()
                    .map(|specifier| match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(named) => ImportedName {
                            imported: named.imported.name().to_string(),
                            local: named.local.name.to_string(),
                            type_only: named.import_kind.is_type(),
                        },
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                            ImportedName {
                                imported: "default".into(),
                                local: default.local.name.to_string(),
                                type_only: false,
                            }
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                            ImportedName {
                                imported: "*".into(),
                                local: namespace.local.name.to_string(),
                                type_only: false,
                            }
                        }
                    })
                    .collect()
            }),
        },
        Statement::ExportAllDeclaration(export) => ModuleStatement::ExportAll {
            source: export.source.value.as_str()?.to_owned(),
            type_only: export.export_kind.is_type(),
            namespace: export.exported.as_ref().map(|name| name.name().to_string()),
        },
        Statement::ExportFromDeclaration(export) => ModuleStatement::ExportFrom {
            source: export.source.value.as_str()?.to_owned(),
            type_only: export.export_kind.is_type(),
            names: export
                .specifiers
                .iter()
                .map(|specifier| ExportedName {
                    original: specifier.local.name().to_string(),
                    exported: specifier.exported.name().to_string(),
                    type_only: specifier.export_kind.is_type(),
                })
                .collect(),
        },
        Statement::ExportNamedDeclaration(export) => ModuleStatement::ExportLocal {
            names: export
                .specifiers
                .iter()
                .map(|specifier| ExportedName {
                    original: specifier.local.name().to_string(),
                    exported: specifier.exported.name().to_string(),
                    type_only: specifier.export_kind.is_type(),
                })
                .collect(),
        },
        Statement::ExportDeclaration(export) => ModuleStatement::Declare {
            names: declared_names(&export.declaration),
        },
        Statement::ExportDefaultDeclaration(_) | Statement::TSExportAssignment(_) => {
            ModuleStatement::Declare {
                names: vec!["default".into()],
            }
        }
        _ => return None,
    })
}

/// Parses a script, retrying with JSX flipped: plenty of `.js` holds JSX.
fn read_module(allocator: &mut Allocator, kind: FileKind, text: &str) -> ModuleFacts {
    let source_type = match kind {
        FileKind::Tsx => SourceType::tsx(),
        FileKind::Js => SourceType::jsx(),
        FileKind::Dts => SourceType::d_ts(),
        _ => SourceType::ts(),
    };
    for source_type in [source_type, source_type.with_jsx(!source_type.is_jsx())] {
        allocator.reset();
        let parsed = Parser::new(allocator, text, source_type).parse();
        if parsed.fatal_error {
            continue;
        }
        let mut collector = CallCollector::default();
        collector.visit_program(&parsed.program);
        return ModuleFacts {
            statements: parsed
                .program
                .body
                .iter()
                .filter_map(module_statement)
                .collect(),
            calls: collector.calls,
        };
    }
    ModuleFacts {
        statements: Vec::new(),
        calls: Vec::new(),
    }
}

/// Where a specifier led: a file in the snapshot, a package outside it, or neither.
enum Resolved {
    File(String),
    Package(String),
    Unresolved,
}

struct Analysis<'a> {
    files: &'a [SourceFile<'a>],
    index: HashMap<&'a str, usize>,
    resolver: &'a Resolver,
    links: Vec<Link>,
    imports: Vec<Import>,
    exports: HashMap<String, Exports>,
    package_counts: Vec<(String, usize)>,
    file_packages: Vec<Vec<String>>,
}

impl<'a> Analysis<'a> {
    fn exists(&self, path: &str) -> bool {
        self.index.contains_key(path)
    }

    fn try_resolve(&self, path: &str) -> Option<String> {
        let normalized = normalize(path);
        for extension in RESOLVE_EXTENSIONS {
            let candidate = format!("{normalized}{extension}");
            if self.exists(&candidate) {
                return Some(candidate);
            }
        }
        // `./x.js` in TypeScript source names `./x.ts`.
        let stem = [".js", ".jsx", ".mjs"]
            .iter()
            .find_map(|extension| normalized.strip_suffix(extension))?;
        [".ts", ".tsx", ".mts"]
            .iter()
            .map(|extension| format!("{stem}{extension}"))
            .find(|candidate| self.exists(candidate))
    }

    fn resolve(&self, from: &str, spec: &str) -> Resolved {
        let spec = spec.split('?').next().unwrap_or(spec);
        if spec.starts_with('.') {
            return self
                .try_resolve(&join(&[dirname(from), spec]))
                .map_or(Resolved::Unresolved, Resolved::File);
        }
        for candidate in self.resolver.candidates(spec) {
            let stem = [".tsx", ".ts", ".jsx", ".js"]
                .iter()
                .find_map(|extension| candidate.strip_suffix(extension))
                .unwrap_or(&candidate);
            if let Some(file) = self.try_resolve(stem) {
                return Resolved::File(file);
            }
            if self.exists(&candidate) {
                return Resolved::File(candidate);
            }
        }
        // A workspace package that couldn't be mapped to a file: internal, but unresolved.
        if self.resolver.is_workspace_package(spec) {
            return Resolved::Unresolved;
        }
        let mut segments = spec.split('/');
        let package = match (segments.next(), segments.next()) {
            (Some(scope), Some(name)) if scope.starts_with('@') => format!("{scope}/{name}"),
            (Some(name), _) => name.to_owned(),
            _ => return Resolved::Unresolved,
        };
        if package.is_empty() {
            Resolved::Unresolved
        } else {
            Resolved::Package(package)
        }
    }

    /// Resolves a specifier from file `from`, counting it if it names a package.
    fn spec(&mut self, from: usize, spec: &str) -> Option<String> {
        match self.resolve(self.files[from].path, spec) {
            Resolved::File(file) => Some(file),
            Resolved::Package(package) => {
                self.add_package(from, package);
                None
            }
            Resolved::Unresolved => None,
        }
    }

    fn add_package(&mut self, from: usize, package: String) {
        match self
            .package_counts
            .iter_mut()
            .find(|(name, _)| *name == package)
        {
            Some((_, count)) => *count += 1,
            None => self.package_counts.push((package.clone(), 1)),
        }
        if !self.file_packages[from].contains(&package) {
            self.file_packages[from].push(package);
        }
    }

    fn link(
        &mut self,
        from: usize,
        target: Option<&str>,
        kind: LinkKind,
        names: Option<Vec<(String, LinkKind)>>,
    ) {
        let Some(target) = target else {
            return;
        };
        let Some(&to) = self.index.get(target) else {
            return;
        };
        if to == from {
            return;
        }
        self.links.push(Link {
            from,
            to,
            kind,
            via: None,
        });
        self.imports.push(Import {
            from,
            file: target.to_owned(),
            names,
            kind,
        });
    }

    fn resolve_python(&self, from: &str, module: &str, level: usize) -> Option<String> {
        let parts: Vec<&str> = if module.is_empty() {
            Vec::new()
        } else {
            module.split('.').collect()
        };
        let mut folders = Vec::new();
        let mut folder = dirname(from).to_owned();
        if level > 0 {
            for _ in 1..level {
                folder = dirname(&folder).to_owned();
            }
            folders.push(folder);
        } else {
            // Absolute imports: try every enclosing folder as a package root.
            loop {
                folders.push(folder.clone());
                if folder == "." || folder.is_empty() {
                    break;
                }
                folder = dirname(&folder).to_owned();
            }
        }
        for folder in folders {
            let mut segments = vec![folder.as_str()];
            segments.extend(&parts);
            let path = join(&segments);
            for candidate in [format!("{path}.py"), format!("{path}/__init__.py")] {
                if self.exists(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    fn scan_script(&mut self, from: usize, allocator: &mut Allocator) {
        let file = &self.files[from];
        let facts = read_module(allocator, file.kind, file.text);
        let mut exports = Exports::default();
        // Local name -> the file and name it was imported as.
        let mut bindings: HashMap<String, (String, String)> = HashMap::new();

        for statement in facts.statements {
            match statement {
                ModuleStatement::Import {
                    source,
                    type_only,
                    names,
                } => {
                    let Some(target) = self.spec(from, &source) else {
                        continue;
                    };
                    let kind = if type_only {
                        LinkKind::TypeOnly
                    } else {
                        LinkKind::Import
                    };
                    let Some(names) = names else {
                        self.link(from, Some(&target), kind, None);
                        continue;
                    };
                    let mut imported = Vec::new();
                    for name in names {
                        let name_kind = if type_only || name.type_only {
                            LinkKind::TypeOnly
                        } else {
                            LinkKind::Import
                        };
                        imported.push((name.imported.clone(), name_kind));
                        bindings.insert(name.local, (target.clone(), name.imported));
                    }
                    self.link(from, Some(&target), kind, Some(imported));
                }
                ModuleStatement::ExportAll {
                    source,
                    type_only,
                    namespace,
                } => {
                    let Some(target) = self.spec(from, &source) else {
                        continue;
                    };
                    match namespace {
                        None => {
                            exports.stars.push(target.clone());
                            let kind = if type_only {
                                LinkKind::TypeOnly
                            } else {
                                LinkKind::ReExport
                            };
                            self.link(from, Some(&target), kind, None);
                        }
                        Some(namespace) => {
                            exports.named.insert(
                                namespace,
                                ExportSource::Reexported {
                                    file: target.clone(),
                                    name: "*".into(),
                                },
                            );
                            let name_kind = if type_only {
                                LinkKind::TypeOnly
                            } else {
                                LinkKind::ReExport
                            };
                            self.link(
                                from,
                                Some(&target),
                                LinkKind::ReExport,
                                Some(vec![("*".into(), name_kind)]),
                            );
                        }
                    }
                }
                ModuleStatement::ExportFrom {
                    source,
                    type_only,
                    names,
                } => {
                    let Some(target) = self.spec(from, &source) else {
                        continue;
                    };
                    let mut reexported = Vec::new();
                    for name in names {
                        exports.named.insert(
                            name.exported,
                            ExportSource::Reexported {
                                file: target.clone(),
                                name: name.original.clone(),
                            },
                        );
                        let kind = if type_only || name.type_only {
                            LinkKind::TypeOnly
                        } else {
                            LinkKind::ReExport
                        };
                        reexported.push((name.original, kind));
                    }
                    self.link(from, Some(&target), LinkKind::ReExport, Some(reexported));
                }
                ModuleStatement::ExportLocal { names } => {
                    for name in names {
                        let source = match bindings.get(&name.original) {
                            Some((file, imported)) => ExportSource::Reexported {
                                file: file.clone(),
                                name: imported.clone(),
                            },
                            None => ExportSource::Local,
                        };
                        exports.named.insert(name.exported, source);
                    }
                }
                ModuleStatement::Declare { names } => {
                    for name in names {
                        exports.named.insert(name, ExportSource::Local);
                    }
                }
            }
        }
        self.exports
            .insert(self.files[from].path.to_owned(), exports);

        for (spec, kind) in facts.calls {
            let target = self.spec(from, &spec);
            self.link(from, target.as_deref(), kind, None);
        }
    }

    fn scan_css(&mut self, from: usize) {
        let files = self.files;
        let file = &files[from];
        let targets: Vec<Option<String>> = CSS_IMPORT
            .captures_iter(file.text)
            .map(|captures| match self.resolve(file.path, &captures[1]) {
                Resolved::File(target) => Some(target),
                _ => None,
            })
            .collect();
        for target in targets {
            self.link(from, target.as_deref(), LinkKind::Import, None);
        }
    }

    fn scan_python(&mut self, from: usize) {
        let files = self.files;
        let file = &files[from];
        let mut targets = Vec::new();
        for line in file.text.lines() {
            if let Some(captures) = PYTHON_FROM.captures(line) {
                let level = captures[1].len();
                let module = &captures[2];
                match self.resolve_python(file.path, module, level) {
                    Some(target) => targets.push(Ok(target)),
                    // `from . import a, b` imports modules, not names.
                    None if level > 0 && module.is_empty() => {
                        for name in captures[3].replace(['(', ')'], "").split(',') {
                            let name = name.trim().split(' ').next().unwrap_or_default();
                            if let Some(target) = self.resolve_python(file.path, name, level) {
                                targets.push(Ok(target));
                            }
                        }
                    }
                    None if level == 0 => {
                        targets.push(Err(module.split('.').next().unwrap_or_default().to_owned()));
                    }
                    None => {}
                }
                continue;
            }
            if let Some(captures) = PYTHON_IMPORT.captures(line) {
                let module = &captures[1];
                match self.resolve_python(file.path, module, 0) {
                    Some(target) => targets.push(Ok(target)),
                    None => {
                        targets.push(Err(module.split('.').next().unwrap_or_default().to_owned()))
                    }
                }
            }
        }
        for target in targets {
            match target {
                Ok(target) => self.link(from, Some(&target), LinkKind::Import, None),
                Err(package) if !package.is_empty() => self.add_package(from, package),
                Err(_) => {}
            }
        }
    }

    fn scan_asset_urls(&mut self, from: usize) {
        let files = self.files;
        let file = &files[from];
        let mut targets = Vec::new();
        for captures in PUBLIC_ASSET.captures_iter(file.text) {
            for folder in &self.resolver.public_dirs {
                targets.push(format!("{folder}{}", &captures[1]));
            }
        }
        for captures in RELATIVE_ASSET.captures_iter(file.text) {
            targets.push(normalize(&join(&[dirname(file.path), &captures[1]])));
        }
        for target in targets {
            self.link(from, Some(&target), LinkKind::AssetUrl, None);
        }
    }

    /// The file defining `name` as `file` exports it; `None` lets an `export *` search go on.
    fn definer(
        &self,
        file: &str,
        name: &str,
        depth: usize,
        memo: &mut HashMap<(String, String), Option<String>>,
    ) -> Option<String> {
        if name == "*" {
            return Some(file.to_owned());
        }
        let Some(exports) = self.exports.get(file) else {
            return Some(file.to_owned());
        };
        if depth > MAX_REEXPORT_DEPTH {
            return Some(file.to_owned());
        }
        let key = (file.to_owned(), name.to_owned());
        if let Some(known) = memo.get(&key) {
            return known.clone();
        }
        // Marked first, so a cycle of re-exports ends instead of recursing.
        memo.insert(key.clone(), None);
        let found = match exports.named.get(name) {
            Some(ExportSource::Local) => Some(file.to_owned()),
            Some(ExportSource::Reexported { file: source, name }) => self
                .definer(source, name, depth + 1, memo)
                .or_else(|| Some(source.clone())),
            None if name != "default" => exports
                .stars
                .iter()
                .filter(|star| self.exports.contains_key(star.as_str()))
                .find_map(|star| self.definer(star, name, depth + 1, memo)),
            None => None,
        };
        memo.insert(key, found.clone());
        found
    }

    fn through_links(&self) -> Vec<Link> {
        let mut memo = HashMap::new();
        let mut through = Vec::new();
        for import in &self.imports {
            let to = self.index[import.file.as_str()];
            let Some(names) = &import.names else {
                through.push(Link {
                    from: import.from,
                    to,
                    kind: import.kind,
                    via: None,
                });
                continue;
            };
            // Each defining file once, by the strongest way any name reached it.
            let mut targets: Vec<(String, LinkKind)> = Vec::new();
            for (name, kind) in names {
                let definer = self
                    .definer(&import.file, name, 0, &mut memo)
                    .unwrap_or_else(|| import.file.clone());
                match targets.iter_mut().find(|(file, _)| *file == definer) {
                    Some((_, existing)) if (*kind as u8) < (*existing as u8) => *existing = *kind,
                    Some(_) => {}
                    None => targets.push((definer, *kind)),
                }
            }
            for (definer, kind) in targets {
                if definer == self.files[import.from].path {
                    continue;
                }
                through.push(Link {
                    from: import.from,
                    to: self.index[definer.as_str()],
                    kind,
                    via: (definer != import.file).then_some(to),
                });
            }
        }
        through
    }
}

/// One link per pair of files, keeping the strongest kind and the first seen.
fn dedupe(links: Vec<Link>) -> Vec<Link> {
    let mut position: HashMap<(usize, usize), usize> = HashMap::new();
    let mut kept: Vec<Link> = Vec::new();
    for link in links {
        if link.from == link.to {
            continue;
        }
        match position.get(&(link.from, link.to)) {
            Some(&at) if link.kind.rank() < kept[at].kind.rank() => kept[at] = link,
            Some(_) => {}
            None => {
                position.insert((link.from, link.to), kept.len());
                kept.push(link);
            }
        }
    }
    kept
}

pub(super) fn analyze(files: &[SourceFile], resolver: &Resolver) -> ImportGraph {
    let mut analysis = Analysis {
        files,
        index: files
            .iter()
            .enumerate()
            .map(|(at, file)| (file.path, at))
            .collect(),
        resolver,
        links: Vec::new(),
        imports: Vec::new(),
        exports: HashMap::new(),
        package_counts: Vec::new(),
        file_packages: vec![Vec::new(); files.len()],
    };
    let mut allocator = Allocator::default();

    for (at, file) in files.iter().enumerate() {
        match file.kind {
            FileKind::Ts | FileKind::Tsx | FileKind::Js | FileKind::Dts => {
                analysis.scan_script(at, &mut allocator);
            }
            FileKind::Css => analysis.scan_css(at),
            FileKind::Py => analysis.scan_python(at),
            _ => {}
        }
        if matches!(
            file.kind,
            FileKind::Ts | FileKind::Tsx | FileKind::Js | FileKind::Css | FileKind::Json
        ) {
            analysis.scan_asset_urls(at);
        }
    }

    let through_links = dedupe(analysis.through_links());
    let mut packages = analysis.package_counts;
    packages.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    packages.truncate(MAX_PACKAGES);
    ImportGraph {
        links: dedupe(analysis.links),
        through_links,
        packages,
        file_packages: analysis.file_packages,
    }
}
