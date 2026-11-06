//! Node's `path.posix` operations, for repository paths, which always use `/`.

pub(super) fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(slash) => &path[..slash],
        None => ".",
    }
}

/// Resolves `.` and `..` segments and repeated slashes, keeping a trailing slash.
pub(super) fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.last().is_some_and(|last| *last != "..") {
                    segments.pop();
                } else if !absolute {
                    segments.push("..");
                }
            }
            name => segments.push(name),
        }
    }
    let mut normalized = segments.join("/");
    if absolute {
        normalized.insert(0, '/');
    }
    if normalized.is_empty() {
        normalized.push('.');
    }
    if path.ends_with('/') && !normalized.ends_with('/') {
        normalized.push('/');
    }
    normalized
}

pub(super) fn join(parts: &[&str]) -> String {
    let present: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|part| !part.is_empty())
        .collect();
    normalize(&present.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_for_the_paths_imports_produce() {
        assert_eq!(dirname("apps/web/src/App.tsx"), "apps/web/src");
        assert_eq!(dirname("package.json"), ".");
        assert_eq!(join(&[".", "src/index"]), "src/index");
        assert_eq!(
            join(&["apps/web/src", "../lib/./util"]),
            "apps/web/lib/util"
        );
        assert_eq!(join(&["src", "../../outside"]), "../outside");
        assert_eq!(normalize("a//b/"), "a/b/");
        assert_eq!(normalize("./"), "./");
        assert_eq!(normalize(""), ".");
    }
}
