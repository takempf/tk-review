//! Maps import specifiers to files by tsconfig `paths`, workspace packages, and public/ folders.

use std::collections::HashSet;

use serde_json::Value;

use super::posix_path::{dirname, join, normalize};

struct Alias {
    prefix: String,
    suffix: String,
    wildcard: bool,
    targets: Vec<String>,
}

struct WorkspacePackage {
    name: String,
    /// The package's folder, empty at the repository root.
    dir: String,
    /// Files its bare name might stand for, most likely first.
    entries: Vec<String>,
}

pub(super) struct Resolver {
    aliases: Vec<Alias>,
    base_urls: Vec<String>,
    packages: Vec<WorkspacePackage>,
    pub public_dirs: Vec<String>,
    /// Top-level folders that hold one project per subfolder (apps/, packages/ ...).
    pub containers: Vec<String>,
}

const ROOT_CONFIGS: [&str; 3] = ["tsconfig.base.json", "tsconfig.json", "jsconfig.json"];
const DEFAULT_CONTAINERS: [&str; 4] = ["apps", "libs", "packages", "services"];
const MAX_EXTENDS_DEPTH: usize = 4;

fn push_unique(list: &mut Vec<String>, item: String) {
    if !list.contains(&item) {
        list.push(item);
    }
}

impl Resolver {
    pub fn new<'a>(paths: &[String], read: impl Fn(&str) -> Option<&'a str>) -> Self {
        let files: HashSet<&str> = paths.iter().map(String::as_str).collect();
        let mut resolver = Self {
            aliases: Vec::new(),
            base_urls: Vec::new(),
            packages: Vec::new(),
            public_dirs: Vec::new(),
            containers: DEFAULT_CONTAINERS.map(String::from).to_vec(),
        };

        let mut seen = HashSet::new();
        for config in ROOT_CONFIGS {
            resolver.load_tsconfig(config, 0, &files, &read, &mut seen);
        }
        // The most specific alias wins.
        resolver
            .aliases
            .sort_by_key(|alias| std::cmp::Reverse(alias.prefix.len()));

        for path in paths {
            if path.rsplit('/').next() != Some("package.json") {
                continue;
            }
            if let Some(package) = read(path).and_then(|text| workspace_package(path, text)) {
                resolver.packages.push(package);
            }
        }
        resolver
            .packages
            .sort_by_key(|package| std::cmp::Reverse(package.name.len()));

        for path in paths {
            let segments: Vec<&str> = path.split('/').collect();
            let folders = &segments[..segments.len() - 1];
            if let Some(at) = folders.iter().position(|segment| *segment == "public") {
                push_unique(&mut resolver.public_dirs, folders[..=at].join("/"));
            }
        }

        let mut parents: Vec<(&str, usize)> = Vec::new();
        for package in &resolver.packages {
            let parts: Vec<&str> = package.dir.split('/').collect();
            if parts.len() != 2 {
                continue;
            }
            match parents.iter_mut().find(|(parent, _)| *parent == parts[0]) {
                Some((_, count)) => *count += 1,
                None => parents.push((parts[0], 1)),
            }
        }
        let crowded: Vec<String> = parents
            .into_iter()
            .filter(|(_, count)| *count >= 2)
            .map(|(parent, _)| parent.to_owned())
            .collect();
        for parent in crowded {
            push_unique(&mut resolver.containers, parent);
        }
        resolver
    }

    fn load_tsconfig<'a>(
        &mut self,
        file: &str,
        depth: usize,
        files: &HashSet<&str>,
        read: &impl Fn(&str) -> Option<&'a str>,
        seen: &mut HashSet<String>,
    ) {
        if depth > MAX_EXTENDS_DEPTH || !files.contains(file) || !seen.insert(file.to_owned()) {
            return;
        }
        let Some(config) = read(file).and_then(parse_jsonc) else {
            return;
        };
        let folder = dirname(file);
        let extends = match &config["extends"] {
            Value::String(one) => vec![one.as_str()],
            Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        for parent in extends.into_iter().filter(|parent| parent.starts_with('.')) {
            let target = normalize(&join(&[folder, parent]));
            let target = if target.ends_with(".json") {
                target
            } else {
                format!("{target}.json")
            };
            self.load_tsconfig(&target, depth + 1, files, read, seen);
        }

        let options = &config["compilerOptions"];
        let base_url = options["baseUrl"].as_str();
        let base = join(&[folder, base_url.unwrap_or(".")]);
        if base_url.is_some() {
            push_unique(&mut self.base_urls, base.clone());
        }
        let Some(paths) = options["paths"].as_object() else {
            return;
        };
        for (key, targets) in paths {
            let star = key.find('*');
            self.aliases.push(Alias {
                prefix: star.map_or(key.clone(), |at| key[..at].to_owned()),
                suffix: star.map_or(String::new(), |at| key[at + 1..].to_owned()),
                wildcard: star.is_some(),
                targets: targets
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|target| join(&[&base, target]))
                    .collect(),
            });
        }
    }

    /// Paths, before extensions are tried, that a non-relative specifier may name.
    pub fn candidates(&self, spec: &str) -> Vec<String> {
        let mut out = Vec::new();
        for alias in &self.aliases {
            if alias.wildcard {
                let fits = spec.len() >= alias.prefix.len() + alias.suffix.len()
                    && spec.starts_with(&alias.prefix)
                    && spec.ends_with(&alias.suffix);
                if fits {
                    let middle = &spec[alias.prefix.len()..spec.len() - alias.suffix.len()];
                    out.extend(
                        alias
                            .targets
                            .iter()
                            .map(|target| target.replacen('*', middle, 1)),
                    );
                }
            } else if spec == alias.prefix {
                out.extend(alias.targets.iter().cloned());
            }
        }
        for package in &self.packages {
            if spec == package.name {
                out.extend(
                    package
                        .entries
                        .iter()
                        .map(|entry| join(&[&package.dir, entry])),
                );
            } else if let Some(sub) = spec
                .strip_prefix(package.name.as_str())
                .and_then(|rest| rest.strip_prefix('/'))
            {
                out.push(join(&[&package.dir, sub]));
                out.push(join(&[&package.dir, "src", sub]));
            }
        }
        out.extend(self.base_urls.iter().map(|base| join(&[base, spec])));
        out
    }

    pub fn is_workspace_package(&self, spec: &str) -> bool {
        self.packages.iter().any(|package| {
            spec == package.name
                || spec
                    .strip_prefix(package.name.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }
}

fn workspace_package(path: &str, text: &str) -> Option<WorkspacePackage> {
    let manifest: Value = serde_json::from_str(text).ok()?;
    let name = manifest["name"].as_str().filter(|name| !name.is_empty())?;
    let folder = dirname(path);
    let declared = [
        export_entry(&manifest["exports"]),
        Some(&manifest["module"]),
        Some(&manifest["main"]),
        Some(&manifest["types"]),
        Some(&manifest["typings"]),
    ];
    let mut entries = Vec::new();
    let declared = declared.into_iter().flatten().filter_map(Value::as_str);
    for entry in declared.chain(["src/index", "index"]) {
        let clean = entry.strip_prefix("./").unwrap_or(entry);
        push_unique(&mut entries, clean.to_owned());
        // Built output usually mirrors src/.
        push_unique(&mut entries, source_of_built(clean));
    }
    Some(WorkspacePackage {
        name: name.to_owned(),
        dir: if folder == "." {
            String::new()
        } else {
            folder.to_owned()
        },
        entries,
    })
}

/// The first entry an `exports` field names, by the conditions a bundler would try.
fn export_entry(exports: &Value) -> Option<&Value> {
    if exports.is_string() {
        return Some(exports);
    }
    let object = exports.as_object()?;
    ["import", "module", "default", "require", "types"]
        .iter()
        .find_map(|condition| object.get(*condition).filter(|value| !value.is_null()))
        .or_else(|| object.get(".").and_then(export_entry))
}

fn source_of_built(entry: &str) -> String {
    let in_src = ["dist/", "build/", "lib/", "out/"]
        .iter()
        .find_map(|built| entry.strip_prefix(built))
        .map_or(entry.to_owned(), |rest| format!("src/{rest}"));
    [".mjs", ".cjs", ".js"]
        .iter()
        .find_map(|extension| in_src.strip_suffix(extension))
        .map_or(in_src.clone(), str::to_owned)
}

/// JSON as tsconfig reads it: comments and trailing commas allowed.
fn parse_jsonc(text: &str) -> Option<Value> {
    serde_json::from_str(&strip_trailing_commas(&strip_comments(text))).ok()
}

fn strip_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&escaped) = chars.get(i + 1) {
                    out.push(escaped);
                    i += 1;
                }
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match (c, chars.get(i + 1)) {
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
            }
            _ => {
                in_string = c == '"';
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn strip_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for (i, &c) in chars.iter().enumerate() {
        if in_string {
            in_string = escaped || c != '"';
            escaped = !escaped && c == '\\';
        } else if c == '"' {
            in_string = true;
        } else if c == ',' {
            let next = chars[i + 1..].iter().find(|next| !next.is_whitespace());
            if matches!(next, Some('}' | ']')) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(files: &[(&str, &str)]) -> Resolver {
        let paths: Vec<String> = files.iter().map(|(path, _)| (*path).to_owned()).collect();
        Resolver::new(&paths, |wanted| {
            files
                .iter()
                .find(|(path, _)| *path == wanted)
                .map(|(_, text)| *text)
        })
    }

    #[test]
    fn follows_tsconfig_paths_through_extends_and_comments() {
        let resolver = resolver(&[
            ("tsconfig.json", r#"{ "extends": "./tsconfig.base", /* why */ }"#),
            (
                "tsconfig.base.json",
                "{\n  // aliases\n  \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@app/*\": [\"src/*\",], \"~\": [\"src/index.ts\"] } },\n}",
            ),
        ]);
        assert_eq!(
            resolver.candidates("@app/util/x"),
            vec!["src/util/x", "@app/util/x"]
        );
        assert_eq!(resolver.candidates("~")[0], "src/index.ts");
    }

    #[test]
    fn maps_workspace_packages_and_their_built_entries_to_source() {
        let resolver = resolver(&[
            (
                "packages/core/package.json",
                r#"{"name":"@x/core","main":"dist/index.js"}"#,
            ),
            (
                "packages/ui/package.json",
                r#"{"name":"@x/ui","exports":{".":{"import":"./lib/ui.mjs"}}}"#,
            ),
            ("apps/web/public/logo.png", ""),
        ]);
        let core = resolver.candidates("@x/core");
        assert!(
            core.contains(&"packages/core/src/index".to_owned()),
            "{core:?}"
        );
        assert!(resolver
            .candidates("@x/ui")
            .contains(&"packages/ui/src/ui".to_owned()));
        assert_eq!(
            resolver.candidates("@x/core/math"),
            vec!["packages/core/math", "packages/core/src/math"]
        );
        assert!(resolver.is_workspace_package("@x/core/deep"));
        assert!(!resolver.is_workspace_package("@x/corex"));
        assert_eq!(resolver.public_dirs, vec!["apps/web/public"]);
        assert!(resolver.containers.contains(&"packages".to_owned()));
    }
}
